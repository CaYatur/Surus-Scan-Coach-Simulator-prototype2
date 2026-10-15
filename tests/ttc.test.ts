import { describe, expect, it } from 'vitest';
import { drive, kinds, newMonitor } from './helpers';

describe('TTC / ramak kala (DrivingMonitor.trackFollowing)', () => {
  it('TTC = mesafe / yaklaşma hızı; en düşük TTC kaydedilir', () => {
    const mon = newMonitor();
    // 30 m gap closing at 10 m/s → TTC 3 s (safe)
    drive(mon, 2, () => ({ lead: { gap: 30, relSpeed: 10 } }));
    expect(mon.stats.minTTC).toBeCloseTo(3, 5);
    expect(mon.stats.nearMiss).toBe(0);
    expect(kinds(mon)).not.toContain('near_miss');
  });

  it('TTC 1,6 sn altına inince bir ramak kala sayar (major), 0,9 altı kritik', () => {
    const mon = newMonitor();
    drive(mon, 1, () => ({ lead: { gap: 12, relSpeed: 10 } })); // 1.2 s
    expect(mon.stats.nearMiss).toBe(1);
    const ev = mon.events.find((e) => e.kind === 'near_miss')!;
    expect(ev.severity).toBe('major');
    expect(ev.value).toBeCloseTo(1.2, 5);

    const mon2 = newMonitor();
    drive(mon2, 1, () => ({ lead: { gap: 8, relSpeed: 10 } })); // 0.8 s
    expect(mon2.events.find((e) => e.kind === 'near_miss')!.severity).toBe('critical');
  });

  it('aynı olay 6 sn içinde tekrar sayılmaz, sonra yeniden sayılır', () => {
    const mon = newMonitor();
    drive(mon, 4, () => ({ lead: { gap: 12, relSpeed: 10 } }));
    expect(mon.stats.nearMiss).toBe(1);
    drive(mon, 4, () => ({ lead: { gap: 12, relSpeed: 10 } }), { t0: 4 });
    expect(mon.stats.nearMiss).toBe(2);
  });

  it('uzaklaşan / sabit mesafedeki araç, uzak araç veya düşük hız TTC üretmez', () => {
    const mon = newMonitor();
    drive(mon, 2, () => ({ lead: { gap: 5, relSpeed: -3 } })); // pulling away
    drive(mon, 2, () => ({ lead: { gap: 5, relSpeed: 0.3 } }), { t0: 2 }); // below 0.5 m/s closing
    drive(mon, 2, () => ({ lead: { gap: 80, relSpeed: 20 } }), { t0: 4 }); // > 60 m ahead
    drive(mon, 2, () => ({ lead: { gap: 3, relSpeed: 3 }, kmh: 10 }), { t0: 6 }); // < 15 km/h
    expect(mon.stats.nearMiss).toBe(0);
    expect(mon.stats.minTTC).toBe(Infinity);
  });
});
