import { clamp, damp, approach } from '../core/math';

export type DriveControls = {
  throttle: number; // 0..1 (W / right trigger / gas pedal)
  brake: number; // 0..1 (S / left trigger / brake pedal)
  steer: number; // −1..1, positive = left
  handbrake: number; // 0..1
  clutch: number; // 0..1 (1 = pedal fully pressed / disengaged)
};

export type TransmissionKind = 'auto' | 'selector' | 'manual';

export type DriveOptions = { mode: TransmissionKind; clutchAssist: boolean; abs: boolean; speedSensitive: boolean };

export type GearMode = 'P' | 'R' | 'N' | 'D';

export type VehicleParams = {
  mass: number;
  wheelBase: number;
  wheelRadius: number;
  maxSteer: number;
  steerRatio: number;
  idleRpm: number;
  redline: number;
  peakTorque: number;
  gears: number[];
  reverseRatio: number;
  finalDrive: number;
  dragCoef: number;
  rollRes: number;
  maxBrakeDecel: number;
};

export const PARAMS: Record<'hatch' | 'sedan' | 'suv', VehicleParams> = {
  hatch: {
    mass: 1180,
    wheelBase: 2.55,
    wheelRadius: 0.31,
    maxSteer: 0.56,
    steerRatio: 15,
    idleRpm: 800,
    redline: 6300,
    peakTorque: 200,
    gears: [3.73, 2.14, 1.41, 1.12, 0.89, 0.74],
    reverseRatio: 3.5,
    finalDrive: 3.94,
    dragCoef: 0.36,
    rollRes: 0.013,
    maxBrakeDecel: 9.2,
  },
  sedan: {
    mass: 1350,
    wheelBase: 2.68,
    wheelRadius: 0.32,
    maxSteer: 0.55,
    steerRatio: 15.5,
    idleRpm: 750,
    redline: 6200,
    peakTorque: 250,
    gears: [3.6, 2.08, 1.36, 1.03, 0.84, 0.69],
    reverseRatio: 3.4,
    finalDrive: 3.7,
    dragCoef: 0.34,
    rollRes: 0.013,
    maxBrakeDecel: 9.4,
  },
  suv: {
    mass: 1620,
    wheelBase: 2.72,
    wheelRadius: 0.37,
    maxSteer: 0.54,
    steerRatio: 16,
    idleRpm: 750,
    redline: 5800,
    peakTorque: 320,
    gears: [3.9, 2.25, 1.47, 1.1, 0.87, 0.7],
    reverseRatio: 3.6,
    finalDrive: 3.6,
    dragCoef: 0.46,
    rollRes: 0.015,
    maxBrakeDecel: 8.9,
  },
};

const G = 9.81;

export class VehicleDynamics {
  p: VehicleParams;
  x = 0;
  z = 0;
  heading = 0;
  /** Signed longitudinal speed (m/s), positive = forward. */
  speed = 0;
  yawRate = 0;
  steerAngle = 0;
  gearMode: GearMode = 'D';
  gear = 1;
  rpm = 800;
  accel = 0;
  latAccel = 0;
  /** 0..1 how much the tyres exceed grip (understeer / wheelspin / lock). */
  slip = 0;
  wheelSpin = 0;
  bodyRoll = 0;
  bodyPitch = 0;
  /** Friction multiplier from weather/surface (1 = dry asphalt). */
  grip = 1;
  handbrakeOn = false;
  /** Seconds the brake has been held at standstill (auto D→R). */
  private holdStill = 0;
  private shiftTimer = 0;
  /** Effective drive / brake after gear logic (for telemetry). */
  driveCmd = 0;
  brakeCmd = 0;
  /** Manual gearbox state. */
  engineOn = true;
  stalls = 0;
  private stallT = 0;
  private crankT = 0;
  private lastClutch = 0;
  /** Clutch engagement 0..1 actually transmitting torque (for HUD / telemetry). */
  clutchEngage = 1;
  wheelLock = false;
  mode: TransmissionKind = 'auto';

  constructor(p: VehicleParams) {
    this.p = p;
  }

  reset(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.gearMode = 'D';
    this.gear = 1;
    this.rpm = this.p.idleRpm;
    this.accel = 0;
    this.latAccel = 0;
    this.slip = 0;
    this.holdStill = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this.engineOn = true;
    this.stallT = 0;
    this.crankT = 0;
    this.wheelLock = false;
    if (this.mode === 'manual') {
      this.gearMode = 'N';
      this.gear = 1;
    }
  }

  private torque(rpm: number): number {
    const p = this.p;
    let f: number;
    if (rpm < 1200) f = 0.55 + (rpm / 1200) * 0.15;
    else if (rpm < 3200) f = 0.7 + ((rpm - 1200) / 2000) * 0.3;
    else if (rpm < 5000) f = 1;
    else f = 1 - ((rpm - 5000) / (p.redline - 5000)) * 0.25;
    return p.peakTorque * clamp(f, 0, 1);
  }

  private autoShift(dt: number, throttle: number) {
    const p = this.p;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.shiftTimer > 0) return;
    const wheelRpm = (Math.abs(this.speed) / p.wheelRadius) * (60 / (2 * Math.PI));
    const rpmIn = wheelRpm * p.gears[this.gear - 1] * p.finalDrive;
    const up = 2300 + throttle * 3200;
    const down = 1250 + throttle * 1300;
    if (rpmIn > up && this.gear < p.gears.length) {
      this.gear++;
      this.shiftTimer = 0.45;
    } else if (this.gear > 1) {
      const rpmLower = wheelRpm * p.gears[this.gear - 2] * p.finalDrive;
      if (rpmIn < down && rpmLower < p.redline * 0.85) {
        this.gear--;
        this.shiftTimer = 0.35;
      }
    }
  }

  /**
   * Manual gearbox: select gear n (1..6), 0 = neutral, −1 = reverse, or step up/down.
   * Without clutch assist the clutch must be pressed, otherwise the gears grind.
   */
  shiftManual(target: number | 'up' | 'down', clutchAssist: boolean): 'ok' | 'grind' | 'blocked' {
    const cur = this.gearMode === 'R' ? -1 : this.gearMode === 'N' || this.gearMode === 'P' ? 0 : this.gear;
    let next: number;
    if (target === 'up') next = cur < 0 ? 0 : Math.min(this.p.gears.length, cur + 1);
    else if (target === 'down') next = cur <= 0 ? (Math.abs(this.speed) < 1.5 ? -1 : 0) : cur - 1;
    else next = clamp(target, -1, this.p.gears.length);
    if (next === cur) return 'ok';
    if (!clutchAssist && this.lastClutch < 0.6 && next !== 0 && this.engineOn) return 'grind';
    if (next === -1 && this.speed > 1.5) return 'blocked';
    if (cur === -1 && next > 0 && this.speed < -1.5) return 'blocked';
    if (next === -1) this.gearMode = 'R';
    else if (next === 0) this.gearMode = 'N';
    else {
      this.gearMode = 'D';
      this.gear = next;
    }
    this.shiftTimer = clutchAssist ? 0.3 : 0;
    return 'ok';
  }

  /** Manually request a gear mode (selector transmission). */
  select(mode: GearMode) {
    if (mode === this.gearMode) return;
    // Only allow R/P while nearly stopped (like a real selector interlock).
    if ((mode === 'R' || mode === 'P' || this.gearMode === 'R') && Math.abs(this.speed) > 1.5) return;
    this.gearMode = mode;
    this.gear = 1;
  }

  update(dt: number, c: DriveControls, opts: DriveOptions) {
    const p = this.p;
    const absV = Math.abs(this.speed);
    const mu = 0.95 * this.grip;
    if (opts.mode !== this.mode) {
      this.mode = opts.mode;
      if (opts.mode === 'manual' && this.gearMode === 'P') this.gearMode = 'N';
      this.engineOn = true;
    }
    this.lastClutch = c.clutch;
    if (opts.mode === 'manual') return this.updateManual(dt, c, opts);

    // ——— Gear logic ———
    let drive = 0;
    let brake = 0;
    if (opts.mode === 'auto') {
      if (this.gearMode === 'P' || this.gearMode === 'N') this.gearMode = 'D';
      if (this.gearMode === 'D') {
        drive = c.throttle;
        brake = c.brake;
        if (absV < 0.25 && c.brake > 0.5 && c.throttle < 0.05) {
          this.holdStill += dt;
          if (this.holdStill > 0.35) {
            this.gearMode = 'R';
            this.holdStill = 0;
          }
        } else this.holdStill = 0;
      } else {
        // Reverse: S drives backwards, W brakes; stop + W → Drive
        drive = c.brake;
        brake = c.throttle;
        if (absV < 0.25 && c.throttle > 0.3 && c.brake < 0.05) {
          this.holdStill += dt;
          if (this.holdStill > 0.12) {
            this.gearMode = 'D';
            this.gear = 1;
            this.holdStill = 0;
          }
        } else this.holdStill = 0;
      }
    } else {
      drive = this.gearMode === 'D' || this.gearMode === 'R' ? c.throttle : 0;
      brake = c.brake;
    }
    this.driveCmd = drive;
    this.brakeCmd = brake;
    this.handbrakeOn = c.handbrake > 0.5;

    // ——— Engine / drive force ———
    const dir = this.gearMode === 'R' ? -1 : 1;
    let ratio = 0;
    if (this.gearMode === 'D') {
      this.autoShift(dt, drive);
      ratio = p.gears[this.gear - 1];
    } else if (this.gearMode === 'R') {
      ratio = p.reverseRatio;
    }
    const wheelRpm = (absV / p.wheelRadius) * (60 / (2 * Math.PI));
    const coupledRpm = wheelRpm * ratio * p.finalDrive;
    // torque converter: engine can rev above wheel speed at low speed
    const slipRpm = p.idleRpm + drive * 2600;
    const targetRpm = ratio > 0 ? Math.max(coupledRpm, absV < 6 ? slipRpm * (1 - absV / 8) : 0, p.idleRpm) : p.idleRpm + drive * 4000;
    this.rpm = damp(this.rpm, clamp(targetRpm, p.idleRpm, p.redline), this.shiftTimer > 0 ? 6 : 12, dt);

    let force = 0;
    if (ratio > 0) {
      const tq = this.torque(this.rpm) * drive;
      // 0.62 lumps drivetrain losses, rotating inertia and tyre slip into one realistic factor
      force = (tq * ratio * p.finalDrive * 0.88 * 0.62) / p.wheelRadius;
      // creep (automatic idle roll) when no pedal
      if (drive < 0.02 && brake < 0.02 && absV < 1.6 && !this.handbrakeOn && this.gearMode !== 'N') force += p.mass * 0.9;
      // traction limit (front-wheel drive ≈ 60 % load)
      const tract = mu * p.mass * G * 0.62;
      if (force > tract) {
        this.slip = Math.max(this.slip, clamp((force - tract) / tract, 0, 1));
        force = tract;
      }
      force *= dir;
      // engine braking in gear
      if (drive < 0.02 && absV > 1) force -= Math.sign(this.speed) * p.mass * (0.35 + 0.02 * absV) * (this.gearMode === 'D' ? 1 : 0.5);
    }

    this.integrate(dt, c, opts, force, brake, mu);
  }

  /**
   * Manual gearbox with clutch. With clutch assist the clutch is automated (launch slip, shifts,
   * never stalls); without it the driver controls the clutch pedal and the engine can stall.
   */
  private updateManual(dt: number, c: DriveControls, opts: DriveOptions) {
    const p = this.p;
    const absV = Math.abs(this.speed);
    const mu = 0.95 * this.grip;
    const assist = opts.clutchAssist;
    this.handbrakeOn = c.handbrake > 0.5;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = this.gearMode === 'D' ? p.gears[this.gear - 1] : this.gearMode === 'R' ? p.reverseRatio : 0;
    const dir = this.gearMode === 'R' ? -1 : 1;
    const wheelRpm = (absV / p.wheelRadius) * (60 / (2 * Math.PI));
    const coupled = wheelRpm * ratio * p.finalDrive;
    // moving against the selected gear direction (e.g. rolling back in 1st) couples negatively
    const against = ratio > 0 && Math.sign(this.speed) === -dir && absV > 0.3;
    // Engine restart after a stall: press the clutch (or select neutral) and touch the throttle
    if (!this.engineOn) {
      if ((c.clutch > 0.7 || ratio === 0) && c.throttle > 0.2) {
        this.crankT += dt;
        if (this.crankT > 0.7) {
          this.engineOn = true;
          this.crankT = 0;
          this.rpm = p.idleRpm;
        }
      } else this.crankT = 0;
    }
    // Clutch engagement (1 = fully engaged)
    let k: number;
    if (ratio === 0) k = 0;
    else if (assist) {
      k = this.shiftTimer > 0 ? clamp(1 - this.shiftTimer / 0.3, 0, 1) * 0.8 : 1;
      if (c.brake > 0.3 && absV < 2.5 && c.throttle < 0.05) k = 0; // clutch in when stopping
    } else k = clamp((1 - c.clutch) * 1.35, 0, 1); // bites before the pedal is fully up
    this.clutchEngage = k;
    let drive = this.engineOn ? c.throttle : 0;
    // idle governor keeps the engine alive (adds a little throttle when rpm drops)
    if (this.engineOn) drive = Math.max(drive, clamp((p.idleRpm - this.rpm) / 450, 0, 0.35));
    const free = p.idleRpm + c.throttle * (p.redline * 0.92 - p.idleRpm);
    let target: number;
    if (!this.engineOn) target = 0;
    else if (k < 0.05) target = free;
    else if (assist) {
      // automated launch slip like a dual-clutch box
      const slip = absV < 5 ? (p.idleRpm + c.throttle * 1800) * (1 - absV / 7) : 0;
      target = Math.max(against ? 0 : coupled, slip, p.idleRpm);
    } else target = free * (1 - k) + (against ? 0 : coupled) * k;
    this.rpm = damp(this.rpm, clamp(target, 0, p.redline + 150), k > 0.9 ? 16 : 8, dt);
    // Stall: engine dragged below ~60 % of idle with the clutch engaged
    const lugging = coupled < p.idleRpm * 0.45 || (coupled < p.idleRpm * 0.62 && c.throttle < 0.2);
    if (this.engineOn && !assist && k > 0.75 && ratio > 0 && (lugging || against)) {
      this.stallT += dt;
      if (this.stallT > (c.throttle > 0.3 ? 0.45 : 0.22)) {
        this.engineOn = false;
        this.stalls++;
        this.stallT = 0;
        this.rpm = 0;
      }
    } else this.stallT = Math.max(0, this.stallT - dt);
    if (!this.engineOn) this.rpm = damp(this.rpm, 0, 10, dt);

    let force = 0;
    if (ratio > 0 && this.engineOn && k > 0) {
      const tq = this.torque(Math.max(this.rpm, p.idleRpm)) * drive;
      // a slipping clutch already passes most of the engine torque once it bites
      const kT = coupled < this.rpm - 150 ? Math.min(1, k * 2.2) : k;
      force = (tq * ratio * p.finalDrive * 0.88 * 0.62 * kT) / p.wheelRadius;
      if (coupled > p.redline + 60) force = 0; // rev limiter
      const tract = mu * p.mass * G * 0.62;
      if (force > tract) {
        this.slip = Math.max(this.slip, clamp((force - tract) / tract, 0, 1));
        force = tract;
      }
      force *= dir;
      // engine braking when off the throttle in gear
      if (c.throttle < 0.02 && absV > 1 && k > 0.5) force -= Math.sign(this.speed) * p.mass * (0.3 + 0.025 * absV) * (ratio / p.gears[2]) * 0.6;
    }
    this.driveCmd = c.throttle;
    this.brakeCmd = c.brake;
    this.integrate(dt, c, opts, force, c.brake, mu);
  }

  /** Brakes, resistance, steering/yaw and body motion (shared by all transmissions). */
  private integrate(dt: number, c: DriveControls, opts: DriveOptions, force: number, brake: number, mu: number) {
    const p = this.p;
    const absV = Math.abs(this.speed);
    // ——— Brakes (ABS caps at the friction limit) ———
    const demand = brake * p.maxBrakeDecel;
    let brakeDecel = Math.min(demand, mu * G);
    // Without ABS a panic stop locks the wheels: less deceleration and almost no steering
    this.wheelLock = !opts.abs && demand > mu * G * 0.97 && absV > 2;
    if (this.wheelLock) brakeDecel = mu * G * 0.78;
    if (this.handbrakeOn) brakeDecel = Math.max(brakeDecel, mu * G * 0.45);
    const resist = p.dragCoef * this.speed * this.speed + p.rollRes * p.mass * G;
    const decel = brakeDecel + resist / p.mass;
    const aDrive = force / p.mass;
    const prev = this.speed;
    let v = this.speed + aDrive * dt;
    // apply decelerations toward zero without crossing
    if (v > 0) v = Math.max(0, v - decel * dt);
    else if (v < 0) v = Math.min(0, v + decel * dt);
    if (this.gearMode === 'P') v = approach(v, 0, 8 * dt);
    this.speed = clamp(v, -12, 60);
    this.accel = (this.speed - prev) / Math.max(dt, 1e-4);

    // ——— Steering & yaw ———
    const vref = 11.5;
    const speedFactor = opts.speedSensitive ? 1 / (1 + (absV * absV) / (vref * vref)) : 1;
    const target = c.steer * p.maxSteer * Math.max(0.28, speedFactor);
    this.steerAngle = approach(this.steerAngle, target, 3.2 * dt);
    let yawTarget = (this.speed * Math.tan(this.steerAngle)) / p.wheelBase;
    const latGrip = mu * G * (this.handbrakeOn && absV > 3 ? 0.55 : 1);
    const latWanted = Math.abs(this.speed * yawTarget);
    let cornerSlip = 0;
    if (latWanted > latGrip && absV > 0.5) {
      cornerSlip = clamp((latWanted - latGrip) / latGrip, 0, 1);
      yawTarget *= latGrip / latWanted;
    }
    // handbrake turn: rear steps out a little
    if (this.handbrakeOn && absV > 5) yawTarget *= 1.25;
    if (this.wheelLock) yawTarget *= 0.15;
    this.yawRate = damp(this.yawRate, yawTarget, 12, dt);
    this.heading += this.yawRate * dt;
    this.latAccel = this.speed * this.yawRate;

    const lockSlip = this.wheelLock ? 0.9 : brake > 0.9 && absV > 8 ? 0.25 : 0;
    this.slip = damp(this.slip, Math.max(cornerSlip, lockSlip, this.handbrakeOn && absV > 4 ? 0.7 : 0), 6, dt);

    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    this.wheelSpin += (this.speed / p.wheelRadius) * dt;

    // body motion for cameras
    this.bodyRoll = damp(this.bodyRoll, clamp(-this.latAccel * 0.011, -0.07, 0.07), 5, dt);
    this.bodyPitch = damp(this.bodyPitch, clamp(-this.accel * 0.0065, -0.05, 0.05), 5, dt);
  }

  /** Scale speed after hitting something with contact normal (nx, nz). Returns impact speed (m/s). */
  applyImpact(nx: number, nz: number, restitution = 0.15): number {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const dot = fx * nx + fz * nz; // <0 when moving into the obstacle (forward)
    const vn = this.speed * dot;
    if (vn >= 0) return 0;
    const impact = -vn;
    // remove the normal component (with a small bounce) from the longitudinal speed
    this.speed -= (1 + restitution) * vn * dot;
    if (Math.abs(this.speed) < 0.3) this.speed = 0;
    return impact;
  }

  get kmh() {
    return Math.abs(this.speed) * 3.6;
  }

  /** Steering wheel rotation (radians) for the cockpit. */
  get wheelAngle() {
    return this.steerAngle * this.p.steerRatio;
  }
}
