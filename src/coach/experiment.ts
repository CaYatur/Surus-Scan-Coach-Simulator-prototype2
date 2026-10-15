import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';
import type { MonitorStats } from './monitor';

/**
 * Experiment mode (pilot study: coaching on vs off).
 *
 * - `feedback` condition: the normal app — live hints, HUD score and the end-of-session report.
 * - `kontrol` condition: no score, no coaching warnings and no report are shown; the drive
 *   is still monitored and the telemetry recorded.
 * Every session records an anonymous participant code, the condition, the mission and the
 * traffic seed, and (optionally) exports its files automatically when it ends. The phone
 * link is locked for the whole experiment so no feedback can leak to a second screen.
 */

export type Condition = 'feedback' | 'kontrol';

export const CONDITION_LABEL: Record<Condition, string> = { feedback: 'Geri bildirim (koçluk açık)', kontrol: 'Kontrol (koçluk kapalı)' };

export type ExperimentConfig = {
  enabled: boolean;
  /** Anonymous participant code — never a real name. */
  participant: string;
  condition: Condition;
  /** Fixed traffic/pedestrian seed for every session; null = a new random seed per session. */
  seed: number | null;
  /** Download telemetry, session JSON and the summary row when a session ends. */
  autoExport: boolean;
};

export const DEFAULT_EXPERIMENT: ExperimentConfig = { enabled: false, participant: '', condition: 'feedback', seed: null, autoExport: true };

const KEY = 'ssc-experiment-v1';
const LOG_KEY = 'ssc-experiment-log-v1';
const LOG_MAX = 2000;

/** 1–16 letters, digits, '-' or '_' (e.g. P012, K-07). */
export function validParticipant(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,16}$/.test(code);
}

class ExperimentStore extends Emitter<{ change: ExperimentConfig }> {
  private data: ExperimentConfig;
  /** Set while a drive is running: participant, condition and seed cannot change mid-session. */
  locked = false;

  constructor() {
    super();
    this.data = { ...DEFAULT_EXPERIMENT, ...storage.get<Partial<ExperimentConfig>>(KEY, {}) };
  }

  get(): Readonly<ExperimentConfig> {
    return this.data;
  }

  /** Returns false (and changes nothing) while locked or when the participant code is invalid. */
  update(patch: Partial<ExperimentConfig>): boolean {
    if (this.locked) return false;
    const next = { ...this.data, ...patch };
    if (next.participant && !validParticipant(next.participant)) return false;
    // Enabling requires a participant code
    if (next.enabled && !next.participant) return false;
    this.data = next;
    storage.set(KEY, this.data);
    this.emit('change', this.data);
    return true;
  }

  get active() {
    return this.data.enabled && !!this.data.participant;
  }

  /** Control condition: hide every kind of performance feedback. */
  get feedbackHidden() {
    return this.active && this.data.condition === 'kontrol';
  }
}

export const experiment = new ExperimentStore();

// ——————————————————————————— session metadata & exports ———————————————————————————

export type SessionMeta = {
  participant: string;
  condition: Condition | '';
  mission: string;
  seed: number;
  map: string;
  /** ISO time the segment started. */
  startedAt: string;
};

export function newSeed(): number {
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  return r[0] || 1;
}

/** Prefix every telemetry row with the session metadata columns (one self-describing CSV). */
export function telemetryCsvWithMeta(csv: string, meta: SessionMeta): string {
  if (!csv) return '';
  const lines = csv.split('\n');
  const cells = [meta.participant, meta.condition, meta.mission, String(meta.seed)].map(csvCell).join(',');
  return [`participant,condition,mission,seed,${lines[0]}`, ...lines.slice(1).map((l) => `${cells},${l}`)].join('\n');
}

export type SummaryInput = {
  meta: SessionMeta;
  stats: MonitorStats;
  maxMirrorGap: number;
  durationSec: number;
  overall: number;
  missionSuccess: boolean | null;
};

/** Column order of the one-row experiment summary. */
export const SUMMARY_COLUMNS = [
  'participant',
  'condition',
  'mission',
  'seed',
  'map',
  'started_at',
  'duration_s',
  'distance_km',
  'maneuvers',
  'scan_before_maneuver_rate',
  'max_mirror_gap_s',
  'near_miss_ttc_count',
  'min_ttc_s',
  'speeding_time_s',
  'speeding_severe_time_s',
  'collisions',
  'red_lights',
  'overall_score',
  'mission_success',
] as const;

export type SummaryRow = Record<(typeof SUMMARY_COLUMNS)[number], string | number>;

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Primary study metrics in one row:
 * - scan_before_maneuver_rate: share of turns + lane changes preceded by the correct mirror check (empty when no manoeuvres)
 * - max_mirror_gap_s: longest interval without any mirror check while moving
 * - near_miss_ttc_count / min_ttc_s: time-to-collision near misses (< 1.6 s) and the minimum TTC
 * - speeding_time_s: time above the limit beyond the tolerance
 */
export function summaryRow(inp: SummaryInput): SummaryRow {
  const st = inp.stats;
  const man = st.turns.total + st.laneChanges.total;
  const col = st.collisions;
  return {
    participant: inp.meta.participant,
    condition: inp.meta.condition,
    mission: inp.meta.mission,
    seed: inp.meta.seed,
    map: inp.meta.map,
    started_at: inp.meta.startedAt,
    duration_s: round(inp.durationSec, 1),
    distance_km: round(st.distance / 1000, 3),
    maneuvers: man,
    scan_before_maneuver_rate: man ? round((st.turns.mirror + st.laneChanges.mirror) / man, 3) : '',
    max_mirror_gap_s: round(inp.maxMirrorGap, 1),
    near_miss_ttc_count: st.nearMiss,
    min_ttc_s: Number.isFinite(st.minTTC) ? round(st.minTTC, 2) : '',
    speeding_time_s: round(st.overTime, 1),
    speeding_severe_time_s: round(st.overSevereTime, 1),
    collisions: col.vehicle + col.static + col.pedestrian,
    red_lights: st.redLights,
    overall_score: inp.overall,
    mission_success: inp.missionSuccess == null ? '' : inp.missionSuccess ? 1 : 0,
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function summaryCsv(rows: SummaryRow[]): string {
  return [SUMMARY_COLUMNS.join(','), ...rows.map((r) => SUMMARY_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n');
}

/** Every summary row of this browser, so lost/blocked downloads can be recovered from Settings. */
export function loggedSummaries(): SummaryRow[] {
  return storage.get<SummaryRow[]>(LOG_KEY, []);
}

export function logSummary(row: SummaryRow) {
  const rows = loggedSummaries();
  rows.push(row);
  storage.set(LOG_KEY, rows.slice(-LOG_MAX));
}

export function clearSummaryLog() {
  storage.remove(LOG_KEY);
}

/** File name stem: P012_kontrol_city_tour_2026-10-15T12-30-00. */
export function exportStem(meta: SessionMeta): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  return [safe(meta.participant || 'anonim'), safe(meta.condition || 'serbest'), safe(meta.mission || 'serbest'), meta.startedAt.slice(0, 19).replace(/:/g, '-')].join('_');
}
