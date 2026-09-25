export type Sample = {
  t: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  kmh: number;
  accel: number;
  latAccel: number;
  yawRate: number;
  steer: number;
  wheelAngle: number;
  throttle: number;
  brake: number;
  limit: number;
  lane: number;
  laneOffset: number;
  surface: string;
  wrongWay: boolean;
  signal: -1 | 0 | 1;
  glance: string;
  headway: number | null;
  ttc: number | null;
  inJunction: boolean;
  active: boolean;
};

export const SAMPLE_HZ = 10;

/** Fixed-rate telemetry recorder (10 Hz). */
export class Telemetry {
  samples: Sample[] = [];
  private acc = 0;
  distance = 0;

  reset() {
    this.samples = [];
    this.acc = 0;
    this.distance = 0;
  }

  update(dt: number, speed: number, make: () => Sample) {
    this.distance += Math.abs(speed) * dt;
    this.acc += dt;
    if (this.acc < 1 / SAMPLE_HZ) return;
    this.acc -= 1 / SAMPLE_HZ;
    if (this.acc > 0.5) this.acc = 0;
    this.samples.push(make());
  }

  last(): Sample | undefined {
    return this.samples[this.samples.length - 1];
  }

  toCSV(): string {
    if (!this.samples.length) return '';
    const keys = Object.keys(this.samples[0]) as (keyof Sample)[];
    const rows = [keys.join(',')];
    for (const s of this.samples) {
      rows.push(
        keys
          .map((k) => {
            const v = s[k];
            if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
            if (v === null) return '';
            return String(v);
          })
          .join(',')
      );
    }
    return rows.join('\n');
  }
}
