import * as THREE from 'three';
import { MeshBuilder } from '../world/meshBuilder';

export type CarType =
  | 'hatch'
  | 'sedan'
  | 'suv'
  | 'van'
  | 'taxi'
  | 'bus'
  | 'truck'
  | 'wagon'
  | 'pickup'
  | 'minibus'
  | 'police'
  | 'ambulance'
  | 'tir'
  | 'trailer'
  | 'moto';
export const CAR_TYPES: CarType[] = ['hatch', 'sedan', 'suv', 'van', 'taxi', 'bus', 'truck', 'wagon', 'pickup', 'minibus', 'police', 'ambulance', 'tir', 'trailer', 'moto'];

/** Tractor + semi-trailer rig: overall length and where each part sits relative to the rig centre. */
export const TIR_RIG = { length: 16.4, width: 2.5, tractorOffset: 16.4 / 2 - 3.1, trailerOffset: -16.4 / 2 + 6.8 };

export type CarDims = {
  length: number;
  width: number;
  height: number;
  wheelBase: number;
  wheelRadius: number;
  track: number;
  /** z of front / rear axle (local, forward = +z) */
  frontAxle: number;
  rearAxle: number;
};

export type WheelSpec = { x: number; y: number; z: number; r: number; w: number; front: boolean };

export type CarParts = {
  paint: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  indL: THREE.BufferGeometry;
  indR: THREE.BufferGeometry;
  /** Wheels baked (for instanced / static use). */
  wheelsBaked: THREE.BufferGeometry;
  /** Single wheel centred at origin, axle along X (for animated player wheels). */
  wheel: THREE.BufferGeometry;
  wheels: WheelSpec[];
  dims: CarDims;
  /** Emergency beacons (two alternating groups), if any. */
  beaconA?: THREE.BufferGeometry;
  beaconB?: THREE.BufferGeometry;
};

type P2 = [number, number];

/** Side profile (z forward, y up) extruded across the width, returned in car space. */
function extrudeProfile(points: P2[], width: number, bevel = 0.07, segs = 2): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: segs,
    curveSegments: 4,
  });
  g.rotateY(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

/** Bottom edge with semicircular wheel-arch cut-outs, from rear to front. */
function archedBottom(zRear: number, zFront: number, y: number, arches: { z: number; r: number }[]): P2[] {
  const pts: P2[] = [[zRear, y]];
  for (const a of [...arches].sort((p, q) => p.z - q.z)) {
    pts.push([a.z - a.r, y]);
    for (let i = 1; i < 8; i++) {
      const t = Math.PI - (i / 8) * Math.PI;
      pts.push([a.z + Math.cos(t) * a.r, y + Math.sin(t) * a.r * 0.92]);
    }
    pts.push([a.z + a.r, y]);
  }
  pts.push([zFront, y]);
  return pts;
}

function wheelGeometry(r: number, w: number): { tire: THREE.BufferGeometry; rim: THREE.BufferGeometry } {
  const tire = new THREE.CylinderGeometry(r, r, w, 18, 1, false);
  tire.rotateZ(Math.PI / 2);
  // sidewall bulge ring
  const side = new THREE.TorusGeometry(r * 0.82, w * 0.3, 6, 18);
  side.rotateY(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 16);
  rim.rotateZ(Math.PI / 2);
  const mb = new MeshBuilder();
  mb.geometry(tire, new THREE.Matrix4());
  mb.geometry(side, new THREE.Matrix4().makeTranslation(w * 0.18, 0, 0));
  mb.geometry(side, new THREE.Matrix4().makeTranslation(-w * 0.18, 0, 0));
  const tg = mb.build();
  const rb = new MeshBuilder();
  rb.geometry(rim, new THREE.Matrix4());
  // spokes
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(w + 0.04, r * 0.5, r * 0.11);
    spoke.translate(0, r * 0.3, 0);
    rb.geometry(spoke, new THREE.Matrix4().makeRotationX(a));
  }
  return { tire: tg, rim: rb.build() };
}

/** Z of the profile outline at height y (front = max z, rear = min z). */
function surfaceZ(profile: P2[], y: number, front: boolean): number {
  let best = front ? -Infinity : Infinity;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    if (a[1] === b[1]) continue;
    if ((a[1] - y) * (b[1] - y) > 0) continue;
    const t = (y - a[1]) / (b[1] - a[1]);
    const z = a[0] + t * (b[0] - a[0]);
    best = front ? Math.max(best, z) : Math.min(best, z);
  }
  return best;
}

function lightBox(mb: MeshBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0) {
  mb.orientedBox(x, y, z, sx, sy, sz, rotY);
}

type Spec = {
  dims: Omit<CarDims, 'track' | 'frontAxle' | 'rearAxle'>;
  body: (d: CarDims) => P2[];
  cabin: ((d: CarDims) => P2[]) | null;
  roof: ((d: CarDims) => P2[]) | null;
  groundY: number;
  cabinInset: number;
  axleBias?: number;
};

const SPECS: Record<'hatch' | 'sedan' | 'suv' | 'wagon', Spec> = {
  hatch: {
    dims: { length: 4.05, width: 1.76, height: 1.48, wheelBase: 2.55, wheelRadius: 0.31 },
    groundY: 0.27,
    cabinInset: 0.12,
    body: (d) => {
      const L = d.length / 2;
      return [
        ...archedBottom(-L + 0.1, L - 0.1, 0.27, [
          { z: d.rearAxle, r: d.wheelRadius + 0.15 },
          { z: d.frontAxle, r: d.wheelRadius + 0.15 },
        ]),
        [L, 0.4],
        [L + 0.02, 0.6],
        [L - 0.2, 0.76],
        [L - 1.05, 0.9],
        [-L + 0.22, 0.98],
        [-L + 0.05, 0.9],
        [-L, 0.6],
        [-L + 0.02, 0.38],
      ];
    },
    cabin: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.02, 0.89],
        [L - 1.85, 1.39],
        [-L + 0.42, 1.42],
        [-L + 0.14, 0.97],
      ];
    },
    roof: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.8, 1.38],
        [L - 1.95, 1.46],
        [-L + 0.5, 1.48],
        [-L + 0.34, 1.41],
      ];
    },
  },
  sedan: {
    dims: { length: 4.55, width: 1.8, height: 1.45, wheelBase: 2.68, wheelRadius: 0.32 },
    groundY: 0.28,
    cabinInset: 0.12,
    body: (d) => {
      const L = d.length / 2;
      return [
        ...archedBottom(-L + 0.1, L - 0.1, 0.28, [
          { z: d.rearAxle, r: d.wheelRadius + 0.15 },
          { z: d.frontAxle, r: d.wheelRadius + 0.15 },
        ]),
        [L, 0.42],
        [L + 0.02, 0.62],
        [L - 0.25, 0.77],
        [L - 1.25, 0.9],
        [-L + 0.95, 0.96],
        [-L + 0.12, 0.93],
        [-L, 0.7],
        [-L + 0.02, 0.4],
      ];
    },
    cabin: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.22, 0.89],
        [L - 2.02, 1.37],
        [-L + 1.42, 1.39],
        [-L + 0.88, 0.95],
      ];
    },
    roof: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.97, 1.36],
        [L - 2.1, 1.43],
        [-L + 1.5, 1.45],
        [-L + 1.36, 1.38],
      ];
    },
  },
  suv: {
    dims: { length: 4.6, width: 1.88, height: 1.72, wheelBase: 2.72, wheelRadius: 0.37 },
    groundY: 0.4,
    cabinInset: 0.12,
    body: (d) => {
      const L = d.length / 2;
      return [
        ...archedBottom(-L + 0.1, L - 0.12, 0.4, [
          { z: d.rearAxle, r: d.wheelRadius + 0.16 },
          { z: d.frontAxle, r: d.wheelRadius + 0.16 },
        ]),
        [L, 0.55],
        [L + 0.02, 0.8],
        [L - 0.2, 0.98],
        [L - 1.05, 1.1],
        [-L + 0.12, 1.14],
        [-L, 0.95],
        [-L + 0.02, 0.5],
      ];
    },
    cabin: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.02, 1.09],
        [L - 1.75, 1.62],
        [-L + 0.25, 1.64],
        [-L + 0.08, 1.13],
      ];
    },
    roof: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.7, 1.61],
        [L - 1.85, 1.69],
        [-L + 0.22, 1.71],
        [-L + 0.14, 1.63],
      ];
    },
  },
  wagon: {
    dims: { length: 4.7, width: 1.8, height: 1.5, wheelBase: 2.72, wheelRadius: 0.32 },
    groundY: 0.28,
    cabinInset: 0.12,
    body: (d) => {
      const L = d.length / 2;
      return [
        ...archedBottom(-L + 0.1, L - 0.1, 0.28, [
          { z: d.rearAxle, r: d.wheelRadius + 0.15 },
          { z: d.frontAxle, r: d.wheelRadius + 0.15 },
        ]),
        [L, 0.42],
        [L + 0.02, 0.62],
        [L - 0.25, 0.77],
        [L - 1.2, 0.9],
        [-L + 0.2, 0.98],
        [-L + 0.04, 0.9],
        [-L, 0.6],
        [-L + 0.02, 0.4],
      ];
    },
    cabin: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.18, 0.89],
        [L - 1.98, 1.4],
        [-L + 0.3, 1.43],
        [-L + 0.1, 0.97],
      ];
    },
    roof: (d) => {
      const L = d.length / 2;
      return [
        [L - 1.93, 1.39],
        [L - 2.08, 1.47],
        [-L + 0.36, 1.5],
        [-L + 0.2, 1.42],
      ];
    },
  },
};

export const PALETTE = [
  '#f4f5f7', '#f4f5f7', '#e8e9eb', '#b8bcc2', '#9aa0a6', '#5d6166', '#2b2d31', '#16181b',
  '#1f3a64', '#27496d', '#8f1d21', '#b3262b', '#d9d2c3', '#6f5a45', '#2f5a3a', '#3e6fa3', '#c9a227',
];

function withAxles(d: Spec['dims'], bias = 0.02): CarDims {
  const center = -bias;
  return {
    ...d,
    track: d.width - 0.26,
    frontAxle: center + d.wheelBase / 2,
    rearAxle: center - d.wheelBase / 2,
  };
}

/** Shared bits: bumpers, grille, lights, mirrors, plates. `fz`/`rz` give the body surface z at height y. */
function commonDetails(
  d: CarDims,
  trim: MeshBuilder,
  head: MeshBuilder,
  tail: MeshBuilder,
  indL: MeshBuilder,
  indR: MeshBuilder,
  paint: MeshBuilder,
  o: { noseY: number; tailY: number; mirrorY: number; mirrorZ: number; lowerY: number; fz: (y: number) => number; rz: (y: number) => number }
) {
  const W = d.width / 2;
  const bumperY = o.lowerY + 0.1;
  // bumpers / lower cladding
  trim.setColor('#1b1d20');
  trim.orientedBox(0, bumperY, o.fz(bumperY) - 0.05, d.width - 0.24, 0.2, 0.14);
  trim.orientedBox(0, bumperY, o.rz(bumperY) + 0.05, d.width - 0.24, 0.2, 0.14);
  // grille
  trim.setColor('#111316');
  const gy = o.noseY - 0.1;
  trim.orientedBox(0, gy, o.fz(gy) - 0.02, d.width * 0.42, 0.16, 0.06);
  // licence plates (TR style: blue band on the left)
  const py = o.lowerY + 0.26;
  const ry = o.tailY - 0.2;
  trim.setColor('#f2f2f2');
  trim.orientedBox(0, py, o.fz(py) + 0.005, 0.52, 0.12, 0.02);
  trim.orientedBox(0, ry, o.rz(ry) - 0.005, 0.52, 0.12, 0.02);
  trim.setColor('#1d4fa3');
  trim.orientedBox(0.22, py, o.fz(py) + 0.012, 0.06, 0.11, 0.01);
  trim.orientedBox(-0.22, ry, o.rz(ry) - 0.012, 0.06, 0.11, 0.01);
  const hz = o.fz(o.noseY);
  const tz = o.rz(o.tailY);
  for (const sx of [-1, 1]) {
    lightBox(head, sx * (W - 0.32), o.noseY, hz - 0.03, 0.36, 0.12, 0.1);
    lightBox(tail, sx * (W - 0.28), o.tailY, tz + 0.03, 0.42, 0.13, 0.08);
    const ind = sx > 0 ? indL : indR; // +x is the car's left
    lightBox(ind, sx * (W - 0.1), o.noseY - 0.02, hz - 0.07, 0.08, 0.08, 0.14);
    lightBox(ind, sx * (W - 0.08), o.tailY + 0.1, tz + 0.06, 0.08, 0.06, 0.12);
    // side repeater
    lightBox(ind, sx * (W + 0.005), o.noseY + 0.08, hz - 0.75, 0.02, 0.04, 0.1);
    // mirrors
    paint.orientedBox(sx * (W + 0.1), o.mirrorY, o.mirrorZ, 0.22, 0.13, 0.12);
    trim.setColor('#15171a');
    trim.orientedBox(sx * (W + 0.02), o.mirrorY - 0.04, o.mirrorZ + 0.02, 0.1, 0.05, 0.08);
  }
  // door handles
  trim.setColor('#15171a');
  for (const sx of [-1, 1]) {
    trim.orientedBox(sx * (W + 0.005), o.mirrorY - 0.2, o.mirrorZ - 0.55, 0.02, 0.03, 0.14);
    trim.orientedBox(sx * (W + 0.005), o.mirrorY - 0.2, o.mirrorZ - 1.45, 0.02, 0.03, 0.14);
  }
}

function assemble(
  d: CarDims,
  paint: MeshBuilder,
  trim: MeshBuilder,
  glass: MeshBuilder,
  head: MeshBuilder,
  tail: MeshBuilder,
  indL: MeshBuilder,
  indR: MeshBuilder,
  wheelWidth = 0.22
): CarParts {
  const { tire, rim } = wheelGeometry(d.wheelRadius, wheelWidth);
  const wheels: WheelSpec[] = [];
  for (const z of [d.frontAxle, d.rearAxle]) {
    for (const sx of [-1, 1]) wheels.push({ x: sx * (d.track / 2), y: d.wheelRadius, z, r: d.wheelRadius, w: wheelWidth, front: z === d.frontAxle });
  }
  // Low-poly wheel for instanced traffic / parked cars (far fewer triangles)
  const lowTire = new THREE.CylinderGeometry(d.wheelRadius, d.wheelRadius, wheelWidth, 10, 1, false);
  lowTire.rotateZ(Math.PI / 2);
  const lowRim = new THREE.CylinderGeometry(d.wheelRadius * 0.6, d.wheelRadius * 0.6, wheelWidth + 0.02, 8, 1, false);
  lowRim.rotateZ(Math.PI / 2);
  const baked = new MeshBuilder();
  const single = new MeshBuilder();
  baked.setColor('#161616');
  single.setColor('#161616');
  single.geometry(tire, new THREE.Matrix4());
  single.setColor('#b9bec4');
  single.geometry(rim, new THREE.Matrix4());
  for (const w of wheels) {
    baked.setColor('#161616');
    baked.geometry(lowTire, new THREE.Matrix4().makeTranslation(w.x, w.y, w.z));
    baked.setColor('#a7adb3');
    baked.geometry(lowRim, new THREE.Matrix4().makeTranslation(w.x, w.y, w.z));
  }
  return {
    paint: paint.build(),
    trim: trim.build(),
    glass: glass.build(),
    head: head.build(),
    tail: tail.build(),
    indL: indL.build(),
    indR: indR.build(),
    wheelsBaked: baked.build(),
    wheel: single.build(),
    wheels,
    dims: d,
  };
}

function buildStandard(type: 'hatch' | 'sedan' | 'suv' | 'taxi' | 'wagon' | 'police'): CarParts {
  const spec = SPECS[type === 'taxi' || type === 'police' ? 'sedan' : type];
  const d = withAxles(spec.dims);
  const paint = new MeshBuilder();
  const trim = new MeshBuilder();
  const glass = new MeshBuilder();
  const head = new MeshBuilder();
  const tail = new MeshBuilder();
  const indL = new MeshBuilder();
  const indR = new MeshBuilder();
  const I = new THREE.Matrix4();
  const bodyProfile = spec.body(d);
  paint.geometry(extrudeProfile(bodyProfile, d.width, 0.08, 3), I);
  if (spec.cabin) glass.geometry(extrudeProfile(spec.cabin(d), d.width - spec.cabinInset * 2 - 0.05, 0.07, 2), I);
  if (spec.roof) paint.geometry(extrudeProfile(spec.roof(d), d.width - spec.cabinInset * 2 - 0.02, 0.05, 2), I);
  // B-pillars
  const cab = spec.cabin!(d);
  const midZ = (cab[0][0] + cab[3][0]) / 2 + 0.05;
  const yLo = Math.min(cab[0][1], cab[3][1]);
  const yHi = Math.max(cab[1][1], cab[2][1]);
  for (const sx of [-1, 1]) {
    paint.orientedBox(sx * (d.width / 2 - spec.cabinInset - 0.015), (yLo + yHi) / 2, midZ, 0.06, yHi - yLo, 0.12);
  }
  // lower door cladding / sills
  trim.setColor('#1c1e21');
  for (const sx of [-1, 1]) trim.orientedBox(sx * (d.width / 2 - 0.02), spec.groundY + 0.06, 0, 0.05, 0.1, d.wheelBase - 0.8);
  const noseY = type === 'suv' ? 0.88 : 0.66;
  const tailY = type === 'suv' ? 1.0 : type === 'hatch' ? 0.84 : 0.82;
  commonDetails(d, trim, head, tail, indL, indR, paint, {
    noseY,
    tailY,
    mirrorY: type === 'suv' ? 1.18 : 0.98,
    mirrorZ: (cab[0][0] + cab[1][0]) / 2 + 0.05,
    lowerY: spec.groundY,
    fz: (y) => surfaceZ(bodyProfile, y, true) + 0.08,
    rz: (y) => surfaceZ(bodyProfile, y, false) - 0.08,
  });
  if (type === 'suv') {
    trim.setColor('#2a2c30');
    for (const sx of [-1, 1]) trim.orientedBox(sx * 0.62, 1.74, -0.2, 0.05, 0.05, 2.2);
  }
  if (type === 'taxi') {
    // TAKSİ roof sign
    trim.setColor('#222222');
    trim.orientedBox(0, 1.47, -0.35, 0.72, 0.04, 0.3);
    head.orientedBox(0, 1.56, -0.35, 0.66, 0.16, 0.24);
    // checker stripe
    trim.setColor('#111111');
    for (const sx of [-1, 1]) trim.orientedBox(sx * (d.width / 2 + 0.003), 0.72, -0.1, 0.01, 0.07, 2.4);
  }
  // third brake light
  if (type === 'sedan' || type === 'taxi' || type === 'police') tail.orientedBox(0, cab[3][1] + 0.06, cab[3][0] + 0.02, 0.3, 0.035, 0.05);
  else tail.orientedBox(0, cab[2][1] - 0.06, cab[2][0] - 0.1, 0.3, 0.035, 0.05);
  if (type === 'wagon') {
    trim.setColor('#2a2c30');
    for (const sx of [-1, 1]) trim.orientedBox(sx * 0.6, 1.52, -0.3, 0.04, 0.04, 2.3);
  }
  let beaconA: THREE.BufferGeometry | undefined;
  let beaconB: THREE.BufferGeometry | undefined;
  if (type === 'police') {
    // blue livery stripe + light bar
    trim.setColor('#0d3b8c');
    for (const sx of [-1, 1]) trim.orientedBox(sx * (d.width / 2 + 0.004), 0.7, 0, 0.012, 0.16, d.length - 0.6);
    trim.setColor('#1a1a1a');
    trim.orientedBox(0, 1.47, -0.25, 1.1, 0.06, 0.32);
    const a = new MeshBuilder();
    const b = new MeshBuilder();
    a.orientedBox(-0.3, 1.55, -0.25, 0.46, 0.12, 0.26);
    b.orientedBox(0.3, 1.55, -0.25, 0.46, 0.12, 0.26);
    a.orientedBox(-0.35, 0.62, d.length / 2 - 0.05, 0.12, 0.06, 0.04);
    b.orientedBox(0.35, 0.62, d.length / 2 - 0.05, 0.12, 0.06, 0.04);
    beaconA = a.build();
    beaconB = b.build();
  }
  const parts = assemble(d, paint, trim, glass, head, tail, indL, indR);
  parts.beaconA = beaconA;
  parts.beaconB = beaconB;
  return parts;
}

function buildVan(): CarParts {
  const d = withAxles({ length: 4.4, width: 1.84, height: 1.88, wheelBase: 2.78, wheelRadius: 0.32 }, -0.05);
  const paint = new MeshBuilder();
  const trim = new MeshBuilder();
  const glass = new MeshBuilder();
  const head = new MeshBuilder();
  const tail = new MeshBuilder();
  const indL = new MeshBuilder();
  const indR = new MeshBuilder();
  const L = d.length / 2;
  const I = new THREE.Matrix4();
  const body: P2[] = [
    ...archedBottom(-L + 0.1, L - 0.1, 0.3, [
      { z: d.rearAxle, r: d.wheelRadius + 0.15 },
      { z: d.frontAxle, r: d.wheelRadius + 0.15 },
    ]),
    [L, 0.45],
    [L + 0.02, 0.72],
    [L - 0.35, 0.98],
    [L - 0.95, 1.05],
    [L - 1.65, 1.84],
    [-L + 0.05, 1.86],
    [-L, 1.7],
    [-L, 0.45],
  ];
  paint.geometry(extrudeProfile(body, d.width, 0.08, 3), I);
  // windshield + front side windows as glass overlays
  const ws: P2[] = [
    [L - 0.97, 1.06],
    [L - 1.62, 1.8],
    [L - 1.7, 1.8],
    [L - 1.05, 1.06],
  ];
  glass.geometry(extrudeProfile(ws, d.width - 0.28, 0.02, 1), new THREE.Matrix4().makeTranslation(0, 0.005, 0.03));
  for (const sx of [-1, 1]) {
    glass.orientedBox(sx * (d.width / 2 + 0.005), 1.42, L - 1.75, 0.02, 0.62, 1.05);
    glass.orientedBox(sx * (d.width / 2 + 0.005), 1.42, L - 2.95, 0.02, 0.5, 0.9);
  }
  glass.orientedBox(0, 1.45, -L - 0.005, d.width - 0.5, 0.55, 0.02);
  commonDetails(d, trim, head, tail, indL, indR, paint, {
    noseY: 0.78,
    tailY: 1.2,
    mirrorY: 1.2,
    mirrorZ: L - 1.2,
    lowerY: 0.3,
    fz: (y) => surfaceZ(body, y, true) + 0.08,
    rz: (y) => surfaceZ(body, y, false) - 0.08,
  });
  // roof rails & side rub strip
  trim.setColor('#1f2124');
  for (const sx of [-1, 1]) {
    trim.orientedBox(sx * (d.width / 2 + 0.01), 0.72, -0.2, 0.03, 0.12, 3.0);
    trim.orientedBox(sx * 0.7, 1.9, -0.4, 0.05, 0.05, 2.4);
  }
  return assemble(d, paint, trim, glass, head, tail, indL, indR);
}

function buildBus(): CarParts {
  const d = withAxles({ length: 12, width: 2.55, height: 3.15, wheelBase: 6.1, wheelRadius: 0.5 }, 0.4);
  const paint = new MeshBuilder();
  const trim = new MeshBuilder();
  const glass = new MeshBuilder();
  const head = new MeshBuilder();
  const tail = new MeshBuilder();
  const indL = new MeshBuilder();
  const indR = new MeshBuilder();
  const L = d.length / 2;
  const W = d.width / 2;
  const I = new THREE.Matrix4();
  const body: P2[] = [
    ...archedBottom(-L + 0.1, L - 0.1, 0.35, [
      { z: d.rearAxle, r: d.wheelRadius + 0.22 },
      { z: d.frontAxle, r: d.wheelRadius + 0.22 },
    ]),
    [L, 0.5],
    [L + 0.02, 1.2],
    [L - 0.05, 3.0],
    [L - 0.35, 3.12],
    [-L + 0.3, 3.12],
    [-L, 3.0],
    [-L, 0.5],
  ];
  paint.geometry(extrudeProfile(body, d.width, 0.12, 3), I);
  // window band
  glass.orientedBox(0, 2.05, 0, d.width + 0.02, 1.2, d.length - 1.6);
  glass.orientedBox(0, 1.95, L + 0.01, d.width - 0.25, 1.9, 0.04);
  glass.orientedBox(0, 2.3, -L - 0.01, d.width - 0.5, 0.8, 0.04);
  // doors (dark)
  trim.setColor('#26313a');
  for (const z of [L - 1.4, 0.2]) trim.orientedBox(-W - 0.01, 1.45, z, 0.03, 2.3, 1.2);
  // roof AC unit
  trim.setColor('#dfe3e6');
  trim.orientedBox(0, 3.25, 0.5, 1.6, 0.26, 3);
  // destination display
  head.orientedBox(0, 2.82, L + 0.03, 1.6, 0.26, 0.02);
  // stripe
  trim.setColor('#c62828');
  for (const sx of [-1, 1]) trim.orientedBox(sx * (W + 0.005), 1.15, 0, 0.01, 0.18, d.length - 0.6);
  for (const sx of [-1, 1]) {
    lightBox(head, sx * (W - 0.3), 0.85, L + 0.01, 0.4, 0.16, 0.06);
    lightBox(tail, sx * (W - 0.2), 1.0, -L - 0.01, 0.22, 0.5, 0.06);
    const ind = sx > 0 ? indL : indR;
    lightBox(ind, sx * (W - 0.1), 1.05, L + 0.01, 0.14, 0.12, 0.06);
    lightBox(ind, sx * (W - 0.2), 1.35, -L - 0.01, 0.2, 0.14, 0.06);
    lightBox(ind, sx * (W + 0.01), 0.9, L - 2.2, 0.02, 0.08, 0.14);
    trim.setColor('#1a1a1a');
    trim.orientedBox(sx * (W + 0.25), 2.4, L - 0.1, 0.06, 0.45, 0.12);
  }
  trim.setColor('#1b1d20');
  trim.orientedBox(0, 0.5, L, d.width - 0.1, 0.3, 0.1);
  trim.orientedBox(0, 0.5, -L, d.width - 0.1, 0.3, 0.1);
  return assemble(d, paint, trim, glass, head, tail, indL, indR, 0.3);
}

function buildTruck(): CarParts {
  const d = withAxles({ length: 6.6, width: 2.2, height: 3.0, wheelBase: 3.9, wheelRadius: 0.45 }, -0.3);
  const paint = new MeshBuilder();
  const trim = new MeshBuilder();
  const glass = new MeshBuilder();
  const head = new MeshBuilder();
  const tail = new MeshBuilder();
  const indL = new MeshBuilder();
  const indR = new MeshBuilder();
  const L = d.length / 2;
  const W = d.width / 2;
  // cab (paint)
  paint.orientedBox(0, 1.55, L - 0.85, d.width, 1.9, 1.7);
  glass.orientedBox(0, 1.95, L + 0.01, d.width - 0.3, 0.8, 0.04);
  for (const sx of [-1, 1]) glass.orientedBox(sx * (W + 0.005), 1.95, L - 0.6, 0.02, 0.7, 0.9);
  // cargo box (white) + chassis
  trim.setColor('#eceff1');
  trim.orientedBox(0, 1.85, -0.9, d.width + 0.05, 2.3, 4.6);
  trim.setColor('#26282b');
  trim.orientedBox(0, 0.6, -0.4, d.width - 0.4, 0.3, d.length - 0.4);
  trim.orientedBox(0, 0.75, L - 0.02, d.width - 0.1, 0.35, 0.12);
  for (const sx of [-1, 1]) {
    lightBox(head, sx * (W - 0.3), 0.95, L + 0.01, 0.34, 0.16, 0.06);
    lightBox(tail, sx * (W - 0.2), 0.8, -L + 0.02, 0.2, 0.3, 0.06);
    const ind = sx > 0 ? indL : indR;
    lightBox(ind, sx * (W - 0.08), 0.95, L + 0.01, 0.12, 0.14, 0.06);
    lightBox(ind, sx * (W - 0.2), 1.12, -L + 0.02, 0.2, 0.12, 0.06);
    trim.setColor('#1a1a1a');
    trim.orientedBox(sx * (W + 0.2), 2.1, L - 0.2, 0.06, 0.4, 0.1);
  }
  return assemble(d, paint, trim, glass, head, tail, indL, indR, 0.3);
}

function builders() {
  return {
    paint: new MeshBuilder(),
    trim: new MeshBuilder(),
    glass: new MeshBuilder(),
    head: new MeshBuilder(),
    tail: new MeshBuilder(),
    indL: new MeshBuilder(),
    indR: new MeshBuilder(),
  };
}

/** Box-bodied van variants: minibus (dolmuş) and ambulance. */
function buildBoxVan(kind: 'minibus' | 'ambulance'): CarParts {
  const amb = kind === 'ambulance';
  const d = withAxles({ length: amb ? 5.9 : 6.4, width: 2.02, height: amb ? 2.65 : 2.55, wheelBase: amb ? 3.6 : 3.9, wheelRadius: 0.36 }, 0.1);
  const { paint, trim, glass, head, tail, indL, indR } = builders();
  const L = d.length / 2;
  const W = d.width / 2;
  const H = d.height;
  const body: P2[] = [
    ...archedBottom(-L + 0.1, L - 0.1, 0.32, [
      { z: d.rearAxle, r: d.wheelRadius + 0.16 },
      { z: d.frontAxle, r: d.wheelRadius + 0.16 },
    ]),
    [L, 0.5],
    [L + 0.02, 0.9],
    [L - 0.25, 1.15],
    [L - 0.9, H - 0.08],
    [L - 1.1, H],
    [-L + 0.1, H],
    [-L, H - 0.1],
    [-L, 0.5],
  ];
  paint.geometry(extrudeProfile(body, d.width, 0.09, 3), new THREE.Matrix4());
  // windshield
  const ws: P2[] = [
    [L - 0.27, 1.18],
    [L - 0.88, H - 0.2],
    [L - 0.96, H - 0.2],
    [L - 0.35, 1.18],
  ];
  glass.geometry(extrudeProfile(ws, d.width - 0.24, 0.02, 1), new THREE.Matrix4().makeTranslation(0, 0.005, 0.04));
  for (const sx of [-1, 1]) {
    glass.orientedBox(sx * (W + 0.005), 1.62, L - 1.2, 0.02, 0.7, 0.9);
    if (!amb) glass.orientedBox(sx * (W + 0.005), 1.68, -0.5, 0.02, 0.62, d.length - 3.2);
    else glass.orientedBox(sx * (W + 0.005), 1.9, -0.9, 0.02, 0.4, 0.9);
  }
  glass.orientedBox(0, 1.8, -L - 0.005, d.width - 0.7, 0.6, 0.02);
  commonDetails(d, trim, head, tail, indL, indR, paint, {
    noseY: 0.82,
    tailY: 1.0,
    mirrorY: 1.75,
    mirrorZ: L - 0.95,
    lowerY: 0.32,
    fz: (y) => surfaceZ(body, y, true) + 0.08,
    rz: (y) => surfaceZ(body, y, false) - 0.08,
  });
  let beaconA: THREE.BufferGeometry | undefined;
  let beaconB: THREE.BufferGeometry | undefined;
  if (amb) {
    // red + yellow reflective bands, light bar and rear beacons
    trim.setColor('#d32f2f');
    for (const sx of [-1, 1]) trim.orientedBox(sx * (W + 0.006), 1.15, -0.3, 0.012, 0.22, d.length - 1.2);
    trim.setColor('#f9c21a');
    for (const sx of [-1, 1]) trim.orientedBox(sx * (W + 0.006), 0.92, -0.3, 0.012, 0.16, d.length - 1.2);
    trim.setColor('#d32f2f');
    trim.orientedBox(0, 1.75, L + 0.005, 0.9, 0.18, 0.02);
    const a = new MeshBuilder();
    const b = new MeshBuilder();
    a.orientedBox(-0.45, H + 0.1, L - 1.3, 0.5, 0.16, 0.3);
    b.orientedBox(0.45, H + 0.1, L - 1.3, 0.5, 0.16, 0.3);
    a.orientedBox(-W + 0.15, H - 0.12, -L + 0.08, 0.18, 0.18, 0.12);
    b.orientedBox(W - 0.15, H - 0.12, -L + 0.08, 0.18, 0.18, 0.12);
    beaconA = a.build();
    beaconB = b.build();
  } else {
    // dolmuş: stripe + roof sign
    trim.setColor('#1f5fa8');
    for (const sx of [-1, 1]) trim.orientedBox(sx * (W + 0.006), 1.12, -0.2, 0.012, 0.14, d.length - 1);
    trim.setColor('#222222');
    trim.orientedBox(0, H + 0.03, L - 1.4, 0.9, 0.06, 0.25);
    head.orientedBox(0, H + 0.14, L - 1.4, 0.84, 0.18, 0.2);
  }
  const parts = assemble(d, paint, trim, glass, head, tail, indL, indR, 0.24);
  parts.beaconA = beaconA;
  parts.beaconB = beaconB;
  return parts;
}

function buildPickup(): CarParts {
  const d = withAxles({ length: 5.3, width: 1.86, height: 1.8, wheelBase: 3.1, wheelRadius: 0.38 }, -0.1);
  const { paint, trim, glass, head, tail, indL, indR } = builders();
  const L = d.length / 2;
  const W = d.width / 2;
  const body: P2[] = [
    ...archedBottom(-L + 0.1, L - 0.1, 0.42, [
      { z: d.rearAxle, r: d.wheelRadius + 0.17 },
      { z: d.frontAxle, r: d.wheelRadius + 0.17 },
    ]),
    [L, 0.58],
    [L + 0.02, 0.9],
    [L - 0.2, 1.08],
    [L - 1.1, 1.14],
    [-L, 1.14],
    [-L, 0.55],
  ];
  paint.geometry(extrudeProfile(body, d.width, 0.08, 3), new THREE.Matrix4());
  // cab
  const cab: P2[] = [
    [L - 1.08, 1.12],
    [L - 1.72, 1.74],
    [-0.35, 1.76],
    [-0.4, 1.12],
  ];
  glass.geometry(extrudeProfile(cab, d.width - 0.26, 0.06, 2), new THREE.Matrix4());
  const roof: P2[] = [
    [L - 1.68, 1.72],
    [L - 1.8, 1.8],
    [-0.36, 1.81],
    [-0.4, 1.73],
  ];
  paint.geometry(extrudeProfile(roof, d.width - 0.22, 0.04, 1), new THREE.Matrix4());
  // bed walls (hollow cargo box)
  trim.setColor('#1d1f22');
  trim.box(-W + 0.12, W - 0.12, 1.1, 1.13, -L + 0.2, -0.45);
  for (const sx of [-1, 1]) paint.orientedBox(sx * (W - 0.05), 1.28, (-L - 0.45) / 2 + 0.05, 0.1, 0.36, L - 0.55);
  paint.orientedBox(0, 1.28, -L + 0.08, d.width - 0.1, 0.36, 0.1);
  commonDetails(d, trim, head, tail, indL, indR, paint, {
    noseY: 0.9,
    tailY: 1.05,
    mirrorY: 1.3,
    mirrorZ: L - 1.3,
    lowerY: 0.42,
    fz: (y) => surfaceZ(body, y, true) + 0.08,
    rz: (y) => surfaceZ(body, y, false) - 0.08,
  });
  return assemble(d, paint, trim, glass, head, tail, indL, indR, 0.26);
}

/** Cab-over tractor unit of an articulated lorry (the trailer is a separate model). */
function buildTractor(): CarParts {
  const d = withAxles({ length: 6.2, width: 2.5, height: 3.6, wheelBase: 3.6, wheelRadius: 0.52 }, 0.2);
  const { paint, trim, glass, head, tail, indL, indR } = builders();
  const L = d.length / 2;
  const W = d.width / 2;
  paint.orientedBox(0, 2.05, L - 1.15, d.width, 2.7, 2.3);
  paint.orientedBox(0, 3.55, L - 1.3, d.width - 0.3, 0.4, 1.9);
  glass.orientedBox(0, 2.6, L + 0.01, d.width - 0.3, 1.0, 0.04);
  for (const sx of [-1, 1]) glass.orientedBox(sx * (W + 0.005), 2.6, L - 0.7, 0.02, 0.8, 0.9);
  trim.setColor('#222428');
  trim.orientedBox(0, 0.85, -0.6, 1.2, 0.35, d.length - 1.2);
  trim.orientedBox(0, 1.2, -L + 1.2, 2.3, 0.12, 1.8); // fifth-wheel plate
  trim.orientedBox(0, 1.0, L + 0.02, d.width - 0.1, 0.5, 0.12);
  trim.setColor('#9aa0a6');
  for (const sx of [-1, 1]) trim.orientedBox(sx * (W - 0.2), 1.2, 0.2, 0.4, 0.6, 1.2); // tanks
  for (const sx of [-1, 1]) {
    lightBox(head, sx * (W - 0.35), 1.15, L + 0.03, 0.4, 0.18, 0.06);
    lightBox(tail, sx * (W - 0.2), 0.95, -L + 0.02, 0.2, 0.3, 0.06);
    const ind = sx > 0 ? indL : indR;
    lightBox(ind, sx * (W - 0.08), 1.15, L + 0.03, 0.12, 0.14, 0.06);
    lightBox(ind, sx * (W - 0.2), 1.3, -L + 0.02, 0.2, 0.12, 0.06);
    trim.setColor('#1a1a1a');
    trim.orientedBox(sx * (W + 0.22), 2.7, L - 0.3, 0.06, 0.5, 0.12);
  }
  // roof marker lights
  for (let i = -2; i <= 2; i++) head.orientedBox(i * 0.35, 3.8, L - 0.45, 0.14, 0.06, 0.06);
  const parts = assemble(d, paint, trim, glass, head, tail, indL, indR, 0.34);
  // dual rear axle look: add a second rear axle to the baked wheels
  return parts;
}

function buildTrailer(): CarParts {
  const d = withAxles({ length: 13.6, width: 2.5, height: 4.0, wheelBase: 8.6, wheelRadius: 0.5 }, 0.0);
  // wheels: rear tandem axles near the back; "front axle" hidden under the kingpin
  d.frontAxle = -3.2;
  d.rearAxle = -5.4;
  const { paint, trim, glass, head, tail, indL, indR } = builders();
  const L = d.length / 2;
  const W = d.width / 2;
  paint.orientedBox(0, 2.55, 0, d.width, 2.8, d.length);
  trim.setColor('#2b2e33');
  trim.orientedBox(0, 1.05, 0, d.width - 0.3, 0.2, d.length - 0.2);
  trim.orientedBox(0, 0.75, -L + 0.2, d.width - 0.2, 0.25, 0.12); // underrun bar
  for (const sx of [-1, 1]) trim.orientedBox(sx * (W - 0.1), 0.72, 1.5, 0.05, 0.3, 5.5); // side guards
  // reflective contour
  trim.setColor('#f6c343');
  for (const sx of [-1, 1]) trim.orientedBox(sx * (W + 0.005), 1.2, 0, 0.012, 0.06, d.length - 0.3);
  trim.setColor('#c62828');
  trim.orientedBox(0, 1.2, -L - 0.005, d.width - 0.2, 0.06, 0.012);
  // rear doors seam
  trim.setColor('#9aa0a6');
  trim.orientedBox(0, 2.55, -L - 0.01, 0.04, 2.6, 0.02);
  for (const sx of [-1, 1]) {
    lightBox(tail, sx * (W - 0.3), 0.95, -L - 0.02, 0.4, 0.16, 0.06);
    const ind = sx > 0 ? indL : indR;
    lightBox(ind, sx * (W - 0.6), 0.95, -L - 0.02, 0.18, 0.16, 0.06);
    lightBox(ind, sx * (W + 0.01), 1.05, 0, 0.02, 0.1, 0.16);
  }
  void glass;
  void head;
  return assemble(d, paint, trim, glass, head, tail, indL, indR, 0.3);
}

/** Motorcycle with rider (courier style). */
function buildMoto(): CarParts {
  const d: CarDims = { length: 2.1, width: 0.8, height: 1.5, wheelBase: 1.4, wheelRadius: 0.31, track: 0, frontAxle: 0.7, rearAxle: -0.7 };
  const { paint, trim, glass, head, tail, indL, indR } = builders();
  paint.orientedBox(0, 0.72, 0.05, 0.34, 0.34, 1.0); // tank / body
  paint.orientedBox(0, 0.8, 0.62, 0.42, 0.42, 0.24); // front fairing
  trim.setColor('#1b1b1b');
  trim.orientedBox(0, 0.86, -0.4, 0.3, 0.12, 0.7); // seat
  trim.orientedBox(0, 0.55, 0, 0.18, 0.2, 1.3); // frame
  trim.orientedBox(0, 1.05, 0.55, 0.62, 0.04, 0.04); // handlebar
  // courier box
  trim.setColor('#e53935');
  trim.orientedBox(0, 1.1, -0.82, 0.46, 0.4, 0.42);
  // rider
  trim.setColor('#263238');
  trim.orientedBox(0, 1.22, -0.2, 0.42, 0.6, 0.28);
  for (const sx of [-1, 1]) trim.orientedBox(sx * 0.18, 0.78, 0.05, 0.12, 0.14, 0.55);
  for (const sx of [-1, 1]) trim.orientedBox(sx * 0.22, 1.25, 0.18, 0.09, 0.09, 0.5);
  const helmet = new THREE.SphereGeometry(0.16, 10, 8);
  trim.setColor('#f5f5f5');
  trim.geometry(helmet, new THREE.Matrix4().makeTranslation(0, 1.66, -0.12));
  glass.orientedBox(0, 1.64, 0.02, 0.22, 0.1, 0.04);
  lightBox(head, 0, 0.92, 0.75, 0.16, 0.12, 0.06);
  lightBox(tail, 0, 0.8, -1.05, 0.14, 0.06, 0.04);
  lightBox(indL, 0.2, 0.92, 0.72, 0.06, 0.05, 0.05);
  lightBox(indR, -0.2, 0.92, 0.72, 0.06, 0.05, 0.05);
  lightBox(indL, 0.16, 0.78, -1.02, 0.06, 0.05, 0.05);
  lightBox(indR, -0.16, 0.78, -1.02, 0.06, 0.05, 0.05);
  const wheels: WheelSpec[] = [
    { x: 0, y: d.wheelRadius, z: d.frontAxle, r: d.wheelRadius, w: 0.12, front: true },
    { x: 0, y: d.wheelRadius, z: d.rearAxle, r: d.wheelRadius, w: 0.14, front: false },
  ];
  const baked = new MeshBuilder();
  const tire = new THREE.CylinderGeometry(d.wheelRadius, d.wheelRadius, 0.13, 12);
  tire.rotateZ(Math.PI / 2);
  baked.setColor('#161616');
  for (const w of wheels) baked.geometry(tire, new THREE.Matrix4().makeTranslation(w.x, w.y, w.z));
  const single = new MeshBuilder();
  single.setColor('#161616');
  single.geometry(tire, new THREE.Matrix4());
  return {
    paint: paint.build(),
    trim: trim.build(),
    glass: glass.build(),
    head: head.build(),
    tail: tail.build(),
    indL: indL.build(),
    indR: indR.build(),
    wheelsBaked: baked.build(),
    wheel: single.build(),
    wheels,
    dims: d,
  };
}

const cache = new Map<CarType, CarParts>();

export function carParts(type: CarType): CarParts {
  let p = cache.get(type);
  if (!p) {
    switch (type) {
      case 'van':
        p = buildVan();
        break;
      case 'bus':
        p = buildBus();
        break;
      case 'truck':
        p = buildTruck();
        break;
      case 'minibus':
      case 'ambulance':
        p = buildBoxVan(type);
        break;
      case 'pickup':
        p = buildPickup();
        break;
      case 'tir':
        p = buildTractor();
        break;
      case 'trailer':
        p = buildTrailer();
        break;
      case 'moto':
        p = buildMoto();
        break;
      default:
        p = buildStandard(type);
    }
    cache.set(type, p);
  }
  return p;
}

export type CarMaterials = {
  paint: THREE.MeshPhysicalMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lights: THREE.MeshBasicMaterial;
  wheel: THREE.MeshStandardMaterial;
};

let sharedMats: CarMaterials | null = null;

export function carMaterials(): CarMaterials {
  if (sharedMats) return sharedMats;
  sharedMats = {
    paint: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.45,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0e161f, metalness: 0.2, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.4 }),
    lights: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    wheel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 }),
  };
  return sharedMats;
}

export type TrafficContext = 'parked' | 'street' | 'arterial' | 'highway' | 'industrial';

/** Weighted vehicle mix for a road context (more lorries on the ring road, taxis/dolmuş downtown). */
export function randomCarType(rng: () => number, ctx: TrafficContext | boolean): CarType {
  const c: TrafficContext = typeof ctx === 'boolean' ? (ctx ? 'arterial' : 'parked') : ctx;
  const table: [CarType, number][] =
    c === 'parked'
      ? [['hatch', 30], ['sedan', 28], ['suv', 14], ['wagon', 8], ['van', 9], ['pickup', 5], ['taxi', 5], ['minibus', 1]]
      : c === 'highway'
        ? [['hatch', 16], ['sedan', 22], ['suv', 14], ['wagon', 8], ['van', 8], ['pickup', 6], ['truck', 7], ['tir', 12], ['bus', 3], ['minibus', 2], ['police', 1], ['moto', 1]]
        : c === 'industrial'
          ? [['hatch', 14], ['sedan', 14], ['van', 14], ['pickup', 14], ['truck', 18], ['tir', 10], ['suv', 8], ['moto', 4], ['minibus', 4]]
          : c === 'arterial'
            ? [['hatch', 22], ['sedan', 22], ['suv', 12], ['wagon', 6], ['van', 8], ['taxi', 10], ['minibus', 6], ['bus', 4], ['truck', 3], ['pickup', 3], ['police', 1.2], ['moto', 5]]
            : [['hatch', 28], ['sedan', 24], ['suv', 12], ['wagon', 6], ['van', 8], ['taxi', 9], ['pickup', 3], ['police', 0.8], ['moto', 7], ['minibus', 2]];
  const total = table.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [t, w] of table) {
    r -= w;
    if (r <= 0) return t;
  }
  return 'sedan';
}

/** Footprint used for traffic spacing / collisions (a lorry rig counts as one long vehicle). */
export function vehicleFootprint(type: CarType): { length: number; width: number } {
  if (type === 'tir') return { length: TIR_RIG.length, width: TIR_RIG.width };
  const d = carParts(type).dims;
  return { length: d.length, width: d.width };
}

/** Greenhouse profile of a passenger car (z, y points: windshield base, roof front, roof rear, rear base). */
export function cabinProfile(type: 'hatch' | 'sedan' | 'suv'): { pts: [number, number][]; inset: number; dims: CarDims } {
  const spec = SPECS[type];
  const d = withAxles(spec.dims);
  return { pts: spec.cabin!(d), inset: spec.cabinInset, dims: d };
}
