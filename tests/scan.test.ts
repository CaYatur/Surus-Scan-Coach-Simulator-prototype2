import { describe, expect, it } from 'vitest';
import { ScanTracker } from '../src/coach/scan';
import type { GlanceTarget } from '../src/input/input';

/** Feed a glance sequence at 20 Hz: `at(t)` says where the driver is looking. */
function run(tr: ScanTracker, from: number, to: number, at: (t: number) => GlanceTarget, moving = true) {
  const dt = 0.05;
  for (let t = from + dt; t <= to + 1e-9; t += dt) tr.update(t, dt, at(t), 0, moving);
}

describe('tarama penceresi (ScanTracker)', () => {
  it('pencere içindeki ayna kontrolü sayılır, pencere dışındaki sayılmaz', () => {
    const tr = new ScanTracker();
    run(tr, 0, 10, (t) => (t > 2 && t < 2.6 ? 'mirrorL' : 'none'));
    // glance ended at ~2.55 s
    expect(tr.checked(['mirrorL'], 8, 6)).toBe(true);
    expect(tr.checked(['mirrorL'], 9, 6)).toBe(false);
    // the wrong side does not count
    expect(tr.checked(['mirrorR'], 5, 6)).toBe(false);
  });

  it('“tek tuş” (generic) bakış her ayna gereksinimini karşılar', () => {
    const tr = new ScanTracker();
    run(tr, 0, 4, (t) => (t > 1 && t < 1.5 ? 'generic' : 'none'));
    expect(tr.checked(['mirrorR'], 4, 6)).toBe(true);
    expect(tr.checked(['shoulderL'], 4, 6)).toBe(true);
  });

  it('aynı hedefe kesintisiz bakış tek bakış sayılır', () => {
    const tr = new ScanTracker();
    run(tr, 0, 3, (t) => (t > 0.5 && t < 2 ? 'mirrorRear' : 'none'));
    expect(tr.count('mirrorRear')).toBe(1);
    run(tr, 3, 5, (t) => (t > 3.5 && t < 4 ? 'mirrorRear' : 'none'));
    expect(tr.count('mirrorRear')).toBe(2);
  });

  it('maxGap: hareket halindeyken aynasız geçen en uzun süre; dururken birikmez', () => {
    const tr = new ScanTracker();
    run(tr, 0, 12, (t) => (t > 4 && t < 4.5 ? 'mirrorL' : 'none'));
    // longest gap is after the glance: 4.45 → 12 s ≈ 7.5 s
    expect(tr.maxGap).toBeGreaterThan(7.3);
    expect(tr.maxGap).toBeLessThan(7.7);
    const still = new ScanTracker();
    run(still, 0, 30, () => 'none', false);
    expect(still.maxGap).toBe(0);
  });

  it('ayna/dk oranı omuz kontrollerini saymaz ve 5 sn altı hareketde 0 döner', () => {
    const tr = new ScanTracker();
    run(tr, 0, 60, (t) => {
      const k = Math.floor(t);
      if (t - k > 0.3) return 'none';
      return k % 10 === 0 ? 'mirrorL' : k % 10 === 5 ? 'shoulderL' : 'none';
    });
    // mirror glances at 0, 10, …, 50 s (6 in a minute); the 6 shoulder checks are excluded
    expect(tr.count()).toBe(12);
    expect(tr.rate()).toBeCloseTo(6, 5);
    const short = new ScanTracker();
    run(short, 0, 4, () => 'mirrorL');
    expect(short.rate()).toBe(0);
  });
});
