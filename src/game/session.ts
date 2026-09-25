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
import { actionKeys } from '../input/bindings';
import type { TimeOfDay, Weather } from '../world/environment';
import { TIME_LABEL, WEATHER_LABEL } from '../world/environment';
import type { RenderPipeline } from '../render/pipeline';
import { CURB_H } from '../world/roadNetwork';
import type { Contact } from '../world/colliders';
import type { AICar, PlayerInfo } from '../traffic/aiTraffic';

export type SessionConfig = {
  mapId: 'training' | 'city';
  mode: 'free' | 'mission';
  missionId?: string;
  time: TimeOfDay;
  weather: Weather;
  traffic: number;
  peds: number;
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
      bundle.mapRenderer.drawMini(g, w, h, { player: { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading }, route: bundle.nav.route?.line, markers: bundle.markerList() }, 110, false);
    });
    this.monitor = new DrivingMonitor(bundle.world.net, bundle.signals);
    this.monitor.onEvent = (e) => this.onCoachEvent(e);
    bundle.nav.onReroute = () => this.monitor.registerReroute(this.dyn.x, this.dyn.z);
    bundle.nav.onAnnounce = (text) => audio.say(text, 'nav', 3);
    this.setup();
  }

  // ——————————————————————————— MissionHost ———————————————————————————
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

  // ——————————————————————————— setup ———————————————————————————

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
    this.trail = [];
    this.live = null;
    this.hardCrashAt = -1;
    this.runner = null;
    this.segment = 'free';
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

  // ——————————————————————————— events ———————————————————————————

  private onCoachEvent(e: CoachEvent) {
    this.hud.pushEvent(e);
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

  // ——————————————————————————— main update ———————————————————————————

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
          this.hud.toast(`Vites girmedi — önce debriyaja basın (${actionKeys('clutch')})`, 'warn');
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
    const near = this.net.nearestLane(this.dyn.x, this.dyn.z, this.dyn.heading, 80);
    if (!near) return;
    const p = { x: 0, z: 0, h: 0 };
    near.lane.path.sample(Math.min(near.lane.path.length - 2, near.s), p);
    this.dyn.reset(p.x, p.z, p.h);
    this.monitor.registerReset(p.x, p.z);
    this.hud.toast(`Araç en yakın şeride alındı (${actionKeys('reset')})`, 'warn');
  }

  update(dtRaw: number) {
    const dt = Math.min(0.05, dtRaw);
    this.fpsAcc += dtRaw;
    this.fpsN++;
    const b = this.bundle;
    const s = settings.get();
    const inp = this.input.update(dt);
    this.inp = inp;
    if (this.paused || this.ended) {
      this.renderFrame(dt, true);
      return;
    }
    this.elapsed += dt;
    this.handleActions(inp);
    if (this.paused) return;
    if (s.scanMode === 'webcam') this.head.update();

    // ——— Physics (sub-stepped) ———
    const crashed = this.hardCrashAt >= 0;
    const drive = crashed ? { throttle: 0, brake: 1, steer: 0, handbrake: 1, clutch: 1 } : this.applyCruise(inp.drive, dt);
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.dyn.update(h, drive, { mode: s.transmission, clutchAssist: s.clutchAssist, abs: s.abs, speedSensitive: s.speedSensitiveSteering && inp.source === 'keyboard' });
      this.resolveCollisions();
    }
    this.updatePlayerInfo();
    this.odometer += Math.abs(this.dyn.speed) * dt;

    // surface effects
    const q = this.net.query(this.dyn.x, this.dyn.z, this.dyn.heading);
    this.lastQ = q;
    const corners = this.cornerSurfaces();
    const onKerb = corners.some((c) => c === 'sidewalk' || c === 'median');
    const offroad = q.kind === 'offroad';
    this.dyn.grip = b.env.grip * (offroad ? 0.65 : 1);
    if (offroad) this.dyn.speed *= 1 - 0.35 * dt;
    const targetY = q.kind === 'sidewalk' || q.kind === 'median' ? CURB_H : onKerb ? CURB_H * 0.5 : 0;
    if (Math.abs(targetY - this.rollingY) > 0.05 && Math.abs(this.dyn.speed) > 2) this.rig.shake = Math.max(this.rig.shake, 0.25);
    this.rollingY = damp(this.rollingY, targetY, 14, dt);

    // stalled engine (manual gearbox without clutch assist)
    if (this.dyn.stalls !== this.lastStalls) {
      this.lastStalls = this.dyn.stalls;
      this.monitor.emit('stall', this.dyn.x, this.dyn.z, `Motor stop etti — debriyaja basıp (${actionKeys('clutch')}) gaza dokunarak yeniden çalıştırın`);
    }
    // automatic headlights (dusk / night / rain)
    if (s.autoLights) {
      const want = b.env.nightFactor > 0.45 || b.env.wetness > 0.5;
      if (want !== this.autoLightWanted) {
        this.autoLightWanted = want;
        this.lights.lights = want;
      }
    }
    // signal self-cancel after a completed turn
    if (this.lights.signal !== 'none' && s.autoSignalCancel) {
      const turned = angleDiff(this.dyn.heading, this.signalHeading);
      this.signalTurned = Math.max(this.signalTurned, Math.abs(turned));
      if (this.signalTurned > 1.0 && Math.abs(this.dyn.steerAngle) < 0.05) this.lights.signal = 'none';
    }
    this.lights.braking = this.dyn.brakeCmd > 0.05 && Math.abs(this.dyn.speed) > 0.1;
    this.lights.reversing = this.dyn.gearMode === 'R';

    // ——— World simulation ———
    b.signals.update(dt);
    const pedsOnRoad = b.peds.onRoad();
    b.traffic.update(dt, this.playerInfo, pedsOnRoad);
    b.peds.update(dt, this.playerInfo, b.traffic.cars);
    this.checkPedestrianHits();

    // ——— Coaching ———
    const lead = b.traffic.leadOf(this.playerInfo, 70);
    const glanceTarget = this.rig.reached;
    this.monitor.update({
      t: this.elapsed,
      dt,
      x: this.dyn.x,
      z: this.dyn.z,
      heading: this.dyn.heading,
      speed: this.dyn.speed,
      kmh: this.dyn.kmh,
      accel: this.dyn.accel,
      latAccel: this.dyn.latAccel,
      q,
      cornerSurfaces: corners,
      signal: this.lights.hazard ? 'none' : this.lights.signal,
      lights: this.lights.lights,
      night: b.env.nightFactor > 0.6,
      wet: b.env.wetness > 0.5,
      brake: inp.drive.brake,
      throttle: inp.drive.throttle,
      active: inp.active,
      idleSec: this.input.idleSeconds(),
      headYaw: this.rig.headYaw,
      reached: glanceTarget,
      length: this.car.dims.length,
      width: this.car.dims.width,
      lead: lead ? { gap: lead.gap, relSpeed: lead.relSpeed } : null,
      peds: pedsOnRoad,
      cars: b.traffic.cars,
      horn: inp.horn,
      emergency: b.traffic.emergencyNear(this.playerInfo, 90),
    });
    const headway = lead && this.dyn.kmh > 10 ? lead.gap / Math.max(0.1, Math.abs(this.dyn.speed)) : null;
    const ttc = lead && lead.relSpeed > 0.3 ? lead.gap / lead.relSpeed : null;
    this.telemetry.update(dt, this.dyn.speed, () => ({
      t: this.elapsed - this.segStart,
      x: this.dyn.x,
      z: this.dyn.z,
      heading: this.dyn.heading,
      speed: this.dyn.speed,
      kmh: this.dyn.kmh,
      accel: this.dyn.accel,
      latAccel: this.dyn.latAccel,
      yawRate: this.dyn.yawRate,
      steer: inp.drive.steer,
      wheelAngle: this.dyn.wheelAngle,
      throttle: inp.drive.throttle,
      brake: inp.drive.brake,
      limit: q.limit,
      lane: q.laneIndex,
      laneOffset: q.lane ? Math.abs(q.lateral) - Math.abs(q.lane.lateral) : 0,
      surface: q.kind,
      wrongWay: q.wrongWay,
      signal: this.lights.signal === 'left' ? 1 : this.lights.signal === 'right' ? -1 : 0,
      glance: glanceTarget,
      headway,
      ttc,
      inJunction: q.kind === 'junction',
      active: inp.active,
    }));
    this.trailTimer -= dt;
    if (this.trailTimer <= 0) {
      this.trailTimer = 1;
      this.trail.push(this.dyn.x, this.dyn.z);
    }

    // zone entry / exit notices
    const zl = q.zone ? `${q.zone.label} — ${q.zone.limit} km/h${q.zone.noHorn ? ' · korna yasak' : ''}` : null;
    if (zl !== this.zoneNotice) {
      if (zl && q.zone && q.zone.kind !== 'rural') this.hud.toast(`⚠ ${zl}`, 'warn', 3200);
      else if (zl && q.zone?.kind === 'rural' && this.zoneNotice === null) this.hud.toast(`Yerleşim yeri dışı — ${q.zone.limit} km/h`, 'info', 2600);
      else if (!zl && this.zoneNotice) this.hud.toast(`Bölge sonu — sınır ${q.limit} km/h`, 'info', 2400);
      this.zoneNotice = zl;
    }

    // ——— Navigation & mission ———
    b.nav.update(dt, { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading }, q, s.voiceNav);
    b.nav.guide.setVisible(s.routeGuideLine);
    if (this.runner) {
      this.runner.update(dt);
      if (this.runner.state !== 'running') {
        audio.cue(this.runner.state === 'success' ? 'complete' : 'bad');
        this.finishSegment();
        return;
      }
    }
    if (this.hardCrashAt >= 0 && this.elapsed - this.hardCrashAt > 2.2) {
      this.hardCrashAt = -1;
      if (s.endOnHardCrash) {
        this.finishSegment('Ağır kaza');
        return;
      }
    }

    this.renderFrame(dt, false);
  }

  private sirenInfo(): { dist: number; police: boolean } | null {
    const em = this.bundle.traffic.emergencyNear(this.playerInfo, 170);
    if (!em) return null;
    return { dist: Math.hypot(em.x - this.dyn.x, em.z - this.dyn.z), police: em.type === 'police' };
  }

  private hintCache = { key: '', html: '' };
  private hintLine(): string {
    const s = settings.get();
    const key = `${s.transmission}|${JSON.stringify(s.keyBindings)}|${s.scanMode}`;
    if (this.hintCache.key === key) return this.hintCache.html;
    const k = (a: Parameters<typeof actionKeys>[0]) => `<b>${actionKeys(a)}</b>`;
    const parts = [
      `${k('throttle')} gaz`,
      `${k('brake')} fren`,
      `${k('handbrake')} el freni`,
      `${k('signalL')}/${k('signalR')} sinyal`,
      `${k('mirrorL')}/${k('mirrorRear')}/${k('mirrorR')} ayna`,
      s.transmission === 'manual' ? `${k('gearUp')}/${k('gearDown')} vites · ${k('clutch')} debriyaj` : s.transmission === 'selector' ? `${k('gearD')} D · ${k('gearR')} R` : '',
      `${k('cruise')} sabitleyici`,
      `${k('camera')} kamera`,
      `${k('map')} harita`,
      `${k('pause')} menü`,
      `${k('help')} yardım`,
    ].filter(Boolean);
    this.hintCache = { key, html: parts.join(' · ') };
    return this.hintCache.html;
  }

  private cornerSurfaces(): string[] {
    const d = this.car.dims;
    const fx = Math.sin(this.dyn.heading);
    const fz = Math.cos(this.dyn.heading);
    const rx = -fz;
    const rz = fx;
    const out: string[] = [];
    for (const [a, l] of [
      [d.length / 2 - 0.4, d.width / 2 - 0.15],
      [d.length / 2 - 0.4, -d.width / 2 + 0.15],
      [-d.length / 2 + 0.4, d.width / 2 - 0.15],
      [-d.length / 2 + 0.4, -d.width / 2 + 0.15],
    ]) {
      const x = this.dyn.x + fx * a + rx * l;
      const z = this.dyn.z + fz * a + rz * l;
      const q = this.net.query(x, z, this.dyn.heading);
      out.push(q.kind);
    }
    return out;
  }

  private resolveCollisions() {
    const d = this.car.dims;
    const dyn = this.dyn;
    const fx = Math.sin(dyn.heading);
    const fz = Math.cos(dyn.heading);
    const r = d.width / 2;
    const offs = [d.length / 2 - r, 0, -(d.length / 2 - r)];
    let hitTag: string | null = null;
    let nx = 0;
    let nz = 0;
    const contacts: Contact[] = [];
    for (const o of offs) {
      const p = { x: dyn.x + fx * o, z: dyn.z + fz * o };
      const before = { ...p };
      contacts.length = 0;
      this.bundle.world.colliders.resolveCircle(p, r, contacts);
      if (contacts.length) {
        dyn.x += p.x - before.x;
        dyn.z += p.z - before.z;
        for (const c of contacts) {
          nx += c.nx;
          nz += c.nz;
          hitTag = c.tag;
        }
      }
    }
    if (hitTag) {
      const l = Math.hypot(nx, nz) || 1;
      const impact = dyn.applyImpact(nx / l, nz / l, 0.1) * 3.6;
      if (impact > 4) this.onImpact(hitTag === 'parked' ? 'vehicle' : 'static', impact, null);
    }
    // AI vehicles (oriented boxes)
    for (const c of this.bundle.traffic.cars) {
      // an emergency vehicle squeezing past on the left never rams the player
      if (c.siren && c.passing > 0.2) continue;
      const mtv = obbOverlap(dyn.x, dyn.z, dyn.heading, d.width / 2, d.length / 2, c.x, c.z, c.heading, c.width / 2, c.length / 2);
      if (!mtv) continue;
      dyn.x += mtv.nx * mtv.depth;
      dyn.z += mtv.nz * mtv.depth;
      // relative velocity along the normal
      const pvx = Math.sin(dyn.heading) * dyn.speed;
      const pvz = Math.cos(dyn.heading) * dyn.speed;
      const cvx = Math.sin(c.heading) * c.v;
      const cvz = Math.cos(c.heading) * c.v;
      const rel = -((pvx - cvx) * mtv.nx + (pvz - cvz) * mtv.nz);
      dyn.applyImpact(mtv.nx, mtv.nz, 0.2);
      if (rel * 3.6 > 3) {
        this.bundle.traffic.crash(c);
        this.onImpact('vehicle', rel * 3.6, c);
      }
    }
  }

  private lastImpactAt = -99;
  private onImpact(kind: 'vehicle' | 'static', kmh: number, _c: AICar | null) {
    if (this.elapsed - this.lastImpactAt < 0.6) return;
    this.lastImpactAt = this.elapsed;
    const hard = kind === 'vehicle' ? kmh > 32 : kmh > 45;
    this.monitor.registerImpact(kind, kmh, this.dyn.x, this.dyn.z, hard);
    this.rig.shake = Math.min(1.2, 0.3 + kmh / 40);
    this.hud.crash(Math.min(1, kmh / 50));
    audio.crash(Math.min(1, kmh / 50));
    if (hard) {
      this.hardCrashAt = this.elapsed;
      this.lights.hazard = true;
      this.hud.toast('AĞIR KAZA', 'bad', 3000);
    }
  }

  private checkPedestrianHits() {
    const d = this.car.dims;
    const fx = Math.sin(this.dyn.heading);
    const fz = Math.cos(this.dyn.heading);
    for (const p of this.bundle.peds.peds) {
      if (p.down) continue;
      const dx = p.x - this.dyn.x;
      const dz = p.z - this.dyn.z;
      if (dx * dx + dz * dz > 16) continue;
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (Math.abs(along) < d.length / 2 + 0.2 && Math.abs(lat) < d.width / 2 + 0.2) {
        if (this.dyn.kmh > 3) {
          this.bundle.peds.knockDown(p, this.dyn.heading);
          this.monitor.registerImpact('pedestrian', this.dyn.kmh, this.dyn.x, this.dyn.z, true);
          this.dyn.speed *= 0.5;
          this.rig.shake = 0.8;
          this.hud.crash(0.7);
          audio.crash(0.5);
          this.hardCrashAt = this.elapsed;
        }
      }
    }
  }

  // ——————————————————————————— rendering & HUD ———————————————————————————

  private renderFrame(dt: number, frozen: boolean) {
    const b = this.bundle;
    const s = settings.get();
    const inp = this.inp;
    this.car.sync(this.dyn, this.lights, frozen ? 0 : dt, b.env.nightFactor);
    this.car.root.position.y = this.rollingY;
    const webcam = s.scanMode === 'webcam' && s.webcamDrivesCamera && (this.head.status === 'running') ? { yaw: this.head.yaw, pitch: this.head.pitch } : null;
    const glance = s.scanMode === 'webcam' && this.head.status === 'running' && inp.glance === 'none' ? this.head.glance : inp.glance;
    this.rig.update(dt, this.car, this.dyn, { glance: frozen ? 'none' : glance, mouseYaw: inp.look.yaw, mousePitch: inp.look.pitch, webcam: frozen ? null : webcam });
    const now = new Date();
    this.car.updateCockpit(
      {
        kmh: this.dyn.kmh,
        rpm: this.dyn.rpm,
        redline: this.dyn.p.redline,
        gearLabel: this.gearLabel(),
        signalL: this.lights.signal === 'left' || this.lights.hazard,
        signalR: this.lights.signal === 'right' || this.lights.hazard,
        blinkOn: this.car.blinkOn,
        lights: this.lights.lights,
        handbrake: this.dyn.handbrakeOn,
        limit: this.lastQ.limit ?? 50,
        wheelAngle: this.dyn.wheelAngle,
        seatbelt: true,
        odometerKm: 12840 + this.odometer / 1000,
        navText: b.nav.instruction?.text ?? '',
        navDist: b.nav.instruction ? `${Math.round(b.nav.instruction.dist)} m` : '',
        navArrow: b.nav.instruction?.arrow ?? '',
        clock: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        temp: b.env.weather === 'rain' ? '12°C' : b.env.time === 'night' ? '14°C' : '22°C',
        wipers: this.wipers,
      },
      dt,
      b.env.wetness
    );
    b.env.update(dt, this.tmpV.set(this.dyn.x, 0, this.dyn.z), this.camera);
    b.world.update(this.elapsed);
    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.lodTimer = 0.5;
      b.world.updateLod(this.camera.position.x, this.camera.position.z, this.q.drawDistance * 1.05 + 60);
    }
    b.traffic.render(dt, this.dyn.x, this.dyn.z, this.car.blinkOn, Math.min(260, this.q.drawDistance * 0.5));
    b.update(dt);
    // mirrors: always in cockpit view; otherwise only while glancing (HUD overlay)
    this.mirrors.render(this.pipeline.renderer, b.scene, this.car, { cockpit: this.rig.isInterior, glance: this.rig.isInterior ? 'none' : glance });
    this.pipeline.render();
    this.mirrors.renderOverlay(this.pipeline.renderer, glance, !this.rig.isInterior && !frozen);
    audio.update({
      rpm: this.dyn.rpm,
      throttle: inp.drive.throttle,
      kmh: this.dyn.kmh,
      slip: this.dyn.slip,
      horn: inp.horn && !frozen,
      blink: this.car.blinkOn,
      blinking: this.lights.signal !== 'none' || this.lights.hazard,
      rain: b.env.wetness,
      interior: this.rig.isInterior,
      siren: this.sirenInfo(),
    });
    if (frozen) return;
    this.updateHud(dt, glance);
  }

  private updateHud(dt: number, glance: string) {
    const s = settings.get();
    const b = this.bundle;
    const hud = this.hud;
    hud.setMode(s.hudMode);
    hud.root.classList.toggle('interior', this.rig.isInterior);
    this.hudTimer -= dt;
    this.mapTimer -= dt;
    this.scoreTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 1 / 20;
      hud.setCluster({
        kmh: this.dyn.kmh,
        limit: this.lastQ.limit ?? 50,
        gear: this.gearLabel(),
        rpmFrac: this.dyn.rpm / this.dyn.p.redline,
        sigL: this.lights.signal === 'left' || this.lights.hazard,
        sigR: this.lights.signal === 'right' || this.lights.hazard,
        blink: this.car.blinkOn,
        lights: this.lights.lights,
        handbrake: this.dyn.handbrakeOn,
        wipers: this.wipers,
        cam: CAMERA_LABEL[this.rig.mode],
        cruise: this.cruise.on ? this.cruise.set : null,
        engineOff: !this.dyn.engineOn,
        abs: s.abs,
        clutch: s.transmission === 'manual' ? 1 - this.dyn.clutchEngage : undefined,
      });
      hud.setHints(this.hintLine());
      const last = this.telemetry.last();
      hud.setHeadway(last?.headway ?? null, b.env.wetness > 0.5);
      hud.setNav(b.nav.instruction);
      const scan = this.monitor.scan;
      const ago = (k: 'mirrorL' | 'mirrorR' | 'mirrorRear' | 'shoulderL' | 'shoulderR') => {
        for (let i = scan.glances.length - 1; i >= 0; i--) if (scan.glances[i].kind === k || scan.glances[i].kind === 'generic') return this.elapsed - scan.glances[i].end;
        return 999;
      };
      hud.setScan({ mirrorL: ago('mirrorL'), mirrorR: ago('mirrorR'), mirrorRear: ago('mirrorRear'), shoulderL: ago('shoulderL'), shoulderR: ago('shoulderR'), sinceAny: scan.secondsSinceAny(this.elapsed), glance });
      const segT = this.elapsed - this.segStart;
      if (this.runner) {
        const r = this.runner;
        const limit = r.def.timeLimit ? ` / ${formatTime(r.def.timeLimit)}` : '';
        hud.setMission(`${r.def.icon} ${r.def.title}`, r.def.subtitle, r.objectives(), r.hint, formatTime(r.elapsed) + limit);
      } else {
        hud.setMission(
          this.segment === 'free' ? '🚗 Serbest sürüş' : '',
          this.bundle.map.id === 'city' ? 'Görev panosu: J · Harita: M (hedef seçmek için tıkla)' : 'Eğitim alanı — M ile haritadan hedef seç',
          [],
          '',
          formatTime(segT)
        );
      }
      hud.meter(this.meterState?.label ?? null, this.meterState?.v ?? 0);
      hud.setStats(segT, this.monitor.stats.distance, `${this.monitor.scan.rate().toFixed(1)} ayna/dk`);
      if (this.fpsN > 0 && s.showFps) hud.setFps(this.fpsN / this.fpsAcc);
      else hud.setFps(null);
      if (this.fpsAcc > 1) {
        this.fpsAcc = 0;
        this.fpsN = 0;
      }
    }
    if (this.scoreTimer <= 0) {
      this.scoreTimer = 2;
      this.live = this.computeResult();
    }
    if (this.live) hud.setScores(this.live.components, this.live.overall, s.hudMode === 'full' && this.elapsed - this.segStart > 20);
    if (this.mapTimer <= 0) {
      this.mapTimer = 1 / 15;
      const g = hud.minimap.getContext('2d')!;
      b.mapRenderer.drawMini(g, hud.minimap.width, hud.minimap.height, {
        player: { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading },
        route: b.nav.route?.line,
        cars: b.traffic.cars,
        markers: b.markerList(),
      }, 110 + Math.min(200, this.dyn.kmh * 1.6));
    }
  }

  // ——————————————————————————— results ———————————————————————————

  private computeResult(): SessionResult {
    const prof = activeProfile();
    return computeSession({
      samples: this.telemetry.samples,
      stats: this.monitor.stats,
      events: this.monitor.events,
      durationSec: this.elapsed - this.segStart,
      objectives: this.runner ? this.runner.counts() : null,
      mirrorRate: this.monitor.scan.rate(),
      maxMirrorGap: this.monitor.scan.maxGap,
      shoulderChecks: this.monitor.scan.count('shoulderL') + this.monitor.scan.count('shoulderR'),
      signalLeads: this.monitor.signalLeads,
      baseline: prof?.baseline.ready ? prof.baseline : null,
      wet: this.bundle.env.wetness > 0.5,
      night: this.bundle.env.nightFactor > 0.6,
    });
  }

  /** End the current segment and show the report. */
  finishSegment(reason?: string) {
    if (this.ended) return;
    this.ended = true;
    if (reason && this.runner && this.runner.state === 'running') this.runner.fail(reason);
    const res = this.computeResult();
    const b = this.bundle;
    const st = this.monitor.stats;
    const mission = this.runner
      ? {
          def: this.runner.def,
          success: this.runner.state === 'success',
          stars: starsFor(this.runner.state === 'success', res.overall, this.monitor.events.filter((e) => e.severity === 'critical').length),
          failReason: this.runner.failReason || (this.runner.state === 'running' ? 'Görev yarıda bırakıldı' : ''),
          lines: this.runner.results,
          objectives: this.runner.objectives(),
        }
      : null;
    const conditions = `${TIME_LABEL[b.env.time]} · ${WEATHER_LABEL[b.env.weather]}`;
    const profile = activeProfile();
    let karne: KarneUpdate | null = null;
    const durationSec = this.elapsed - this.segStart;
    if (profile && durationSec > 25) {
      const man = st.turns.total + st.laneChanges.total;
      const summary: SessionSummary = {
        id: Math.random().toString(36).slice(2),
        at: Date.now(),
        map: b.map.name,
        kind: this.segment,
        missionId: mission?.def.id,
        missionTitle: mission?.def.title,
        success: mission?.success,
        stars: mission?.stars,
        overall: res.overall,
        grade: res.grade,
        components: res.components,
        distanceKm: res.distanceKm,
        durationSec,
        risk: res.risk,
        conditions,
        highlights: res.tips.slice(0, 2),
      };
      karne = applySession(profile, res, summary, {
        mirrorBefore: man ? ((st.turns.mirror + st.laneChanges.mirror) / man) * 100 : null,
        maneuvers: man,
        signalsAll: man > 0 && st.turns.signaled + st.laneChanges.signaled === man,
        pedYielded: st.pedYielded,
        pedConflicts: st.pedConflicts,
        night: b.env.nightFactor > 0.6,
        rain: b.env.wetness > 0.5,
        calibration: this.segment === 'calibration' && !!mission?.success,
      });
    }
    this.stimulus(null);
    this.meter(null);
    this.ui.showReport({
      result: res,
      events: [...this.monitor.events],
      samples: this.telemetry.samples,
      stats: st,
      mission,
      mapName: b.map.name,
      mapId: b.map.id,
      conditions,
      karne,
      profileName: profile?.name ?? null,
      baseline: profile?.baseline.ready ? profile.baseline : null,
      scan: { rate: this.monitor.scan.rate(), maxGap: this.monitor.scan.maxGap, glances: this.monitor.scan.count(), shoulder: this.monitor.scan.count('shoulderL') + this.monitor.scan.count('shoulderR') },
      at: Date.now(),
    });
  }

  csv(): string {
    return this.telemetry.toCSV();
  }

  get trailPoints() {
    return this.trail;
  }

  get position() {
    return { x: this.dyn.x, z: this.dyn.z, heading: this.dyn.heading };
  }

  setPaused(p: boolean) {
    this.paused = p;
    audio.setActive(!p);
    this.input.flush();
  }

  /** Big-map click: navigate there (free drive). */
  navigateTo(x: number, z: number) {
    const ok = this.navigate(x, z, 'Seçilen hedef');
    if (ok) {
      this.bundle.marker('free', this.bundle.nav.route!.dest.x, this.bundle.nav.route!.dest.z, { kind: 'beacon', color: 0x35a7ff });
      this.hud.toast('Rota oluşturuldu', 'good');
    } else this.hud.toast('Bu noktaya rota bulunamadı', 'warn');
  }
}

/** Separating-axis test for two oriented rectangles. Returns MTV pushing A out of B. */
function obbOverlap(ax: number, az: number, ah: number, aw: number, al: number, bx: number, bz: number, bh: number, bw: number, bl: number) {
  const axes = [
    [Math.cos(ah), -Math.sin(ah)],
    [Math.sin(ah), Math.cos(ah)],
    [Math.cos(bh), -Math.sin(bh)],
    [Math.sin(bh), Math.cos(bh)],
  ];
  const dx = bx - ax;
  const dz = bz - az;
  let best = Infinity;
  let bn: [number, number] = [0, 0];
  const aAxes = [axes[0], axes[1]];
  const bAxes = [axes[2], axes[3]];
  for (const [nx, nz] of axes) {
    const ra = aw * Math.abs(aAxes[0][0] * nx + aAxes[0][1] * nz) + al * Math.abs(aAxes[1][0] * nx + aAxes[1][1] * nz);
    const rb = bw * Math.abs(bAxes[0][0] * nx + bAxes[0][1] * nz) + bl * Math.abs(bAxes[1][0] * nx + bAxes[1][1] * nz);
    const dist = dx * nx + dz * nz;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      const sgn = dist > 0 ? -1 : 1; // push A away from B
      bn = [nx * sgn, nz * sgn];
    }
  }
  return { nx: bn[0], nz: bn[1], depth: clamp(best, 0, 1.5) };
}
