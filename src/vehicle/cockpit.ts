import * as THREE from 'three';
import { MeshBuilder } from '../world/meshBuilder';
import type { CarDims } from './carModels';

export type CockpitState = {
  kmh: number;
  rpm: number;
  redline: number;
  gearLabel: string;
  signalL: boolean;
  signalR: boolean;
  blinkOn: boolean;
  lights: boolean;
  handbrake: boolean;
  limit: number;
  wheelAngle: number;
  seatbelt: boolean;
  odometerKm: number;
  navText: string;
  navDist: string;
  navArrow: 'L' | 'R' | 'S' | 'U' | '';
  clock: string;
  temp: string;
  wipers: number;
};

export const LAYER_INTERIOR = 2;
export const LAYER_EXTERIOR = 1;
/** Small world details (trees, signs, props, pedestrians) — skipped by mirror cameras. */
export const LAYER_DETAIL = 3;

/** Driver-view interior: dashboard with live gauges, steering wheel, pillars, seats, mirrors. */
export class Cockpit {
  readonly group = new THREE.Group();
  readonly eye: THREE.Vector3;
  readonly passengerEye: THREE.Vector3;
  readonly mirrorAnchors: { left: THREE.Vector3; right: THREE.Vector3; rear: THREE.Vector3 };
  readonly mirrorPlanes: { left: THREE.Mesh; right: THREE.Mesh; rear: THREE.Mesh };
  private wheel = new THREE.Group();
  private clusterCanvas: HTMLCanvasElement;
  private clusterTex: THREE.CanvasTexture;
  private screenCanvas: HTMLCanvasElement;
  private screenTex: THREE.CanvasTexture;
  private gearLever = new THREE.Group();
  private handbrakeLever = new THREE.Group();
  private stalk = new THREE.Group();
  private wiperL = new THREE.Group();
  private wiperR = new THREE.Group();
  private windshield: THREE.Mesh;
  private rainCanvas: HTMLCanvasElement;
  private rainTex: THREE.CanvasTexture;
  private drops: { x: number; y: number; r: number; age: number }[] = [];
  private lastDraw = 0;
  private wiperPhase = 0;
  private screenMap: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;

  constructor(dims: CarDims, cabin: [number, number][], inset: number, paint?: THREE.Material) {
    const W = dims.width / 2;
    const [wsBase, wsTop, roofRear, rearBase] = cabin;
    const innerW = W - inset - 0.06;
    const roofY = Math.min(wsTop[1], roofRear[1]) - 0.04;
    const belt = wsBase[1] + 0.02;
    this.eye = new THREE.Vector3(0.36, roofY - 0.24, wsTop[0] - 0.56);
    this.passengerEye = new THREE.Vector3(-0.36, roofY - 0.26, wsTop[0] - 0.58);

    const mb = new MeshBuilder();
    const dark = '#1e2125';
    const mid = '#2c3036';
    const light = '#5c6168';
    const headliner = '#cfcac2';

    // ——— Dashboard ———
    const dashFront = wsBase[0] - 0.02;
    const dashBack = wsBase[0] - 0.62;
    mb.setColor(dark);
    mb.box(-innerW, innerW, belt - 0.32, belt - 0.02, dashBack, dashFront);
    // soft top slope toward the windshield
    mb.setColor(mid);
    mb.quad(
      { x: innerW, y: belt - 0.02, z: dashBack },
      { x: -innerW, y: belt - 0.02, z: dashBack },
      { x: -innerW, y: belt + 0.02, z: dashFront - 0.05 },
      { x: innerW, y: belt + 0.02, z: dashFront - 0.05 }
    );
    // instrument binnacle (hood over the cluster)
    const cx = this.eye.x;
    mb.setColor(dark);
    mb.box(cx - 0.26, cx + 0.26, belt - 0.02, belt + 0.08, dashBack + 0.02, dashBack + 0.26);
    mb.quad(
      { x: cx + 0.27, y: belt + 0.09, z: dashBack - 0.02 },
      { x: cx - 0.27, y: belt + 0.09, z: dashBack - 0.02 },
      { x: cx - 0.27, y: belt + 0.09, z: dashBack + 0.3 },
      { x: cx + 0.27, y: belt + 0.09, z: dashBack + 0.3 }
    );
    // centre stack & console
    mb.setColor(mid);
    mb.box(-0.16, 0.16, belt - 0.62, belt - 0.05, dashBack - 0.05, dashBack + 0.2);
    mb.setColor(dark);
    mb.box(-0.13, 0.13, 0.35, belt - 0.5, dashBack - 0.85, dashBack - 0.05);
    // air vents
    mb.setColor('#0d0f11');
    for (const vx of [-0.62, -0.1, 0.1, 0.62]) mb.box(vx - 0.07, vx + 0.07, belt - 0.14, belt - 0.07, dashBack - 0.012, dashBack + 0.01);
    // glovebox line
    mb.setColor('#15171a');
    mb.box(-0.62, -0.2, belt - 0.26, belt - 0.25, dashBack - 0.008, dashBack);

    // ——— Doors ———
    for (const sx of [-1, 1]) {
      const x = sx * (W - 0.1);
      mb.setColor(mid);
      mb.box(Math.min(x, x + sx * 0.06), Math.max(x, x + sx * 0.06), 0.35, belt, rearBase[0] - 0.2, dashFront);
      // window sill / beltline trim
      mb.setColor(light);
      mb.box(Math.min(x - sx * 0.08, x), Math.max(x - sx * 0.08, x), belt - 0.03, belt + 0.01, rearBase[0] - 0.2, dashFront);
      // armrest
      mb.setColor(dark);
      mb.box(Math.min(x - sx * 0.12, x), Math.max(x - sx * 0.12, x), belt - 0.26, belt - 0.2, dashBack - 0.85, dashBack - 0.25);
    }

    // ——— Pillars & roof ———
    const pillar = (p0: [number, number], p1: [number, number], x: number, thick: number) => {
      const dz = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const len = Math.hypot(dz, dy);
      const g = new THREE.BoxGeometry(0.07, len + 0.04, thick);
      const m = new THREE.Matrix4()
        .makeTranslation(x, (p0[1] + p1[1]) / 2, (p0[0] + p1[0]) / 2)
        .multiply(new THREE.Matrix4().makeRotationX(Math.atan2(dz, dy)));
      mb.geometry(g, m);
    };
    mb.setColor(headliner);
    for (const sx of [-1, 1]) {
      pillar(wsBase, wsTop, sx * (innerW + 0.01), 0.1); // A
      pillar(roofRear, rearBase, sx * (innerW + 0.01), 0.22); // C
      // B pillar
      const bz = (wsBase[0] + rearBase[0]) / 2 + 0.05;
      mb.box(sx * innerW - 0.05, sx * innerW + 0.05, belt, roofY, bz - 0.08, bz + 0.08);
    }
    // headliner
    mb.box(-innerW - 0.02, innerW + 0.02, roofY, roofY + 0.03, roofRear[0] - 0.05, wsTop[0] + 0.02);
    // windshield top trim + sun visors
    mb.setColor('#bdb7ae');
    for (const sx of [-1, 1]) {
      const vx = sx * 0.36;
      mb.box(vx - 0.2, vx + 0.2, roofY - 0.04, roofY - 0.01, wsTop[0] - 0.25, wsTop[0] - 0.02);
    }

    // ——— Seats ———
    const seat = (x: number, z: number, w = 0.5) => {
      mb.setColor('#2a2d31');
      mb.box(x - w / 2, x + w / 2, 0.35, 0.52, z - 0.25, z + 0.25);
      mb.box(x - w / 2, x + w / 2, 0.5, 1.12, z - 0.34, z - 0.22);
      mb.setColor('#25272a');
      mb.box(x - 0.12, x + 0.12, 1.14, 1.3, z - 0.34, z - 0.26);
    };
    seat(-0.36, this.eye.z - 0.05);
    seat(0.36, this.eye.z - 0.05);
    // rear bench
    mb.setColor('#2a2d31');
    mb.box(-innerW + 0.05, innerW - 0.05, 0.35, 0.5, rearBase[0] + 0.1, rearBase[0] + 0.62);
    mb.box(-innerW + 0.05, innerW - 0.05, 0.5, 1.02, rearBase[0] - 0.02, rearBase[0] + 0.1);
    // floor
    mb.setColor('#141517');
    mb.box(-innerW, innerW, 0.3, 0.34, rearBase[0] - 0.2, dashFront);

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    const shell = mb.toMesh(mat, { receive: true });
    this.group.add(shell);

    // Bonnet as seen from the driver's seat (the exterior body is not drawn in interior views)
    if (paint) {
      const hb = new MeshBuilder();
      const hw = W - 0.14;
      const zFront = dims.length / 2 - 0.22;
      const yFront = wsBase[1] - 0.14;
      hb.quad({ x: hw, y: wsBase[1] - 0.005, z: wsBase[0] + 0.02 }, { x: -hw, y: wsBase[1] - 0.005, z: wsBase[0] + 0.02 }, { x: -hw + 0.06, y: yFront, z: zFront }, { x: hw - 0.06, y: yFront, z: zFront });
      // wing tops curving down at the sides
      for (const sx of [-1, 1]) {
        hb.quad(
          { x: sx * hw, y: wsBase[1] - 0.005, z: wsBase[0] + 0.02 },
          { x: sx * (hw - 0.06), y: yFront, z: zFront },
          { x: sx * (W + 0.02), y: yFront - 0.12, z: zFront },
          { x: sx * (W + 0.02), y: wsBase[1] - 0.1, z: wsBase[0] + 0.02 }
        );
      }
      const bonnet = hb.toMesh(paint, { receive: true });
      (bonnet.material as THREE.Material).side = THREE.DoubleSide;
      this.group.add(bonnet);
    }

    // ——— Steering wheel ———
    const wheelPos = new THREE.Vector3(cx, belt - 0.05, dashBack - 0.3);
    this.wheel.position.copy(wheelPos);
    this.wheel.rotation.x = -0.42; // tilt: top toward driver
    const leather = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.6 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.022, 10, 40), leather);
    const spin = new THREE.Group();
    spin.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.05, 20), new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.5, metalness: 0.3 }));
    hub.rotation.x = Math.PI / 2;
    spin.add(hub);
    const logo = new THREE.Mesh(new THREE.CircleGeometry(0.022, 16), new THREE.MeshStandardMaterial({ color: 0xc0c6cc, metalness: 0.9, roughness: 0.25 }));
    logo.position.z = -0.027;
    logo.rotation.y = Math.PI;
    spin.add(logo);
    for (const a of [Math.PI / 2 + 0.25, -Math.PI / 2 - 0.25, Math.PI]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.028, 0.014), leather);
      sp.position.set(Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0);
      sp.rotation.z = a;
      spin.add(sp);
    }
    // top-centre marker stripe helps to read the wheel angle
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.025, 0.05), new THREE.MeshStandardMaterial({ color: 0xd0d4d8 }));
    marker.position.set(0, 0.185, 0);
    spin.add(marker);
    // hands on the wheel (9 & 3 o'clock) — gloves
    const glove = new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.8 });
    for (const sx of [-1, 1]) {
      const hand = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.06, 4, 8), glove);
      hand.position.set(sx * 0.185, 0.0, -0.01);
      hand.rotation.z = Math.PI / 2;
      spin.add(hand);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.36, 8), new THREE.MeshStandardMaterial({ color: 0x3b4a5e, roughness: 0.9 }));
      arm.position.set(sx * 0.2, -0.03, -0.2);
      arm.rotation.x = Math.PI / 2 - 0.3;
      spin.add(arm);
    }
    spin.name = 'spin';
    this.wheel.add(spin);
    // column
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0x1b1c1f }));
    column.rotation.x = Math.PI / 2;
    column.position.z = 0.16;
    this.wheel.add(column);
    // indicator stalk (left of column)
    const stalkMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.16, 6), new THREE.MeshStandardMaterial({ color: 0x222428 }));
    stalkMesh.rotation.z = Math.PI / 2;
    stalkMesh.position.x = 0.08;
    this.stalk.add(stalkMesh);
    this.stalk.position.set(0.05, 0.02, 0.1);
    this.wheel.add(this.stalk);
    this.group.add(this.wheel);

    // ——— Instrument cluster (live canvas) ———
    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.width = 768;
    this.clusterCanvas.height = 288;
    this.clusterTex = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.46, 0.17),
      new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false, color: new THREE.Color(2.3, 2.3, 2.3) })
    );
    cluster.position.set(cx, belt + 0.02, dashBack + 0.2);
    cluster.rotation.set(0.28, Math.PI, 0);
    this.group.add(cluster);

    // ——— Centre screen (navigation) ———
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 512;
    this.screenCanvas.height = 320;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.162), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false, color: new THREE.Color(2.1, 2.1, 2.1) }));
    screen.position.set(0, belt - 0.02, dashBack - 0.06);
    screen.rotation.set(0.32, Math.PI, 0);
    this.group.add(screen);

    // ——— Gear lever & handbrake ———
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 }));
    knob.position.y = 0.15;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.15, 8), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8 }));
    rod.position.y = 0.075;
    this.gearLever.add(knob, rod);
    this.gearLever.position.set(0, belt - 0.5, dashBack - 0.35);
    this.group.add(this.gearLever);
    const hb = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.24), new THREE.MeshStandardMaterial({ color: 0x1d1e20 }));
    hb.position.z = -0.12;
    this.handbrakeLever.add(hb);
    this.handbrakeLever.position.set(0, belt - 0.5, dashBack - 0.62);
    this.group.add(this.handbrakeLever);

    // ——— Mirrors ———
    const mirrorGlass = (w: number, h: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x223040 }));
      const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // mirror-reversed image
      return m;
    };
    const housing = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 });
    // rear-view mirror
    const rearPos = new THREE.Vector3(0, roofY - 0.13, wsTop[0] - 0.12);
    const rearBody = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.085, 0.035), housing);
    rearBody.position.copy(rearPos);
    rearBody.rotation.y = -0.22;
    const rearGlass = mirrorGlass(0.25, 0.07);
    rearGlass.position.set(0, 0, -0.019);
    rearGlass.rotation.y = Math.PI;
    rearBody.add(rearGlass);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.1), housing);
    stem.position.set(rearPos.x, roofY - 0.06, rearPos.z);
    this.group.add(rearBody, stem);
    // side mirrors (outside, visible through the side windows)
    const sidePos = (sx: number) => new THREE.Vector3(sx * (W + 0.1), belt + 0.08, wsBase[0] - 0.28);
    const sideMirror = (sx: number) => {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.08), housing);
      const p = sidePos(sx);
      body.position.copy(p);
      body.rotation.y = sx > 0 ? 0.45 : -0.75;
      const g = mirrorGlass(0.18, 0.11);
      g.position.set(0, 0, -0.041);
      g.rotation.y = Math.PI;
      body.add(g);
      this.group.add(body);
      return g;
    };
    const leftGlass = sideMirror(1);
    const rightGlass = sideMirror(-1);
    this.mirrorPlanes = { left: leftGlass, right: rightGlass, rear: rearGlass };
    this.mirrorAnchors = { left: sidePos(1), right: sidePos(-1), rear: new THREE.Vector3(0, roofY - 0.1, rearBase[0] + 0.1) };

    // ——— Wipers & windshield film (rain) ———
    this.rainCanvas = document.createElement('canvas');
    this.rainCanvas.width = 256;
    this.rainCanvas.height = 128;
    this.rainTex = new THREE.CanvasTexture(this.rainCanvas);
    const wsLen = Math.hypot(wsTop[0] - wsBase[0], wsTop[1] - wsBase[1]);
    const ws = new THREE.Mesh(
      new THREE.PlaneGeometry(innerW * 2 + 0.1, wsLen),
      new THREE.MeshBasicMaterial({ map: this.rainTex, transparent: true, depthWrite: false, opacity: 0.9 })
    );
    ws.position.set(0, (wsBase[1] + wsTop[1]) / 2, (wsBase[0] + wsTop[0]) / 2 - 0.03);
    ws.rotation.set(Math.atan2(wsTop[0] - wsBase[0], wsTop[1] - wsBase[1]), Math.PI, 0);
    ws.visible = false;
    this.windshield = ws;
    this.group.add(ws);
    const wiperMat = new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.6 });
    this.wsTilt = Math.atan2(wsTop[0] - wsBase[0], wsTop[1] - wsBase[1]);
    for (const [grp, x] of [[this.wiperL, 0.58], [this.wiperR, -0.02]] as const) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.6, 0.018), wiperMat);
      blade.position.y = 0.3;
      grp.add(blade);
      grp.position.set(x, wsBase[1] + 0.03, wsBase[0] + 0.02);
      grp.rotation.set(this.wsTilt, 0, Math.PI / 2);
      this.group.add(grp);
    }

    this.group.traverse((o) => {
      o.layers.set(LAYER_INTERIOR);
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = true;
      }
    });
    this.drawScreenIdle();
  }

  private wsTilt = 0;

  setMirrorTextures(left: THREE.Texture | null, right: THREE.Texture | null, rear: THREE.Texture | null) {
    const set = (m: THREE.Mesh, t: THREE.Texture | null) => {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map = t;
      if (t) mat.color.setRGB(1.9, 1.95, 2.0);
      else mat.color.set(0x223040);
      mat.needsUpdate = true;
    };
    set(this.mirrorPlanes.left, left);
    set(this.mirrorPlanes.right, right);
    set(this.mirrorPlanes.rear, rear);
  }

  /** Provide a callback that draws the navigation map on the centre screen. */
  setScreenMapDrawer(fn: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null) {
    this.screenMap = fn;
  }

  update(s: CockpitState, dt: number, rain: number) {
    const spin = this.wheel.getObjectByName('spin')!;
    spin.rotation.z = s.wheelAngle;
    this.stalk.rotation.z = s.signalL ? 0.18 : s.signalR ? -0.18 : 0;
    this.gearLever.position.z = this.gearLever.userData.z0 ?? this.gearLever.position.z;
    this.gearLever.userData.z0 = this.gearLever.userData.z0 ?? this.gearLever.position.z;
    const off = s.gearLabel === 'P' ? 0.06 : s.gearLabel === 'R' ? 0.03 : s.gearLabel === 'N' ? 0 : -0.03;
    this.gearLever.position.z = this.gearLever.userData.z0 + off;
    this.handbrakeLever.rotation.x = s.handbrake ? -0.35 : 0;

    const now = performance.now();
    if (now - this.lastDraw > 45) {
      this.lastDraw = now;
      this.drawCluster(s);
      this.drawScreen(s);
    }
    this.updateRain(dt, rain, s.wipers, s.kmh);
  }

  private drawCluster(s: CockpitState) {
    const c = this.clusterCanvas;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, W, H);
    const dial = (cx: number, cy: number, r: number, value: number, max: number, label: string, ticks: number, red?: number) => {
      const a0 = Math.PI * 0.75;
      const a1 = Math.PI * 2.25;
      g.lineWidth = 3;
      g.strokeStyle = '#2b3542';
      g.beginPath();
      g.arc(cx, cy, r, a0, a1);
      g.stroke();
      if (red) {
        g.strokeStyle = '#c62828';
        g.lineWidth = 6;
        g.beginPath();
        g.arc(cx, cy, r - 4, a0 + (a1 - a0) * (red / max), a1);
        g.stroke();
      }
      g.fillStyle = '#c9d6e3';
      g.font = '600 17px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i <= ticks; i++) {
        const a = a0 + ((a1 - a0) * i) / ticks;
        g.strokeStyle = '#9fb2c6';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
        g.lineTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14));
        g.stroke();
        g.fillText(String(Math.round((max / ticks) * i * (label === 'x1000' ? 0.001 : 1))), cx + Math.cos(a) * (r - 30), cy + Math.sin(a) * (r - 30));
      }
      const va = a0 + (a1 - a0) * Math.min(1.02, value / max);
      g.strokeStyle = '#ff5a36';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(va) * (r - 8), cy + Math.sin(va) * (r - 8));
      g.stroke();
      g.fillStyle = '#1b2430';
      g.beginPath();
      g.arc(cx, cy, 10, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#7f93a8';
      g.font = '600 14px system-ui, sans-serif';
      g.fillText(label, cx, cy + r * 0.45);
    };
    dial(150, 150, 125, s.rpm, 8000, 'x1000', 8, s.redline);
    dial(W - 150, 150, 125, s.kmh, 200, 'km/h', 10);
    // centre display
    g.fillStyle = '#0c131b';
    g.fillRect(300, 30, 168, 230);
    g.fillStyle = '#eaf2fb';
    g.font = '700 64px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(Math.round(s.kmh)), 384, 105);
    g.font = '600 18px system-ui, sans-serif';
    g.fillStyle = '#8fa4b8';
    g.fillText('km/h', 384, 145);
    g.font = '800 40px system-ui, sans-serif';
    g.fillStyle = s.gearLabel === 'R' ? '#ffb347' : '#6fe3a2';
    g.fillText(s.gearLabel, 384, 195);
    // speed limit roundel
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(384, 238, 18, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#d32f2f';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = '#111';
    g.font = '800 16px system-ui, sans-serif';
    g.fillText(String(s.limit), 384, 239);
    // telltales
    const arrow = (x: number, dir: number, on: boolean) => {
      g.fillStyle = on ? '#39e36b' : '#1b2a20';
      g.beginPath();
      g.moveTo(x + dir * 22, 28);
      g.lineTo(x, 12);
      g.lineTo(x, 22);
      g.lineTo(x - dir * 16, 22);
      g.lineTo(x - dir * 16, 34);
      g.lineTo(x, 34);
      g.lineTo(x, 44);
      g.closePath();
      g.fill();
    };
    arrow(250, -1, s.signalL && s.blinkOn);
    arrow(W - 250, 1, s.signalR && s.blinkOn);
    g.fillStyle = s.lights ? '#3fa0ff' : '#18222e';
    g.font = '700 16px system-ui, sans-serif';
    g.fillText('◐ FAR', 384, 18);
    if (s.handbrake) {
      g.fillStyle = '#ff4040';
      g.fillText('(P) EL FRENİ', 384, 275);
    }
    g.fillStyle = '#6a7d90';
    g.font = '500 14px system-ui, sans-serif';
    g.fillText(`${s.odometerKm.toFixed(1)} km`, 150, 262);
    g.fillText(`${s.clock}  ${s.temp}`, W - 150, 262);
    this.clusterTex.needsUpdate = true;
  }

  private drawScreenIdle() {
    const g = this.screenCanvas.getContext('2d')!;
    g.fillStyle = '#0b1118';
    g.fillRect(0, 0, 512, 320);
    this.screenTex.needsUpdate = true;
  }

  private drawScreen(s: CockpitState) {
    const c = this.screenCanvas;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b1118';
    g.fillRect(0, 0, c.width, c.height);
    if (this.screenMap) {
      g.save();
      this.screenMap(g, c.width, c.height);
      g.restore();
    }
    // top bar
    g.fillStyle = 'rgba(8,12,18,0.85)';
    g.fillRect(0, 0, c.width, 64);
    if (s.navText) {
      g.fillStyle = '#2d8cff';
      g.fillRect(8, 8, 48, 48);
      g.fillStyle = '#fff';
      g.font = '800 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.navArrow === 'L' ? '↰' : s.navArrow === 'R' ? '↱' : s.navArrow === 'U' ? '⮌' : '↑', 32, 34);
      g.textAlign = 'left';
      g.font = '700 26px system-ui, sans-serif';
      g.fillText(s.navDist, 68, 24);
      g.font = '500 18px system-ui, sans-serif';
      g.fillStyle = '#b8c7d6';
      g.fillText(s.navText.slice(0, 34), 68, 48);
    } else {
      g.fillStyle = '#8aa0b5';
      g.font = '600 20px system-ui, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText('Sürüş Koçu • Navigasyon', 16, 32);
    }
    this.screenTex.needsUpdate = true;
  }

  private updateRain(dt: number, rain: number, wipers: number, kmh: number) {
    this.windshield.visible = rain > 0.02;
    // wiper sweep
    const active = wipers > 0;
    if (active) this.wiperPhase += dt * (wipers > 1 ? 2.2 : 1.3);
    const sweep = active ? (1 - Math.cos(this.wiperPhase * Math.PI)) / 2 : 0;
    for (const w of [this.wiperL, this.wiperR]) w.rotation.z = Math.PI / 2 - sweep * 1.65;
    if (!this.windshield.visible) return;
    const g = this.rainCanvas.getContext('2d')!;
    // add drops
    const rate = rain * (40 + kmh * 0.8) * dt;
    for (let i = 0; i < rate; i++) {
      this.drops.push({ x: Math.random() * 256, y: Math.random() * 128, r: 0.8 + Math.random() * 2.2, age: 0 });
    }
    if (this.drops.length > 700) this.drops.splice(0, this.drops.length - 700);
    // wiper clears a band that follows the blade angle
    if (active) {
      const ang = sweep * 1.7;
      const cx = 256 * 0.25;
      this.drops = this.drops.filter((d) => {
        const a = Math.atan2(128 - d.y, d.x - cx);
        return Math.abs(a - (Math.PI - 0.12 - ang)) > 0.25 || Math.random() < 0.02;
      });
    }
    g.clearRect(0, 0, 256, 128);
    for (const d of this.drops) {
      d.age += dt;
      if (kmh > 30) d.y -= kmh * 0.02 * dt * 60 * 0.1;
      g.fillStyle = 'rgba(210,225,240,0.35)';
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(d.x - d.r * 0.3, d.y - d.r * 0.4, d.r * 0.4, d.r * 0.4);
    }
    this.drops = this.drops.filter((d) => d.y > -5);
    this.rainTex.needsUpdate = true;
  }
}
