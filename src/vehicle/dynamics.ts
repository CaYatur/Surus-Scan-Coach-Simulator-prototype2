import { clamp, damp, approach } from '../core/math';

export type DriveControls = {
  throttle: number; // 0..1 (W / right trigger / gas pedal)
  brake: number; // 0..1 (S / left trigger / brake pedal)
  steer: number; // −1..1, positive = left
  handbrake: number; // 0..1
};

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

  /** Manually request a gear mode (selector transmission). */
  select(mode: GearMode) {
    if (mode === this.gearMode) return;
    // Only allow R/P while nearly stopped (like a real selector interlock).
    if ((mode === 'R' || mode === 'P' || this.gearMode === 'R') && Math.abs(this.speed) > 1.5) return;
    this.gearMode = mode;
    this.gear = 1;
  }

  update(dt: number, c: DriveControls, opts: { autoReverse: boolean; speedSensitive: boolean }) {
    const p = this.p;
    const absV = Math.abs(this.speed);
    const mu = 0.95 * this.grip;

    // ——— Gear logic ———
    let drive = 0;
    let brake = 0;
    if (opts.autoReverse) {
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

    // ——— Brakes (ABS caps at the friction limit) ———
    let brakeDecel = brake * p.maxBrakeDecel;
    brakeDecel = Math.min(brakeDecel, mu * G);
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
    this.yawRate = damp(this.yawRate, yawTarget, 12, dt);
    this.heading += this.yawRate * dt;
    this.latAccel = this.speed * this.yawRate;

    const lockSlip = brake > 0.9 && absV > 8 ? 0.25 : 0;
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
