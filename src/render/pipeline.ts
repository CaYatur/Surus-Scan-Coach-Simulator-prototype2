import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { QualityProfile } from '../core/settings';

/** WebGL renderer + post-processing chain configured from a quality profile. */
export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private profile: QualityProfile | null = null;
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  apply(profile: QualityProfile) {
    this.profile = profile;
    const r = this.renderer;
    r.setPixelRatio(profile.pixelRatio);
    r.shadowMap.enabled = profile.shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.composer?.dispose();
    const size = r.getSize(new THREE.Vector2());
    const composer = new EffectComposer(r);
    composer.setPixelRatio(profile.pixelRatio);
    composer.setSize(size.x, size.y);
    this.renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(this.renderPass);
    this.bloom = null;
    if (profile.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.45, 5.0);
      composer.addPass(this.bloom);
    }
    composer.addPass(new OutputPass());
    if (profile.antialias === 'fxaa') composer.addPass(new FXAAPass());
    else if (profile.antialias === 'smaa') composer.addPass(new SMAAPass());
    this.composer = composer;
  }

  setScene(scene: THREE.Scene) {
    this.scene = scene;
    if (this.renderPass) this.renderPass.scene = scene;
  }

  setBloom(strength: number) {
    if (this.bloom) this.bloom.strength = strength;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const cam = this.camera as THREE.PerspectiveCamera;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  render() {
    this.renderer.shadowMap.needsUpdate = true;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get quality() {
    return this.profile;
  }
}
