import { storage } from './storage';
import { Emitter } from './emitter';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type ScanMode = 'keys' | 'webcam' | 'legacy';
export type TransmissionMode = 'auto' | 'selector' | 'manual';
export type ControlPreset = 'easy' | 'advanced' | 'custom';
export type HudMode = 'full' | 'minimal' | 'off';
export type PlayerCarType = 'hatch' | 'sedan' | 'suv';

export type Settings = {
  // Graphics
  quality: QualityLevel;
  /** True until the user picks a preset manually — then auto-detection never overrides it. */
  qualityAuto: boolean;
  showFps: boolean;
  // Camera
  fov: number;
  seatHeight: number;
  seatForward: number;
  headMotion: boolean;
  mouseLook: boolean;
  // Scanning / attention proxy
  scanMode: ScanMode;
  webcamYawThreshold: number;
  webcamDrivesCamera: boolean;
  webcamPreview: boolean;
  // Controls
  controlPreset: ControlPreset;
  /** Custom key bindings (action → KeyboardEvent.code list); empty = defaults. */
  keyBindings: Record<string, string[]>;
  clutchAssist: boolean;
  abs: boolean;
  autoSignalCancel: boolean;
  autoLights: boolean;
  keyboardSteerSpeed: number;
  speedSensitiveSteering: boolean;
  transmission: TransmissionMode;
  gamepadDeadzone: number;
  gamepadSteerGamma: number;
  wheelSteerAxis: number;
  wheelThrottleAxis: number;
  wheelBrakeAxis: number;
  wheelPedalsInverted: boolean;
  useWheelMapping: boolean;
  // Vehicle
  playerCar: PlayerCarType;
  playerColor: string;
  // Audio
  masterVolume: number;
  engineVolume: number;
  voiceNav: boolean;
  voiceCoach: boolean;
  // Coaching
  hudMode: HudMode;
  liveCoachHints: boolean;
  routeGuideLine: boolean;
  surpriseEvents: boolean;
  emergencyVehicles: boolean;
  endOnHardCrash: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  qualityAuto: true,
  showFps: false,
  fov: 72,
  seatHeight: 0,
  seatForward: 0,
  headMotion: true,
  mouseLook: true,
  scanMode: 'keys',
  webcamYawThreshold: 20,
  webcamDrivesCamera: true,
  webcamPreview: true,
  controlPreset: 'easy',
  keyBindings: {},
  clutchAssist: true,
  abs: true,
  autoSignalCancel: true,
  autoLights: true,
  keyboardSteerSpeed: 1,
  speedSensitiveSteering: true,
  transmission: 'auto',
  gamepadDeadzone: 0.06,
  gamepadSteerGamma: 1.35,
  wheelSteerAxis: 0,
  wheelThrottleAxis: 2,
  wheelBrakeAxis: 3,
  wheelPedalsInverted: true,
  useWheelMapping: false,
  playerCar: 'hatch',
  playerColor: '#f2f4f7',
  masterVolume: 0.7,
  engineVolume: 0.8,
  voiceNav: true,
  voiceCoach: false,
  hudMode: 'full',
  liveCoachHints: true,
  routeGuideLine: true,
  surpriseEvents: true,
  emergencyVehicles: true,
  endOnHardCrash: false,
};

const KEY = 'ssc-settings-v1';

/** Control presets: "Kolay" hides the mechanics, "Gelişmiş" is close to a real driving-school car. */
export const CONTROL_PRESETS: Record<Exclude<ControlPreset, 'custom'>, Partial<Settings>> = {
  easy: { transmission: 'auto', clutchAssist: true, abs: true, autoSignalCancel: true, autoLights: true, speedSensitiveSteering: true },
  advanced: { transmission: 'manual', clutchAssist: false, abs: true, autoSignalCancel: true, autoLights: false, speedSensitiveSteering: false },
};

/** Settings that belong to a control preset (changing one makes the preset "custom"). */
export const PRESET_KEYS: (keyof Settings)[] = ['transmission', 'clutchAssist', 'abs', 'autoSignalCancel', 'autoLights', 'speedSensitiveSteering'];

type SettingsEvents = { change: { settings: Settings; keys: (keyof Settings)[] } };

class SettingsStore extends Emitter<SettingsEvents> {
  private data: Settings;

  constructor() {
    super();
    this.data = { ...DEFAULT_SETTINGS, ...storage.get<Partial<Settings>>(KEY, {}) };
  }

  get(): Readonly<Settings> {
    return this.data;
  }

  update(patch: Partial<Settings>) {
    const keys = Object.keys(patch) as (keyof Settings)[];
    const changed = keys.filter((k) => this.data[k] !== patch[k]);
    if (!changed.length) return;
    this.data = { ...this.data, ...patch };
    storage.set(KEY, this.data);
    this.emit('change', { settings: this.data, keys: changed });
  }

  reset() {
    this.data = { ...DEFAULT_SETTINGS };
    storage.set(KEY, this.data);
    this.emit('change', { settings: this.data, keys: Object.keys(this.data) as (keyof Settings)[] });
  }
}

export const settings = new SettingsStore();

export type QualityProfile = {
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  antialias: 'none' | 'fxaa' | 'smaa';
  drawDistance: number;
  trafficCount: number;
  pedestrianCount: number;
  mirrorResolution: number;
  mirrorEveryNthFrame: number;
  anisotropy: number;
  rainDrops: number;
};

export function qualityProfile(q: QualityLevel): QualityProfile {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  switch (q) {
    case 'low':
      return {
        pixelRatio: Math.min(dpr, 1) * 0.8,
        shadows: false,
        shadowMapSize: 512,
        bloom: false,
        antialias: 'none',
        drawDistance: 260,
        trafficCount: 18,
        pedestrianCount: 10,
        mirrorResolution: 192,
        mirrorEveryNthFrame: 3,
        anisotropy: 1,
        rainDrops: 1200,
      };
    case 'medium':
      return {
        pixelRatio: Math.min(dpr, 1),
        shadows: true,
        shadowMapSize: 1024,
        bloom: false,
        antialias: 'fxaa',
        drawDistance: 380,
        trafficCount: 26,
        pedestrianCount: 18,
        mirrorResolution: 256,
        mirrorEveryNthFrame: 2,
        anisotropy: 4,
        rainDrops: 2500,
      };
    case 'high':
      return {
        pixelRatio: Math.min(dpr, 1.5),
        shadows: true,
        shadowMapSize: 2048,
        bloom: true,
        antialias: 'fxaa',
        drawDistance: 520,
        trafficCount: 34,
        pedestrianCount: 28,
        mirrorResolution: 384,
        mirrorEveryNthFrame: 2,
        anisotropy: 8,
        rainDrops: 4000,
      };
    case 'ultra':
    default:
      return {
        pixelRatio: Math.min(dpr, 2),
        shadows: true,
        shadowMapSize: 4096,
        bloom: true,
        antialias: 'smaa',
        drawDistance: 700,
        trafficCount: 44,
        pedestrianCount: 40,
        mirrorResolution: 512,
        mirrorEveryNthFrame: 1,
        anisotropy: 16,
        rainDrops: 6000,
      };
  }
}

/** Heuristic first-run quality pick from the GPU renderer string. */
export function detectQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): QualityLevel {
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    ).toLowerCase();
  } catch {
    /* ignore */
  }
  const cores = navigator.hardwareConcurrency || 4;
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(renderer)) return 'low';
  if (/mali|adreno|powervr|apple gpu/.test(renderer) && cores <= 8) return 'medium';
  if (/intel/.test(renderer) && !/arc/.test(renderer)) return cores >= 8 ? 'medium' : 'low';
  if (/rtx|radeon rx [67]|rx 7|rx 9|arc|apple m[2-9]/.test(renderer)) return 'ultra';
  return 'high';
}
