import * as THREE from 'three';
import { CAR_TYPES, carMaterials, carParts, type CarType } from '../vehicle/carModels';

export type VehicleVisual = {
  type: CarType;
  x: number;
  z: number;
  heading: number;
  color: THREE.Color;
  brake: boolean;
  lights: boolean;
  indL: boolean;
  indR: boolean;
  roll?: number;
};

const BRAKE = new THREE.Color(13, 0.7, 0.5);
const TAIL_ON = new THREE.Color(3.2, 0.15, 0.1);
const TAIL_OFF = new THREE.Color(0.25, 0.03, 0.03);
const HEAD_ON = new THREE.Color(11, 10.5, 9.5);
const HEAD_OFF = new THREE.Color(0.55, 0.55, 0.52);
const IND_ON = new THREE.Color(11, 6, 0.3);
const IND_OFF = new THREE.Color(0.22, 0.13, 0.02);

type TypeBatch = {
  meshes: THREE.InstancedMesh[];
  paint: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  indL: THREE.InstancedMesh;
  indR: THREE.InstancedMesh;
  capacity: number;
};

/** Draws every AI and parked vehicle with a handful of instanced meshes per model. */
export class VehicleRenderer {
  readonly group = new THREE.Group();
  private batches = new Map<CarType, TypeBatch>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();

  constructor(capacityPerType: Partial<Record<CarType, number>>) {
    const mats = carMaterials();
    const lightMat = mats.lights;
    for (const type of CAR_TYPES) {
      const cap = Math.max(1, capacityPerType[type] ?? 8);
      const parts = carParts(type);
      const mk = (g: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(g, mat, cap);
        im.count = 0;
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        im.frustumCulled = false;
        this.group.add(im);
        return im;
      };
      const paint = mk(parts.paint, mats.paint, true);
      const trim = mk(parts.trim, mats.trim, true);
      const wheels = mk(parts.wheelsBaked, mats.wheel, true);
      const glass = mk(parts.glass, mats.glass, false);
      const head = mk(parts.head, lightMat, false);
      const tail = mk(parts.tail, lightMat, false);
      const indL = mk(parts.indL, lightMat, false);
      const indR = mk(parts.indR, lightMat, false);
      // allocate colour buffers
      const white = new THREE.Color(1, 1, 1);
      for (const im of [paint, head, tail, indL, indR]) for (let i = 0; i < cap; i++) im.setColorAt(i, white);
      this.batches.set(type, { meshes: [paint, trim, wheels, glass, head, tail, indL, indR], paint, head, tail, indL, indR, capacity: cap });
    }
  }

  /** Replace all instances with the given list (called every frame). */
  draw(list: VehicleVisual[]) {
    const counts = new Map<CarType, number>();
    for (const v of list) {
      const b = this.batches.get(v.type);
      if (!b) continue;
      const i = counts.get(v.type) ?? 0;
      if (i >= b.capacity) continue;
      counts.set(v.type, i + 1);
      this.e.set(0, v.heading, v.roll ?? 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.p.set(v.x, 0, v.z);
      this.m.compose(this.p, this.q, this.one);
      for (const im of b.meshes) im.setMatrixAt(i, this.m);
      b.paint.setColorAt(i, v.color);
      b.head.setColorAt(i, v.lights ? HEAD_ON : HEAD_OFF);
      b.tail.setColorAt(i, v.brake ? BRAKE : v.lights ? TAIL_ON : TAIL_OFF);
      b.indL.setColorAt(i, v.indL ? IND_ON : IND_OFF);
      b.indR.setColorAt(i, v.indR ? IND_ON : IND_OFF);
    }
    for (const [type, b] of this.batches) {
      const n = counts.get(type) ?? 0;
      for (const im of b.meshes) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }
}
