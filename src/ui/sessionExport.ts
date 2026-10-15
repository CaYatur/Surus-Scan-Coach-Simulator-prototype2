import { download } from './dom';
import type { ReportData } from '../game/session';
import { exportStem, logSummary, summaryCsv, summaryRow, telemetryCsvWithMeta } from '../coach/experiment';

/** Session JSON (also offered by the report's JSON button) — always carries the session metadata. */
export function sessionJson(d: ReportData): string {
  return JSON.stringify(
    {
      meta: d.meta,
      result: d.result,
      stats: d.stats,
      events: d.events,
      mission: d.mission ? { id: d.mission.def.id, success: d.mission.success, stars: d.mission.stars, lines: d.mission.lines } : null,
      conditions: d.conditions,
      map: d.mapName,
    },
    null,
    2
  );
}

export function telemetryCsv(d: ReportData, rawCsv: string): string {
  return telemetryCsvWithMeta(rawCsv, d.meta);
}

/**
 * Experiment end-of-session export: telemetry CSV, session JSON and the one-row summary CSV.
 * The summary row is also kept in the browser (Settings → Deney → "tüm özetler") in case
 * the browser blocked the automatic downloads.
 */
export function exportExperimentSession(d: ReportData, rawCsv: string, autoDownload: boolean) {
  const row = summaryRow({
    meta: d.meta,
    stats: d.stats,
    maxMirrorGap: d.scan.maxGap,
    durationSec: d.result.durationSec,
    overall: d.result.overall,
    missionSuccess: d.mission ? d.mission.success : null,
  });
  logSummary(row);
  if (!autoDownload) return;
  const stem = exportStem(d.meta);
  const files: [string, string, string][] = [
    [`${stem}_telemetri.csv`, telemetryCsv(d, rawCsv), 'text/csv'],
    [`${stem}_oturum.json`, sessionJson(d), 'application/json'],
    [`${stem}_ozet.csv`, summaryCsv([row]), 'text/csv'],
  ];
  // Spaced out: browsers drop rapid back-to-back downloads
  files.forEach(([name, body, type], i) => setTimeout(() => download(name, body, type), i * 450));
}
