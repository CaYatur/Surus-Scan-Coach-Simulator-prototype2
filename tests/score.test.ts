import { describe, expect, it } from 'vitest';
import { computeSession, letterGrade, type ScoreInput } from '../src/coach/metrics';
import { emptyStats, type MonitorStats } from '../src/coach/monitor';
import { COMPONENTS, COMPONENT_META, EVENT_META } from '../src/coach/types';

function input(patch: (st: MonitorStats) => void = () => undefined): ScoreInput {
  const stats = emptyStats();
  // a clean, long-enough drive (full confidence: ≥ 120 s and ≥ 0.8 km)
  stats.distance = 2500;
  stats.movingTime = 240;
  patch(stats);
  return { samples: [], stats, events: [], durationSec: 300, objectives: null, mirrorRate: 8, maxMirrorGap: 8, shoulderChecks: 2, signalLeads: [], baseline: null, wet: false, night: false };
}

describe('5 bileşenli puan', () => {
  it('bileşen ağırlıklarının toplamı 1', () => {
    const sum = COMPONENTS.reduce((a, c) => a + COMPONENT_META[c].weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('genel puan bileşenlerin ağırlıklı ortalaması (tavan yoksa)', () => {
    const r = computeSession(input());
    const weighted = Math.round(COMPONENTS.reduce((a, c) => a + r.components[c] * COMPONENT_META[c].weight, 0));
    expect(r.caps).toEqual([]);
    expect(r.overall).toBe(weighted);
    for (const c of COMPONENTS) {
      expect(r.components[c]).toBeGreaterThanOrEqual(0);
      expect(r.components[c]).toBeLessThanOrEqual(100);
    }
  });

  it('her olay türü 5 bileşenden birine bağlı', () => {
    for (const meta of Object.values(EVENT_META)) expect(COMPONENTS).toContain(meta.component);
  });

  it('harf notu sınırları', () => {
    expect(letterGrade(90)).toBe('A');
    expect(letterGrade(89)).toBe('B');
    expect(letterGrade(70)).toBe('C');
    expect(letterGrade(49)).toBe('F');
  });
});

describe('ağır ihlal tavanı', () => {
  const cases: [string, (st: MonitorStats) => void, number][] = [
    ['yayaya çarpma', (st) => (st.collisions.pedestrian = 1), 20],
    ['ağır kaza', (st) => (st.collisions.hard = 1), 40],
    ['kırmızı ışık', (st) => (st.redLights = 1), 72],
    ['iki araç çarpışması', (st) => (st.collisions.vehicle = 2), 55],
    ['uzun ters yön', (st) => (st.wrongWayTime = 10), 60],
  ];
  for (const [name, patch, cap] of cases) {
    it(`${name} → genel puan en fazla ${cap}`, () => {
      const r = computeSession(input(patch));
      expect(r.overall).toBeLessThanOrEqual(cap);
      expect(r.caps.length).toBeGreaterThan(0);
    });
  }

  it('en sıkı tavan geçerli olur (yaya + kırmızı ışık → 20)', () => {
    const r = computeSession(
      input((st) => {
        st.collisions.pedestrian = 1;
        st.redLights = 1;
      })
    );
    expect(r.overall).toBeLessThanOrEqual(20);
  });

  it('ters yön 6 sn ve altı tavana takılmaz', () => {
    const r = computeSession(input((st) => (st.wrongWayTime = 5)));
    expect(r.caps.some((c) => c.includes('ters yön'))).toBe(false);
  });
});
