import * as THREE from 'three';
import type { PlayerCar } from './playerCar';
import { LAYER_EXTERIOR } from './cockpit';
import type { GlanceTarget } from '../input/input';

type MirrorKey = 'left' | 'right' | 'rear';

/**
 * Real rendered mirrors. Each mirror has a camera looking backwards from the mirror position
 * into a render target; the cockpit mirror glass and the HUD overlay sample these textures.
 */
export class MirrorSystem {
  private targets: Record<MirrorKey, THREE.WebGLRenderTarget>;
  private cams: Record<MirrorKey, THREE.PerspectiveCamera>;
  private frame = 0;
  private overlayScene = new THREE.Scene();
  private overlayCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private panels: Record<MirrorKey, THREE.Mesh>;
  private frames: Record<MirrorKey, THREE.Mesh>;
  everyNth = 1;

  constructor(resolution: number) {
    const mk = (w: number, h: number) =>
      new THREE.WebGLRenderTarget(w, h, { samples: 0, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
    const r = resolution;
    this.targets = {
      left: mk(Math.round(r * 0.75), Math.round(r * 0.5)),
      right: mk(Math.round(r * 0.75), Math.round(r * 0.5)),
      rear: mk(r * 1.4, Math.round(r * 0.42)),
    };
    this.cams = {
      left: new THREE.PerspectiveCamera(34, 1.5, 0.3, 260),
      right: new THREE.PerspectiveCamera(30, 1.5, 0.3, 260),
      rear: new THREE.PerspectiveCamera(26, 3.3, 0.5, 300),
    };
    this.cams.left.layers.enable(LAYER_EXTERIOR);
    this.cams.right.layers.enable(LAYER_EXTERIOR);
    this.cams.rear.layers.set(0);

    const panel = (key: MirrorKey) => {
      const g = new THREE.PlaneGeometry(1, 1);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.targets[key].texture, toneMapped: false }));
      const f = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x0b0d10, toneMapped: false }));
      f.renderOrder = 0;
      m.renderOrder = 1;
      this.overlayScene.add(f, m);
      return [m, f] as const;
    };
    const [pl, fl] = panel('left');
    const [pr, fr] = panel('right');
    const [pre, fre] = panel('rear');
    this.panels = { left: pl, right: pr, rear: pre };
    this.frames = { left: fl, right: fr, rear: fre };
  }

  textures() {
    return { left: this.targets.left.texture, right: this.targets.right.texture, rear: this.targets.rear.texture };
  }

  private place(car: PlayerCar) {
    const a = car.cockpit.mirrorAnchors;
    const m = car.body.matrixWorld;
    const heading = car.root.rotation.y;
    const setCam = (cam: THREE.PerspectiveCamera, local: THREE.Vector3, yawOffset: number, pitch = -0.04) => {
      cam.position.copy(local.clone().applyMatrix4(m));
      cam.quaternion.setFromEuler(new THREE.Euler(pitch, heading + yawOffset, 0, 'YXZ'));
    };
    // Cameras look backwards (camera −Z = car −Z when yaw = heading).
    setCam(this.cams.left, a.left.clone().add(new THREE.Vector3(0.05, 0, 0)), -0.16);
    setCam(this.cams.right, a.right.clone().add(new THREE.Vector3(-0.05, 0, 0)), 0.2);
    const rearLocal = new THREE.Vector3(0, a.rear.y + 0.05, -car.dims.length / 2 - 0.15);
    setCam(this.cams.rear, rearLocal, 0, -0.03);
  }

  /** Render the mirrors needed this frame. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, car: PlayerCar, need: { cockpit: boolean; glance: GlanceTarget }) {
    this.frame++;
    const wantAll = need.cockpit;
    const glanceKey: MirrorKey | null =
      need.glance === 'mirrorL' || need.glance === 'shoulderL'
        ? 'left'
        : need.glance === 'mirrorR' || need.glance === 'shoulderR'
          ? 'right'
          : need.glance === 'mirrorRear' || need.glance === 'generic'
            ? 'rear'
            : null;
    if (!wantAll && !glanceKey) return;
    if (this.frame % this.everyNth !== 0 && !glanceKey) return;
    this.place(car);
    const prevTarget = renderer.getRenderTarget();
    const keys: MirrorKey[] = wantAll ? ['left', 'right', 'rear'] : [glanceKey!];
    for (const k of keys) {
      renderer.setRenderTarget(this.targets[k]);
      renderer.render(scene, this.cams[k]);
    }
    renderer.setRenderTarget(prevTarget);
  }

  /** HUD mirrors for exterior cameras (drawn over the final image). */
  renderOverlay(renderer: THREE.WebGLRenderer, glance: GlanceTarget, show: boolean) {
    if (!show) return;
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    this.overlayCam.left = 0;
    this.overlayCam.right = w;
    this.overlayCam.top = h;
    this.overlayCam.bottom = 0;
    this.overlayCam.updateProjectionMatrix();
    const showL = glance === 'mirrorL' || glance === 'shoulderL';
    const showR = glance === 'mirrorR' || glance === 'shoulderR';
    const showRear = glance === 'mirrorRear' || glance === 'generic';
    const sw = Math.min(300, w * 0.22);
    const sh = sw * 0.62;
    const layout = (k: MirrorKey, vis: boolean, x: number, y: number, pw: number, ph: number) => {
      this.panels[k].visible = vis;
      this.frames[k].visible = vis;
      this.panels[k].position.set(x, y, 0);
      this.panels[k].scale.set(pw, ph, 1);
      this.frames[k].position.set(x, y, 0);
      this.frames[k].scale.set(pw + 8, ph + 8, 1);
    };
    layout('left', showL, 24 + sw / 2, h * 0.5, sw, sh);
    layout('right', showR, w - 24 - sw / 2, h * 0.5, sw, sh);
    layout('rear', showRear, w / 2, h - 90 - (sw * 0.3) / 2, sw * 1.5, sw * 0.42);
    if (!showL && !showR && !showRear) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.overlayScene, this.overlayCam);
    renderer.autoClear = auto;
  }

  setResolution(r: number) {
    this.targets.left.setSize(Math.round(r * 0.75), Math.round(r * 0.5));
    this.targets.right.setSize(Math.round(r * 0.75), Math.round(r * 0.5));
    this.targets.rear.setSize(r * 1.4, Math.round(r * 0.42));
  }
}
