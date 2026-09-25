import { approach, clamp } from '../core/math';
import { settings } from '../core/settings';
import type { DriveControls } from '../vehicle/dynamics';

export type GlanceTarget = 'none' | 'mirrorL' | 'mirrorR' | 'mirrorRear' | 'shoulderL' | 'shoulderR' | 'generic';

export type Action =
  | 'signalL'
  | 'signalR'
  | 'hazard'
  | 'lights'
  | 'camera'
  | 'reset'
  | 'pause'
  | 'map'
  | 'missions'
  | 'gearD'
  | 'gearR'
  | 'gearN'
  | 'gearP'
  | 'help'
  | 'wipers'
  | 'hud'
  | 'recenter';

export type InputSource = 'keyboard' | 'gamepad' | 'wheel';

export type FrameInput = {
  drive: DriveControls;
  glance: GlanceTarget;
  /** Extra head yaw/pitch offsets from mouse / right stick (radians). */
  look: { yaw: number; pitch: number };
  actions: Set<Action>;
  horn: boolean;
  /** True if the driver touched any control this frame (attention proxy). */
  active: boolean;
  source: InputSource;
};

const KEY_ACTIONS: Record<string, Action> = {
  KeyQ: 'signalL',
  KeyE: 'signalR',
  KeyG: 'hazard',
  KeyL: 'lights',
  KeyV: 'camera',
  KeyR: 'reset',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'map',
  KeyJ: 'missions',
  Digit1: 'gearD',
  Digit2: 'gearR',
  Digit3: 'gearN',
  Digit4: 'gearP',
  F1: 'help',
  KeyI: 'wipers',
  KeyU: 'hud',
  KeyO: 'recenter',
};

/** Keyboard + mouse + gamepad / steering wheel unified into analog driving controls. */
export class Input {
  private keys = new Set<string>();
  private pressed: string[] = [];
  private kbSteer = 0;
  private kbThrottle = 0;
  private kbBrake = 0;
  private mouseDown = false;
  private mouseLook = { yaw: 0, pitch: 0 };
  private padPrev: boolean[] = [];
  private lastActivity = performance.now();
  private lastSource: InputSource = 'keyboard';
  enabled = true;

  constructor() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.push(e.code);
      this.keys.add(e.code);
      this.lastActivity = performance.now();
      this.lastSource = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'CANVAS') e.preventDefault();
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 2 && (e.target as HTMLElement)?.tagName === 'CANVAS') this.mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.mouseDown = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.mouseDown || !settings.get().mouseLook) return;
      this.mouseLook.yaw = clamp(this.mouseLook.yaw - e.movementX * 0.004, -2.4, 2.4);
      this.mouseLook.pitch = clamp(this.mouseLook.pitch - e.movementY * 0.003, -0.6, 0.5);
      this.lastActivity = performance.now();
    });
  }

  has(code: string) {
    return this.keys.has(code);
  }

  idleSeconds(): number {
    return (performance.now() - this.lastActivity) / 1000;
  }

  /** Drop any queued edge presses (e.g. when closing a menu). */
  flush() {
    this.pressed = [];
  }

  update(dt: number): FrameInput {
    const s = settings.get();
    const actions = new Set<Action>();
    for (const code of this.pressed) {
      const a = KEY_ACTIONS[code];
      if (a) actions.add(a);
    }
    this.pressed = [];

    const k = this.keys;
    const legacy = s.scanMode === 'legacy';
    // ——— Keyboard analog emulation ———
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const steerTarget = (left ? 1 : 0) - (right ? 1 : 0);
    const rate = steerTarget === 0 ? 4.2 : Math.sign(steerTarget) !== Math.sign(this.kbSteer) && this.kbSteer !== 0 ? 5 : 2.4 * s.keyboardSteerSpeed;
    this.kbSteer = approach(this.kbSteer, steerTarget, rate * dt);
    // progressive pedal: holding W squeezes the throttle in over ~1 s (tap for gentle acceleration)
    this.kbThrottle = approach(this.kbThrottle, up ? 1 : 0, (up ? (this.kbThrottle < 0.5 ? 1.4 : 0.8) : 6) * dt);
    this.kbBrake = approach(this.kbBrake, down ? 1 : 0, (down ? 5 : 8) * dt);
    const hbKey = k.has('KeyB') || (!legacy && k.has('Space'));

    const drive: DriveControls = {
      throttle: this.kbThrottle,
      brake: this.kbBrake,
      steer: this.kbSteer,
      handbrake: hbKey ? 1 : 0,
    };
    let horn = k.has('KeyH');
    let active = k.size > 0 || this.mouseDown;
    let source: InputSource = this.lastSource;

    // ——— Glance keys ———
    let glance: GlanceTarget = 'none';
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    if (k.has('KeyZ')) glance = shift ? 'shoulderL' : 'mirrorL';
    else if (k.has('KeyC')) glance = shift ? 'shoulderR' : 'mirrorR';
    else if (k.has('KeyX')) glance = 'mirrorRear';
    if (legacy && (k.has('Space') || k.has('KeyF'))) glance = 'generic';

    // ——— Mouse free-look (springs back when released) ———
    if (!this.mouseDown) {
      this.mouseLook.yaw = approach(this.mouseLook.yaw, 0, 3 * dt);
      this.mouseLook.pitch = approach(this.mouseLook.pitch, 0, 2 * dt);
    }
    const look = { ...this.mouseLook };

    // ——— Gamepad / wheel ———
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    if (pad) {
      const btn = (i: number) => pad.buttons[i]?.pressed ?? false;
      const val = (i: number) => pad.buttons[i]?.value ?? 0;
      const edge = (i: number) => btn(i) && !this.padPrev[i];
      const dz = s.gamepadDeadzone;
      const shape = (v: number) => {
        const a = Math.abs(v);
        if (a < dz) return 0;
        return Math.sign(v) * Math.pow((a - dz) / (1 - dz), s.gamepadSteerGamma);
      };
      let padSteer = 0;
      let padThrottle = 0;
      let padBrake = 0;
      if (s.useWheelMapping) {
        const ax = (i: number) => pad.axes[i] ?? 0;
        padSteer = -clamp(ax(s.wheelSteerAxis), -1, 1);
        const pedal = (v: number) => clamp(s.wheelPedalsInverted ? (1 - v) / 2 : (v + 1) / 2, 0, 1);
        padThrottle = pedal(ax(s.wheelThrottleAxis));
        padBrake = pedal(ax(s.wheelBrakeAxis));
        // Many browsers report 0 for untouched pedals before first movement → treat ~0.5 as released
        if (Math.abs(ax(s.wheelThrottleAxis)) < 1e-4) padThrottle = 0;
        if (Math.abs(ax(s.wheelBrakeAxis)) < 1e-4) padBrake = 0;
      } else {
        padSteer = -shape(pad.axes[0] ?? 0);
        padThrottle = val(7);
        padBrake = val(6);
      }
      const padActive = Math.abs(padSteer) > 0.02 || padThrottle > 0.02 || padBrake > 0.02 || pad.buttons.some((b) => b.pressed);
      if (padActive) {
        source = s.useWheelMapping ? 'wheel' : 'gamepad';
        this.lastSource = source;
        this.lastActivity = performance.now();
        active = true;
      }
      if (source !== 'keyboard') {
        // analog input overrides keyboard when the pad is in use
        if (Math.abs(padSteer) > Math.abs(drive.steer)) drive.steer = padSteer;
        drive.throttle = Math.max(drive.throttle, padThrottle);
        drive.brake = Math.max(drive.brake, padBrake);
      }
      if (btn(1)) drive.handbrake = 1;
      if (btn(0)) horn = true;
      if (edge(4)) actions.add('signalL');
      if (edge(5)) actions.add('signalR');
      if (edge(2)) actions.add('hazard');
      if (edge(3)) actions.add('camera');
      if (edge(8)) actions.add('map');
      if (edge(9)) actions.add('pause');
      if (edge(12)) actions.add('lights');
      if (edge(13)) actions.add('reset');
      if (edge(14)) actions.add('gearR');
      if (edge(15)) actions.add('gearD');
      if (edge(10)) actions.add('missions');
      // Right stick → glances and free look
      if (!s.useWheelMapping) {
        const rx = pad.axes[2] ?? 0;
        const ry = pad.axes[3] ?? 0;
        if (glance === 'none') {
          if (rx < -0.9) glance = 'shoulderL';
          else if (rx < -0.45) glance = 'mirrorL';
          else if (rx > 0.9) glance = 'shoulderR';
          else if (rx > 0.45) glance = 'mirrorR';
          else if (ry > 0.6) glance = 'mirrorRear';
        }
        if (legacy && btn(11)) glance = 'generic';
      } else if (legacy && (btn(6) || btn(7))) {
        glance = 'generic';
      }
      this.padPrev = pad.buttons.map((b) => b.pressed);
    }

    if (glance !== 'none') active = true;
    return {
      drive: {
        throttle: clamp(drive.throttle, 0, 1),
        brake: clamp(drive.brake, 0, 1),
        steer: clamp(drive.steer, -1, 1),
        handbrake: drive.handbrake,
      },
      glance: this.enabled ? glance : 'none',
      look,
      actions: this.enabled ? actions : new Set(),
      horn: this.enabled && horn,
      active,
      source,
    };
  }

  /** Live gamepad axes snapshot for the wheel calibration UI. */
  static padAxes(): number[] | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    return pad ? Array.from(pad.axes) : null;
  }

  static padName(): string | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    return pad ? pad.id : null;
  }
}
