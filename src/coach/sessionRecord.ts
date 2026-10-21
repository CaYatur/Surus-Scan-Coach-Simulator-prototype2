import { mean } from '../core/math';
import type { Sample } from './telemetry';
import type { MonitorStats } from './monitor';
import type { SessionResult, StyleBaseline } from './metrics';
import type { CoachEvent, Component, Severity } from './types';

export type MetricSnap = { name: string; score: number | null; value: string; detail: string };

export type SessionSeriesPoint = {
  t: number;
  kmh: number;
  limit: number;
  accel: number;
  lat: number;
  headway: number | null;
};

/** Compact copy of the end-of-session analysis, small enough for localStorage and the phone link. */
export type SessionDetail = {
  confidence: number;
  caps: string[];
  subs: (MetricSnap & { component: Component })[];
  insights: { id: string; title: string; score: number | null; color: string; tip: string; rows: MetricSnap[] }[];
  tiles: { label: string; value: string; sub: string }[];
  zones: { name: string; limit: number; timeSec: number; inPct: number; maxOver: number }[];
  style: StyleBaseline;
  events: { t: number; severity: Severity; component: Component; message: string }[];
  series: SessionSeriesPoint[];
};

const clip = (s: string, n = 180) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const dec = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function snap(row: { name: string; score: number | null; value: string; detail: string }): MetricSnap {
  return { name: row.name, score: row.score, value: clip(row.value, 48), detail: clip(row.detail) };
}

export function captureSessionDetail(args: {
  result: SessionResult;
  stats: MonitorStats;
  scan: { rate: number; maxGap: number; shoulder: number };
  events: CoachEvent[];
  samples: Sample[];
}): SessionDetail {
  const { result: r, stats: st, scan } = args;
  const man = st.turns.total + st.laneChanges.total;
  const reaction = st.reactionTimes.length ? mean(st.reactionTimes) : null;
  const tile = (label: string, value: string, sub = ''): SessionDetail['tiles'][number] => ({ label, value, sub });
  const tiles = [
    tile('Ortalama hız', `${r.avgKmh.toFixed(0)} km/h`, `maks ${r.maxKmh.toFixed(0)}`),
    tile('Manevra', String(man), `${st.turns.total} dönüş · ${st.laneChanges.total} şerit`),
    tile('Ayna kontrolü', `${scan.rate.toFixed(1)}/dk`, `en uzun ara ${scan.maxGap.toFixed(0)} sn`),
    tile('Omuz kontrolü', String(scan.shoulder)),
    tile('Tepki süresi', reaction == null ? '—' : `${reaction.toFixed(2)} sn`, st.reactionTimes.length ? `${st.reactionTimes.length} ölçüm` : ''),
    tile('Min. TTC', Number.isFinite(st.minTTC) ? `${st.minTTC.toFixed(1)} sn` : '—', `${st.nearMiss} ramak kala`),
    tile('Takip mesafesi', Number.isFinite(st.minHeadway) ? `min ${st.minHeadway.toFixed(1)} sn` : '—'),
    tile('Işık / DUR', `${st.redLights} kırmızı`, `${st.stopSigns.full}/${st.stopSigns.total} tam duruş`),
    tile('Şerit değişimi', `${st.laneChanges.signaled}/${st.laneChanges.total}`, `sinyalli · ${st.solidLine} düz çizgi`),
  ];
  if (st.highwayTime > 5) tiles.push(tile('Bölünmüş yol', `${(st.highwayDistance / 1000).toFixed(1)} km`, `${st.rightOvertakes} sağdan sollama · ${st.leftLaneHog} sol şerit`));
  if (st.roundabouts.total) tiles.push(tile('Dönel kavşak', `${st.roundabouts.exitSignal}/${st.roundabouts.total}`, 'çıkışta sinyal'));
  const step = Math.max(1, Math.ceil(args.samples.length / 120));
  const series = args.samples.filter((_, i) => i % step === 0).map((s) => ({
    t: dec(s.t),
    kmh: Math.round(s.kmh),
    limit: s.limit,
    accel: dec(s.accel, 2),
    lat: dec(s.latAccel, 2),
    headway: s.headway == null ? null : dec(Math.min(6, s.headway), 2),
  }));
  const events = args.events
    .filter((e) => e.severity !== 'info')
    .slice(-40)
    .map((e) => ({ t: dec(e.t), severity: e.severity, component: e.component, message: clip(e.message, 140) }));
  return {
    confidence: dec(r.confidence, 2),
    caps: r.caps.slice(0, 6).map((c) => clip(c, 120)),
    subs: r.subs.map((s) => ({ component: s.component, ...snap(s) })),
    insights: r.insights.map((ins) => ({
      id: ins.id,
      title: ins.title,
      score: ins.score,
      color: ins.color,
      tip: clip(ins.tip, 220),
      rows: ins.rows.map(snap),
    })),
    tiles,
    zones: Object.entries(st.zones)
      .filter(([, z]) => z.time > 3)
      .sort((a, b) => b[1].time - a[1].time)
      .slice(0, 8)
      .map(([name, z]) => ({
        name,
        limit: z.limit,
        timeSec: Math.round(z.time),
        inPct: Math.round((1 - z.over / Math.max(0.1, z.time)) * 100),
        maxOver: Math.round(z.maxOver),
      })),
    style: r.style,
    events,
    series,
  };
}
