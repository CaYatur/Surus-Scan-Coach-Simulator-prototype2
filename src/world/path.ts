/** A polyline on the XZ plane with arc-length parametrisation. */
export class Path {
  readonly pts: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  readonly count: number;

  constructor(flat: number[]) {
    this.pts = Float64Array.from(flat);
    this.count = flat.length / 2;
    this.cum = new Float64Array(this.count);
    let acc = 0;
    for (let i = 1; i < this.count; i++) {
      acc += Math.hypot(this.pts[i * 2] - this.pts[i * 2 - 2], this.pts[i * 2 + 1] - this.pts[i * 2 - 1]);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  private segIndex(s: number): number {
    // Binary search for the segment containing s.
    let lo = 0;
    let hi = this.count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** Position + heading at arc length s (clamped). */
  sample(s: number, out: { x: number; z: number; h: number }) {
    if (this.count < 2) {
      out.x = this.pts[0];
      out.z = this.pts[1];
      out.h = 0;
      return out;
    }
    const cs = Math.max(0, Math.min(this.length, s));
    const i = this.segIndex(cs);
    const ax = this.pts[i * 2];
    const az = this.pts[i * 2 + 1];
    const bx = this.pts[i * 2 + 2];
    const bz = this.pts[i * 2 + 3];
    const segLen = this.cum[i + 1] - this.cum[i] || 1e-6;
    const t = (cs - this.cum[i]) / segLen;
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    out.h = Math.atan2(bx - ax, bz - az);
    // Extrapolate linearly past the ends so callers can look slightly ahead.
    if (s > this.length) {
      out.x += Math.sin(out.h) * (s - this.length);
      out.z += Math.cos(out.h) * (s - this.length);
    } else if (s < 0) {
      out.x += Math.sin(out.h) * s;
      out.z += Math.cos(out.h) * s;
    }
    return out;
  }

  /** Closest arc length and signed lateral offset (positive = right of travel). */
  project(x: number, z: number): { s: number; lateral: number; dist: number } {
    let best = { s: 0, lateral: 0, dist: Infinity };
    for (let i = 0; i < this.count - 1; i++) {
      const ax = this.pts[i * 2];
      const az = this.pts[i * 2 + 1];
      const dx = this.pts[i * 2 + 2] - ax;
      const dz = this.pts[i * 2 + 3] - az;
      const len2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) {
        const len = Math.sqrt(len2);
        // right vector of (dx,dz) is (−dz, dx)/len
        const lateral = ((x - px) * -dz + (z - pz) * dx) / len;
        best = { s: this.cum[i] + t * len, lateral, dist: d };
      }
    }
    return best;
  }
}

/** Quadratic bezier sampled into a Path. */
export function bezierPath(
  x0: number,
  z0: number,
  cx: number,
  cz: number,
  x1: number,
  z1: number,
  segments = 12
): Path {
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * z0 + 2 * u * t * cz + t * t * z1);
  }
  return new Path(pts);
}
