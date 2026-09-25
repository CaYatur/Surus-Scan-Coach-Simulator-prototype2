import * as THREE from 'three';

/**
 * Accumulates triangles (position/normal/uv/color) and produces a single BufferGeometry.
 * Used to batch whole districts into a handful of draw calls.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private vcount = 0;
  color = new THREE.Color(1, 1, 1);

  get empty() {
    return this.vcount === 0;
  }

  setColor(c: THREE.ColorRepresentation) {
    this.color.set(c);
    return this;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.color.r, this.color.g, this.color.b);
    return this.vcount++;
  }

  /** Quad from 4 corners (counter-clockwise when seen from the normal side). */
  quad(
    p0: THREE.Vector3Like,
    p1: THREE.Vector3Like,
    p2: THREE.Vector3Like,
    p3: THREE.Vector3Like,
    uv: [number, number, number, number, number, number, number, number] = [0, 0, 1, 0, 1, 1, 0, 1]
  ) {
    const ax = p1.x - p0.x;
    const ay = p1.y - p0.y;
    const az = p1.z - p0.z;
    const bx = p3.x - p0.x;
    const by = p3.y - p0.y;
    const bz = p3.z - p0.z;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const a = this.vert(p0.x, p0.y, p0.z, nx, ny, nz, uv[0], uv[1]);
    const b = this.vert(p1.x, p1.y, p1.z, nx, ny, nz, uv[2], uv[3]);
    const c = this.vert(p2.x, p2.y, p2.z, nx, ny, nz, uv[4], uv[5]);
    const d = this.vert(p3.x, p3.y, p3.z, nx, ny, nz, uv[6], uv[7]);
    this.idx.push(a, b, c, a, c, d);
  }

  tri(p0: THREE.Vector3Like, p1: THREE.Vector3Like, p2: THREE.Vector3Like, uv: [number, number, number, number, number, number] = [0, 0, 1, 0, 0.5, 1]) {
    const ax = p1.x - p0.x;
    const ay = p1.y - p0.y;
    const az = p1.z - p0.z;
    const bx = p2.x - p0.x;
    const by = p2.y - p0.y;
    const bz = p2.z - p0.z;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const a = this.vert(p0.x, p0.y, p0.z, nx, ny, nz, uv[0], uv[1]);
    const b = this.vert(p1.x, p1.y, p1.z, nx, ny, nz, uv[2], uv[3]);
    const c = this.vert(p2.x, p2.y, p2.z, nx, ny, nz, uv[4], uv[5]);
    this.idx.push(a, b, c);
  }

  /** Vertical cylinder / prism (radial segments) — used for columns, tanks, minarets. */
  cylinder(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg = 10, caps = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a: number, r: number, y: number) => ({ x: cx + Math.cos(a) * r, y, z: cz - Math.sin(a) * r });
      this.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), [i / seg, 0, (i + 1) / seg, 0, (i + 1) / seg, 1, i / seg, 1]);
      if (caps && r1 > 0.001) this.tri({ x: cx, y: y1, z: cz }, p(a0, r1, y1), p(a1, r1, y1));
    }
  }

  /** Upper hemisphere (dome). */
  dome(cx: number, cy: number, cz: number, r: number, seg = 16, rings = 6, squash = 1) {
    for (let j = 0; j < rings; j++) {
      const t0 = (j / rings) * (Math.PI / 2);
      const t1 = ((j + 1) / rings) * (Math.PI / 2);
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        const p = (a: number, t: number) => ({
          x: cx + Math.cos(a) * Math.cos(t) * r,
          y: cy + Math.sin(t) * r * squash,
          z: cz - Math.sin(a) * Math.cos(t) * r,
        });
        if (j === rings - 1) this.tri(p(a0, t0), p(a1, t0), p(a0, t1));
        else this.quad(p(a0, t0), p(a1, t0), p(a1, t1), p(a0, t1));
      }
    }
  }

  /** Horizontal rectangle at height y facing up, with world-space UV scaled by uvScale. */
  flatRect(minX: number, maxX: number, minZ: number, maxZ: number, y: number, uvScale = 1, uvRot = false) {
    const u = (x: number, z: number): [number, number] => (uvRot ? [z * uvScale, x * uvScale] : [x * uvScale, -z * uvScale]);
    const [u0, v0] = u(minX, maxZ);
    const [u1, v1] = u(maxX, maxZ);
    const [u2, v2] = u(maxX, minZ);
    const [u3, v3] = u(minX, minZ);
    this.quad(
      { x: minX, y, z: maxZ },
      { x: maxX, y, z: maxZ },
      { x: maxX, y, z: minZ },
      { x: minX, y, z: minZ },
      [u0, v0, u1, v1, u2, v2, u3, v3]
    );
  }

  /**
   * Axis-aligned box. Side faces get UVs in "meters / tile" (u along face, v up) so facade
   * textures tile per floor; top uses world XZ.
   */
  box(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    opts: { tileU?: number; tileV?: number; top?: boolean; bottom?: boolean; sides?: boolean; vOffset?: number } = {}
  ) {
    const tu = opts.tileU ?? 1;
    const tv = opts.tileV ?? 1;
    const vo = opts.vOffset ?? 0;
    const sides = opts.sides ?? true;
    const v0 = vo + minY / tv;
    const v1 = vo + maxY / tv;
    if (sides) {
      // +Z face
      let w = (maxX - minX) / tu;
      this.quad({ x: minX, y: minY, z: maxZ }, { x: maxX, y: minY, z: maxZ }, { x: maxX, y: maxY, z: maxZ }, { x: minX, y: maxY, z: maxZ }, [0, v0, w, v0, w, v1, 0, v1]);
      // −Z face
      this.quad({ x: maxX, y: minY, z: minZ }, { x: minX, y: minY, z: minZ }, { x: minX, y: maxY, z: minZ }, { x: maxX, y: maxY, z: minZ }, [0, v0, w, v0, w, v1, 0, v1]);
      w = (maxZ - minZ) / tu;
      // +X face
      this.quad({ x: maxX, y: minY, z: maxZ }, { x: maxX, y: minY, z: minZ }, { x: maxX, y: maxY, z: minZ }, { x: maxX, y: maxY, z: maxZ }, [0, v0, w, v0, w, v1, 0, v1]);
      // −X face
      this.quad({ x: minX, y: minY, z: minZ }, { x: minX, y: minY, z: maxZ }, { x: minX, y: maxY, z: maxZ }, { x: minX, y: maxY, z: minZ }, [0, v0, w, v0, w, v1, 0, v1]);
    }
    if (opts.top ?? true) this.flatRect(minX, maxX, minZ, maxZ, maxY, 1 / tu);
    if (opts.bottom) {
      this.quad({ x: minX, y: minY, z: minZ }, { x: maxX, y: minY, z: minZ }, { x: maxX, y: minY, z: maxZ }, { x: minX, y: minY, z: maxZ });
    }
  }

  /** Box centered at (cx, cy, cz), rotated around Y by `rotY`. UVs 0..1 per face. */
  orientedBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0) {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const P = (x: number, y: number, z: number) => ({ x: cx + x * c + z * s, y: cy + y, z: cz - x * s + z * c });
    const corners = [
      P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz),
      P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz),
    ];
    const [a, b, cc, d, e, f, g, h] = corners;
    this.quad(e, f, g, h); // +z
    this.quad(b, a, d, cc); // −z
    this.quad(f, b, cc, g); // +x
    this.quad(a, e, h, d); // −x
    this.quad(h, g, cc, d); // top
    this.quad(a, b, f, e); // bottom
  }

  /** Append an arbitrary geometry transformed by a matrix (uses its uv if present). */
  geometry(geo: THREE.BufferGeometry, matrix: THREE.Matrix4) {
    const g = geo.index ? geo : geo;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    const vn = new THREE.Vector3();
    const base = this.vcount;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      if (n) vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      else vn.set(0, 1, 0);
      this.vert(v.x, v.y, v.z, vn.x, vn.y, vn.z, t ? t.getX(i) : 0, t ? t.getY(i) : 0);
    }
    if (g.index) {
      const ix = g.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /**
   * Split into square XZ tiles (by triangle centroid) so frustum culling can skip
   * whole districts — important for the main view and the three mirror passes.
   */
  toTiledMeshes(material: THREE.Material, tile: number, opts: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh[] {
    const tiles = new Map<string, { map: Map<number, number>; pos: number[]; nrm: number[]; uv: number[]; col: number[]; idx: number[] }>();
    const P = this.pos;
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t];
      const b = this.idx[t + 1];
      const c = this.idx[t + 2];
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
      const cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      const key = `${Math.floor(cx / tile)}:${Math.floor(cz / tile)}`;
      let T = tiles.get(key);
      if (!T) tiles.set(key, (T = { map: new Map(), pos: [], nrm: [], uv: [], col: [], idx: [] }));
      for (const v of [a, b, c]) {
        let nv = T.map.get(v);
        if (nv === undefined) {
          nv = T.pos.length / 3;
          T.map.set(v, nv);
          T.pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          T.nrm.push(this.nrm[v * 3], this.nrm[v * 3 + 1], this.nrm[v * 3 + 2]);
          T.uv.push(this.uv[v * 2], this.uv[v * 2 + 1]);
          T.col.push(this.col[v * 3], this.col[v * 3 + 1], this.col[v * 3 + 2]);
        }
        T.idx.push(nv);
      }
    }
    const out: THREE.Mesh[] = [];
    for (const T of tiles.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(T.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(T.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(T.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(T.col, 3));
      const n = T.pos.length / 3;
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(T.idx, 1) : new THREE.Uint16BufferAttribute(T.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, material);
      m.castShadow = opts.cast ?? false;
      m.receiveShadow = opts.receive ?? true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      out.push(m);
    }
    return out;
  }

  toMesh(material: THREE.Material, opts: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh {
    const m = new THREE.Mesh(this.build(), material);
    m.castShadow = opts.cast ?? false;
    m.receiveShadow = opts.receive ?? true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }
}
