import { describe, expect, it } from 'vitest';
import { computeSession, type ScoreInput } from '../src/coach/metrics';
import { emptyStats, type MonitorStats } from '../src/coach/monitor';
import { COMPONENT_META } from '../src/coach/types';
import { captureSessionDetail } from '../src/coach/sessionRecord';
import { sessionAnalysisHtml } from '../src/ui/sessionDetailView';

function input(patch: (st: MonitorStats) => void = () => undefined): ScoreInput {
  const stats = emptyStats();
  stats.distance = 2500;
  stats.movingTime = 240;
  patch(stats);
  return { samples: [], stats, events: [], durationSec: 300, objectives: null, mirrorRate: 8, maxMirrorGap: 8, shoulderChecks: 2, signalLeads: [], baseline: null, wet: false, night: false };
}

describe('oturum detayı', () => {
  it('oturum sonu metriklerini Türkçe adlarla saklar', () => {
    const stats = emptyStats();
    stats.distance = 2500;
    stats.movingTime = 240;
    const result = computeSession(input());
    const detail = captureSessionDetail({ result, stats, scan: { rate: 8, maxGap: 12, shoulder: 2 }, events: [], samples: [] });
    expect(detail.subs.length).toBe(result.subs.length);
    expect(detail.tiles.some((t) => t.label === 'Ayna kontrolü')).toBe(true);
    expect(detail.insights.map((i) => i.title)).toEqual(['Yorgunluk belirtisi', 'Agresif sürüş', 'Odak puanı']);
    const html = sessionAnalysisHtml(
      {
        title: 'Serbest sürüş',
        at: 1,
        map: 'Şehir',
        conditions: 'Öğle',
        distanceKm: 2.5,
        durationSec: 300,
        overall: result.overall,
        grade: result.grade,
        risk: result.risk,
        components: result.components,
        tips: result.tips,
        strengths: result.strengths,
        detail,
      },
      null
    );
    expect(html).toContain(COMPONENT_META.guvenlik.title);
    expect(html).not.toContain('guvenlik:');
    expect(html).toContain('Yorgunluk belirtisi');
    expect(html).toContain('Ayna kontrolü');
  });
});
