import * as THREE from 'three';
import { formatDistance } from '../core/math';
import type { RoadNetwork, RoadQuery } from '../world/roadNetwork';
import { findRoute, roundaboutExit, type Route } from './routing';

export type NavInstruction = {
  arrow: 'L' | 'R' | 'S' | 'U' | '';
  dist: number;
  text: string;
  street: string;
  /** Lane guidance for the next manoeuvre: lanes of the current carriageway (0 = right) and which ones are suitable. */
  lanes?: { count: number; ok: boolean[]; current: number; hint: string } | null;
};

/** Turn-by-turn navigation with rerouting and optional voice prompts. */
export class Navigator {
  route: Route | null = null;
  stepIndex = 0;
  instruction: NavInstruction | null = null;
  remaining = 0;
  arrived = false;
  onReroute: (() => void) | null = null;
  onAnnounce: ((text: string) => void) | null = null;
  private net: RoadNetwork;
  private offT = 0;
  private announced = new Set<string>();
  readonly guide: RouteGuide;

  constructor(net: RoadNetwork, scene: THREE.Scene) {
    this.net = net;
    this.guide = new RouteGuide(scene);
  }

  setDestination(x: number, z: number, name: string, player: { x: number; z: number; heading: number }): boolean {
    const near = this.net.nearestLane(player.x, player.z, player.heading, 25);
    if (!near) return false;
    const r = findRoute(this.net, near.lane, near.s, x, z, name);
    if (!r) return false;
    this.route = r;
    this.stepIndex = 0;
    this.arrived = false;
    this.offT = 0;
    this.announced.clear();
    this.guide.set(r.line);
    return true;
  }

  clear() {
    this.route = null;
    this.instruction = null;
    this.arrived = false;
    this.guide.set(null);
  }

  update(dt: number, player: { x: number; z: number; heading: number }, q: RoadQuery, voice: boolean) {
    const r = this.route;
    if (!r || this.arrived) {
      this.instruction = null;
      return;
    }
    const dd = Math.hypot(player.x - r.dest.x, player.z - r.dest.z);
    // progress along steps
    if (q.edge && (q.kind === 'road' || q.kind === 'parking')) {
      let found = -1;
      for (let i = this.stepIndex; i < r.steps.length; i++) {
        if (r.steps[i].edge === q.edge && r.steps[i].dir === q.travelDir) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        this.stepIndex = found;
        this.offT = 0;
      } else {
        this.offT += dt;
        if (this.offT > 1.6 && dd > 20) {
          this.offT = 0;
          const ok = this.setDestination(r.dest.x, r.dest.z, r.destName, player);
          if (ok) {
            this.onReroute?.();
            if (voice) this.onAnnounce?.('Rota yeniden hesaplanıyor');
          }
          return;
        }
      }
    }
    if (dd < 14 && this.stepIndex >= r.steps.length - 1) {
      this.arrived = true;
      this.instruction = { arrow: '', dist: 0, text: `${r.destName} — vardınız`, street: '' };
      if (voice) this.onAnnounce?.(`Hedefe ulaştınız: ${r.destName}`);
      this.guide.set(null);
      return;
    }
    // distance to the next manoeuvre
    const st = r.steps[this.stepIndex];
    let toEnd = st.edge.length;
    if (q.edge === st.edge) toEnd = q.travelDir === 1 ? st.edge.length - q.along : q.along;
    let dist = toEnd;
    let i = this.stepIndex;
    while (i < r.steps.length - 1 && r.steps[i].turnAtEnd === 'S') {
      i++;
      dist += r.steps[i].edge.length + 12;
    }
    const last = i >= r.steps.length - 1;
    const turn = r.steps[i].turnAtEnd;
    const street = last ? r.destName : r.steps[i + 1]?.edge.name ?? '';
    let verb = last ? 'Hedef' : turn === 'L' ? 'Sola dönün' : turn === 'R' ? 'Sağa dönün' : 'Düz devam edin';
    const node = r.steps[i].to;
    if (!last && node.kind === 'roundabout') {
      const inArm = this.net.armOf(node, r.steps[i].edge);
      const outArm = this.net.armOf(node, r.steps[i + 1].edge);
      if (inArm && outArm) verb = `Göbekli kavşakta ${roundaboutExit(node, inArm, outArm)}. çıkıştan çıkın`;
    }
    // Lane guidance on multi-lane approaches to the next turn
    let lanes: NavInstruction['lanes'] = null;
    if (!last && (turn === 'L' || turn === 'R') && i === this.stepIndex && dist < 260 && q.edge === st.edge && q.laneIndex >= 0) {
      const n = st.edge.spec.lanes;
      if (n >= 2) {
        const ok = Array.from({ length: n }, (_, k) => (turn === 'R' ? k === 0 : k === n - 1));
        const good = ok[q.laneIndex];
        lanes = {
          count: n,
          ok,
          current: q.laneIndex,
          hint: good ? 'Doğru şeritteysiniz' : turn === 'L' ? 'Sola dönüş için en sol şeride geçin' : 'Sağa dönüş için en sağ şeride geçin',
        };
        if (voice && !good && dist > 60 && !this.announced.has(`${i}:lane`)) {
          this.announced.add(`${i}:lane`);
          this.onAnnounce?.(lanes.hint);
        }
      }
    }
    this.instruction = {
      arrow: last ? 'S' : turn === 'L' ? 'L' : turn === 'R' ? 'R' : 'S',
      dist: last ? dd : dist,
      text: last ? `${r.destName}` : `${verb} — ${street}`,
      street,
      lanes,
    };
    this.remaining = dd;
    if (voice && !last) {
      const key = `${i}:${turn}`;
      if (dist < 160 && dist > 70 && !this.announced.has(key + 'far')) {
        this.announced.add(key + 'far');
        this.onAnnounce?.(`${formatDistance(Math.round(dist / 10) * 10)} sonra ${verb.toLowerCase()}. ${street}`);
      } else if (dist < 35 && !this.announced.has(key + 'near')) {
        this.announced.add(key + 'near');
        this.onAnnounce?.(verb);
      }
    }
  }
}

/** Chevron ribbon drawn on the road along the route. */
class RouteGuide {
  private mesh: THREE.Mesh | null = null;
  private scene: THREE.Scene;
  private tex: THREE.CanvasTexture;
  visible = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(60,170,255,0.55)';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(230,248,255,0.95)';
    g.beginPath();
    g.moveTo(8, 18);
    g.lineTo(32, 42);
    g.lineTo(56, 18);
    g.lineTo(56, 30);
    g.lineTo(32, 54);
    g.lineTo(8, 30);
    g.closePath();
    g.fill();
    this.tex = new THREE.CanvasTexture(c);
    this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.colorSpace = THREE.SRGBColorSpace;
  }

  set(line: number[] | null) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!line || line.length < 4) return;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const w = 0.7;
    let v = 0;
    const n = line.length / 2;
    for (let i = 0; i < n; i++) {
      const x = line[i * 2];
      const z = line[i * 2 + 1];
      const j = Math.min(n - 1, i + 1);
      const k = Math.max(0, i - 1);
      let dx = line[j * 2] - line[k * 2];
      let dz = line[j * 2 + 1] - line[k * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      if (i > 0) v += Math.hypot(x - line[(i - 1) * 2], z - line[(i - 1) * 2 + 1]) / 2.2;
      pos.push(x - dz * w, 0.03, z + dx * w, x + dz * w, 0.03, z - dx * w);
      uv.push(0, -v, 1, -v);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, fog: true })
    );
    this.mesh.renderOrder = 2;
    this.mesh.visible = this.visible;
    this.scene.add(this.mesh);
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (this.mesh) this.mesh.visible = v;
  }

  update(dt: number) {
    this.tex.offset.y -= dt * 0.8;
  }
}
