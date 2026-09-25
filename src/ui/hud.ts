import { el, esc, scoreColor } from './dom';
import { formatDistance, formatTime } from '../core/math';
import { COMPONENTS, COMPONENT_META, type CoachEvent, type Component } from '../coach/types';
import type { ObjectiveView } from '../missions/mission';
import type { NavInstruction } from '../missions/navigator';
import type { HudMode } from '../core/settings';

const SEV_ICON: Record<string, string> = { positive: '✓', info: 'i', minor: '!', major: '!!', critical: '✖' };

const ARROW_SVG: Record<string, string> = {
  L: '<svg viewBox="0 0 48 48"><path d="M30 42V22a6 6 0 0 0-6-6H12" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M14 6 4 16l10 10" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  R: '<svg viewBox="0 0 48 48"><path d="M18 42V22a6 6 0 0 1 6-6h12" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M34 6l10 10-10 10" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  S: '<svg viewBox="0 0 48 48"><path d="M24 44V8" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M12 18 24 6l12 12" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  U: '<svg viewBox="0 0 48 48"><path d="M16 44V18a8 8 0 0 1 16 0v14" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M22 28l10 10 10-10" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '': '<svg viewBox="0 0 48 48"><circle cx="24" cy="20" r="8" fill="currentColor"/><path d="M24 44 12 24h24z" fill="currentColor"/></svg>',
};

export type ScanView = { mirrorL: number; mirrorR: number; mirrorRear: number; shoulderL: number; shoulderR: number; sinceAny: number; glance: string };

/** In-drive heads-up display (DOM). */
export class Hud {
  readonly root: HTMLElement;
  private speedVal: HTMLElement;
  private limitSign: HTMLElement;
  private gearEl: HTMLElement;
  private rpmBar: HTMLElement;
  private indL: HTMLElement;
  private indR: HTMLElement;
  private icons: HTMLElement;
  private headway: HTMLElement;
  private nav: HTMLElement;
  private mission: HTMLElement;
  private scores: HTMLElement;
  private feed: HTMLElement;
  private toasts: HTMLElement;
  private stim: HTMLElement;
  private meterEl: HTMLElement;
  private scan: HTMLElement;
  private scanParts: Record<string, HTMLElement> = {};
  private scanText: HTMLElement;
  readonly minimap: HTMLCanvasElement;
  private statsEl: HTMLElement;
  private fpsEl: HTMLElement;
  private crashFlash: HTMLElement;
  private hintBar: HTMLElement;
  private conditionsEl: HTMLElement;
  private lastMission = '';
  mode: HudMode = 'full';

  constructor(host: HTMLElement) {
    this.root = el('div', { id: 'hud' });
    host.append(this.root);

    // ——— bottom-centre cluster ———
    this.speedVal = el('div', { class: 'spd-val', text: '0' });
    this.limitSign = el('div', { class: 'limit-sign', text: '50' });
    this.gearEl = el('div', { class: 'gear', text: 'D1' });
    this.rpmBar = el('div', { class: 'rpm-fill' });
    this.indL = el('div', { class: 'ind ind-l', html: '<svg viewBox="0 0 24 24"><path d="M10 4 2 12l8 8v-5h12V9H10z" fill="currentColor"/></svg>' });
    this.indR = el('div', { class: 'ind ind-r', html: '<svg viewBox="0 0 24 24"><path d="M14 4l8 8-8 8v-5H2V9h12z" fill="currentColor"/></svg>' });
    this.icons = el('div', { class: 'tell' });
    this.headway = el('div', { class: 'headway hidden' });
    const cluster = el('div', { class: 'cluster panel' }, [
      this.indL,
      el('div', { class: 'spd' }, [this.speedVal, el('div', { class: 'spd-unit', text: 'km/h' }), el('div', { class: 'rpm' }, [this.rpmBar])]),
      el('div', { class: 'cluster-side' }, [this.limitSign, this.gearEl]),
      this.indR,
      this.icons,
    ]);
    this.root.append(el('div', { class: 'hud-bottom' }, [this.headway, cluster]));

    // ——— navigation card ———
    this.nav = el('div', { class: 'nav-card panel hidden' });
    this.root.append(this.nav);

    // ——— mission panel ———
    this.mission = el('div', { class: 'mission panel' });
    this.meterEl = el('div', { class: 'meter hidden' });
    this.root.append(el('div', { class: 'hud-tl' }, [this.mission, this.meterEl]));

    // ——— live scores + stats ———
    this.scores = el('div', { class: 'scores panel hidden' });
    this.statsEl = el('div', { class: 'stats' });
    this.conditionsEl = el('div', { class: 'conditions' });
    this.feed = el('div', { class: 'feed' });
    this.root.append(el('div', { class: 'hud-tr' }, [this.scores, this.statsEl, this.conditionsEl, this.feed]));

    // ——— scan widget ———
    this.scan = el('div', { class: 'scan panel' });
    const svg = `
      <svg viewBox="0 0 120 150" class="scan-car">
        <path class="zone" data-z="shoulderL" d="M6 70 L30 58 L30 110 L6 122 Z"/>
        <path class="zone" data-z="shoulderR" d="M114 70 L90 58 L90 110 L114 122 Z"/>
        <path class="zone" data-z="mirrorL" d="M8 40 L30 46 L30 56 L8 62 Z"/>
        <path class="zone" data-z="mirrorR" d="M112 40 L90 46 L90 56 L112 62 Z"/>
        <path class="zone" data-z="mirrorRear" d="M44 124 L76 124 L86 148 L34 148 Z"/>
        <rect x="34" y="18" width="52" height="104" rx="16" class="car-body"/>
        <rect x="40" y="38" width="40" height="22" rx="5" class="car-glass"/>
        <rect x="40" y="90" width="40" height="16" rx="5" class="car-glass"/>
        <circle class="eye" cx="66" cy="66" r="4"/>
      </svg>`;
    this.scan.innerHTML = svg;
    this.scan.querySelectorAll<SVGPathElement>('.zone').forEach((z) => (this.scanParts[z.dataset.z!] = z as unknown as HTMLElement));
    this.scanText = el('div', { class: 'scan-text' });
    this.scan.append(this.scanText);
    this.minimap = el('canvas', { class: 'minimap', width: 240, height: 240 });
    this.root.append(el('div', { class: 'hud-bl' }, [this.scan]));
    this.root.append(el('div', { class: 'hud-br' }, [this.minimap]));

    // ——— centre overlays ———
    this.toasts = el('div', { class: 'toasts' });
    this.stim = el('div', { class: 'stimulus hidden' });
    this.crashFlash = el('div', { class: 'crash-flash' });
    this.root.append(this.toasts, this.stim, this.crashFlash);
    this.hintBar = el('div', { class: 'hint-bar', html: '' });
    this.root.append(this.hintBar);
    this.fpsEl = el('div', { class: 'fps hidden' });
    this.root.append(this.fpsEl);
  }

  setMode(m: HudMode) {
    this.mode = m;
    this.root.dataset.mode = m;
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  setCluster(s: { kmh: number; limit: number; gear: string; rpmFrac: number; sigL: boolean; sigR: boolean; blink: boolean; lights: boolean; handbrake: boolean; wipers: number; cam: string; cruise?: number | null; engineOff?: boolean; abs?: boolean; clutch?: number }) {
    this.speedVal.textContent = String(Math.round(s.kmh));
    const over = s.kmh > s.limit + 3;
    this.speedVal.classList.toggle('over', over);
    if (this.limitSign.textContent !== String(s.limit)) this.limitSign.textContent = String(s.limit);
    this.limitSign.classList.toggle('flash', over);
    this.gearEl.textContent = s.gear;
    this.rpmBar.style.width = `${Math.round(s.rpmFrac * 100)}%`;
    this.rpmBar.classList.toggle('red', s.rpmFrac > 0.85);
    this.indL.classList.toggle('on', s.sigL && s.blink);
    this.indR.classList.toggle('on', s.sigR && s.blink);
    this.indL.classList.toggle('armed', s.sigL);
    this.indR.classList.toggle('armed', s.sigR);
    this.icons.innerHTML =
      `<span class="ti ${s.lights ? 'on-blue' : ''}" title="Farlar (L)">◐</span>` +
      `<span class="ti ${s.handbrake ? 'on-red' : ''}" title="El freni">(P)</span>` +
      `<span class="ti ${s.wipers ? 'on-green' : ''}" title="Silecek (I)">⌇</span>` +
      (s.cruise ? `<span class="ti on-green" title="Hız sabitleyici (K)">⏲ ${s.cruise}</span>` : '') +
      (s.engineOff ? `<span class="ti on-red" title="Motor durdu">MOTOR</span>` : '') +
      (s.abs === false ? `<span class="ti" title="ABS kapalı">ABS✕</span>` : '') +
      (s.clutch != null && s.clutch > 0.1 ? `<span class="ti on-blue" title="Debriyaj">D ${Math.round(s.clutch * 100)}%</span>` : '') +
      `<span class="ti cam" title="Kamera (V)">🎥 ${esc(s.cam)}</span>`;
  }

  /** Bottom hint line (built from the current key bindings). */
  setHints(html: string) {
    if (this.hintBar.innerHTML !== html) this.hintBar.innerHTML = html;
  }

  setHeadway(sec: number | null, wet: boolean) {
    if (sec == null || sec > 6) {
      this.headway.classList.add('hidden');
      return;
    }
    const need = wet ? 4 : 2;
    const tone = sec < need * 0.5 ? 'bad' : sec < need ? 'warn' : 'good';
    this.headway.className = `headway panel ${tone}`;
    this.headway.innerHTML = `<span>Takip</span><b>${sec.toFixed(1)} sn</b><div class="hw-bar"><i style="width:${Math.min(100, (sec / (need * 1.5)) * 100)}%"></i><em style="left:${(need / (need * 1.5)) * 100}%"></em></div>`;
  }

  setNav(n: NavInstruction | null) {
    if (!n) {
      this.nav.classList.add('hidden');
      return;
    }
    this.nav.classList.remove('hidden');
    this.nav.innerHTML = `<div class="nav-arrow">${ARROW_SVG[n.arrow] ?? ARROW_SVG.S}</div><div class="nav-body"><div class="nav-dist">${n.dist > 0 ? formatDistance(n.dist) : ''}</div><div class="nav-text">${esc(n.text)}</div></div>`;
  }

  setMission(title: string, sub: string, objs: ObjectiveView[], hint: string, timer: string) {
    const key = title + sub + objs.map((o) => o.status + o.title).join('|') + hint + timer;
    if (key === this.lastMission) return;
    this.lastMission = key;
    const icon = (s: ObjectiveView['status']) => (s === 'done' ? '✔' : s === 'failed' ? '✖' : s === 'active' ? '➤' : '○');
    const list = objs
      .map((o) => `<li class="obj ${o.status}${o.detail ? ' cons' : ''}"><span class="oi">${icon(o.status)}</span>${esc(o.title)}</li>`)
      .join('');
    this.mission.innerHTML = `<div class="m-head"><div class="m-title">${esc(title)}</div><div class="m-timer">${esc(timer)}</div></div><div class="m-sub">${esc(sub)}</div>${list ? `<ul class="objs">${list}</ul>` : ''}${hint ? `<div class="m-hint">💡 ${esc(hint)}</div>` : ''}`;
  }

  setScores(c: Record<Component, number>, overall: number, show: boolean) {
    if (!show) {
      this.scores.classList.add('hidden');
      return;
    }
    this.scores.classList.remove('hidden');
    const bars = COMPONENTS.map(
      (k) =>
        `<div class="sc-row"><span>${COMPONENT_META[k].title}</span><div class="sc-bar"><i style="width:${c[k]}%;background:${scoreColor(c[k])}"></i></div><b>${c[k]}</b></div>`
    ).join('');
    this.scores.innerHTML = `<div class="sc-head"><span>Canlı puan</span><b style="color:${scoreColor(overall)}">${overall}</b></div>${bars}`;
  }

  setStats(t: number, dist: number, extra: string) {
    this.statsEl.innerHTML = `<span>⏱ ${formatTime(t)}</span><span>🛣 ${formatDistance(dist)}</span>${extra ? `<span>${esc(extra)}</span>` : ''}`;
  }

  setConditions(text: string) {
    this.conditionsEl.textContent = text;
  }

  pushEvent(e: CoachEvent) {
    if (e.severity === 'info' && e.kind !== 'reaction') return;
    const item = el('div', { class: `ev ev-${e.severity}` }, [el('span', { class: 'ev-i', text: SEV_ICON[e.severity] }), el('span', { text: e.message })]);
    this.feed.prepend(item);
    while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    setTimeout(() => item.classList.add('fade'), 7000);
    setTimeout(() => item.remove(), 8000);
  }

  toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info', ms = 3200) {
    const t = el('div', { class: `toast ${kind}`, text });
    this.toasts.append(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 400);
  }

  stimulus(text: string | null) {
    this.stim.classList.toggle('hidden', !text);
    this.stim.textContent = text ?? '';
  }

  meter(label: string | null, v = 0) {
    if (!label) {
      this.meterEl.classList.add('hidden');
      return;
    }
    this.meterEl.classList.remove('hidden');
    this.meterEl.innerHTML = `<span>${esc(label)}</span><div class="meter-bar"><i style="width:${Math.round(v)}%;background:${scoreColor(v)}"></i></div><b>${Math.round(v)}</b>`;
  }

  setScan(s: ScanView) {
    for (const [k, part] of Object.entries(this.scanParts)) {
      const age = (s as unknown as Record<string, number>)[k];
      const a = Math.max(0, 1 - age / 8);
      part.style.fillOpacity = String(0.12 + a * 0.75);
      part.classList.toggle('now', s.glance === k);
    }
    const since = s.sinceAny;
    const tone = since < 10 ? 'good' : since < 20 ? 'warn' : 'bad';
    this.scanText.innerHTML = `<span class="${tone}">Son ayna: ${since > 900 ? '—' : Math.round(since) + ' sn'}</span><small>Z sol · X dikiz · C sağ</small>`;
  }

  crash(strength: number) {
    this.crashFlash.style.opacity = String(Math.min(0.75, 0.2 + strength));
    setTimeout(() => (this.crashFlash.style.opacity = '0'), 120);
  }

  setFps(fps: number | null) {
    this.fpsEl.classList.toggle('hidden', fps == null);
    if (fps != null) this.fpsEl.textContent = `${Math.round(fps)} FPS`;
  }
}
