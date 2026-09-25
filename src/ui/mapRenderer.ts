import type { RoadNetwork } from '../world/roadNetwork';
import type { Landmark } from '../world/mapDefs';

export type MapDynamic = {
  player: { x: number; z: number; heading: number };
  route?: number[] | null;
  cars?: { x: number; z: number }[];
  markers?: { x: number; z: number; color: string }[];
  trail?: number[];
};

const DISTRICT_COLOR: Record<string, string> = {
  downtown: '#3b4658',
  commercial: '#3f4a5a',
  residential: '#39434f',
  suburb: '#374a3c',
  park: '#2f5b35',
  plaza: '#5a5345',
  school: '#5a4a34',
  industrial: '#44464b',
  lot: '#2f3238',
  hospital: '#4d4050',
  mosque: '#4b4a3a',
  campus: '#34503f',
};

/** Pre-rendered top-down map + dynamic overlays for the minimap, big map and cockpit screen. */
export class MapRenderer {
  readonly base: HTMLCanvasElement;
  readonly scale: number;
  private minX: number;
  private minZ: number;
  readonly landmarks: Landmark[];

  constructor(net: RoadNetwork) {
    const ext = net.map.extent;
    this.landmarks = net.map.landmarks;
    this.scale = 1.4;
    this.minX = ext.minX;
    this.minZ = ext.minZ;
    const w = Math.ceil((ext.maxX - ext.minX) * this.scale);
    const h = Math.ceil((ext.maxZ - ext.minZ) * this.scale);
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    const g = this.base.getContext('2d')!;
    g.fillStyle = '#1f2a22';
    g.fillRect(0, 0, w, h);
    const X = (x: number) => (x - this.minX) * this.scale;
    const Z = (z: number) => (z - this.minZ) * this.scale;
    for (const b of net.blocks) {
      g.fillStyle = net.isOuterBlock(b) ? '#23302a' : DISTRICT_COLOR[b.district] ?? '#39434f';
      g.fillRect(X(b.rect.minX), Z(b.rect.minZ), (b.rect.maxX - b.rect.minX) * this.scale, (b.rect.maxZ - b.rect.minZ) * this.scale);
    }
    g.fillStyle = '#5b6068';
    for (const s of net.sidewalks) g.fillRect(X(s.minX), Z(s.minZ), (s.maxX - s.minX) * this.scale, (s.maxZ - s.minZ) * this.scale);
    const roadColor: Record<string, string> = { boulevard: '#c9ccd2', avenue: '#b8bcc4', street: '#9ea3ab', oneway: '#9ea3ab', residential: '#8a8f97' };
    for (const e of net.edges) {
      g.fillStyle = roadColor[e.cls];
      const hw = e.halfWidth;
      if (e.axis === 'ns') g.fillRect(X(e.x0 - hw), Z(e.z0), hw * 2 * this.scale, (e.z1 - e.z0) * this.scale);
      else g.fillRect(X(e.x0), Z(e.z0 - hw), (e.x1 - e.x0) * this.scale, hw * 2 * this.scale);
    }
    for (const n of net.nodes) {
      g.fillStyle = '#b3b7bf';
      g.fillRect(X(n.x - n.hx), Z(n.z - n.hz), n.hx * 2 * this.scale, n.hz * 2 * this.scale);
    }
    // one-way arrows
    g.fillStyle = 'rgba(40,50,70,0.8)';
    for (const e of net.edges) {
      if (!e.oneway) continue;
      const hdg = e.oneway === 1 ? e.heading : e.heading + Math.PI;
      for (let s = 20; s < e.length - 10; s += 40) {
        const x = X(e.x0 + e.dx * s);
        const z = Z(e.z0 + e.dz * s);
        g.save();
        g.translate(x, z);
        g.rotate(-hdg + Math.PI);
        g.beginPath();
        g.moveTo(0, -5);
        g.lineTo(4, 3);
        g.lineTo(-4, 3);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
    // signal junction dots
    for (const n of net.nodes) {
      if (!n.signalized) continue;
      g.fillStyle = '#f5b942';
      g.beginPath();
      g.arc(X(n.x), Z(n.z), 2.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  private toMap(x: number, z: number): [number, number] {
    return [(x - this.minX) * this.scale, (z - this.minZ) * this.scale];
  }

  /**
   * Heading-up minimap centred on the player. `range` = metres from centre to edge.
   * Screen up = player's forward.
   */
  drawMini(g: CanvasRenderingContext2D, w: number, h: number, d: MapDynamic, range = 120, round = true) {
    const s = (Math.min(w, h) / 2 / range) / this.scale;
    g.save();
    g.clearRect(0, 0, w, h);
    if (round) {
      g.beginPath();
      g.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      g.clip();
    }
    g.fillStyle = '#1b231e';
    g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2 + h * 0.12);
    // forward (sin h, cos h) must point up (−y): rotate by (π − heading)
    g.rotate(d.player.heading - Math.PI);
    g.scale(s, s);
    const [px, pz] = this.toMap(d.player.x, d.player.z);
    g.translate(-px, -pz);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, 0, 0);
    this.overlays(g, d, 1 / s);
    g.restore();
    // player arrow
    g.save();
    g.translate(w / 2, h / 2 + h * 0.12);
    g.fillStyle = '#35a7ff';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(7, 7);
    g.lineTo(0, 3);
    g.lineTo(-7, 7);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // north indicator (world −z) — on screen it lies along (−sin h, cos h)
    const r = Math.min(w, h) / 2 - 12;
    const nx = w / 2 - Math.sin(d.player.heading) * r;
    const ny = h / 2 + Math.cos(d.player.heading) * r;
    g.fillStyle = '#e53935';
    g.font = 'bold 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('K', nx, ny);
  }

  private overlays(g: CanvasRenderingContext2D, d: MapDynamic, px: number) {
    const X = (x: number) => (x - this.minX) * this.scale;
    const Z = (z: number) => (z - this.minZ) * this.scale;
    if (d.trail && d.trail.length > 3) {
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 2 * px;
      g.beginPath();
      g.moveTo(X(d.trail[0]), Z(d.trail[1]));
      for (let i = 2; i < d.trail.length; i += 2) g.lineTo(X(d.trail[i]), Z(d.trail[i + 1]));
      g.stroke();
    }
    if (d.route && d.route.length > 3) {
      g.strokeStyle = '#2d8cff';
      g.lineWidth = 5 * px;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(X(d.route[0]), Z(d.route[1]));
      for (let i = 2; i < d.route.length; i += 2) g.lineTo(X(d.route[i]), Z(d.route[i + 1]));
      g.stroke();
    }
    if (d.cars) {
      g.fillStyle = '#e0e4ea';
      for (const c of d.cars) {
        g.beginPath();
        g.arc(X(c.x), Z(c.z), 2.4 * px, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const lm of this.landmarks) {
      g.save();
      g.translate(X(lm.x), Z(lm.z));
      g.font = `${16 * px}px system-ui, "Segoe UI Emoji", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(lm.icon, 0, 0);
      g.restore();
    }
    if (d.markers) {
      for (const m of d.markers) {
        g.fillStyle = m.color;
        g.strokeStyle = '#fff';
        g.lineWidth = 2 * px;
        g.beginPath();
        g.arc(X(m.x), Z(m.z), 6 * px, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
  }

  /** North-up full map fitted into the canvas. Returns the transform for click picking. */
  drawFull(g: CanvasRenderingContext2D, w: number, h: number, d: MapDynamic): (sx: number, sy: number) => { x: number; z: number } {
    const bw = this.base.width;
    const bh = this.base.height;
    const s = Math.min(w / bw, h / bh);
    const ox = (w - bw * s) / 2;
    const oy = (h - bh * s) / 2;
    g.save();
    g.clearRect(0, 0, w, h);
    g.translate(ox, oy);
    g.scale(s, s);
    g.drawImage(this.base, 0, 0);
    this.overlays(g, d, 1 / s);
    const [px, pz] = this.toMap(d.player.x, d.player.z);
    g.translate(px, pz);
    g.rotate(Math.PI - d.player.heading);
    g.fillStyle = '#35a7ff';
    g.strokeStyle = '#fff';
    g.lineWidth = 2 / s;
    g.beginPath();
    g.moveTo(0, -12 / s);
    g.lineTo(9 / s, 9 / s);
    g.lineTo(0, 4 / s);
    g.lineTo(-9 / s, 9 / s);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    return (sx, sy) => ({ x: (sx - ox) / s / this.scale + this.minX, z: (sy - oy) / s / this.scale + this.minZ });
  }

  /** Static overview (for reports): driven path coloured by speed + event pins. */
  drawTrace(g: CanvasRenderingContext2D, w: number, h: number, pts: { x: number; z: number; v: number }[], pins: { x: number; z: number; color: string }[]) {
    if (!pts.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = 60;
    minX -= pad;
    maxX += pad;
    minZ -= pad;
    maxZ += pad;
    const s = Math.min(w / (maxX - minX), h / (maxZ - minZ));
    const ox = (w - (maxX - minX) * s) / 2;
    const oy = (h - (maxZ - minZ) * s) / 2;
    g.save();
    g.fillStyle = '#10151c';
    g.fillRect(0, 0, w, h);
    g.translate(ox, oy);
    g.scale(s / this.scale, s / this.scale);
    g.translate(-(minX - this.minX) * this.scale, -(minZ - this.minZ) * this.scale);
    g.globalAlpha = 0.75;
    g.drawImage(this.base, 0, 0);
    g.globalAlpha = 1;
    g.restore();
    const P = (x: number, z: number): [number, number] => [ox + (x - minX) * s, oy + (z - minZ) * s];
    g.lineWidth = 4;
    g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = Math.min(1, b.v / 70);
      g.strokeStyle = `hsl(${200 - t * 200}, 90%, 55%)`;
      g.beginPath();
      g.moveTo(...P(a.x, a.z));
      g.lineTo(...P(b.x, b.z));
      g.stroke();
    }
    for (const p of pins) {
      const [x, y] = P(p.x, p.z);
      g.fillStyle = p.color;
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }
}
