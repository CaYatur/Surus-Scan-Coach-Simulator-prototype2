import * as THREE from 'three';
import { clamp, damp, dampAngle } from '../core/math';
import { settings } from '../core/settings';
import type { GlanceTarget } from '../input/input';
import type { VehicleDynamics } from './dynamics';
import type { PlayerCar } from './playerCar';
import { LAYER_DETAIL, LAYER_EXTERIOR, LAYER_INTERIOR } from './cockpit';

export type CameraMode = 'cockpit' | 'hood' | 'chase' | 'chaseFar' | 'top' | 'instructor';
export const CAMERA_MODES: CameraMode[] = ['cockpit', 'hood', 'chase', 'chaseFar', 'top', 'instructor'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  cockpit: 'Sürücü koltuğu (iç)',
  hood: 'Kaput kamerası',
  chase: 'Takip (yakın)',
  chaseFar: 'Takip (uzak)',
  top: 'Kuşbakışı',
  instructor: 'Eğitmen koltuğu (iç)',
};

export type LookInput = {
  glance: GlanceTarget;
  mouseYaw: number;
  mousePitch: number;
  /** Continuous head pose from webcam (radians) when enabled. */
  webcam: { yaw: number; pitch: number } | null;
};

/** Camera controller with a physically placed driver head that turns toward mirrors / shoulders. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'cockpit';
  headYaw = 0;
  headPitch = 0;
  private headOffset = new THREE.Vector3();
  private chasePos = new THREE.Vector3();
  private chaseHeading = 0;
  private initialized = false;
  /** Glance target the head is currently holding (reached within tolerance). */
  reached: GlanceTarget = 'none';
  private reachedTime = 0;
  private lastTarget: GlanceTarget = 'none';
  shake = 0;
  zoom = 1;
  private fovScale = 1;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    window.addEventListener('wheel', (e) => {
      if ((e.target as HTMLElement)?.tagName !== 'CANVAS') return;
      this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.5, 2.5);
    });
  }

  get isInterior() {
    return this.mode === 'cockpit' || this.mode === 'instructor';
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  setMode(m: CameraMode) {
    this.mode = m;
    this.initialized = false;
    const cam = this.camera;
    cam.layers.set(0);
    cam.layers.enable(LAYER_DETAIL);
    // Interior views draw the cockpit shell instead of the exterior body (which would cover the dash)
    if (this.isInterior) cam.layers.enable(LAYER_INTERIOR);
    else cam.layers.enable(LAYER_EXTERIOR);
  }

  /** Head yaw/pitch that aims the driver's eyes at a given glance target. */
  private glanceAngles(car: PlayerCar, g: GlanceTarget): { yaw: number; pitch: number; lean: THREE.Vector3 } {
    const eye = car.cockpit.eye;
    const a = car.cockpit.mirrorAnchors;
    const aim = (p: THREE.Vector3) => {
      const dx = p.x - eye.x;
      const dy = p.y - eye.y;
      const dz = p.z - eye.z;
      return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
    };
    const zero = new THREE.Vector3();
    switch (g) {
      case 'mirrorL':
        return { ...aim(a.left), lean: new THREE.Vector3(0.03, 0, 0.02) };
      case 'mirrorR':
        return { ...aim(a.right), lean: new THREE.Vector3(-0.02, 0, 0.03) };
      case 'mirrorRear': {
        const rear = new THREE.Vector3(0, a.rear.y - 0.03, eye.z + 0.55);
        const r = aim(rear);
        return { yaw: r.yaw, pitch: r.pitch, lean: zero };
      }
      case 'shoulderL':
        return { yaw: 2.05, pitch: -0.08, lean: new THREE.Vector3(-0.08, 0.02, 0.08) };
      case 'shoulderR':
        return { yaw: -2.15, pitch: -0.08, lean: new THREE.Vector3(-0.14, 0.02, 0.1) };
      case 'generic':
        return { yaw: 0.5, pitch: 0, lean: zero };
      default:
        return { yaw: 0, pitch: 0, lean: zero };
    }
  }

  update(dt: number, car: PlayerCar, dyn: VehicleDynamics, look: LookInput) {
    const s = settings.get();
    const cam = this.camera;
    const root = car.root;
    root.updateMatrixWorld(true);

    // ——— Head orientation (used in interior views, and for glance detection everywhere) ———
    const target = this.glanceAngles(car, look.glance);
    let yawT = target.yaw + look.mouseYaw;
    let pitchT = target.pitch + look.mousePitch;
    if (look.webcam && look.glance === 'none') {
      yawT += clamp(look.webcam.yaw * 2.3, -2.2, 2.2);
      pitchT += clamp(look.webcam.pitch * 1.6, -0.5, 0.5);
    }
    const rate = look.glance !== 'none' ? 11 : 8;
    this.headYaw = dampAngle(this.headYaw, yawT, rate, dt);
    this.headPitch = damp(this.headPitch, pitchT, rate, dt);
    this.headOffset.lerp(target.lean, 1 - Math.exp(-8 * dt));

    // glance reached? (head within ~12° of the target)
    if (look.glance !== this.lastTarget) {
      this.lastTarget = look.glance;
      this.reachedTime = 0;
      this.reached = 'none';
    }
    if (look.glance !== 'none') {
      const close = Math.abs(this.headYaw - target.yaw) < 0.21 || !this.isInterior;
      if (close) this.reachedTime += dt;
      if (this.reachedTime > 0.12) this.reached = look.glance;
    } else this.reached = 'none';

    const up = new THREE.Vector3(0, 1, 0);
    const heading = dyn.heading;
    const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));

    if (this.isInterior) {
      const base = this.mode === 'cockpit' ? car.cockpit.eye.clone() : car.cockpit.passengerEye.clone();
      base.y += s.seatHeight * 0.12;
      base.z += s.seatForward * 0.12;
      base.add(this.headOffset);
      // subtle head motion from g-forces
      if (s.headMotion) {
        base.x += clamp(dyn.latAccel * 0.004, -0.04, 0.04);
        base.z += clamp(-dyn.accel * 0.003, -0.03, 0.03);
      }
      const world = base.applyMatrix4(car.body.matrixWorld);
      cam.position.copy(world);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.headPitch + 0.035, heading + this.headYaw, 0, 'YXZ'));
      const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(dyn.bodyPitch * 0.6, 0, dyn.bodyRoll * 0.6, 'XYZ'));
      cam.quaternion.copy(q).multiply(bodyQ);
      // YXZ with negative pitch looks up for positive headPitch; three's camera looks down −Z,
      // so rotate an extra π around Y.
      cam.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI));
      // eyes 'focus' on a mirror: narrow the field of view a little while glancing at one
      const focus = look.glance === 'mirrorL' || look.glance === 'mirrorR' || look.glance === 'mirrorRear' ? 0.72 : 1;
      this.fovScale = damp(this.fovScale, focus, 6, dt);
      cam.fov = s.fov * this.fovScale;
      cam.near = 0.03;
      this.initialized = true;
    } else if (this.mode === 'hood') {
      const p = new THREE.Vector3(0, car.dims.height + 0.12, car.dims.length / 2 - 1.95).applyMatrix4(car.body.matrixWorld);
      cam.position.copy(p);
      cam.quaternion.setFromEuler(new THREE.Euler(-0.08 + this.headPitch, heading + Math.PI + this.headYaw, 0, 'YXZ'));
      cam.fov = s.fov;
      cam.near = 0.1;
    } else if (this.mode === 'chase' || this.mode === 'chaseFar') {
      const far = this.mode === 'chaseFar';
      const dist = (far ? 11 : 6.2) * this.zoom;
      const h = (far ? 4.4 : 2.2) * Math.sqrt(this.zoom);
      if (!this.initialized) {
        this.chaseHeading = heading;
        this.initialized = true;
      }
      // follow the direction of travel; swing around when reversing
      this.chaseHeading = dampAngle(this.chaseHeading, heading + this.headYaw * 0.9, 4, dt);
      const dir = new THREE.Vector3(Math.sin(this.chaseHeading), 0, Math.cos(this.chaseHeading));
      const want = new THREE.Vector3(dyn.x, h, dyn.z).addScaledVector(dir, -dist);
      if (this.chasePos.lengthSq() === 0 || this.chasePos.distanceTo(want) > 40) this.chasePos.copy(want);
      this.chasePos.lerp(want, 1 - Math.exp(-7 * dt));
      cam.position.copy(this.chasePos);
      cam.lookAt(dyn.x + fwd.x * 2.5, 1.1, dyn.z + fwd.z * 2.5);
      cam.fov = 62;
      cam.near = 0.1;
    } else if (this.mode === 'top') {
      const h = 38 * this.zoom;
      const want = new THREE.Vector3(dyn.x - fwd.x * 6, h, dyn.z - fwd.z * 6);
      cam.position.lerp(want, this.initialized ? 1 - Math.exp(-6 * dt) : 1);
      this.initialized = true;
      cam.up.set(fwd.x, 0, fwd.z);
      cam.lookAt(dyn.x + fwd.x * 6, 0, dyn.z + fwd.z * 6);
      cam.up.set(0, 1, 0);
      cam.fov = 55;
      cam.near = 0.5;
    }
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.2);
      const a = this.shake * 0.05;
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
      cam.rotateZ((Math.random() - 0.5) * a * 0.5);
    }
    cam.updateProjectionMatrix();
  }
}
