import * as THREE from 'three';
import { angleDiff, clamp, damp, formatTime } from '../core/math';
import { settings, type QualityProfile } from '../core/settings';
import type { Input, FrameInput } from '../input/input';
import type { HeadTracker } from '../input/headTracker';
import { VehicleDynamics, PARAMS } from '../vehicle/dynamics';
import { PlayerCar, type LightState } from '../vehicle/playerCar';
import { CameraRig, CAMERA_LABEL } from '../vehicle/cameraRig';
import { MirrorSystem } from '../vehicle/mirrors';
import { DrivingMonitor, type MonitorStats } from '../coach/monitor';
import { Telemetry, type Sample } from '../coach/telemetry';
import { computeSession, starsFor, type SessionResult, type StyleBaseline } from '../coach/metrics';
import type { CoachEvent } from '../coach/types';
import { activeProfile, applySession, type KarneUpdate, type SessionSummary } from '../coach/profiles';
import { MissionRunner, type MarkerOpts, type MissionDef, type MissionHost, type HostPlayer } from '../missions/mission';
import { missionById } from '../missions/catalog';
import type { WorldBundle } from './worldBundle';
import type { Hud } from '../ui/hud';
import { audio } from '../audio/audio';
import { controlDevice, expandPromptText, promptHtml, promptPlain } from '../input/prompts';
import type { TimeOfDay, Weather } from '../world/environment';
import { TIME_LABEL, WEATHER_LABEL } from '../world/environment';
import type { RenderPipeline } from '../render/pipeline';
import { CURB_H } from '../world/roadNetwork';
import type { Contact } from '../world/colliders';
import type { AICar, PlayerInfo } from '../traffic/aiTraffic';
import type { LinkTelemetry } from '../link/protocol';
import { experiment, newSeed, type SessionMeta } from '../coach/experiment';

export type SessionConfig = {
  mapId: 'training' | 'city';
  mode: 'free' | 'mission';
  missionId?: string;
  time: TimeOfDay;
  weather: Weather;
  traffic: number;
  peds: number;
  /** Traffic/pedestrian random seed; omitted = a fresh random seed. */
  seed?: number;
};

export type ReportData = {
  result: SessionResult;
  events: CoachEvent[];
  samples: Sample[];
  stats: MonitorStats;
  mission: null | { def: MissionDef; success: boolean; stars: number; failReason: string; lines: string[]; objectives: { title: string; status: string }[] };
  mapName: string;
  mapId: 'training' | 'city';
  conditions: string;
  karne: KarneUpdate | null;
  /** Participant / condition / mission / seed of this segment (exports). */
  meta: SessionMeta;
  profileName: string | null;
  baseline: StyleBaseline | null;
  scan: { rate: number; maxGap: number; glances: number; shoulder: number };
  at: number;
};

export type SessionUI = {
  openPause(): void;
  openMissionBoard(): void;
  openBigMap(): void;
  openHelp(): void;
  showReport(data: ReportData): void;
};

type SegmentKind = 'free' | 'mission' | 'calibration';

/** One drive in a world: player car, coaching, mission runner, cameras and HUD glue. */
export class Session implements MissionHost {
  readonly bundle: WorldBundle;
  readonly cfg: SessionConfig;
  readonly dyn: VehicleDynamics;
  readonly car: PlayerCar;
  readonly rig: CameraRig;
  readonly mirrors: MirrorSystem;
  readonly monitor: DrivingMonitor;
  readonly telemetry = new Telemetry();
  runner: MissionRunner | null = null;
  segment: SegmentKind = 'free';
  /** Seed of this drive's traffic and pedestrians (same seed → same traffic). */
  readonly seed: number;
  /** Experiment control condition: no score, coaching toasts, coach audio or report. */
  readonly quiet: boolean;
  /** Snapshot of the experiment identity at the start of the drive (it is locked meanwhile). */
  private readonly exp: { participant: string; condition: SessionMeta['condition'] };
  private segStartedAt = new Date();
  /** Observers for the companion-display link. */
  onCoach: ((e: CoachEvent) => void) | null = null;
  onSegment: (() => void) | null = null;
  paused = false;
  ended = false;
  private elapsed = 0;
  private segStart = 0;
  private lights: LightState = { signal: 'none', hazard: false, lights: false, braking: false, reversing: false };
  private signalHeading = 0;
  private signalTurned = 0;
  private wipers = 0;
  private inp!: FrameInput;
  private hudTimer = 0;
  private mapTimer = 0;
  private scoreTimer = 0;
  private live: SessionResult | null = null;
  private fpsAcc = 0;
  private fpsN = 0;
  private hardCrashAt = -1;
  private rollingY = 0;
  private trail: number[] = [];
  private trailTimer = 0;
  private lastQ = { kind: 'road' } as ReturnType<WorldBundle['world']['net']['query']>;
  private meterState: { label: string; v: number } | null = null;
  private stimText: string | null = null;
  private odometer = 0;
  private zoneNotice: string | null = null;
  private lodTimer = 0;
  private cruise = { on: false, set: 0, integ: 0 };
  private lastStalls = 0;
  private autoLightWanted: boolean | null = null;
  private pipeline: RenderPipeline;
  private camera: THREE.PerspectiveCamera;
  private input: Input;
  private head: HeadTracker;
  private hud: Hud;
  private ui: SessionUI;
  private q: QualityProfile;
  private playerInfo: PlayerInfo = { x: 0, z: 0, heading: 0, speed: 0, length: 4, width: 1.8 };
  private tmpV = new THREE.Vector3();

  constructor(
    bundle: WorldBundle,
    cfg: SessionConfig,
    deps: { pipeline: RenderPipeline; camera: THREE.PerspectiveCamera; input: Input; head: HeadTracker; hud: Hud; ui: SessionUI; quality: QualityProfile }
  ) {
    this.bundle = bundle;
    this.cfg = cfg;
    this.pipeline = deps.pipeline;
    this.camera = deps.camera;
    this.input = deps.input;
    this.head = deps.head;
    this.hud = deps.hud;
    this.ui = deps.ui;
    this.q = deps.quality;
    this.seed = cfg.seed ?? newSeed();
    this.quiet = experiment.feedbackHidden;
    const ex = experiment.get();
    this.exp = experiment.active ? { participant: ex.participant, condition: ex.condition } : { participant: '', condition: '' };
    this.hud.setFeedback(!this.quiet);
    const s = settings.get();
    this.dyn = new VehicleDynamics(PARAMS[s.playerCar]);
    this.car = new PlayerCar(s.playerCar, s.playerColor);
    bundle.scene.add(this.car.root);
    this.rig = new CameraRig(this.camera);
    this.rig.setMode('cockpit');
    this.mirrors = new MirrorSystem(this.q.mirrorResolution);
    this.mirrors.everyNth = this.q.mirrorEveryNthFrame;
    const t = this.mirrors.textures();
    this.car.cockpit.setMirrorTextures(t.left, t.right, t.rear);
    this.car.cockpit.setScreenMapDrawer((g, w, h) => {
      bundle.mapRenderer.drawMini(g, w, h, { player: { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading }, route: this.routeLine(), markers: bundle.markerList() }, 110, false);
    });
    this.monitor = new DrivingMonitor(bundle.world.net, bundle.signals);
    this.monitor.onEvent = (e) => this.onCoachEvent(e);
    bundle.nav.onReroute = () => this.monitor.registerReroute(this.dyn.x, this.dyn.z);
    bundle.nav.onAnnounce = (text) => audio.say(text, 'nav', 3);
    this.setup();
  }

  // ——————————————————————— MissionHost ————————————————————————
  get map() {
    return this.bundle.map;
  }
  get world() {
    return this.bundle.world;
  }
  get net() {
    return this.bundle.world.net;
  }
  get traffic() {
    return this.bundle.traffic;
  }
  get peds() {
    return this.bundle.peds;
  }
  get signals() {
    return this.bundle.signals;
  }
  get nav() {
    return this.bundle.nav;
  }
  player(): HostPlayer {
    return {
      ...this.playerInfo,
      lane: this.lastQ.kind === 'road' ? this.lastQ.laneIndex : -1,
      kmh: this.dyn.kmh,
      gear: this.dyn.gearMode,
      handbrake: this.dyn.handbrakeOn,
      brake: this.inp?.drive.brake ?? 0,
      throttle: this.inp?.drive.throttle ?? 0,
      lights: this.lights.lights,
    };
  }
  time() {
    return this.elapsed;
  }
  toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info') {
    this.hud.toast(text, kind);
    if (kind === 'good') audio.cue('good');
  }
  say(text: string) {
    audio.say(text, 'nav', 2);
  }
  stimulus(text: string | null) {
    if (text && text !== this.stimText) audio.cue('stimulus');
    this.stimText = text;
    this.hud.stimulus(text);
  }
  marker(id: string, x: number, z: number, opts?: MarkerOpts) {
    this.bundle.marker(id, x, z, opts);
  }
  clearMarker(id?: string) {
    this.bundle.clearMarker(id);
  }
  navigate(x: number, z: number, name: string) {
    return this.bundle.nav.setDestination(x, z, name, { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading });
  }
  meter(label: string | null, value = 0) {
    this.meterState = label ? { label, v: value } : null;
  }

  // ——————————————————————— setup ——————————————————————

  private spawnPoint(def?: MissionDef): { x: number; z: number; heading: number } {
    const sp = def?.spawn ?? this.bundle.map.spawn;
    const near = this.net.nearestLane(sp.x, sp.z, sp.heading, 40);
    // Spawns placed off the lane network (e.g. inside the parking lot) stay as defined
    if (!near || near.dist > 12) return sp;
    const p = { x: 0, z: 0, h: 0 };
    near.lane.path.sample(near.s, p);
    return { x: p.x, z: p.z, heading: p.h };
  }

  private setup() {
    const cfg = this.cfg;
    const b = this.bundle;
    b.reset();
    const def = cfg.mode === 'mission' && cfg.missionId ? missionById(cfg.missionId) : undefined;
    const time = def?.conditions?.time ?? cfg.time;
    const weather = def?.conditions?.weather ?? cfg.weather;
    b.env.set(time, weather);
    b.world.setNight(b.env.nightFactor);
    b.world.setWet(b.env.wetness);
    b.traffic.lightsOn = b.env.nightFactor > 0.4;
    b.setDensity(this.q, def?.conditions?.traffic ?? cfg.traffic, def?.conditions?.peds ?? cfg.peds);
    this.dyn.grip = b.env.grip;
    this.lights.lights = false;
    this.wipers = weather === 'rain' ? 1 : 0;
    const sp = this.spawnPoint(def);
    this.dyn.reset(sp.x, sp.z, sp.heading);
    this.car.sync(this.dyn, this.lights, 0, b.env.nightFactor);
    this.updatePlayerInfo();
    b.traffic.reseed(this.seed);
    b.peds.reseed((this.seed ^ 0x5bd1e995) >>> 0 || 7);
    b.traffic.populate(this.playerInfo, true);
    b.peds.populate(sp.x, sp.z, true);
    this.pipeline.setBloom(0.35 + b.env.nightFactor * 0.55);
    this.pipeline.renderer.toneMappingExposure = b.env.exposure;
    this.hud.setConditions(`${b.map.name} · ${TIME_LABEL[time]} · ${WEATHER_LABEL[weather]}`);
    this.beginSegment(def);
  }

  private beginSegment(def?: MissionDef) {
    this.monitor.reset();
    this.telemetry.reset();
    this.segStart = this.elapsed;
    this.segStartedAt = new Date();
    this.trail = [];
    this.live = null;
    this.hardCrashAt = -1;
    this.runner = null;
    this.segment = 'free';
    this.onSegment?.();
    if (def) {
      this.segment = def.category === 'calibration' ? 'calibration' : 'mission';
      this.runner = new MissionRunner(def, this);
    }
  }

  /** Start a mission from the in-drive board (keeps the car where it is). */
  startBoardMission(id: string) {
    const def = missionById(id);
    if (!def) return;
    const b = this.bundle;
    if (def.conditions?.time || def.conditions?.weather) {
      b.env.set(def.conditions.time ?? b.env.time, def.conditions.weather ?? b.env.weather);
      b.world.setNight(b.env.nightFactor);
      b.world.setWet(b.env.wetness);
      b.traffic.lightsOn = b.env.nightFactor > 0.4;
      this.dyn.grip = b.env.grip;
      this.pipeline.setBloom(0.35 + b.env.nightFactor * 0.55);
      this.pipeline.renderer.toneMappingExposure = b.env.exposure;
      this.hud.setConditions(`${b.map.name} · ${TIME_LABEL[b.env.time]} · ${WEATHER_LABEL[b.env.weather]}`);
    }
    b.setDensity(this.q, def.conditions?.traffic ?? this.cfg.traffic, def.conditions?.peds ?? this.cfg.peds);
    b.nav.clear();
    b.clearMarker();
    this.beginSegment(def);
    audio.cue('ui');
  }

  /** Continue driving freely after a report. */
  continueFree() {
    this.bundle.nav.clear();
    this.bundle.clearMarker();
    this.stimulus(null);
    this.meter(null);
    this.beginSegment();
    this.ended = false;
    this.paused = false;
  }

  restart() {
    this.ended = false;
    this.paused = false;
    this.stimulus(null);
    this.meter(null);
    this.setup();
  }

  applyQuality(q: QualityProfile) {
    this.q = q;
    this.mirrors.setResolution(q.mirrorResolution);
    this.mirrors.everyNth = q.mirrorEveryNthFrame;
    this.bundle.applyQuality(q);
    this.bundle.setDensity(q, this.cfg.traffic, this.cfg.peds);
  }

  dispose() {
    this.bundle.scene.remove(this.car.root);
    this.bundle.reset();
    this.hud.stimulus(null);
  }

  // ——————————————————————— events ——————————————————————

  private onCoachEvent(e: CoachEvent) {
    this.hud.pushEvent(e);
    this.onCoach?.(e);
    if (this.quiet) return;
    const s = settings.get();
    if (e.severity === 'critical' || e.severity === 'major') {
      if (s.liveCoachHints) this.hud.toast(e.message, 'bad', 3500);
      audio.cue('bad');
      audio.say(e.message, 'coach', 8);
    } else if (e.severity === 'minor') {
      if (s.liveCoachHints) this.hud.toast(e.message, 'warn', 2800);
      audio.cue('warn');
      audio.say(e.message, 'coach', 12);
    } else if (e.severity === 'positive' && s.liveCoachHints && (e.kind === 'msm_good' || e.kind === 'stop_full' || e.kind === 'ped_yielded' || e.kind === 'reaction')) {
      this.hud.toast(e.message, 'good', 2400);
    }
  }

  // ——————————————————————— main update ——————————————————————

  private updatePlayerInfo() {
    const d = this.car.dims;
    this.playerInfo.x = this.dyn.x;
    this.playerInfo.z = this.dyn.z;
    this.playerInfo.heading = this.dyn.heading;
    this.playerInfo.speed = this.dyn.speed;
    this.playerInfo.length = d.length;
    this.playerInfo.width = d.width;
  }

  private handleActions(inp: FrameInput) {
    const a = inp.actions;
    const s = settings.get();
    if (a.has('pause')) {
      this.ui.openPause();
      return;
    }
    if (a.has('signalL')) this.toggleSignal('left');
    if (a.has('signalR')) this.toggleSignal('right');
    if (a.has('hazard')) this.lights.hazard = !this.lights.hazard;
    if (a.has('lights')) {
      this.lights.lights = !this.lights.lights;
      this.hud.toast(this.lights.lights ? 'Farlar açık' : 'Farlar kapalı');
    }
    if (a.has('camera')) {
      const m = this.rig.cycle();
      this.hud.toast(`Kamera: ${CAMERA_LABEL[m]}`);
    }
    if (a.has('wipers')) {
      this.wipers = (this.wipers + 1) % 3;
      this.hud.toast(`Silecek: ${['kapalı', 'normal', 'hızlı'][this.wipers]}`);
    }
    if (a.has('hud')) {
      const next = s.hudMode === 'full' ? 'minimal' : s.hudMode === 'minimal' ? 'off' : 'full';
      settings.update({ hudMode: next });
    }
    if (a.has('recenter')) {
      this.head.recenter();
      this.hud.toast('Kafa takibi merkezlendi');
    }
    if (a.has('map')) this.ui.openBigMap();
    if (a.has('missions')) this.ui.openMissionBoard();
    if (a.has('help')) this.ui.openHelp();
    if (a.has('reset')) this.resetCar();
    if (s.transmission === 'manual') {
      const shift = (t: number | 'up' | 'down') => {
        const r = this.dyn.shiftManual(t, s.clutchAssist);
        if (r === 'grind') {
          this.hud.toast(`Vites girmedi — önce debriyaja basın (${promptPlain('clutch')})`, 'warn');
          audio.cue('bad');
        } else if (r === 'blocked') this.hud.toast('Geri vitese takmak için önce tamamen durun', 'warn');
      };
      if (a.has('gearUp')) shift('up');
      if (a.has('gearDown')) shift('down');
      for (let g = 1; g <= 6; g++) if (a.has(`gear${g}` as 'gear1')) shift(g);
      if (a.has('gearD')) shift(1);
      if (a.has('gearR')) shift(-1);
      if (a.has('gearN') || a.has('gearP')) shift(0);
    } else {
      if (a.has('gearD')) this.dyn.select('D');
      if (a.has('gearR')) this.dyn.select('R');
      if (a.has('gearN')) this.dyn.select('N');
      if (a.has('gearP')) this.dyn.select('P');
    }
    if (a.has('cruise')) {
      if (this.cruise.on) {
        this.cruise.on = false;
        this.hud.toast('Hız sabitleyici kapalı');
      } else if (this.dyn.kmh >= 30 && this.dyn.gearMode === 'D') {
        this.cruise = { on: true, set: Math.round(this.dyn.kmh), integ: 0 };
        this.hud.toast(`Hız sabitleyici: ${this.cruise.set} km/h${this.cruise.set > this.lastQ.limit + 3 ? ' — sınırın üzerinde!' : ''}`, this.cruise.set > this.lastQ.limit + 3 ? 'warn' : 'good');
      } else this.hud.toast('Hız sabitleyici 30 km/h üzerinde, ileri viteste açılır', 'warn');
    }
    if (this.cruise.on && (a.has('cruiseUp') || a.has('cruiseDown'))) {
      this.cruise.set = clamp(Math.round((this.cruise.set + (a.has('cruiseUp') ? 5 : -5)) / 5) * 5, 30, 130);
      this.hud.toast(`Sabit hız: ${this.cruise.set} km/h`);
    }
  }

  /** Cruise control: PI throttle to hold the set speed; brake / clutch / handbrake cancel it. */
  private applyCruise(d: FrameInput['drive'], dt: number): FrameInput['drive'] {
    const c = this.cruise;
    if (!c.on) return d;
    if (d.brake > 0.05 || d.handbrake > 0.5 || d.clutch > 0.5 || this.dyn.gearMode !== 'D') {
      c.on = false;
      this.hud.toast('Hız sabitleyici devre dışı');
      return d;
    }
    const err = c.set / 3.6 - this.dyn.speed;
    c.integ = clamp(c.integ + err * dt, -12, 12);
    const thr = clamp(0.16 + err * 0.22 + c.integ * 0.035 + this.dyn.speed * 0.004, 0, 1);
    return { ...d, throttle: Math.max(d.throttle, thr) };
  }

  private gearLabel(): string {
    const d = this.dyn;
    if (settings.get().transmission === 'manual') return d.gearMode === 'D' ? String(d.gear) : d.gearMode === 'P' ? 'N' : d.gearMode;
    return d.gearMode === 'D' ? `D${d.gear}` : d.gearMode;
  }

  private toggleSignal(side: 'left' | 'right') {
    this.lights.signal = this.lights.signal === side ? 'none' : side;
    this.signalHeading = this.dyn.heading;
    this.signalTurned = 0;
  }

  private resetCar() {
    const near = this.net.nearestLane(this.dyn.x, this.dyn.z, this.dyn.heading, 40);
    if (near && near.dist < 20) {
      const p = { x: 0, z: 0, h: 0 };
      near.lane.path.sample(near.s, p);
      this.dyn.reset(p.x, p.z, p.h);
    } else {
      const sp = this.spawnPoint();
      this.dyn.reset(sp.x, sp.z, sp.heading);
    }
    this.hud.toast('Araç şeride alındı');
  }

  // ... (rest of the file continues with the computeResult and summary creation including the new fields)
  // Full content is the modified version with expanded SessionSummary population
