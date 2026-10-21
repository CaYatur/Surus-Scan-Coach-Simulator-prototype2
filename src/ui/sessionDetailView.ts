import { esc, fmtDate, scoreColor } from './dom';
import { barRows, lineChart, radarSvg, stars } from './charts';
import { formatTime } from '../core/math';
import { COMPONENTS, COMPONENT_META, SEVERITY_LABEL, type Component } from '../coach/types';
import type { StyleBaseline } from '../coach/metrics';
import type { MetricSnap, SessionDetail } from '../coach/sessionRecord';

const SEV_COLOR: Record<string, string> = { positive: '#4cd07d', info: '#6aa9ff', minor: '#f5b942', major: '#ff7a45', critical: '#f0544f' };

export type DetailSource = {
  title: string;
  at: number;
  map: string;
  conditions: string;
  distanceKm: number;
  durationSec: number;
  stars?: number;
  overall: number;
  grade: string;
  risk: string;
  styleAdherence?: number | null;
  components?: Partial<Record<Component, number>> | null;
  tips?: string[];
  strengths?: string[];
  highlights?: string[];
  detail?: SessionDetail | null;
  /** In-progress drive: full metrics are written when the session ends. */
  pending?: boolean;
  /** The row is saved; the long analysis is still on its way from the computer. */
  loadingDetail?: boolean;
};

function list(items: string[] | undefined, empty: string): string {
  return items?.length ? `<ul class="tips">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
}

function metricRows(rows: MetricSnap[]): string {
  return rows
    .map((row) => {
      const v = row.score;
      return `<div class="metric-row" role="button" tabindex="0" aria-expanded="false">
        <div class="bar-row"><div class="br-l"><b>${esc(row.name)}</b><small>${esc(row.value)}${row.detail ? ` · ${esc(row.detail)}` : ''}</small></div><div class="br-track">${v == null ? '<i class="na"></i>' : `<i style="width:${v}%;background:${scoreColor(v)}"></i>`}</div><div class="br-v" style="color:${v == null ? '#8894a3' : scoreColor(v)}">${v == null ? '—' : v}</div></div>
      </div>`;
    })
    .join('');
}

function styleTable(cur: StyleBaseline, base: StyleBaseline | null): string {
  const rows: [string, (b: StyleBaseline) => number, string, number][] = [
    ['Hız tercihi (sınıra oran)', (b) => b.speedRatio * 100, '%', 0],
    ['Hızlanma P90', (b) => b.accelP90, 'm/s²', 2],
    ['Yavaşlama P90', (b) => b.decelP90, 'm/s²', 2],
    ['Yanal ivme P90', (b) => b.latP90, 'm/s²', 2],
    ['Sarsıntı (jerk RMS)', (b) => b.jerkRms, 'm/s³', 2],
    ['Direksiyon yön değiştirme', (b) => b.srr, '/dk', 1],
    ['Takip mesafesi (medyan)', (b) => b.headwayMedian, 'sn', 1],
    ['Tepki süresi', (b) => b.reaction, 'sn', 2],
    ['Ayna sıklığı', (b) => b.mirrorRate, '/dk', 1],
    ['Sinyal öncesi süre', (b) => b.signalLead, 'sn', 1],
  ];
  return `<table class="tbl"><thead><tr><th>Özellik</th><th>Bu oturum</th><th>Kişisel profil</th><th>Fark</th></tr></thead><tbody>${rows
    .map(([label, f, unit, dp]) => {
      const a = f(cur);
      const b = base?.ready ? f(base) : null;
      const diff = b != null && b > 0 && a > 0 ? ((a - b) / b) * 100 : null;
      const diffCell = diff == null || !Number.isFinite(diff) ? '—' : `<span style="color:${Math.abs(diff) < 15 ? '#4cd07d' : Math.abs(diff) < 35 ? '#f5b942' : '#f0544f'}">${diff > 0 ? '+' : ''}${diff.toFixed(0)}%</span>`;
      return `<tr><td>${label}</td><td>${a > 0 ? `${a.toFixed(dp)} ${unit}` : '—'}</td><td>${b != null && b > 0 ? `${b.toFixed(dp)} ${unit}` : '—'}</td><td>${diffCell}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function charts(d: SessionDetail): string {
  if (d.series.length < 2) return '';
  const xFmt = (x: number) => formatTime(x);
  const speed = lineChart(
    [
      { values: d.series.map((s) => ({ x: s.t, y: s.kmh })), color: '#35a7ff', label: 'Hız (km/h)', fill: true },
      { values: d.series.map((s) => ({ x: s.t, y: s.limit })), color: '#f0544f', label: 'Sınır', dashed: true },
    ],
    { yMin: 0, h: 180, xFmt }
  );
  const accel = lineChart(
    [
      { values: d.series.map((s) => ({ x: s.t, y: s.accel })), color: '#4cd07d', label: 'Boylamsal (m/s²)' },
      { values: d.series.map((s) => ({ x: s.t, y: s.lat })), color: '#ab47bc', label: 'Yanal (m/s²)' },
    ],
    { yMin: -8, yMax: 6, h: 180, xFmt }
  );
  const head = d.series.filter((s) => s.headway != null);
  const headway = head.length
    ? lineChart([{ values: head.map((s) => ({ x: s.t, y: s.headway! })), color: '#ffa726', label: 'Headway' }], { yMin: 0, yMax: 6, h: 160, xFmt })
    : '';
  return `<div class="card"><h3>Hız ve hız sınırı</h3>${speed}</div>
    <div class="card"><h3>Boylamsal ve yanal ivme</h3>${accel}</div>
    ${headway ? `<div class="card"><h3>Takip mesafesi (sn)</h3>${headway}</div>` : ''}`;
}

/** End-of-session statistics for a saved session. Old records without `detail` stay short. */
export function sessionAnalysisHtml(s: DetailSource, baseline: StyleBaseline | null, compare?: Record<Component, number> | null): string {
  const d = s.detail;
  const comps = s.components;
  const full = comps != null && COMPONENTS.every((c) => typeof comps[c] === 'number');
  const compBars = COMPONENTS.map((c) => {
    const v = comps?.[c];
    const meta = COMPONENT_META[c];
    return `<div class="sc-row big"><span>${esc(meta.title)}</span><div class="sc-bar"><i style="width:${v ?? 0}%;background:${meta.color}"></i></div><b>${v == null ? '—' : Math.round(v)}</b></div>`;
  }).join('');
  const tips = s.tips?.length ? s.tips : s.highlights ?? [];
  const head = `<div class="card">
      <h3>${esc(s.title)}</h3>
      <p class="muted">${fmtDate(s.at)} · ${esc(s.map)} · ${esc(s.conditions)} · ${s.distanceKm.toFixed(1)} km · ${formatTime(s.durationSec)}${s.stars != null ? ' · ' + stars(s.stars) : ''}</p>
      <div class="kt-score" style="color:${scoreColor(s.overall)}"><b>${Math.round(s.overall)}</b> ${esc(s.grade)} · Risk: ${esc(s.risk || '—')}${s.styleAdherence != null ? ` · Stil ${s.styleAdherence}` : ''}${d && d.confidence < 0.8 ? ` · Güven %${Math.round(d.confidence * 100)}` : ''}</div>
      ${d?.caps.length ? `<div class="caps">${d.caps.map((c) => `⚠ ${esc(c)}`).join('<br>')}</div>` : ''}
      ${d ? '' : s.loadingDetail ? '<p class="muted small">Ayrıntılı istatistikler bilgisayardan yükleniyor…</p>' : s.pending ? '<p class="muted small">Sürüş bitince alt metrikler, grafikler ve olay listesi bu karta yazılır. Şimdilik canlı bileşen puanları görünür.</p>' : '<p class="muted small">Bu oturum ayrıntılı kayıttan önce tutulmuş. Puan, bileşenler ve kısa notlar duruyor. Alt metrikler, grafikler ve olay listesi bundan sonraki oturumlarda burada açılır.</p>'}
    </div>`;
  if (!d) {
    return `${head}
      <div class="card"><h3>Bileşenler</h3>${compBars}</div>
      <div class="grid2">
        <div class="card"><h3>Koç önerileri</h3>${list(tips, 'Kayıtlı öneri yok.')}</div>
        <div class="card"><h3>Güçlü yönler</h3>${list(s.strengths, 'Kayıtlı güçlü yön yok.')}</div>
      </div>`;
  }
  const weak = d.subs.filter((row) => row.score != null && row.score < 75).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 4);
  const groups = COMPONENTS.map((c) => {
    const rows = d.subs.filter((row) => row.component === c);
    if (!rows.length) return '';
    const score = comps?.[c];
    return `<div class="card"><div class="metric-head"><h3 style="color:${COMPONENT_META[c].color}">${esc(COMPONENT_META[c].title)}</h3><b style="color:${score == null ? '#8894a3' : scoreColor(score)}">${score == null ? '—' : Math.round(score)}</b></div>${metricRows(rows)}</div>`;
  }).join('');
  const insights = d.insights
    .map(
      (ins) =>
        `<div class="card"><div class="metric-head"><h3 style="color:${esc(ins.color)}">${esc(ins.title)}</h3><b style="color:${ins.score == null ? '#8894a3' : scoreColor(ins.score)}">${ins.score ?? '—'}</b></div><p class="muted small">${esc(ins.tip)}</p>${metricRows(ins.rows)}</div>`
    )
    .join('');
  const zones = d.zones.length
    ? `<div class="card"><h3>Hız bölgeleri</h3><table class="ztable"><thead><tr><th>Bölge</th><th>Sınır</th><th>Süre</th><th>İçinde</th><th>Aşım</th></tr></thead><tbody>${d.zones
        .map(
          (z) =>
            `<tr><td>${esc(z.name)}</td><td>${z.limit}</td><td>${formatTime(z.timeSec)}</td><td style="color:${z.inPct >= 95 ? '#4cd07d' : z.inPct >= 80 ? '#ffa726' : '#f0544f'}">%${z.inPct}</td><td>${z.maxOver > 0 ? `+${z.maxOver}` : '—'}</td></tr>`
        )
        .join('')}</tbody></table></div>`
    : '';
  const events = d.events.length
    ? `<div class="card"><h3>Olaylar</h3><ul class="timeline">${d.events
        .map(
          (e) =>
            `<li><span class="tl-t">${formatTime(e.t)}</span><span class="tl-sev" style="background:${SEV_COLOR[e.severity] ?? '#6aa9ff'}">${esc(SEVERITY_LABEL[e.severity] ?? e.severity)}</span><span class="tl-c">${esc(COMPONENT_META[e.component]?.title ?? e.component)}</span><span class="tl-m">${esc(e.message)}</span></li>`
        )
        .join('')}</ul></div>`
    : '';
  return `${head}
    <div class="tiles">${d.tiles.map((t) => `<div class="tile"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}</div>`).join('')}</div>
    <div class="grid2">
      <div class="card"><h3>5 eksen</h3>${full ? barRows(COMPONENTS.map((c) => ({ label: COMPONENT_META[c].title, value: comps![c] ?? null, sub: COMPONENT_META[c].tip }))) : compBars}</div>
      <div class="card center">${full ? radarSvg(comps as Record<Component, number>, compare ?? undefined, 240) : ''}${compare ? '<p class="muted small">Kesik çizgi: karne ortalaman</p>' : ''}</div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Koç önerileri</h3>${list(tips, 'Öneri yok.')}</div>
      <div class="card"><h3>Güçlü yönler</h3>${list(s.strengths, 'Bu oturumda 90 ve üzeri alan yok.')}${weak.length ? `<h3>Zayıf yönler</h3>${list(weak.map((w) => w.name), '')}` : ''}</div>
    </div>
    ${groups}
    ${insights ? `<h3 class="insight-head">Belirti okumaları</h3>${insights}` : ''}
    ${charts(d)}
    ${zones}
    <div class="card"><h3>Stil profili</h3>${styleTable(d.style, baseline)}<p class="muted small">Stil tutarlılığı güvenlik puanını değiştirmez. Kişisel profil, kalibrasyondan sonra oluşan ortalamadır.</p></div>
    ${events}`;
}

export function bindSessionAnalysis(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('.metric-row').forEach((row) => {
    const toggle = () => {
      const open = row.classList.toggle('open');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });
}
