import { el, esc, scoreColor } from '../ui/dom';
import { storage } from '../core/storage';
import { COMPONENTS, COMPONENT_META, type EventKind } from '../coach/types';
import { DeviceLink, formatCode, linkUrl, newLinkCode, savedLink, type LinkStatus } from './link';
import { deviceName } from './device';
import { qrSvg } from './qr';
import { eventGroup, type DisplayMsg, type EventGroup, type HostMsg, type LinkEvent, type LinkReport, type LinkState, type LinkTelemetry, type LinkHistory } from './protocol';

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
  solid_line_change: '🛣',
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
  hard_brake: '🛴',
  hard_accel: '🛴',
  harsh_corner: '🛴',
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
  unsupported: 'Güvenli bağlantı (HTTPS) gerekli',
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
  private history: LinkHistory | null = null;
  private events: LinkEvent[] = [];
  private filter: EventGroup | 'all' = 'all';
  private counts: Record<EventGroup, number> = { crash: 0, violation: 0, warning: 0, positive: 0, info: 0 };
  private audioCtx: AudioContext | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private alertTimer = 0;
  private historyOpen = false;
  private ui!: {
    nofb: HTMLElement;
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
    historyBox: HTMLElement;
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

  // ——————————————————————— link ——————————————————————

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
      case 'history':
        this.history = m.history;
        this.renderHistory();
        break;
      case 'bye':
        break;
    }
  }

  // ——————————————————————— build ——————————————————————

  private build() {
    const r = this.root;
    const svg = (tag: string, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };

    const conn = el('div', { class: 'cmp-conn' }, [el('i'), el('span', { text: 'Bağlı değil' })]);
    const top = el('header', { class: 'cmp-top' }, [
      el('div', { class: 'cmp-brand', html: '<span class=\"cmp-logo\">◎</span><div><b>CANLI KOÇ</b><small>Sürüş Koçu · ikinci ekran</small></div>' }),
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
    const historyBox = el('section', { class: 'cmp-history hidden' });
    const idle = el('section', {
      class: 'cmp-idle hidden',
      html: '<div class=\"cmp-idle-car\">🚗</div><b>Bilgisayarda sürüş bekleniyor</b><span>Serbest sürüş veya bir görev başladığında hız, puan ve tüm uyarılar burada anlık görünür.</span>',
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
    const histBtn = el('button', { class: 'cmp-btn ghost', text: '📋 Geçmiş' });
    histBtn.onclick = () => this.toggleHistory();
    const menuBtn = el('button', { class: 'cmp-btn ghost', text: 'Menü' });
    menuBtn.onclick = () => this.close();
    const offBtn = el('button', { class: 'cmp-btn danger', text: 'Bağlantıyı kes' });
    offBtn.onclick = () => {
      if (confirm('Bilgisayarla bağlantı kesilsin mi?')) this.disconnect();
    };
    const foot = el('footer', { class: 'cmp-foot' }, [pauseBtn, toggles, el('div', { class: 'cmp-foot-row' }, [histBtn, menuBtn, offBtn])]);

    const toasts = el('div', { class: 'cmp-toasts' });
    const alert = el('div', { class: 'cmp-alert hidden' });
    alert.onclick = () => alert.classList.add('hidden');
    const flash = el('div', { class: 'cmp-flash' });
    const wait = el('div', { class: 'cmp-wait hidden' });

    const nofb = el('section', { class: 'cmp-nofb hidden', text: '🔕 Bilgisayarda canlı koçluk ipuçları kapalı — uyarılar, puan ve rapor bu ekranda gösterilmez.' });
    const scroll = el('div', { class: 'cmp-scroll' }, [status, nofb, idle, reportBox, historyBox, dash, comps, stats, counters, mission, feedBox]);
    r.append(flash, top, scroll, foot, toasts, alert, wait);
    r.addEventListener('pointerdown', () => this.unlockAudio(), { passive: true });

    this.ui = { nofb, conn, connText: conn.querySelector('span')!, mode, where, timer, speed, speedArc, limit, gear, sigL, sigR, scoreArc, scoreVal, grade, comps, counters, mission, reportBox, historyBox, feed, chips, toasts, alert, flash, wait, idle, pauseBtn, toggles, stats };
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

  // ——————————————————————— render ——————————————————————

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
    this.ui.where.textContent = st && mode !== 'menu' ? `${st.map} · ${st.conditions}` : '';
    this.root.dataset.mode = mode;
    this.ui.nofb.classList.toggle('hidden', !st || st.feedback !== false);
    this.ui.idle.classList.toggle('hidden', mode !== 'menu' && mode !== 'loading');
    this.ui.pauseBtn.disabled = mode !== 'driving' && mode !== 'paused';
    this.ui.pauseBtn.textContent = mode === 'paused' ? '▶ Devam et' : '⏸ Duraklat';
    const m = st?.mission;
    const mb = this.ui.mission;
    mb.classList.toggle('hidden', !m || mode === 'menu');
    if (m) {
      const icon: Record<string, string> = { done: '✓', failed: '✖', active: '●', pending: '○' };
      mb.innerHTML = `<div class=\"cmp-m-head\"><span class=\"cmp-m-i\">${esc(m.icon)}</span><div><b>${esc(m.title)}</b><small>${esc(m.subtitle)}</small></div></div><ul>${m.objectives
        .map((o) => `<li class=\"${esc(o.status)}\"><span>${icon[o.status] ?? '○'}</span>${esc(o.title)}</li>`)
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
    // ... (rest of render methods, including toggleHistory and renderHistory)
  }

  private toggleHistory() {
    this.historyOpen = !this.historyOpen;
    this.ui.historyBox.classList.toggle('hidden', !this.historyOpen);
    if (this.historyOpen) this.renderHistory();
    this.root.querySelector('.cmp-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private renderHistory() {
    const h = this.history;
    const box = this.ui.historyBox;
    if (!h || !this.historyOpen) {
      box.innerHTML = '';
      return;
    }
    const avg = `<div class=\"cmp-karne\"><b>Genel ortalama</b> <span style=\"color:${scoreColor(h.karneOverall)}\">${h.karneOverall} ${h.karneGrade}</span></div>`;
    const list = h.sessions.map((s) => {
      const detail = `<div class=\"sess-detail hidden\">
        <div>${s.components ? Object.entries(s.components).map(([k, v]) => `<div>${k}: ${v}</div>`).join('') : ''}</div>
        ${s.tips?.length ? `<p><b>Öneriler:</b> ${s.tips.map(esc).join(' · ')}</p>` : ''}
        ${s.strengths?.length ? `<p><b>Güçlü:</b> ${s.strengths.map(esc).join(' · ')}</p>` : ''}
        ${s.keyStats?.length ? s.keyStats.map((ks) => `<div>${esc(ks.label)}: ${esc(ks.value)}</div>`).join('') : ''}
      </div>`;
      return `<div class=\"sess-row\" data-id=\"${esc(s.id)}\"><b>${esc(s.title)}</b> · ${new Date(s.at).toLocaleDateString('tr')} · ${s.distanceKm.toFixed(1)} km · <span style=\"color:${scoreColor(s.overall)}\">${s.overall} ${s.grade}</span>${detail}</div>`;
    }).join('');
    box.innerHTML = `<h3>Oturum Geçmişi</h3>${avg}<div class=\"sess-list\">${list || '<p class=\"muted\">Henüz oturum yok.</p>'}</div>`;
    box.querySelectorAll('.sess-row').forEach((row) => {
      row.addEventListener('click', () => {
        const det = row.querySelector('.sess-detail');
        det?.classList.toggle('hidden');
      });
    });
  }

  // ... remaining methods (renderCounters, renderFeed, etc.) are the original ones
}
