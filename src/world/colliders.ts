export type ColliderTag = 'building' | 'tree' | 'pole' | 'parked' | 'barrier' | 'bench' | 'signal';

export type StaticCollider =
  | { kind: 'box'; minX: number; maxX: number; minZ: number; maxZ: number; tag: ColliderTag }
  | { kind: 'circle'; x: number; z: number; r: number; tag: ColliderTag }
  | { kind: 'obb'; x: number; z: number; hw: number; hl: number; heading: number; tag: ColliderTag; id?: number };

export type Contact = { nx: number; nz: number; depth: number; tag: ColliderTag };

/** Static world colliders in a uniform spatial hash. Dynamic bodies are circles. */
export class ColliderWorld {
  private cells = new Map<number, StaticCollider[]>();
  private readonly cs = 16;
  readonly all: StaticCollider[] = [];

  private key(ix: number, iz: number) {
    return (ix + 8192) * 16384 + (iz + 8192);
  }

  private bounds(c: StaticCollider): [number, number, number, number] {
    switch (c.kind) {
      case 'box':
        return [c.minX, c.maxX, c.minZ, c.maxZ];
      case 'circle':
        return [c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r];
      case 'obb': {
        const r = Math.hypot(c.hw, c.hl);
        return [c.x - r, c.x + r, c.z - r, c.z + r];
      }
    }
  }

  add(c: StaticCollider) {
    this.all.push(c);
    const [x0, x1, z0, z1] = this.bounds(c);
    for (let ix = Math.floor(x0 / this.cs); ix <= Math.floor(x1 / this.cs); ix++) {
      for (let iz = Math.floor(z0 / this.cs); iz <= Math.floor(z1 / this.cs); iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
    }
  }

  remove(pred: (c: StaticCollider) => boolean) {
    for (const [k, list] of this.cells) {
      const f = list.filter((c) => !pred(c));
      if (f.length !== list.length) this.cells.set(k, f);
    }
    for (let i = this.all.length - 1; i >= 0; i--) if (pred(this.all[i])) this.all.splice(i, 1);
  }

  /** Push a circle out of all overlapping static colliders. Mutates p. */
  resolveCircle(p: { x: number; z: number }, r: number, out: Contact[]): void {
    const seen = new Set<StaticCollider>();
    for (let ix = Math.floor((p.x - r) / this.cs); ix <= Math.floor((p.x + r) / this.cs); ix++) {
      for (let iz = Math.floor((p.z - r) / this.cs); iz <= Math.floor((p.z + r) / this.cs); iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (seen.has(c)) continue;
          seen.add(c);
          const ct = circleVs(c, p.x, p.z, r);
          if (ct) {
            p.x += ct.nx * ct.depth;
            p.z += ct.nz * ct.depth;
            out.push(ct);
          }
        }
      }
    }
  }

  /** Any collider overlapping the circle? (no resolution) */
  overlaps(x: number, z: number, r: number): boolean {
    const list = this.cells.get(this.key(Math.floor(x / this.cs), Math.floor(z / this.cs)));
    if (!list) return false;
    for (const c of list) if (circleVs(c, x, z, r)) return true;
    return false;
  }
}

function circleVs(c: StaticCollider, x: number, z: number, r: number): Contact | null {
  if (c.kind === 'circle') {
    const dx = x - c.x;
    const dz = z - c.z;
    const d = Math.hypot(dx, dz);
    const pen = r + c.r - d;
    if (pen <= 0) return null;
    const inv = d > 1e-6 ? 1 / d : 0;
    return { nx: d > 1e-6 ? dx * inv : 1, nz: d > 1e-6 ? dz * inv : 0, depth: pen, tag: c.tag };
  }
  let lx = x;
  let lz = z;
  let minX: number, maxX: number, minZ: number, maxZ: number;
  let cos = 1;
  let sin = 0;
  if (c.kind === 'obb') {
    // transform into OBB local frame (forward = +z local)
    cos = Math.cos(c.heading);
    sin = Math.sin(c.heading);
    const dx = x - c.x;
    const dz = z - c.z;
    lx = dx * cos - dz * sin;
    lz = dx * sin + dz * cos;
    minX = -c.hw;
    maxX = c.hw;
    minZ = -c.hl;
    maxZ = c.hl;
  } else {
    minX = c.minX;
    maxX = c.maxX;
    minZ = c.minZ;
    maxZ = c.maxZ;
  }
  const qx = Math.max(minX, Math.min(lx, maxX));
  const qz = Math.max(minZ, Math.min(lz, maxZ));
  let nx = lx - qx;
  let nz = lz - qz;
  const d2 = nx * nx + nz * nz;
  if (d2 >= r * r) return null;
  let depth: number;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    nx /= d;
    nz /= d;
    depth = r - d;
  } else {
    // centre inside: push along the shallowest axis
    const dl = lx - minX;
    const dr = maxX - lx;
    const db = lz - minZ;
    const dt = maxZ - lz;
    const m = Math.min(dl, dr, db, dt);
    if (m === dl) [nx, nz, depth] = [-1, 0, dl + r];
    else if (m === dr) [nx, nz, depth] = [1, 0, dr + r];
    else if (m === db) [nx, nz, depth] = [0, -1, db + r];
    else [nx, nz, depth] = [0, 1, dt + r];
  }
  if (c.kind === 'obb') {
    // rotate normal back to world: inverse of (x cos − z sin, x sin + z cos)
    const wx = nx * cos + nz * sin;
    const wz = -nx * sin + nz * cos;
    nx = wx;
    nz = wz;
  }
  return { nx, nz, depth, tag: c.tag };
}
