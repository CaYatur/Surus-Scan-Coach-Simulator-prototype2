import { el, esc, scoreColor } from '../ui/dom';
import { storage } from '../core/storage';
import { COMPONENTS, COMPONENT_META, type EventKind } from '../coach/types';
import { DeviceLink, formatCode, linkUrl, newLinkCode, savedLink, type LinkStatus } from './link';
import { deviceName } from './device';
import { qrSvg } from './qr';
import { eventGroup, type DisplayMsg, type EventGroup, type HostMsg, type LinkEvent, type LinkReport, type LinkState, type LinkTelemetry } from './protocol';

/**
 * Companion display ("Canlı Koç Ekranı"): a phone paired with the game PC turns into a
 * live second screen for crashes, penalties, warnings, score and mission progress.
 */

const PREFS_KEY = 'ssc-companion-prefs';
type Prefs = { vibrate: boolean; sound: boolean; voice: boolean };

const GROUP_META: Record<EventGroup, { title: string; icon: string; color: string }> = {
  crash: { title: 'Kaza', icon: '💥', color: '#ff4d6d' },
  violation: { title: 'İhlal', icon: '⛔', color: '#ff9f43' },
  warning: { title: 'Uyarı', icon: '⚠️', color: '#f5c542' },
  positive: { title: 'Olumlu', icon: '✓', color: '#4cd07d' },
  info: { title: 'Bilgi', icon: 'ℹ️', color: '#6aa9ff' },
};

const KIND_ICON: Partial<Record<EventKind, string>> = {
  collision_vehicle: '💥',
  collision_static: '💥',
  collision_pedestrian: '🚸',
  hard_crash: '🚨',
  red_light: '🚦',
  yellow_risky: '🚦',
  stopline_over: '🚦',
  stop_rolling: '🛑',
  stop_ignored: '🛑',
  stop_full: '🛑',
  yield_fail: '🔻',
  rb_yield_fail: '🔄',
  rb_no_exit_signal: '🔄',
  rb_good: '🔄',
  speeding: '⏱️',
  zone_speeding: '🏫',
  too_slow: '🐢',
  wrong_way: '⛔',
  sidewalk: '🚧',
  median: '🚧',
  offroad: '🚧',
  shoulder_drive: '🚧',
  no_signal_turn: '↪️',
  no_signal_lane: '↔️',
  late_signal: '↔️',
  wrong_signal: '↔️',
  signal_left_on: '↔️',
  solid_line_change: '⛙',
  weaving: '〰️',
  right_overtake: '⏩',
  left_lane_hog: '⏪',
  no_mirror_lane: '🪞',
  no_mirror_turn: '🪞',
  mirror_neglect: '🪞',
  no_shoulder_lane: '👀',
  junction_no_scan: '👀',
  junction_scan_ok: '👀',
  idle_attention: '😴',
  msm_good: '✅',
  wrong_lane_turn: '🛣️',
  hard_brake: '🛞',
  hard_accel: '🛞',
  harsh_corner: '🛞',
  tailgating: '📏',
  near_miss: '⚠️',
  ped_not_yielded: '🚶',
  ped_yielded: '🚶',
  lane_straddle: '🛣️',
  no_headlights: '💡',
  reaction: '⚡',
  objective: '🎯',
  horn_prohibited: '📯',
  junction_block: '⛔',
  emergency_yield_fail: '🚑',
  emergency_yield_ok: '🚑',
  stall: '⚙️',
  reset: '↺',
  reroute: '🧭',
};

const MODE_LABEL: Record<LinkState['mode'], string> = {
  menu: 'Menüde',
  loading: 'Yükleniyor',
  driving: 'Sürüşte',
  paused: 'Duraklatıldı',
  report: 'Rapor',
};

const STATUS_LABEL: Record<LinkStatus, string> = {
  off: 'Bağlı değil',
  connecting: 'Sunucuya bağlanıyor…',
  waiting: 'Bilgisayar bekleniyor',
  connected: 'Bağlı',
  error: 'Sunucuya ulaşılamıyor — tekrar deneniyor',
};

function mmss(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const GAUGE_SWEEP = 240;

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(a0)} A${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

export class Companion {
  readonly link = new DeviceLink<HostMsg, DisplayMsg>('display');
  readonly root: HTMLElement;
  /** Fires when the full-screen dashboard is shown or hidden (the 3D game pauses rendering meanwhile). */
  onVisibility: ((visible: boolean) => void) | null = null;
  visible = false;
  hostName = '';
  private prefs: Prefs = { vibrate: true, sound: true, voice: false, ...storage.get<Partial<Prefs>>(PREFS_KEY, {}) };
  private state: LinkState | null = null;
  private tele: LinkTelemetry | null = null;
  private report: LinkReport | null = null;
  private events: LinkEvent[] = [];
  private filter: EventGroup | 'all' = 'all';
  private counts: Record<EventGroup, number> = { crash: 0, violation: 0, warning: 0, positive: 0, info: 0 };
  private audioCtx: AudioContext | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private alertTimer = 0;
  private ui!: {
    conn: HTMLElement;
    connText: HTMLElement;
    mode: HTMLElement;
    where: HTMLElement;
    timer: HTMLElement;
    speed: HTMLElement;
    speedArc: SVGPathElement;
    limit: HTMLElement;
    gear: HTMLElement;
    sigL: HTMLElement;
    sigR: HTMLElement;
    scoreArc: SVGCircleElement;
    scoreVal: HTMLElement;
    grade: HTMLElement;
    comps: HTMLElement;
    counters: HTMLElement;
    mission: HTMLElement;
    reportBox: HTMLElement;
    feed: HTMLElement;
    chips: HTMLElement;
    toasts: HTMLElement;
    alert: HTMLElement;
    flash: HTMLElement;
    wait: HTMLElement;
    idle: HTMLElement;
    pauseBtn: HTMLButtonElement;
    toggles: HTMLElement;
    stats: HTMLElement;
  };

  constructor(host: HTMLElement) {
    this.root = el('div', { id: 'companion', class: 'cmp hidden' });
    host.append(this.root);
    this.build();
    this.link.on('status', (s) => this.onStatus(s));
    this.link.on('peer', () => this.link.send({ t: 'hello', name: deviceName() }));
    this.link.on('message', ({ msg }) => this.onMessage(msg));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.visible) void this.keepAwake();
    });
  }

  /** Resume a remembered pairing (page reload) — returns true when the dashboard should open right away. */
  resumeSaved(): boolean {
    const saved = savedLink();
    if (saved?.role !== 'display') return false;
    this.link.start(saved.code);
    return true;
  }

  /** Make sure this device is listening for a PC and return the pairing code shown in its QR. */
  ensureListening(): string {
    if (this.link.active && this.link.code) return this.link.code;
    const code = newLinkCode();
    this.link.start(code);
    return code;
  }

  newCode(): string {
    this.link.stop();
    return this.ensureListening();
  }

  /** Join a code that came from the PC's QR (phone camera opened `?baglan=`). */
  join(code: string) {
    this.link.start(code);
    this.open();
  }

  open() {
    if (this.visible) return;
    this.visible = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('companion-on');
    this.render();
    void this.keepAwake();
    this.onVisibility?.(true);
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('companion-on');
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.onVisibility?.(false);
  }

  disconnect() {
    this.link.stop();
    this.state = null;
    this.tele = null;
    this.report = null;
    this.events = [];
    this.resetCounts();
    this.close();
  }

  // ——————————————————————————— link ———————————————————————————

  private onStatus(s: LinkStatus) {
    if (s === 'connected') {
      this.link.send({ t: 'hello', name: deviceName() });
      this.open();
      this.cue('connect');
    }
    this.renderConn();
  }

  private onMessage(m: HostMsg) {
    switch (m.t) {
      case 'hello':
        this.hostName = m.name;
        this.renderConn();
        break;
      case 'snapshot':
        this.state = m.state;
        this.tele = m.tele;
        this.report = m.report;
        this.events = m.events.slice();
        this.recount();
        this.render();
        break;
      case 'state': {
        const prev = this.state?.mode;
        this.state = m.state;
        if (prev !== m.state.mode && m.state.mode === 'driving' && prev !== 'paused') this.report = null;
        this.renderState();
        break;
      }
      case 'tele':
        this.tele = m.tele;
        this.renderTele();
        break;
      case 'event':
        this.events.push(m.event);
        if (this.events.length > 120) this.events.shift();
        this.counts[eventGroup(m.event)]++;
        this.renderCounters();
        this.prependFeed(m.event);
        this.react(m.event);
        break;
      case 'notice':
        this.toast(m.text, m.kind);
        break;
      case 'segment':
        this.events = [];
        this.report = null;
        this.resetCounts();
        this.render();
        break;
      case 'report':
        this.report = m.report;
        this.renderReport();
        this.root.querySelector('.cmp-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
        this.cue('report');
        break;
      case 'bye':
        break;
    }
  }

  // ——————————————————————————— build ———————————————————————————

  private build() {
    const r = this.root;
    const svg = (tag: string, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };

    const conn = el('div', { class: 'cmp-conn' }, [el('i'), el('span', { text: 'Bağlı değil' })]);
    const top = el('header', { class: 'cmp-top' }, [
      el('div', { class: 'cmp-brand', html: '<span class="cmp-logo">◎</span><div><b>CANLI KOÇ</b><small>Sürüş Koçu · ikinci ekran</small></div>' }),
      conn,
    ]);

    const mode = el('span', { class: 'cmp-mode', text: '—' });
    const where = el('span', { class: 'cmp-where', text: '' });
    const timer = el('span', { class: 'cmp-timer', text: '0:00' });
    const status = el('div', { class: 'cmp-status' }, [mode, where, timer]);

    // speed gauge
    const gauge = svg('svg', { viewBox: '0 0 200 170', class: 'cmp-gauge' }) as SVGSVGElement;
    const a0 = -GAUGE_SWEEP / 2;
    gauge.append(svg('path', { d: arcPath(100, 100, 82, a0, a0 + GAUGE_SWEEP), class: 'g-track' }));
    const speedArc = svg('path', { d: arcPath(100, 100, 82, a0, a0 + 0.1), class: 'g-val' }) as SVGPathElement;
    gauge.append(speedArc);
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (GAUGE_SWEEP * i) / 12;
      const rad = ((a - 90) * Math.PI) / 180;
      const r1 = i % 2 ? 66 : 62;
      gauge.append(svg('line', { x1: 100 + 70 * Math.cos(rad), y1: 100 + 70 * Math.sin(rad), x2: 100 + r1 * Math.cos(rad), y2: 100 + r1 * Math.sin(rad), class: 'g-tick' }));
    }
    const speed = el('div', { class: 'cmp-speed-val', text: '0' });
    const gear = el('div', { class: 'cmp-gear', text: 'D' });
    const sigL = el('span', { class: 'cmp-sig l', text: '◀' });
    const sigR = el('span', { class: 'cmp-sig r', text: '▶' });
    const limit = el('div', { class: 'cmp-limit', text: '50' });
    const speedBox = el('div', { class: 'cmp-speed' }, [gauge, el('div', { class: 'cmp-speed-c' }, [speed, el('small', { text: 'km/h' }), el('div', { class: 'cmp-sigs' }, [sigL, gear, sigR])]), limit]);

    // score ring
    const ring = svg('svg', { viewBox: '0 0 120 120', class: 'cmp-ring' }) as SVGSVGElement;
    ring.append(svg('circle', { cx: 60, cy: 60, r: 50, class: 'r-track' }));
    const scoreArc = svg('circle', { cx: 60, cy: 60, r: 50, class: 'r-val', 'stroke-dasharray': '0 400', transform: 'rotate(-90 60 60)' }) as SVGCircleElement;
    ring.append(scoreArc);
    const scoreVal = el('div', { class: 'cmp-score-val', text: '—' });
    const grade = el('div', { class: 'cmp-grade', text: 'Puan' });
    const scoreBox = el('div', { class: 'cmp-score' }, [ring, el('div', { class: 'cmp-score-c' }, [scoreVal, grade])]);

    const dash = el('section', { class: 'cmp-dash' }, [speedBox, scoreBox]);
    const comps = el('section', { class: 'cmp-comps' });
    const stats = el('div', { class: 'cmp-stats' });
    const counters = el('section', { class: 'cmp-counters' });
    const mission = el('section', { class: 'cmp-mission hidden' });
    const reportBox = el('section', { class: 'cmp-report hidden' });
    const idle = el('section', {
      class: 'cmp-idle hidden',
      html: '<div class="cmp-idle-car">🚗</div><b>Bilgisayarda sürüş bekleniyor</b><span>Serbest sürüş veya bir görev başladığında hız, puan ve tüm uyarılar burada anlık görünür.</span>',
    });

    const chips = el('div', { class: 'cmp-chips' });
    const feed = el('div', { class: 'cmp-feed-list' });
    const feedBox = el('section', { class: 'cmp-feed' }, [el('div', { class: 'cmp-feed-head' }, [el('b', { text: 'Olay akışı' }), chips]), feed]);

    const pauseBtn = el('button', { class: 'cmp-btn primary', text: '⏸ Duraklat' }) as HTMLButtonElement;
    pauseBtn.onclick = () => {
      this.unlockAudio();
      const paused = this.state?.mode === 'paused';
      this.link.send({ t: 'cmd', cmd: paused ? 'resume' : 'pause' });
    };
    const toggles = el('div', { class: 'cmp-toggles' });
    const menuBtn = el('button', { class: 'cmp-btn ghost', text: 'Menü' });
    menuBtn.onclick = () => this.close();
    const offBtn = el('button', { class: 'cmp-btn danger', text: 'Bağlantıyı kes' });
    offBtn.onclick = () => {
      if (confirm('Bilgisayarla bağlantı kesilsin mi?')) this.disconnect();
    };
    const foot = el('footer', { class: 'cmp-foot' }, [pauseBtn, toggles, el('div', { class: 'cmp-foot-row' }, [menuBtn, offBtn])]);

    const toasts = el('div', { class: 'cmp-toasts' });
    const alert = el('div', { class: 'cmp-alert hidden' });
    alert.onclick = () => alert.classList.add('hidden');
    const flash = el('div', { class: 'cmp-flash' });
    const wait = el('div', { class: 'cmp-wait hidden' });

    const scroll = el('div', { class: 'cmp-scroll' }, [status, idle, reportBox, dash, comps, stats, counters, mission, feedBox]);
    r.append(flash, top, scroll, foot, toasts, alert, wait);
    r.addEventListener('pointerdown', () => this.unlockAudio(), { passive: true });

    this.ui = { conn, connText: conn.querySelector('span')!, mode, where, timer, speed, speedArc, limit, gear, sigL, sigR, scoreArc, scoreVal, grade, comps, counters, mission, reportBox, feed, chips, toasts, alert, flash, wait, idle, pauseBtn, toggles, stats };
    this.buildToggles();
    this.buildChips();
  }

  private buildToggles() {
    const t = this.ui.toggles;
    t.innerHTML = '';
    const mk = (key: keyof Prefs, icon: string, label: string) => {
      const b = el('button', { class: `cmp-tg ${this.prefs[key] ? 'on' : ''}`, html: `<span>${icon}</span>${esc(label)}` });
      b.onclick = () => {
        this.prefs[key] = !this.prefs[key];
        storage.set(PREFS_KEY, this.prefs);
        this.unlockAudio();
        if (key === 'vibrate' && this.prefs.vibrate) navigator.vibrate?.(60);
        if (key === 'sound' && this.prefs.sound) this.cue('connect');
        if (key === 'voice' && this.prefs.voice) this.speak('Sesli uyarılar açık');
        this.buildToggles();
      };
      return b;
    };
    t.append(mk('vibrate', '📳', 'Titreşim'), mk('sound', '🔔', 'Ses'), mk('voice', '🗣️', 'Sesli okuma'));
  }

  private buildChips() {
    const c = this.ui.chips;
    c.innerHTML = '';
    const groups: (EventGroup | 'all')[] = ['all', 'crash', 'violation', 'warning', 'positive'];
    for (const g of groups) {
      const b = el('button', { class: `cmp-chip ${this.filter === g ? 'active' : ''}`, text: g === 'all' ? 'Tümü' : GROUP_META[g].title });
      if (g !== 'all') b.style.setProperty('--c', GROUP_META[g].color);
      b.onclick = () => {
        this.filter = g;
        this.buildChips();
        this.renderFeed();
      };
      c.append(b);
    }
  }

  // ——————————————————————————— render ———————————————————————————

  private render() {
    this.renderConn();
    this.renderState();
    this.renderTele();
    this.renderCounters();
    this.renderFeed();
    this.renderReport();
  }

  private renderConn() {
    const s = this.link.status;
    this.ui.conn.className = `cmp-conn ${s}`;
    this.ui.connText.textContent = s === 'connected' ? `Bağlı${this.hostName ? ' · ' + this.hostName : ''}` : STATUS_LABEL[s];
    const w = this.ui.wait;
    const show = this.visible && s !== 'connected';
    w.classList.toggle('hidden', !show);
    if (!show) return;
    const code = this.link.code;
    w.innerHTML = '';
    const box = el('div', { class: 'cmp-wait-box' }, [
      el('div', { class: 'cmp-pulse', html: '<i></i><i></i><i></i><span>📱</span>' }),
      el('h3', { text: s === 'off' ? 'Bağlantı yok' : 'Bilgisayar bekleniyor…' }),
      el('p', { text: 'Bilgisayarda Ana menü → “Telefonu Bağla” (veya Ayarlar → Telefon Ekranı) açın ve bu QR kodu bilgisayarın kamerasına gösterin.' }),
      code ? el('div', { class: 'cmp-wait-qr', html: qrSvg(linkUrl(code)) }) : null,
      code ? el('div', { class: 'pair-code', text: formatCode(code) }) : null,
      el('small', { class: 'muted', text: STATUS_LABEL[s] }),
    ]);
    const back = el('button', { class: 'cmp-btn ghost', text: 'Menüye dön' });
    back.onclick = () => this.close();
    box.append(back);
    w.append(box);
  }

  private renderState() {
    const st = this.state;
    const mode = st?.mode ?? 'menu';
    this.ui.mode.textContent = MODE_LABEL[mode];
    this.ui.mode.dataset.mode = mode;
    this.ui.where.textContent = st && mode !== 'menu' ? `${st.map} · ${st.conditions}` : st?.profile ? `Sürücü: ${st.profile}` : '';
    this.root.dataset.mode = mode;
    this.ui.idle.classList.toggle('hidden', mode !== 'menu' && mode !== 'loading');
    this.ui.pauseBtn.disabled = mode !== 'driving' && mode !== 'paused';
    this.ui.pauseBtn.textContent = mode === 'paused' ? '▶ Devam et' : '⏸ Duraklat';
    const m = st?.mission;
    const mb = this.ui.mission;
    mb.classList.toggle('hidden', !m || mode === 'menu');
    if (m) {
      const icon: Record<string, string> = { done: '✓', failed: '✖', active: '●', pending: '○' };
      mb.innerHTML = `<div class="cmp-m-head"><span class="cmp-m-i">${esc(m.icon)}</span><div><b>${esc(m.title)}</b><small>${esc(m.subtitle)}</small></div></div><ul>${m.objectives
        .map((o) => `<li class="${esc(o.status)}"><span>${icon[o.status] ?? '○'}</span>${esc(o.title)}</li>`)
        .join('')}</ul>`;
    }
    this.renderReport();
  }

  private renderTele() {
    const t = this.tele;
    const u = this.ui;
    const kmh = t?.kmh ?? 0;
    const limit = t?.limit ?? 50;
    u.speed.textContent = String(Math.abs(kmh));
    u.limit.textContent = String(limit);
    u.gear.textContent = t?.gear ?? '—';
    const over = Math.abs(kmh) > limit + 3;
    const near = Math.abs(kmh) > limit - 2;
    u.speed.classList.toggle('over', over);
    u.limit.classList.toggle('flash', over);
    const max = Math.max(140, Math.ceil((limit * 1.5) / 20) * 20);
    const frac = Math.min(1, Math.abs(kmh) / max);
    const a0 = -GAUGE_SWEEP / 2;
    u.speedArc.setAttribute('d', arcPath(100, 100, 82, a0, a0 + Math.max(0.1, GAUGE_SWEEP * frac)));
    u.speedArc.style.stroke = over ? 'var(--bad)' : near ? 'var(--warn)' : 'var(--accent)';
    u.sigL.classList.toggle('on', t?.signal === 'left' || t?.signal === 'hazard');
    u.sigR.classList.toggle('on', t?.signal === 'right' || t?.signal === 'hazard');
    u.timer.textContent = t ? mmss(t.t) : '0:00';
    const ov = t?.overall;
    if (ov != null) {
      const c = 2 * Math.PI * 50;
      u.scoreArc.setAttribute('stroke-dasharray', `${((c * ov) / 100).toFixed(1)} ${c.toFixed(1)}`);
      u.scoreArc.style.stroke = scoreColor(ov);
      u.scoreVal.textContent = String(Math.round(ov));
      u.scoreVal.style.color = scoreColor(ov);
      u.grade.textContent = 'Canlı puan';
    } else {
      u.scoreArc.setAttribute('stroke-dasharray', '0 400');
      u.scoreVal.textContent = '—';
      u.scoreVal.style.color = '';
      u.grade.textContent = 'Puan hesaplanıyor';
    }
    const comps = t?.components;
    u.comps.innerHTML = COMPONENTS.map((k) => {
      const v = comps ? Math.round(comps[k]) : null;
      const meta = COMPONENT_META[k];
      return `<div class="cmp-comp"><span>${esc(meta.title)}</span><div class="cmp-bar"><i style="width:${v ?? 0}%;background:${meta.color}"></i></div><b>${v ?? '—'}</b></div>`;
    }).join('');
    u.stats.innerHTML = t
      ? `<span>📍 ${t.km.toFixed(1)} km</span><span>🪞 ${t.mirrorRate.toFixed(1)} ayna/dk</span><span>🕑 ${mmss(t.t)}</span>`
      : '';
  }

  private renderCounters() {
    const groups: EventGroup[] = ['crash', 'violation', 'warning', 'positive'];
    this.ui.counters.innerHTML = groups
      .map((g) => `<div class="cmp-count" style="--c:${GROUP_META[g].color}"><span>${GROUP_META[g].icon}</span><b>${this.counts[g]}</b><small>${GROUP_META[g].title}</small></div>`)
      .join('');
  }

  private eventItem(e: LinkEvent, fresh = false): HTMLElement {
    const g = eventGroup(e);
    const icon = KIND_ICON[e.kind] ?? GROUP_META[g].icon;
    const item = el('div', { class: `cmp-ev ${g} sev-${e.severity} ${fresh ? 'fresh' : ''}` }, [
      el('span', { class: 'cmp-ev-i', text: icon }),
      el('div', { class: 'cmp-ev-b' }, [el('b', { text: e.label }), el('span', { text: e.message })]),
      el('time', { text: mmss(e.t) }),
    ]);
    item.style.setProperty('--c', GROUP_META[g].color);
    return item;
  }

  private visibleEvent(e: LinkEvent) {
    const g = eventGroup(e);
    if (this.filter === 'all') return g !== 'info' || e.kind === 'reaction' || e.kind === 'objective';
    return g === this.filter;
  }

  private renderFeed() {
    const f = this.ui.feed;
    f.innerHTML = '';
    const list = this.events.filter((e) => this.visibleEvent(e)).slice(-60).reverse();
    if (!list.length) {
      f.append(el('div', { class: 'cmp-empty', text: this.state?.mode === 'driving' ? 'Henüz olay yok — temiz sürüş! 👌' : 'Olaylar sürüş sırasında burada listelenir.' }));
      return;
    }
    for (const e of list) f.append(this.eventItem(e));
  }

  private prependFeed(e: LinkEvent) {
    if (!this.visibleEvent(e)) return;
    const f = this.ui.feed;
    f.querySelector('.cmp-empty')?.remove();
    f.prepend(this.eventItem(e, true));
    while (f.children.length > 60) f.lastChild?.remove();
  }

  private renderReport() {
    const r = this.report;
    const box = this.ui.reportBox;
    const show = !!r && this.state?.mode === 'report';
    box.classList.toggle('hidden', !show);
    if (!show || !r) return;
    const stars = r.mission ? '★'.repeat(r.mission.stars) + '☆'.repeat(3 - r.mission.stars) : '';
    box.innerHTML = `
      <div class="cmp-r-head">
        <div class="cmp-r-grade" style="--c:${scoreColor(r.overall)}"><b>${esc(r.grade)}</b><span>${r.overall}</span></div>
        <div>
          <small>Oturum raporu</small>
          <h3>${r.mission ? esc(r.mission.title) : 'Serbest sürüş'}</h3>
          ${r.mission ? `<div class="cmp-r-res ${r.mission.success ? 'ok' : 'fail'}">${r.mission.success ? 'Görev başarılı' : 'Görev başarısız'} <span class="stars">${stars}</span></div>` : ''}
          ${r.mission && !r.mission.success && r.mission.failReason ? `<small class="muted">${esc(r.mission.failReason)}</small>` : ''}
        </div>
      </div>
      <div class="cmp-r-meta"><span>🕑 ${mmss(r.durationSec)}</span><span>📍 ${r.distanceKm.toFixed(1)} km</span><span>💥 ${r.counts.crash}</span><span>⛔ ${r.counts.violation}</span><span>⚠️ ${r.counts.warning}</span><span>✓ ${r.counts.positive}</span></div>
      ${r.strengths.length ? `<div class="cmp-r-list good"><b>Güçlü yönler</b>${r.strengths.map((s) => `<p>✓ ${esc(s)}</p>`).join('')}</div>` : ''}
      ${r.tips.length ? `<div class="cmp-r-list"><b>Gelişim önerileri</b>${r.tips.map((s) => `<p>→ ${esc(s)}</p>`).join('')}</div>` : ''}
      <small class="muted">Ayrıntılı rapor bilgisayar ekranında.</small>`;
  }

  // ——————————————————————————— live reactions ———————————————————————————

  private react(e: LinkEvent) {
    const g = eventGroup(e);
    const big = g === 'crash' || e.severity === 'critical' || e.severity === 'major';
    if (big) {
      this.showAlert(e);
      this.flash(GROUP_META[g].color);
      if (this.prefs.vibrate) navigator.vibrate?.(e.severity === 'critical' || g === 'crash' ? [260, 90, 260, 90, 260] : [180, 80, 180]);
      this.cue(g === 'crash' ? 'crash' : 'bad');
      if (this.prefs.voice) this.speak(e.message);
    } else if (e.severity === 'minor') {
      this.flash(GROUP_META[g].color, true);
      if (this.prefs.vibrate) navigator.vibrate?.(70);
      this.cue('warn');
    } else if (e.severity === 'positive') {
      this.cue('good');
    }
  }

  private showAlert(e: LinkEvent) {
    const g = eventGroup(e);
    const a = this.ui.alert;
    window.clearTimeout(this.alertTimer);
    a.className = `cmp-alert ${g}`;
    a.style.setProperty('--c', GROUP_META[g].color);
    a.innerHTML = `<div class="cmp-alert-card"><span class="cmp-alert-i">${KIND_ICON[e.kind] ?? GROUP_META[g].icon}</span><small>${esc(GROUP_META[g].title.toUpperCase())}${e.severity === 'critical' ? ' · KRİTİK' : ''}</small><h2>${esc(e.label)}</h2><p>${esc(e.message)}</p><time>${mmss(e.t)}</time></div>`;
    this.alertTimer = window.setTimeout(() => a.classList.add('hidden'), e.severity === 'critical' ? 4200 : 3200);
  }

  private flash(color: string, soft = false) {
    const f = this.ui.flash;
    f.style.setProperty('--c', color);
    f.classList.remove('on', 'soft');
    void f.offsetWidth; // restart the animation
    f.classList.add('on');
    if (soft) f.classList.add('soft');
  }

  private toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad') {
    const t = el('div', { class: `cmp-toast ${kind}`, text });
    this.ui.toasts.append(t);
    while (this.ui.toasts.children.length > 3) this.ui.toasts.firstChild?.remove();
    setTimeout(() => t.classList.add('out'), 2800);
    setTimeout(() => t.remove(), 3200);
  }

  private resetCounts() {
    this.counts = { crash: 0, violation: 0, warning: 0, positive: 0, info: 0 };
  }

  private recount() {
    this.resetCounts();
    for (const e of this.events) this.counts[eventGroup(e)]++;
  }

  // ——————————————————————————— device features ———————————————————————————

  private async keepAwake() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl || this.wakeLock) return;
    try {
      this.wakeLock = await wl.request('screen');
      (this.wakeLock as unknown as EventTarget).addEventListener?.('release', () => (this.wakeLock = null));
    } catch {
      this.wakeLock = null;
    }
  }

  private unlockAudio() {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      return;
    }
    try {
      this.audioCtx = new AudioContext();
    } catch {
      this.audioCtx = null;
    }
    void this.keepAwake();
  }

  private cue(kind: 'connect' | 'crash' | 'bad' | 'warn' | 'good' | 'report') {
    const ctx = this.audioCtx;
    if (!this.prefs.sound || !ctx || ctx.state !== 'running') return;
    const notes: Record<typeof kind, [number, number, OscillatorType][]> = {
      connect: [
        [660, 0.09, 'sine'],
        [990, 0.14, 'sine'],
      ],
      crash: [
        [220, 0.16, 'square'],
        [160, 0.28, 'square'],
      ],
      bad: [
        [520, 0.12, 'triangle'],
        [390, 0.2, 'triangle'],
      ],
      warn: [[620, 0.1, 'triangle']],
      good: [
        [880, 0.07, 'sine'],
        [1175, 0.1, 'sine'],
      ],
      report: [
        [523, 0.1, 'sine'],
        [659, 0.1, 'sine'],
        [784, 0.18, 'sine'],
      ],
    };
    let t = ctx.currentTime;
    for (const [f, d, type] of notes[kind]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d * 0.85;
    }
  }

  private speak(text: string) {
    const ss = window.speechSynthesis;
    if (!ss) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'tr-TR';
    u.rate = 1.05;
    ss.cancel();
    ss.speak(u);
  }
}
