import type { GlanceTarget } from '../input/input';

export type GlanceKind = Exclude<GlanceTarget, 'none'>;

export type GlanceRecord = { kind: GlanceKind; start: number; end: number };

/**
 * Records completed glances (mirror / shoulder checks) with timestamps.
 * A glance counts once the head has reached the target (see CameraRig.reached).
 * In legacy mode a single "generic" glance satisfies any mirror requirement.
 */
export class ScanTracker {
  readonly glances: GlanceRecord[] = [];
  private current: GlanceRecord | null = null;
  private lastAny = -999;
  /** Free-look / webcam head yaw beyond this counts as a side scan (junction scanning). */
  private lastSideLook = { left: -999, right: -999 };
  movingTime = 0;
  /** Longest interval without any mirror check while moving (s). */
  maxGap = 0;
  private gapStart = 0;

  reset() {
    this.glances.length = 0;
    this.current = null;
    this.lastAny = -999;
    this.lastSideLook = { left: -999, right: -999 };
    this.movingTime = 0;
    this.maxGap = 0;
    this.gapStart = 0;
  }

  update(t: number, dt: number, reached: GlanceTarget, headYaw: number, moving: boolean) {
    if (reached !== 'none') {
      if (!this.current || this.current.kind !== reached) {
        this.current = { kind: reached, start: t, end: t };
        this.glances.push(this.current);
      }
      this.current.end = t;
      this.lastAny = t;
      if (moving) this.gapStart = t;
    } else this.current = null;
    if (headYaw > 0.45) this.lastSideLook.left = t;
    if (headYaw < -0.45) this.lastSideLook.right = t;
    if (reached === 'mirrorL' || reached === 'shoulderL') this.lastSideLook.left = t;
    if (reached === 'mirrorR' || reached === 'shoulderR') this.lastSideLook.right = t;
    if (moving) {
      this.movingTime += dt;
      this.maxGap = Math.max(this.maxGap, t - this.gapStart);
    } else this.gapStart = t;
  }

  /** Was any of the given glance kinds made within `sec` before time t? (legacy "generic" counts too) */
  checked(kinds: GlanceKind[], t: number, sec: number): boolean {
    for (let i = this.glances.length - 1; i >= 0; i--) {
      const g = this.glances[i];
      if (t - g.end > sec) break;
      if (kinds.includes(g.kind) || g.kind === 'generic') return true;
    }
    return false;
  }

  sideLooked(side: 'left' | 'right', t: number, sec: number) {
    return t - this.lastSideLook[side] <= sec || this.checked(side === 'left' ? ['mirrorL', 'shoulderL'] : ['mirrorR', 'shoulderR'], t, sec);
  }

  secondsSinceAny(t: number) {
    return t - this.lastAny;
  }

  count(kind?: GlanceKind) {
    return kind ? this.glances.filter((g) => g.kind === kind).length : this.glances.length;
  }

  /** Mirror checks per minute of moving time. */
  rate(): number {
    return this.movingTime > 5 ? (this.glances.filter((g) => g.kind !== 'shoulderL' && g.kind !== 'shoulderR').length / this.movingTime) * 60 : 0;
  }
}
