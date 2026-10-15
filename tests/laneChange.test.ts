import { describe, expect, it } from 'vitest';
import { drive, kinds, laneIndexAt, newMonitor } from './helpers';

/** Smooth move from lane 0 to lane 1 between `from` and `from + dur` seconds. */
const shift = (t: number, from: number, dur = 3) => Math.min(1, Math.max(0, (t - from) / dur));

describe('şerit değişimi tespiti (DrivingMonitor.trackLanes)', () => {
  it('ayna + sinyal ile yapılan sola şerit değişimini bir kez sayar ve olumlu olay üretir', () => {
    const mon = newMonitor();
    drive(mon, 16, (t) => ({
      lat: shift(t, 8),
      signal: t > 5 && t < 12 ? 'left' : 'none',
      reached: t > 5.5 && t < 6.3 ? 'mirrorL' : 'none',
    }));
    const lc = mon.stats.laneChanges;
    expect(lc.total).toBe(1);
    expect(lc.signaled).toBe(1);
    expect(lc.mirror).toBe(1);
    expect(kinds(mon)).toContain('msm_good');
    expect(kinds(mon)).not.toContain('no_signal_lane');
    expect(kinds(mon)).not.toContain('no_mirror_lane');
  });

  it('sinyalsiz ve aynasız şerit değişimini ihlal olarak işaretler', () => {
    const mon = newMonitor();
    drive(mon, 16, (t) => ({ lat: shift(t, 8) }));
    expect(mon.stats.laneChanges.total).toBe(1);
    expect(mon.stats.laneChanges.signaled).toBe(0);
    expect(kinds(mon)).toContain('no_signal_lane');
    expect(kinds(mon)).toContain('no_mirror_lane');
    expect(kinds(mon)).not.toContain('msm_good');
  });

  it('manevradan hemen önce verilen sinyali “geç sinyal” sayar', () => {
    const mon = newMonitor();
    // the car centre crosses the line at ~t=9.5 s; signal only 0.3 s before that
    drive(mon, 16, (t) => ({ lat: shift(t, 8), signal: t > 9.2 && t < 12 ? 'left' : 'none', reached: t > 6 && t < 7 ? 'mirrorL' : 'none' }));
    expect(mon.stats.laneChanges.total).toBe(1);
    expect(kinds(mon)).toContain('late_signal');
  });

  describe('yanlış pozitif koruması', () => {
    it('(ön koşul) test konumları gerçekten çizginin öbür tarafında', () => {
      expect(laneIndexAt(0)).toBe(0);
      expect(laneIndexAt(0.25)).toBe(0);
      expect(laneIndexAt(0.58)).toBe(1);
      expect(laneIndexAt(0.62)).toBe(1);
      expect(laneIndexAt(1)).toBe(1);
    });

    it('şerit içinde yalpalamak şerit değişimi sayılmaz', () => {
      const mon = newMonitor();
      drive(mon, 20, (t) => ({ lat: 0.25 * Math.sin(t * 1.3) }));
      expect(mon.stats.laneChanges.total).toBe(0);
      expect(kinds(mon)).not.toContain('no_signal_lane');
    });

    it('çizgiyi kısa süre aşıp aynı şeride dönmek düzeltme sayılır, şerit değişimi değil', () => {
      const mon = newMonitor();
      // dip ~0.6 lane widths over the line for well under a second, then back
      drive(mon, 16, (t) => ({ lat: t > 8 && t < 8.6 ? 0.62 : 0 }));
      expect(mon.stats.laneChanges.total).toBe(0);
    });

    it('çok yavaş (< 8 km/h) yanal kayma şerit değişimi sayılmaz', () => {
      const mon = newMonitor();
      drive(mon, 16, (t) => ({ lat: shift(t, 6), kmh: 5 }));
      expect(mon.stats.laneChanges.total).toBe(0);
    });

    it('yeni şeritte tutunmadan önce geri dönülürse sayılmaz', () => {
      const mon = newMonitor();
      // cross to just past the line (depth < 0.5 m) and come back within ~2 s
      drive(mon, 16, (t) => ({ lat: t > 8 && t < 10 ? 0.58 : 0 }));
      expect(mon.stats.laneChanges.total).toBe(0);
    });
  });
});
