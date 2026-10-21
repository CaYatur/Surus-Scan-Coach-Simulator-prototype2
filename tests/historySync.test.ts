import { describe, expect, it } from 'vitest';
import { mergeHistory, upsertSession } from '../src/link/historySync';
import type { LinkHistory } from '../src/link/protocol';

const row = (id: string, overall: number): LinkHistory['sessions'][number] => ({
  id,
  at: 1,
  title: id,
  overall,
  grade: 'C',
  map: 'Şehir',
  conditions: 'Öğle',
  distanceKm: 1,
  durationSec: 60,
  risk: 'Düşük',
  tips: [],
  strengths: [],
  components: { guvenlik: 70, kural: 70, tarama: 70, puruzsuzluk: 70, gorev: 70 },
  keyStats: [],
});

const pack = (profileId: string, sessions: LinkHistory['sessions']): LinkHistory => ({
  profileId,
  karneOverall: 80,
  karneGrade: 'B',
  karneComponents: row('x', 80).components,
  sessions,
});

describe('telefon geçmişi', () => {
  it('yeni liste eski ayrıntıyı silmez', () => {
    const prev = pack('p', [{ ...row('a', 70), detail: { confidence: 1, caps: [], subs: [], insights: [], tiles: [], zones: [], style: { ready: false, sessions: 0, speedRatio: 0, accelP90: 0, decelP90: 0, latP90: 0, jerkRms: 0, srr: 0, headwayMedian: 0, reaction: 0, mirrorRate: 0, signalLead: 0 }, events: [], series: [] } }]);
    const next = mergeHistory(prev, pack('p', [row('a', 71), row('b', 80)]));
    expect(next.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(next.sessions[0].overall).toBe(71);
    expect(next.sessions[0].detail?.confidence).toBe(1);
  });

  it('biten oturum listeye eklenir ve orada kalır', () => {
    const prev = pack('p', [row('eski', 60)]);
    const next = upsertSession(prev, row('yeni', 90));
    expect(next.sessions.map((s) => s.id)).toEqual(['yeni', 'eski']);
    const again = mergeHistory(next, pack('p', [row('yeni', 90), row('eski', 60)]));
    expect(again.sessions.map((s) => s.id)).toEqual(['yeni', 'eski']);
  });

  it('profilsiz boş paket dolu listeyi silmez', () => {
    const prev = pack('p', [row('a', 70)]);
    expect(mergeHistory(prev, pack('', [])).sessions).toHaveLength(1);
  });
});
