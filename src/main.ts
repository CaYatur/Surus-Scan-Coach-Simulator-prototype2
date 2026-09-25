import './style.css';
import { actionsFor } from './input/bindings';
import * as THREE from 'three';
import { settings, qualityProfile, detectQuality, type QualityLevel } from './core/settings';
import { RenderPipeline } from './render/pipeline';
import { Input } from './input/input';
import { HeadTracker } from './input/headTracker';
import { Hud } from './ui/hud';
import { Screens, type AppApi } from './ui/screens';
import { renderReport } from './ui/report';
import { WorldBundle } from './game/worldBundle';
import { Session, type SessionConfig, type ReportData } from './game/session';
import { audio } from './audio/audio';

type Mode = 'menu' | 'loading' | 'driving';

class App implements AppApi {
  private host = document.getElementById('app')!;
  private canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  private camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4500);
  private placeholder = new THREE.Scene();
  pipeline: RenderPipeline;
  private input = new Input();
  readonly head = new HeadTracker();
  private hud: Hud;
  private screens: Screens;
  private bundles = new Map<'training' | 'city', WorldBundle>();
  private bundle: WorldBundle | null = null;
  session: Session | null = null;
  private mode: Mode = 'menu';
  private last = performance.now();
  private orbit = 0;
  readonly detectedQuality: QualityLevel;
  perf = { ms: 0, calls: 0, tris: 0 };
  private menuPlayer = { x: 40, z: -30, heading: 0, speed: 0, length: 4, width: 1.8 };

  constructor() {
    this.pipeline = new RenderPipeline(this.canvas, this.placeholder, this.camera);
    this.detectedQuality = detectQuality(this.pipeline.renderer.getContext());
    if (settings.get().qualityAuto) settings.update({ quality: this.detectedQuality });
    this.pipeline.apply(qualityProfile(settings.get().quality));
    this.hud = new Hud(this.host);
    this.hud.setVisible(false);
    this.screens = new Screens(this.host, this);
    this.screens.onOverlayChange = (open) => {
      if (open) this.session?.setPaused(true);
    };
    window.addEventListener('resize', () => this.pipeline.resize());
    this.pipeline.resize();
    window.addEventListener('keydown', (e) => this.overlayKeys(e), true);
    settings.on('change', ({ keys }) => {
      if (keys.includes('webcamPreview')) this.head.setPreviewVisible(settings.get().webcamPreview);
      if (keys.includes('scanMode') && settings.get().scanMode === 'webcam' && this.session) void this.head.start(this.host);
    });
    // unlock audio on the first interaction
    const unlock = () => {
      audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.screens.show('main');
    // Build the city in the background for the animated menu
    this.screens.loading('Şehir oluşturuluyor…');
    setTimeout(() => {
      this.getBundle('city');
      this.useMenuBackground();
      this.screens.loading(null);
    }, 30);
    requestAnimationFrame((t) => this.frame(t));
  }

  private getBundle(id: 'training' | 'city'): WorldBundle {
    let b = this.bundles.get(id);
    if (!b) {
      b = new WorldBundle(id, this.pipeline.renderer, qualityProfile(settings.get().quality));
      this.bundles.set(id, b);
    }
    return b;
  }

  private useMenuBackground() {
    const b = this.bundles.get('city');
    if (!b) return;
    this.bundle = b;
    b.reset();
    b.env.set('sunset', 'clear');
    b.world.setNight(b.env.nightFactor);
    b.world.setWet(0);
    b.traffic.lightsOn = true;
    b.setDensity(qualityProfile(settings.get().quality), 1, 1);
    b.traffic.populate(this.menuPlayer, true);
    b.peds.populate(this.menuPlayer.x, this.menuPlayer.z, true);
    this.pipeline.setScene(b.scene);
    this.pipeline.setBloom(0.6);
    this.pipeline.renderer.toneMappingExposure = b.env.exposure;
    this.camera.layers.set(0);
    this.camera.layers.enable(3);
  }

  // ——————————————————————————— AppApi ———————————————————————————

  startSession(cfg: SessionConfig) {
    audio.unlock();
    this.screens.hideMenus();
    this.screens.closeOverlay();
    this.mode = 'loading';
    this.screens.loading(cfg.mapId === 'city' ? 'Şehir hazırlanıyor…' : 'Eğitim alanı hazırlanıyor…');
    setTimeout(() => {
      this.session?.dispose();
      const b = this.getBundle(cfg.mapId);
      this.bundle = b;
      this.pipeline.setScene(b.scene);
      const q = qualityProfile(settings.get().quality);
      this.session = new Session(b, cfg, {
        pipeline: this.pipeline,
        camera: this.camera,
        input: this.input,
        head: this.head,
        hud: this.hud,
        quality: q,
        ui: {
          openPause: () => this.screens.pauseMenu(),
          openMissionBoard: () => this.screens.missionBoard(!!this.session?.runner),
          openBigMap: () => this.screens.bigMap(),
          openHelp: () => this.screens.helpOverlay(),
          showReport: (d) => this.showReport(d),
        },
      });
      this.hud.setVisible(true);
      this.mode = 'driving';
      this.screens.loading(null);
      this.input.flush();
      if (settings.get().scanMode === 'webcam') void this.head.start(this.host);
      this.last = performance.now();
    }, 40);
  }

  resume() {
    if (!this.session) return;
    this.screens.hideMenus();
    this.hud.setVisible(true);
    this.session.setPaused(false);
    this.last = performance.now();
  }

  finishSegment() {
    this.session?.finishSegment();
  }

  restartSession() {
    if (!this.session) return;
    this.session.restart();
    this.resume();
  }

  quitToMenu() {
    this.session?.bundle.world.updateLod(0, 0, 1e9);
    this.session?.dispose();
    this.session = null;
    this.head.stop();
    this.hud.setVisible(false);
    this.screens.closeOverlay();
    this.mode = 'menu';
    this.useMenuBackground();
    this.screens.show('main');
  }

  startBoardMission(id: string) {
    this.session?.startBoardMission(id);
    this.resume();
  }

  qualityChanged() {
    const q = qualityProfile(settings.get().quality);
    this.pipeline.apply(q);
    this.pipeline.resize();
    for (const b of this.bundles.values()) b.applyQuality(q);
    this.session?.applyQuality(q);
  }

  inSession() {
    return !!this.session;
  }

  sessionMapId() {
    return this.session?.bundle.map.id ?? null;
  }

  bigMap(canvas: HTMLCanvasElement) {
    const s = this.session;
    if (!s) return null;
    const g = canvas.getContext('2d')!;
    const pos = s.position;
    const pick = s.bundle.mapRenderer.drawFull(g, canvas.width, canvas.height, {
      player: pos,
      route: s.bundle.nav.route?.line,
      markers: s.bundle.markerList(),
      trail: s.trailPoints,
    });
    return (sx: number, sy: number) => {
      const p = pick(sx, sy);
      s.navigateTo(p.x, p.z);
    };
  }

  private showReport(d: ReportData) {
    const s = this.session;
    if (!s) return;
    s.setPaused(true);
    this.hud.setVisible(false);
    const panel = this.screens.report();
    renderReport(panel, d, s.bundle.mapRenderer, {
      onContinue: () => {
        this.screens.closeOverlay();
        s.continueFree();
        this.resume();
      },
      onRetry: () => {
        this.screens.closeOverlay();
        if (d.mission) {
          this.startSession({ ...s.cfg, mode: 'mission', missionId: d.mission.def.id, mapId: d.mission.def.map });
        } else {
          s.restart();
          this.resume();
        }
      },
      onMenu: () => this.quitToMenu(),
      csv: () => s.csv(),
    });
  }

  // ——————————————————————————— overlays & keys ———————————————————————————

  private overlayKeys(e: KeyboardEvent) {
    if (this.mode !== 'driving' || !this.session) return;
    const open = this.screens.overlayOpen;
    const menus = !document.getElementById('menu-root')!.classList.contains('hidden');
    if (menus) {
      if (e.code === 'Escape') {
        e.stopPropagation();
        this.screens.back();
      }
      return;
    }
    if (!open) return;
    if (this.session.ended) return; // report visible: buttons only
    const acts = actionsFor(e.code);
    if (e.code === 'Escape' || acts.some((a) => a === 'pause' || a === 'map' || a === 'missions' || a === 'help')) {
      e.preventDefault();
      e.stopPropagation();
      this.screens.closeOverlay();
      this.resume();
    }
  }

  // ——————————————————————————— loop ———————————————————————————

  private frame(t: number) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.max(0, Math.min(0.1, (t - this.last) / 1000));
    this.last = t;
    if (this.mode === 'driving' && this.session) {
      const t0 = performance.now();
      const info = this.pipeline.renderer.info;
      info.autoReset = false;
      info.reset();
      this.session.update(dt);
      this.perf = { ms: performance.now() - t0, calls: info.render.calls, tris: info.render.triangles };
      return;
    }
    const b = this.bundle;
    if (!b) {
      this.pipeline.render();
      return;
    }
    // Animated menu background: slow orbit over the live city
    this.orbit += dt * 0.035;
    const cx = 40;
    const cz = -30;
    const r = 360;
    this.camera.position.set(cx + Math.cos(this.orbit) * r, 175 + Math.sin(this.orbit * 0.7) * 20, cz + Math.sin(this.orbit) * r);
    this.camera.lookAt(cx, 0, cz);
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.menuPlayer.x = cx;
    this.menuPlayer.z = cz;
    const sdt = Math.min(dt, 0.05);
    b.signals.update(sdt);
    b.traffic.update(sdt, this.menuPlayer, b.peds.onRoad());
    b.peds.update(sdt, this.menuPlayer, b.traffic.cars);
    b.traffic.render(sdt, cx, cz, (t / 400) % 2 < 1, 260);
    b.env.update(sdt, new THREE.Vector3(cx, 0, cz), this.camera);
    b.world.update(t / 1000);
    this.pipeline.render();
  }
}

const app = new App();
// Debug / automation hook
(window as unknown as { __ssc: App }).__ssc = app;
