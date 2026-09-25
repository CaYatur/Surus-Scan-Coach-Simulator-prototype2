import * as THREE from 'three';
import { carMaterials, carParts, cabinProfile, type CarParts } from './carModels';
import { Cockpit, LAYER_EXTERIOR, type CockpitState } from './cockpit';
import type { VehicleDynamics } from './dynamics';
import type { PlayerCarType } from '../core/settings';

export type LightState = {
  signal: 'none' | 'left' | 'right';
  hazard: boolean;
  lights: boolean;
  braking: boolean;
  reversing: boolean;
};

/** Visual representation of the player's car: exterior, animated wheels, lights and the cockpit. */
export class PlayerCar {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly exterior = new THREE.Group();
  readonly cockpit: Cockpit;
  readonly parts: CarParts;
  readonly type: PlayerCarType;
  private wheels: { mesh: THREE.Group; front: boolean; left: boolean }[] = [];
  private mats: { head: THREE.MeshBasicMaterial; tail: THREE.MeshBasicMaterial; indL: THREE.MeshBasicMaterial; indR: THREE.MeshBasicMaterial; paint: THREE.MeshPhysicalMaterial };
  readonly headlights: THREE.SpotLight[] = [];
  private reverseLight: THREE.PointLight;
  blinkOn = false;
  private bonnetPaint: THREE.MeshPhysicalMaterial;
  private blinkT = 0;

  constructor(type: PlayerCarType, color: string) {
    this.type = type;
    this.parts = carParts(type);
    const shared = carMaterials();
    const paint = shared.paint.clone();
    paint.color.set(color);
    this.mats = {
      paint,
      head: new THREE.MeshBasicMaterial({ color: 0x9a9a92, toneMapped: false }),
      tail: new THREE.MeshBasicMaterial({ color: 0x3a0606, toneMapped: false }),
      indL: new THREE.MeshBasicMaterial({ color: 0x3a2404, toneMapped: false }),
      indR: new THREE.MeshBasicMaterial({ color: 0x3a2404, toneMapped: false }),
    };
    const p = this.parts;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, cast = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.exterior.add(mesh);
      return mesh;
    };
    add(p.paint, paint);
    add(p.trim, shared.trim);
    add(p.glass, shared.glass);
    add(p.head, this.mats.head, false);
    add(p.tail, this.mats.tail, false);
    add(p.indL, this.mats.indL, false);
    add(p.indR, this.mats.indR, false);
    for (const w of p.wheels) {
      const holder = new THREE.Group();
      holder.position.set(w.x, w.y, w.z);
      const spin = new THREE.Mesh(p.wheel, shared.wheel);
      spin.castShadow = true;
      spin.name = 'spin';
      if (w.x < 0) spin.rotation.y = Math.PI; // outer face outward on the right side
      holder.add(spin);
      this.exterior.add(holder);
      this.wheels.push({ mesh: holder, front: w.front, left: w.x > 0 });
    }
    // "Direksiyon eğitim aracı" roof sign, white with red text
    const signTex = makeRoofSignTexture();
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.14), [
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      new THREE.MeshStandardMaterial({ map: signTex }),
      new THREE.MeshStandardMaterial({ map: signTex }),
    ]);
    const cab = cabinProfile(type);
    const roofY = Math.max(cab.pts[1][1], cab.pts[2][1]) + 0.06;
    sign.position.set(0, roofY + 0.13, (cab.pts[1][0] + cab.pts[2][0]) / 2);
    sign.castShadow = true;
    this.exterior.add(sign);

    this.exterior.traverse((o) => o.layers.set(LAYER_EXTERIOR));
    this.body.add(this.exterior);

    const bonnetPaint = paint.clone();
    bonnetPaint.side = THREE.DoubleSide;
    this.bonnetPaint = bonnetPaint;
    this.cockpit = new Cockpit(cab.dims, cab.pts, cab.inset, bonnetPaint);
    this.body.add(this.cockpit.group);
    this.root.add(this.body);

    // Headlights (real spot lights for night driving)
    const L = p.dims.length / 2;
    for (const sx of [-1, 1]) {
      const s = new THREE.SpotLight(0xfff1d8, 0, 95, 0.52, 0.55, 1.4);
      s.position.set(sx * 0.6, 0.7, L - 0.1);
      s.target.position.set(sx * 1.2, 0, L + 28);
      s.castShadow = false;
      this.root.add(s, s.target);
      this.headlights.push(s);
    }
    this.reverseLight = new THREE.PointLight(0xffffff, 0, 8, 2);
    this.reverseLight.position.set(0, 0.6, -L - 0.4);
    this.root.add(this.reverseLight);
  }

  get dims() {
    return this.parts.dims;
  }

  setColor(color: string) {
    this.mats.paint.color.set(color);
    this.bonnetPaint.color.set(color);
  }

  /** Visibility per camera is handled with layers; this only toggles the whole car. */
  setVisible(v: boolean) {
    this.root.visible = v;
  }

  sync(dyn: VehicleDynamics, ls: LightState, dt: number, nightFactor: number) {
    this.root.position.set(dyn.x, 0, dyn.z);
    this.root.rotation.y = dyn.heading;
    this.body.rotation.set(dyn.bodyPitch, 0, dyn.bodyRoll);
    for (const w of this.wheels) {
      const spin = w.mesh.getObjectByName('spin')!;
      spin.rotation.x = dyn.wheelSpin * (w.left ? 1 : 1);
      w.mesh.rotation.y = w.front ? dyn.steerAngle : 0;
    }
    // indicators blink at ~1.5 Hz
    const blinking = ls.signal !== 'none' || ls.hazard;
    if (blinking) {
      this.blinkT += dt;
      if (this.blinkT > 0.34) {
        this.blinkT = 0;
        this.blinkOn = !this.blinkOn;
      }
    } else {
      this.blinkOn = false;
      this.blinkT = 0.34;
    }
    const lOn = this.blinkOn && (ls.signal === 'left' || ls.hazard);
    const rOn = this.blinkOn && (ls.signal === 'right' || ls.hazard);
    this.mats.indL.color.setRGB(lOn ? 11 : 0.23, lOn ? 6 : 0.14, lOn ? 0.3 : 0.02);
    this.mats.indR.color.setRGB(rOn ? 11 : 0.23, rOn ? 6 : 0.14, rOn ? 0.3 : 0.02);
    const tail = ls.braking ? 13 : ls.lights ? 3.2 : 0.22;
    this.mats.tail.color.setRGB(tail, tail * 0.06, tail * 0.05);
    const head = ls.lights ? 11 : 0.6;
    this.mats.head.color.setRGB(head, head * 0.97, head * 0.9);
    for (const s of this.headlights) s.intensity = ls.lights ? 260 * (0.35 + 0.65 * nightFactor) : 0;
    this.reverseLight.intensity = ls.reversing ? 6 : 0;
  }

  updateCockpit(state: CockpitState, dt: number, rain: number) {
    this.cockpit.update(state, dt, rain);
  }
}

function makeRoofSignTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = '#c62828';
  g.lineWidth = 4;
  g.strokeRect(3, 3, 250, 58);
  g.fillStyle = '#c62828';
  g.font = 'bold 24px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DİREKSİYON', 128, 22);
  g.font = 'bold 18px Arial, sans-serif';
  g.fillText('EĞİTİM ARACI', 128, 46);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
