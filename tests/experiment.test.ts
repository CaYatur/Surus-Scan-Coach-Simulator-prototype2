import { describe, expect, it } from 'vitest';
import { SUMMARY_COLUMNS, exportStem, summaryCsv, summaryRow, telemetryCsvWithMeta, validParticipant, type SessionMeta } from '../src/coach/experiment';
import { emptyStats } from '../src/coach/monitor';

const meta: SessionMeta = { participant: 'P012', condition: 'kontrol', mission: 'city_tour', seed: 42, map: 'city', startedAt: '2026-10-15T12:30:05.000Z' };

describe('deney modu dışa aktarımı', () => {
  it('katılımcı kodu yalnızca anonim kod biçiminde kabul edilir', () => {
    expect(validParticipant('P012')).toBe(true);
    expect(validParticipant('K-07_b')).toBe(true);
    expect(validParticipant('')).toBe(false);
    expect(validParticipant('Ayşe Yılmaz')).toBe(false);
    expect(validParticipant('x'.repeat(17))).toBe(false);
  });

  it('telemetri CSV satırlarının başına katılımcı/koşul/görev/tohum eklenir', () => {
    const csv = telemetryCsvWithMeta('t,kmh\n0.1,12\n0.2,13', meta);
    expect(csv.split('\n')).toEqual(['participant,condition,mission,seed,t,kmh', 'P012,kontrol,city_tour,42,0.1,12', 'P012,kontrol,city_tour,42,0.2,13']);
    expect(telemetryCsvWithMeta('', meta)).toBe('');
  });

  it('özet satırı birincil metrikleri doğru hesaplar', () => {
    const st = emptyStats();
    st.distance = 1234;
    st.turns = { total: 3, signaled: 3, mirror: 2, shoulder: 0 };
    st.laneChanges = { total: 1, signaled: 1, mirror: 1, shoulder: 1 };
    st.nearMiss = 2;
    st.minTTC = 1.234;
    st.overTime = 12.34;
    st.collisions.vehicle = 1;
    const row = summaryRow({ meta, stats: st, maxMirrorGap: 17.26, durationSec: 300, overall: 71, missionSuccess: true });
    expect(row.scan_before_maneuver_rate).toBe(0.75);
    expect(row.max_mirror_gap_s).toBe(17.3);
    expect(row.near_miss_ttc_count).toBe(2);
    expect(row.min_ttc_s).toBe(1.23);
    expect(row.speeding_time_s).toBe(12.3);
    expect(row.distance_km).toBe(1.234);
    expect(row.collisions).toBe(1);
    expect(row.mission_success).toBe(1);
    expect(row.participant).toBe('P012');
    expect(row.seed).toBe(42);
  });

  it('manevra / TTC yoksa ilgili hücreler boş kalır (0 değil)', () => {
    const row = summaryRow({ meta, stats: emptyStats(), maxMirrorGap: 0, durationSec: 60, overall: 70, missionSuccess: null });
    expect(row.scan_before_maneuver_rate).toBe('');
    expect(row.min_ttc_s).toBe('');
    expect(row.mission_success).toBe('');
  });

  it('özet CSV başlığı sabit sütun sırasını izler', () => {
    const row = summaryRow({ meta, stats: emptyStats(), maxMirrorGap: 0, durationSec: 60, overall: 70, missionSuccess: false });
    const [head, line] = summaryCsv([row]).split('\n');
    expect(head).toBe(SUMMARY_COLUMNS.join(','));
    expect(line.split(',').length).toBe(SUMMARY_COLUMNS.length);
  });

  it('dosya adı kökü katılımcı, koşul, görev ve zamandan oluşur', () => {
    expect(exportStem(meta)).toBe('P012_kontrol_city_tour_2026-10-15T12-30-05');
  });
});
