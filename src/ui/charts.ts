import { COMPONENTS, COMPONENT_META, type Component } from '../coach/types';
import { esc, scoreColor } from './dom';

/** 5-axis radar (SVG string). Optional second series drawn dashed (e.g. karne average). */
export function radarSvg(values: Record<Component, number>, compare?: Record<Component, number>, size = 240): string {
  const c = size / 2;
  const r = size * 0.36;
  const n = COMPONENTS.length;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [c + Math.cos(a) * r * (v / 100), c + Math.sin(a) * r * (v / 100)];
  };
  let grid = '';
  for (const lvl of [25, 50, 75, 100]) {
    grid += `<polygon points="${COMPONENTS.map((_, i) => pt(i, lvl).join(',')).join(' ')}" class="rg"/>`;
  }
  let axes = '';
  COMPONENTS.forEach((k, i) => {
    const [x, y] = pt(i, 100);
    axes += `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" class="ra"/>`;
    const [lx, ly] = pt(i, 128);
    axes += `<text x="${lx}" y="${ly}" class="rl" text-anchor="middle" dominant-baseline="middle">${esc(COMPONENT_META[k].title)}</text>`;
    const [vx, vy] = pt(i, values[k]);
    axes += `<circle cx="${vx}" cy="${vy}" r="3.5" fill="${scoreColor(values[k])}"/>`;
  });
  const poly = COMPONENTS.map((k, i) => pt(i, values[k]).join(',')).join(' ');
  const cmp = compare ? `<polygon points="${COMPONENTS.map((k, i) => pt(i, compare[k]).join(',')).join(' ')}" class="rc"/>` : '';
  return `<svg class="radar" viewBox="-40 -6 ${size + 80} ${size + 12}" width="${size + 80}" height="${size + 12}">${grid}${axes}${cmp}<polygon points="${poly}" class="rp"/></svg>`;
}

/** Simple line chart; series share the x domain. */
export function lineChart(
  series: { values: { x: number; y: number }[]; color: string; label: string; dashed?: boolean; fill?: boolean }[],
  opts: { w?: number; h?: number; yMin?: number; yMax?: number; xLabel?: string; yLabel?: string; markers?: { x: number; color: string; label: string }[]; xFmt?: (x: number) => string } = {}
): string {
  const W = opts.w ?? 640;
  const H = opts.h ?? 200;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values);
  if (!all.length) return '<div class="muted">Veri yok</div>';
  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x), xMin + 1);
  const yMin = opts.yMin ?? Math.min(0, ...all.map((p) => p.y));
  const yMax = opts.yMax ?? Math.max(...all.map((p) => p.y), yMin + 1) * 1.08;
  const X = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * (W - pad.l - pad.r);
  const Y = (y: number) => H - pad.b - ((Math.max(yMin, Math.min(yMax, y)) - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="cg"/><text x="${pad.l - 6}" y="${Y(v)}" class="ct" text-anchor="end" dominant-baseline="middle">${Math.round(v)}</text>`;
  }
  const fmt = opts.xFmt ?? ((x: number) => `${Math.round(x)}`);
  let lastLabel = '';
  for (let i = 0; i <= 5; i++) {
    const v = xMin + ((xMax - xMin) * i) / 5;
    const label = fmt(v);
    if (label === lastLabel) continue;
    lastLabel = label;
    g += `<text x="${X(v)}" y="${H - 8}" class="ct" text-anchor="middle">${label}</text>`;
  }
  for (const m of opts.markers ?? []) {
    g += `<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${pad.t}" y2="${H - pad.b}" stroke="${m.color}" stroke-width="1.5" opacity="0.7"><title>${esc(m.label)}</title></line>`;
  }
  let paths = '';
  for (const s of series) {
    if (!s.values.length) continue;
    const d = s.values.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    if (s.fill) paths += `<path d="${d}L${X(s.values[s.values.length - 1].x)},${Y(yMin)}L${X(s.values[0].x)},${Y(yMin)}Z" fill="${s.color}" opacity="0.12"/>`;
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="6 4"' : ''}/>`;
  }
  const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${g}${paths}</svg><div class="legend">${legend}</div></div>`;
}

export function barRows(rows: { label: string; value: number | null; right?: string; sub?: string }[]): string {
  return rows
    .map((r) => {
      const v = r.value;
      return `<div class="bar-row"><div class="br-l"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div><div class="br-track">${v == null ? '<i class="na"></i>' : `<i style="width:${v}%;background:${scoreColor(v)}"></i>`}</div><div class="br-v" style="color:${v == null ? '#8894a3' : scoreColor(v)}">${v == null ? '—' : v}${r.right ? `<small>${esc(r.right)}</small>` : ''}</div></div>`;
    })
    .join('');
}

export function scoreRing(value: number, size = 150, label = ''): string {
  const r = size * 0.42;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - value / 100);
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" class="ring-bg"/><circle cx="${c}" cy="${c}" r="${r}" class="ring-fg" stroke="${scoreColor(value)}" stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 ${c} ${c})"/><text x="${c}" y="${c - 4}" text-anchor="middle" dominant-baseline="middle" class="ring-v">${value}</text><text x="${c}" y="${c + size * 0.2}" text-anchor="middle" class="ring-l">${esc(label)}</text></svg>`;
}

export function stars(n: number, max = 3): string {
  return `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(Math.max(0, max - n))}</span></span>`;
}
