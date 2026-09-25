import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export type TimeOfDay = 'morning' | 'noon' | 'sunset' | 'night';
export type Weather = 'clear' | 'cloudy' | 'rain' | 'fog';

export const TIME_LABEL: Record<TimeOfDay, string> = {
  morning: 'Sabah',
  noon: 'Öğle',
  sunset: 'Gün batımı',
  night: 'Gece',
};
export const WEATHER_LABEL: Record<Weather, string> = {
  clear: 'Açık',
  cloudy: 'Bulutlu',
  rain: 'Yağmurlu',
  fog: 'Sisli',
};

type Preset = {
  elevation: number;
  azimuth: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  fog: number;
  night: number;
  envIntensity: number;
};

const TIME: Record<TimeOfDay, Preset> = {
  morning: { elevation: 16, azimuth: 115, sunColor: 0xffe2c0, sunIntensity: 2.8, hemiSky: 0xbfd6ff, hemiGround: 0x6d6a55, hemiIntensity: 0.7, exposure: 0.5, fog: 0xc9d6e2, night: 0, envIntensity: 0.32 },
  noon: { elevation: 52, azimuth: 150, sunColor: 0xfff5e6, sunIntensity: 3.2, hemiSky: 0xc7dcff, hemiGround: 0x74705c, hemiIntensity: 0.75, exposure: 0.44, fog: 0xc4d6e8, night: 0, envIntensity: 0.28 },
  sunset: { elevation: 5, azimuth: 250, sunColor: 0xffa46b, sunIntensity: 2.6, hemiSky: 0xf2b58c, hemiGround: 0x5a4a44, hemiIntensity: 0.55, exposure: 0.58, fog: 0xe0ae8a, night: 0.45, envIntensity: 0.3 },
  night: { elevation: -14, azimuth: 250, sunColor: 0x9db4ff, sunIntensity: 0.35, hemiSky: 0x2a3d63, hemiGround: 0x120f0c, hemiIntensity: 0.45, exposure: 1.0, fog: 0x0b1320, night: 1, envIntensity: 0.4 },
};

/** Sky, sun/moon, fog, rain and time-of-day controller. */
export class Environment {
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private stars: THREE.Points;
  private rain: THREE.LineSegments | null = null;
  private rainVel: Float32Array | null = null;
  time: TimeOfDay = 'noon';
  weather: Weather = 'clear';
  nightFactor = 0;
  wetness = 0;
  grip = 1;
  exposure = 1;
  private scene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3();
  private drawDistance = 600;
  private rainDrops = 3000;
  private elapsed = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 10;
    sc.far = 420;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    sc.layers.enableAll();
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xc7dcff, 0x74705c, 1);
    scene.add(this.hemi);

    // Stars
    const starGeo = new THREE.BufferGeometry();
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const v = Math.random() * 0.48 + 0.02;
      const th = u * Math.PI * 2;
      const ph = Math.acos(1 - v);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * 4000;
      pos[i * 3 + 1] = Math.cos(ph) * 4000;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 4000;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }));
    this.stars.frustumCulled = false;
    scene.add(this.stars);
  }

  configure(opts: { shadows: boolean; shadowMapSize: number; drawDistance: number; rainDrops: number }) {
    this.sun.castShadow = opts.shadows;
    if (this.sun.shadow.mapSize.x !== opts.shadowMapSize) {
      this.sun.shadow.mapSize.set(opts.shadowMapSize, opts.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.drawDistance = opts.drawDistance;
    this.rainDrops = opts.rainDrops;
    this.applyFog();
  }

  set(time: TimeOfDay, weather: Weather) {
    this.time = time;
    this.weather = weather;
    const p = TIME[time];
    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    const overcast = weather === 'cloudy' ? 0.7 : weather === 'rain' ? 1 : weather === 'fog' ? 0.6 : 0;
    u.turbidity.value = 2.5 + overcast * 12;
    u.rayleigh.value = time === 'sunset' ? 2.6 : time === 'night' ? 0.4 : 1.2 + overcast;
    u.mieCoefficient.value = 0.004 + overcast * 0.01;
    u.mieDirectionalG.value = 0.82;
    if (u.cloudCoverage) {
      u.cloudCoverage.value = 0.18 + overcast * 0.75;
      u.cloudDensity.value = 0.35 + overcast * 0.6;
      u.showSunDisc.value = overcast > 0.5 || time === 'night' ? 0 : 1;
    }
    const dim = 1 - overcast * 0.55;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity * dim;
    this.sun.castShadow = this.sun.castShadow && time !== 'night';
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity * (1 + overcast * 0.25);
    this.nightFactor = Math.min(1, p.night + (weather === 'rain' && time !== 'night' ? 0.35 : 0));
    this.exposure = p.exposure;
    (this.stars.material as THREE.PointsMaterial).opacity = time === 'night' && overcast < 0.6 ? 0.9 : 0;
    this.wetness = weather === 'rain' ? 1 : 0;
    this.grip = weather === 'rain' ? 0.7 : 1;
    this.scene.environmentIntensity = p.envIntensity * dim;
    this.sky.visible = weather !== 'fog' && weather !== 'rain';
    this.applyFog();
    this.rebuildEnvMap();
    this.setupRain(weather === 'rain');
  }

  private applyFog() {
    const p = TIME[this.time];
    const col = new THREE.Color(p.fog);
    if (this.weather === 'rain') col.lerp(new THREE.Color(this.time === 'night' ? 0x0a0f16 : 0x8e98a2), 0.7);
    if (this.weather === 'fog') col.lerp(new THREE.Color(this.time === 'night' ? 0x1a1f26 : 0xc8ccd0), 0.8);
    if (this.weather === 'cloudy') col.lerp(new THREE.Color(0xb3bcc4), 0.5);
    let near = 220;
    let far = Math.max(900, this.drawDistance * 4);
    if (this.weather === 'rain') {
      near = 30;
      far = Math.min(far, 420);
    } else if (this.weather === 'fog') {
      near = 8;
      far = 150;
    } else if (this.time === 'night') {
      near = 90;
      far = Math.min(far, 1100);
    }
    this.scene.fog = new THREE.Fog(col, near, far);
    this.scene.background = col;
  }

  private rebuildEnvMap() {
    const envScene = new THREE.Scene();
    const sky = new Sky();
    sky.scale.setScalar(10000);
    const src = this.sky.material.uniforms;
    const dst = sky.material.uniforms;
    for (const k of Object.keys(src)) {
      const v = src[k].value;
      dst[k].value = v && typeof v === 'object' && 'clone' in v ? (v as THREE.Vector3).clone() : v;
    }
    envScene.add(sky);
    if (this.time === 'night') envScene.add(new THREE.HemisphereLight(0x33476b, 0x111111, 1));
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    sky.geometry.dispose();
    sky.material.dispose();
  }

  private setupRain(on: boolean) {
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
      this.rain = null;
    }
    if (!on) return;
    const n = this.rainDrops;
    const pos = new Float32Array(n * 6);
    this.rainVel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 70;
      const y = Math.random() * 30;
      const z = (Math.random() - 0.5) * 70;
      pos.set([x, y, z, x + 0.05, y - 0.55, z + 0.02], i * 6);
      this.rainVel[i] = 16 + Math.random() * 6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: this.time === 'night' ? 0x8899aa : 0xc8d2dc, transparent: true, opacity: 0.38, depthWrite: false })
    );
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera) {
    this.elapsed += dt;
    // Shadow frustum follows the player (snapped to texels to avoid shimmering)
    const texel = (150 / this.sun.shadow.mapSize.x) * 2;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + this.sunDir.x * 250, Math.max(20, this.sunDir.y * 250), fz + this.sunDir.z * 250);
    this.sun.target.updateMatrixWorld();
    this.stars.position.copy(camera.position);
    const u = this.sky.material.uniforms;
    if (u.time) u.time.value = this.elapsed;
    if (this.rain && this.rainVel) {
      this.rain.position.set(camera.position.x, camera.position.y - 12, camera.position.z);
      const arr = (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < this.rainVel.length; i++) {
        const o = i * 6;
        const dy = this.rainVel[i] * dt;
        arr[o + 1] -= dy;
        arr[o + 4] -= dy;
        if (arr[o + 1] < 0) {
          const x = (Math.random() - 0.5) * 70;
          const z = (Math.random() - 0.5) * 70;
          const y = 28 + Math.random() * 4;
          arr[o] = x;
          arr[o + 1] = y;
          arr[o + 2] = z;
          arr[o + 3] = x + 0.05;
          arr[o + 4] = y - 0.55;
          arr[o + 5] = z + 0.02;
        }
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Visibility range used by the coach (for speed advice in fog/rain). */
  get visibility(): number {
    return this.weather === 'fog' ? 90 : this.weather === 'rain' ? 250 : this.time === 'night' ? 300 : 800;
  }
}
