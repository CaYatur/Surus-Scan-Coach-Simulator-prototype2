import { download, el, esc, scoreColor } from './dom';
import { barRows, lineChart, radarSvg, scoreRing, stars } from './charts';
import { COMPONENTS, COMPONENT_META, SEVERITY_LABEL, type CoachEvent, type Component } from '../coach/types';
import type { ReportData } from '../game/session';
import { formatTime, mean } from '../core/math';
import { BADGES } from '../coach/profiles';
import type { MapRenderer } from './mapRenderer';
import type { StyleBaseline } from '../coach/metrics';

const SEV_COLOR: Record<string, string> = { positive: '#4cd07d', info: '#6aa9ff', minor: '#f5b942', major: '#ff7a45', critical: '#f0544f' };

export type ReportActions = {
  onContinue?: () => void;
  onRetry?: () => void;
  onMenu: () => void;
  csv: () => string;
};

function statTile(label: string, value: string, sub = ''): string {
  return `<div class="tile"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function styleRows(cur: StyleBaseline, base: StyleBaseline | null): string {
  const rows: [string, (b: StyleBaseline) => number, string, number][] = [
    ['Hız tercihi (sınıra oran)', (b) => b.speedRatio * 100, '%', 0],
    ['Hızlanma P90', (b) => b.accelP90, 'm/s²', 2],
    ['Yavaşlama P90', (b) => b.decelP90, 'm/s²', 2],
    ['Yanal ivme P90', (b) => b.latP90, 'm/s²', 2],
    ['Sarsıntı (jerk RMS)', (b) => b.jerkRms, 'm/s³', 2],
    ['Direksiyon yön değiştirme (SRR)', (b) => b.srr, '/dk', 1],
    ['Takip mesafesi (medyan)', (b) => b.headwayMedian, 'sn', 1],
    ['Tepki süresi', (b) => b.reaction, 'sn', 2],
    ['Ayna sıklığı', (b) => b.mirrorRate, '/dk', 1],
    ['Sinyal öncesi süre', (b) => b.signalLead, 'sn', 1],
  ];
  return `<table class="tbl"><thead><tr><th>Özellik</th><th>Bu oturum</th><th>Kişisel profil</th><th>Fark</th></tr></thead><tbody>${rows
    .map(([label, f, unit, dp]) => {
      const a = f(cur);
      const b = base ? f(base) : null;
      const diff = b != null && b > 0 ? ((a - b) / b) * 100 : null;
      return `<tr><td>${label}</td><td>${a > 0 ? a.toFixed(dp) + ' ' + unit : '—'}</td><td>${b != null && b > 0 ? b.toFixed(dp) + ' ' + unit : '—'}</td><td>${diff == null || !isFinite(diff) || a <= 0 ? '—' : `<span style="color:${Math.abs(diff) < 15 ? '#4cd07d' : Math.abs(diff) < 35 ? '#f5b942' : '#f0544f'}">${diff > 0 ? '+' : ''}${diff.toFixed(0)}%</span>`}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function eventList(events: CoachEvent[], filter: Component | 'all'): string {
  const list = events.filter((e) => filter === 'all' || e.component === filter);
  if (!list.length) return '<p class="muted">Bu kategoride olay yok.</p>';
  return `<ul class="timeline">${list
    .map(
      (e) =>
        `<li><span class="tl-t">${formatTime(e.t)}</span><span class="tl-sev" style="background:${SEV_COLOR[e.severity]}">${SEVERITY_LABEL[e.severity]}</span><span class="tl-c">${COMPONENT_META[e.component].title}</span><span class="tl-m">${esc(e.message)}</span></li>`
    )
    .join('')}</ul>`;
}

/** Build the report DOM inside `host`. */
export function renderReport(host: HTMLElement, d: ReportData, map: MapRenderer, actions: ReportActions) {
  const r = d.result;
  host.innerHTML = '';
  const m = d.mission;
  const title = m ? `${m.def.icon} ${m.def.title}` : d.mapId === 'training' ? 'Eğitim Sürüşü Raporu' : 'Serbest Sürüş Raporu';
  const verdict = m
    ? m.success
      ? `<div class="verdict ok">Görev tamamlandı ${stars(m.stars)}</div>`
      : `<div class="verdict fail">Görev başarısız — ${esc(m.failReason)}</div>`
    : '';
  const kd = d.karne;
  const karneLine = kd
    ? `<div class="karne-delta">Karne (${esc(d.profileName ?? '')}): <b>${kd.profile.karne.overall}</b> <span style="color:${kd.delta >= 0 ? '#4cd07d' : '#f0544f'}">${kd.delta >= 0 ? '+' : ''}${kd.delta}</span></div>`
    : d.profileName
      ? ''
      : '<div class="karne-delta muted">Misafir sürüş — karneye işlenmedi (profil oluşturun)</div>';
  const badges = kd?.newBadges.length
    ? `<div class="new-badges">${kd.newBadges.map((b) => `<span class="badge-chip">${BADGES[b].icon} ${esc(BADGES[b].title)}</span>`).join('')}</div>`
    : '';
  const head = el('div', {
    class: 'rp-head',
    html: `<div class="rp-ring">${scoreRing(r.overall, 150, `Not ${r.grade}`)}</div>
      <div class="rp-title"><h1>${esc(title)}</h1>
        <div class="rp-sub">${esc(d.mapName)} · ${esc(d.conditions)} · ${formatTime(r.durationSec)} · ${r.distanceKm.toFixed(2)} km</div>
        ${verdict}
        <div class="rp-badges"><span class="risk risk-${r.risk}">Risk: ${r.risk}</span>${r.styleAdherence != null ? `<span class="chip">Stil tutarlılığı ${r.styleAdherence}</span>` : ''}${r.confidence < 0.8 ? `<span class="chip muted">Kısa oturum güveni %${Math.round(r.confidence * 100)}</span>` : ''}</div>
        ${karneLine}${badges}
        ${r.caps.length ? `<div class="caps">${r.caps.map((c) => `⚠ ${esc(c)}`).join('<br>')}</div>` : ''}
      </div>`,
  });
  const tabs = ['Özet', 'Olaylar', 'Harita', 'Grafikler', 'Detaylı metrikler', 'Stil profili'];
  const tabBar = el('div', { class: 'tabs' });
  const body = el('div', { class: 'rp-body' });
  const pages: HTMLElement[] = [];

  // ——— Özet ———
  const st = d.stats;
  const man = st.turns.total + st.laneChanges.total;
  const compBars = barRows(COMPONENTS.map((c) => ({ label: COMPONENT_META[c].title, value: r.components[c], sub: `${Math.round(COMPONENT_META[c].weight * 100)}% · ${COMPONENT_META[c].tip}` })));
  const karneCmp = kd ? kd.profile.karne.components : undefined;
  const reaction = st.reactionTimes.length ? `${mean(st.reactionTimes).toFixed(2)} sn` : '—';
  const summary = el('div', {
    class: 'page',
    html: `<div class="grid2">
      <div class="card"><h3>5 eksen</h3>${compBars}<p class="muted small">Ağırlıklar: Güvenli sürüş %30 · Kural %25 · Gözlem %20 · Araç hâkimiyeti %15 · Görev & güzergâh %10</p></div>
      <div class="card center">${radarSvg(r.components, karneCmp, 260)}${karneCmp ? '<p class="muted small">Kesik çizgi: karne ortalaman</p>' : ''}</div>
    </div>
    <div class="tiles">
      ${statTile('Ortalama hız', `${r.avgKmh.toFixed(0)} km/h`, `maks ${r.maxKmh.toFixed(0)}`)}
      ${statTile('Manevra', String(man), `${st.turns.total} dönüş · ${st.laneChanges.total} şerit`)}
      ${statTile('Ayna kontrolü', `${d.scan.rate.toFixed(1)}/dk`, `en uzun ara ${d.scan.maxGap.toFixed(0)} sn`)}
      ${statTile('Omuz kontrolü', String(d.scan.shoulder))}
      ${statTile('Tepki süresi', reaction, st.reactionTimes.length ? `${st.reactionTimes.length} ölçüm` : '')}
      ${statTile('Min. TTC', isFinite(st.minTTC) ? `${st.minTTC.toFixed(1)} sn` : '—', `${st.nearMiss} ramak kala`)}
      ${statTile('Takip mesafesi', isFinite(st.minHeadway) ? `min ${st.minHeadway.toFixed(1)} sn` : '—')}
      ${statTile('Işık / DUR', `${st.redLights} kırmızı`, `${st.stopSigns.full}/${st.stopSigns.total} tam duruş`)}
      ${st.highwayTime > 5 ? statTile('Bölünmüş yol', `${(st.highwayDistance / 1000).toFixed(1)} km`, `${st.rightOvertakes} sağdan sollama · ${st.leftLaneHog} sol şerit`) : ''}
      ${st.roundabouts.total ? statTile('Dönel kavşak', `${st.roundabouts.exitSignal}/${st.roundabouts.total}`, 'çıkışta sinyal') : ''}
      ${statTile('Şerit değişimi', `${st.laneChanges.signaled}/${st.laneChanges.total}`, `sinyalli · ${st.solidLine} düz çizgi`)}
    </div>
    <div class="grid2">
      <div class="card"><h3>🧭 Koç önerileri</h3><ol class="tips">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
      <div class="card"><h3>💪 Güçlü yönler</h3>${r.strengths.length ? `<ul class="tips">${r.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="muted">Bu oturumda 90+ alan yok — pratik yapmaya devam!</p>'}
      ${m ? `<h3>🎯 Görev</h3><ul class="objs-r">${m.objectives.map((o) => `<li class="${o.status}">${o.status === 'done' ? '✔' : o.status === 'failed' ? '✖' : '○'} ${esc(o.title)}</li>`).join('')}</ul>${m.lines.length ? `<ul class="tips">${m.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}` : ''}</div>
    </div>`,
  });
  pages.push(summary);

  // ——— Olaylar ———
  const evPage = el('div', { class: 'page' });
  const filters = el('div', { class: 'seg' });
  const evList = el('div');
  const counts = (c: Component | 'all') => d.events.filter((e) => c === 'all' || e.component === c).length;
  const setFilter = (f: Component | 'all') => {
    evList.innerHTML = eventList(d.events, f);
    filters.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.f === f));
  };
  for (const f of ['all', ...COMPONENTS] as (Component | 'all')[]) {
    const b = el('button', { 'data-f': f, text: `${f === 'all' ? 'Tümü' : COMPONENT_META[f].title} (${counts(f)})` });
    b.onclick = () => setFilter(f);
    filters.append(b);
  }
  evPage.append(filters, evList);
  setFilter('all');
  pages.push(evPage);

  // ——— Harita ———
  const mapPage = el('div', { class: 'page' });
  const cv = el('canvas', { width: 900, height: 560, class: 'trace' });
  mapPage.append(cv, el('p', { class: 'muted small', text: 'Çizgi rengi hızı gösterir (mavi yavaş → kırmızı hızlı). Noktalar olaylardır (renk: önem derecesi).' }));
  const pts = d.samples.filter((_, i) => i % 3 === 0).map((s) => ({ x: s.x, z: s.z, v: s.kmh }));
  const pins = d.events.filter((e) => e.severity !== 'info').map((e) => ({ x: e.x, z: e.z, color: SEV_COLOR[e.severity] }));
  requestAnimationFrame(() => map.drawTrace(cv.getContext('2d')!, cv.width, cv.height, pts, pins));
  pages.push(mapPage);

  // ——— Grafikler ———
  const step = Math.max(1, Math.floor(d.samples.length / 600));
  const ds = d.samples.filter((_, i) => i % step === 0);
  const markers = d.events.filter((e) => e.severity === 'major' || e.severity === 'critical').map((e) => ({ x: e.t, color: SEV_COLOR[e.severity], label: e.message }));
  const xFmt = (x: number) => formatTime(x);
  const charts = el('div', {
    class: 'page',
    html: `<div class="card"><h3>Hız ve hız sınırı</h3>${lineChart(
      [
        { values: ds.map((s) => ({ x: s.t, y: s.kmh })), color: '#35a7ff', label: 'Hız (km/h)', fill: true },
        { values: ds.map((s) => ({ x: s.t, y: s.limit })), color: '#f0544f', label: 'Sınır', dashed: true },
      ],
      { yMin: 0, markers, xFmt }
    )}</div>
    <div class="card"><h3>Boylamsal & yanal ivme</h3>${lineChart(
      [
        { values: ds.map((s) => ({ x: s.t, y: s.accel })), color: '#4cd07d', label: 'Boylamsal (m/s²)' },
        { values: ds.map((s) => ({ x: s.t, y: s.latAccel })), color: '#ab47bc', label: 'Yanal (m/s²)' },
      ],
      { yMin: -8, yMax: 6, xFmt }
    )}</div>
    <div class="card"><h3>Takip mesafesi (sn)</h3>${lineChart([{ values: ds.filter((s) => s.headway != null).map((s) => ({ x: s.t, y: Math.min(6, s.headway!) })), color: '#ffa726', label: 'Headway' }], { yMin: 0, yMax: 6, xFmt })}</div>`,
  });
  pages.push(charts);

  // ——— Detaylı metrikler ———
  const detail = el('div', { class: 'page' });
  for (const c of COMPONENTS) {
    const subs = r.subs.filter((s) => s.component === c);
    detail.append(
      el('div', {
        class: 'card',
        html: `<h3 style="color:${COMPONENT_META[c].color}">${COMPONENT_META[c].title} — ${r.components[c]}</h3>${barRows(subs.map((s) => ({ label: s.name, value: s.score, sub: `${s.value} · ${s.detail}` })))}`,
      })
    );
  }
  const zoneRows = Object.entries(st.zones)
    .filter(([, z]) => z.time > 3)
    .sort((a, b) => b[1].time - a[1].time)
    .map(([k, z]) => {
      const pctIn = Math.round((1 - z.over / Math.max(0.1, z.time)) * 100);
      return `<tr><td>${esc(k)}</td><td>${z.limit} km/h</td><td>${formatTime(z.time)}</td><td style="color:${pctIn >= 95 ? '#4cd07d' : pctIn >= 80 ? '#ffa726' : '#f0544f'}">%${pctIn}</td><td>${z.maxOver > 0 ? `+${Math.round(z.maxOver)}` : '—'}</td></tr>`;
    })
    .join('');
  if (zoneRows) {
    detail.append(
      el('div', {
        class: 'card',
        html: `<h3>🚸 Hız bölgeleri</h3><table class="ztable"><thead><tr><th>Bölge / yol</th><th>Sınır</th><th>Süre</th><th>Sınır içinde</th><th>En fazla aşım</th></tr></thead><tbody>${zoneRows}</tbody></table><p class="muted small">Tolerans: okul/hastane/çarşı 3 km/h, diğer yollarda sınırın %10'u (en az 6 km/h).</p>`,
      })
    );
  }
  detail.append(
    el('div', {
      class: 'card',
      html: `<h3>Yöntem</h3><p class="muted small">Olaylar sürüş sırasında kural tabanlı dedektörlerle çıkarılır (şerit/dönüş için Ayna→Sinyal→Manevra sırası, ışık fazı, DUR levhasında en düşük hız, TTC ve takip mesafesi, yanal/boylamsal ivme). Alt metrikler 0–100 aralığına ölçeklenir, bileşen içinde ağırlıklandırılır ve Güvenli sürüş %30 · Kural %25 · Gözlem %20 · Araç hâkimiyeti %15 · Görev & güzergâh %10 ağırlıklarıyla birleştirilir. Kısa oturumlar düşük güvenle 70'e doğru çekilir; ağır ihlaller toplam puana tavan uygular. Tarama ölçümü ${esc('bakış tuşları / webcam kafa takibi / tek tuş')} proxy'sidir — klinik göz takibi değildir.</p>`,
    })
  );
  pages.push(detail);

  // ——— Stil ———
  const stylePage = el('div', {
    class: 'page',
    html: `<div class="card"><h3>Kişisel sürüş profili karşılaştırması</h3>${d.baseline ? '' : '<p class="muted">Henüz kalibre edilmiş bir profil yok. Kalibrasyon Programı\'nı tamamlayınca bu oturum kişisel ortalamanla karşılaştırılır.</p>'}${styleRows(r.style, d.baseline)}<p class="muted small">Stil tutarlılığı güvenlik puanını şişirmez; yalnızca alışkanlıklarındaki değişimi gösterir.</p></div>`,
  });
  pages.push(stylePage);

  tabs.forEach((t, i) => {
    const b = el('button', { text: t });
    b.onclick = () => {
      pages.forEach((p, j) => p.classList.toggle('hidden', j !== i));
      tabBar.querySelectorAll('button').forEach((x, j) => x.classList.toggle('active', j === i));
    };
    tabBar.append(b);
  });
  pages.forEach((p, j) => p.classList.toggle('hidden', j !== 0));
  (tabBar.firstChild as HTMLElement).classList.add('active');
  body.append(...pages);

  // ——— Actions ———
  const bar = el('div', { class: 'rp-actions' });
  if (actions.onContinue) bar.append(button('Sürüşe devam et', 'primary', actions.onContinue));
  if (actions.onRetry) bar.append(button(m ? 'Görevi tekrarla' : 'Yeniden başlat', '', actions.onRetry));
  bar.append(button('Ana menü', '', actions.onMenu));
  bar.append(el('span', { class: 'spacer' }));
  bar.append(button('HTML rapor', 'ghost', () => download(`surus-raporu-${new Date(d.at).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`, standaloneHtml(host, title), 'text/html')));
  bar.append(button('Telemetri CSV', 'ghost', () => download('telemetri.csv', actions.csv(), 'text/csv')));
  bar.append(
    button('JSON', 'ghost', () =>
      download(
        'oturum.json',
        JSON.stringify({ result: d.result, stats: d.stats, events: d.events, mission: d.mission ? { id: d.mission.def.id, success: d.mission.success, stars: d.mission.stars, lines: d.mission.lines } : null, conditions: d.conditions, map: d.mapName }, null, 2),
        'application/json'
      )
    )
  );
  host.append(head, tabBar, body, bar);
}

function button(text: string, kind: string, fn: () => void) {
  const b = el('button', { class: `btn ${kind}`, text });
  b.onclick = fn;
  return b;
}

function standaloneHtml(host: HTMLElement, title: string): string {
  const css = [...document.styleSheets]
    .map((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.page').forEach((p) => p.classList.remove('hidden'));
  clone.querySelector('.rp-actions')?.remove();
  clone.querySelector('.tabs')?.remove();
  clone.querySelectorAll('canvas').forEach((c, i) => {
    const src = host.querySelectorAll('canvas')[i] as HTMLCanvasElement | undefined;
    if (src) {
      const img = document.createElement('img');
      img.src = src.toDataURL('image/png');
      img.className = c.className;
      c.replaceWith(img);
    }
  });
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(title)} — Sürüş Koçu</title><style>${css}\nbody{overflow:auto;background:#0d1117}.report-doc{max-width:1100px;margin:24px auto;padding:24px}</style></head><body><div class="report-doc overlay-panel">${clone.innerHTML}</div></body></html>`;
}

export { scoreColor };
