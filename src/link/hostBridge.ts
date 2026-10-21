import { EVENT_META, type CoachEvent } from '../coach/types';
import type { ReportData } from '../game/session';
import { settings } from '../core/settings';
import { experiment } from '../coach/experiment';
import { activeProfile, letterGrade } from '../coach/profiles';
import { DeviceLink, forgetSavedLink, savedLink } from './link';
import { deviceName } from './device';
import { eventGroup, type DisplayMsg, type HostMsg, type LinkEvent, type LinkReport, type LinkState, type LinkTelemetry, type LinkHistory } from './protocol';

/** What the game exposes to the link. */
export interface HostSource {
  linkState(): Omit<LinkState, 'feedback'>;
  linkTelemetry(): LinkTelemetry | null;
  remotePause(): void;
  remoteResume(): void;
}

const MAX_EVENTS = 80;

/** Game side (PC): streams coaching events, live telemetry and reports to paired phones. */
export class HostBridge {
  readonly link = new DeviceLink<DisplayMsg, HostMsg>('host');
  /** Names of the paired displays (by link peer id). */
  readonly displays = new Map<string, string>();
  private src: HostSource | null = null;
  private events: LinkEvent[] = [];
  private lastReport: LinkReport | null = null;
  private lastState = '';
  private lastEventText = '';
  private lastEventAt = 0;
  private teleTimer = 0;
  private stateTimer = 0;
  private historyRetry = 0;

  constructor() {
    // Experiment mode locks the phone link entirely (no feedback may reach a second screen)
    experiment.on('change', () => {
      if (experiment.active) this.disconnect();
    });
    // Hints switched off mid-drive: clear what the phone already shows
    settings.on('change', ({ keys }) => {
      if (keys.includes('liveCoachHints') && this.live) this.sendSnapshot();
    });
    this.link.on('peer', () => {
      this.link.send({ t: 'hello', name: deviceName() });
      this.sendSnapshot();
      this.scheduleHistory();
    });
    this.link.on('message', ({ from, msg }) => {
      if (msg.t === 'hello') {
        this.displays.set(from, msg.name);
        this.link.send({ t: 'hello', name: deviceName() });
        this.sendSnapshot();
        this.scheduleHistory();
      } else if (msg.t === 'history') this.sendHistory();
      else if (msg.t === 'detail') this.sendDetail(msg.id);
      else if (msg.t === 'bye') this.displays.delete(from);
      else if (msg.t === 'cmd') {
        if (msg.cmd === 'pause') this.src?.remotePause();
        else if (msg.cmd === 'resume') this.src?.remoteResume();
      }
    });
    this.link.on('status', (s) => {
      window.clearInterval(this.teleTimer);
      window.clearInterval(this.stateTimer);
      if (s !== 'connected') {
        this.displays.clear();
        window.clearTimeout(this.historyRetry);
        return;
      }
      this.teleTimer = window.setInterval(() => this.sendTelemetry(), 250);
      this.stateTimer = window.setInterval(() => this.syncState(), 500);
      this.scheduleHistory();
    });
  }

  attach(src: HostSource) {
    this.src = src;
    // Only a pairing used within the last minutes is resumed (a page reload); on a shared
    // computer an older one — the previous person's phone — is forgotten instead.
    const saved = savedLink();
    if (saved?.role === 'host' && !experiment.active) this.link.start(saved.code);
    else if (saved?.role === 'host') forgetSavedLink();
  }

  /** Whether pairing is possible right now (not in experiment mode). */
  get allowed() {
    return !experiment.active;
  }

  connect(code: string) {
    if (!this.allowed) return;
    this.link.start(code);
  }

  /**
   * Coaching content (events, notices, scores, reports) is forwarded only while live hints
   * are on — the phone must not give feedback the PC screen is hiding.
   */
  private get feedbackOn() {
    return settings.get().liveCoachHints && !experiment.active;
  }

  disconnect() {
    this.link.stop();
  }

  // ——————————————————————— game hooks ————————————————————————

  coachEvent(e: CoachEvent) {
    const ev: LinkEvent = { kind: e.kind, label: EVENT_META[e.kind].label, severity: e.severity, component: e.component, message: e.message, t: Math.round(e.t * 10) / 10 };
    if (e.value != null) ev.value = Math.round(e.value * 10) / 10;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.lastEventText = e.message;
    this.lastEventAt = performance.now();
    if (this.live && this.feedbackOn) this.link.send({ t: 'event', event: ev });
  }

  notice(text: string, kind: 'info' | 'good' | 'warn' | 'bad') {
    if (!this.live || !this.feedbackOn) return;
    // Coaching events already toast their own message; send those once, as events
    if (text === this.lastEventText && performance.now() - this.lastEventAt < 1500) return;
    this.link.send({ t: 'notice', text, kind });
  }

  segmentStart() {
    this.events = [];
    this.lastReport = null;
    if (this.live) this.link.send({ t: 'segment' });
  }

  report(d: ReportData) {
    const counts = { crash: 0, violation: 0, warning: 0, positive: 0 };
    for (const e of d.events) {
      const g = eventGroup(e);
      if (g !== 'info') counts[g]++;
    }
    const r = d.result;
    this.lastReport = {
      overall: r.overall,
      grade: r.grade,
      components: r.components,
      mission: d.mission ? { title: d.mission.def.title, success: d.mission.success, stars: d.mission.stars, failReason: d.mission.failReason } : null,
      durationSec: Math.round(r.durationSec),
      distanceKm: Math.round(r.distanceKm * 10) / 10,
      tips: r.tips.slice(0, 6),
      strengths: r.strengths.slice(0, 5),
      counts,
      id: d.sessionId ?? undefined,
    };
    if (this.live) {
      this.syncState();
      if (this.feedbackOn) {
        this.link.send({ t: 'report', report: this.lastReport });
        this.sendHistory();
      }
    }
  }

  /** List first, then again once the phone's subscription has settled. The list stays small. */
  private scheduleHistory() {
    this.sendHistory();
    window.clearTimeout(this.historyRetry);
    this.historyRetry = window.setTimeout(() => this.sendHistory(), 800);
  }

  /** One session's charts and sub-scores. Sent only when the phone opens that row. */
  private sendDetail(id: string) {
    if (!this.live || !this.feedbackOn) return;
    const s = activeProfile()?.sessions.find((x) => x.id === id);
    this.link.send({ t: 'detail', id, detail: s?.detail ?? null });
  }

  sendHistory() {
    if (!this.live || !this.feedbackOn) return;
    const p = activeProfile();
    const sessions = (p?.sessions ?? []).slice(0, 20).map((s) => ({
      id: s.id,
      at: s.at,
      title: s.missionTitle ?? (s.kind === 'free' ? 'Serbest sürüş' : s.kind === 'calibration' ? 'Kalibrasyon' : 'Görev'),
      overall: s.overall,
      grade: s.grade,
      map: s.map,
      conditions: s.conditions,
      distanceKm: s.distanceKm,
      durationSec: s.durationSec,
      risk: s.risk,
      tips: (s.tips?.length ? s.tips : s.highlights) ?? [],
      strengths: s.strengths ?? [],
      components: s.components,
      keyStats: s.keyStats ?? [],
    }));
    const history: LinkHistory = {
      profileId: p?.id ?? '',
      karneOverall: p?.karne.overall ?? 0,
      karneGrade: p ? letterGrade(p.karne.overall) : '—',
      karneComponents: p?.karne.components ?? { guvenlik: 0, kural: 0, tarama: 0, puruzsuzluk: 0, gorev: 0 },
      sessions,
    };
    this.link.send({ t: 'history', history });
  }

  // ——————————————————————— sending ————————————————————————

  private get live() {
    return this.link.status === 'connected';
  }

  private state(): LinkState {
    return { ...this.src!.linkState(), feedback: this.feedbackOn };
  }

  /** Live readout; the score fields are withheld while feedback is off. */
  private telemetry(): LinkTelemetry | null {
    const tele = this.src?.linkTelemetry() ?? null;
    return tele && !this.feedbackOn ? { ...tele, overall: null, components: null, mirrorRate: 0 } : tele;
  }

  private sendSnapshot() {
    if (!this.src) return;
    const state = this.state();
    const fb = state.feedback;
    this.lastState = JSON.stringify(state);
    this.link.send({ t: 'snapshot', state, events: fb ? this.events.slice(-40) : [], tele: this.telemetry(), report: fb ? this.lastReport : null });
  }

  private sendTelemetry() {
    const tele = this.telemetry();
    if (tele) this.link.send({ t: 'tele', tele });
  }

  private syncState() {
    if (!this.src) return;
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastState) return;
    this.lastState = key;
    this.link.send({ t: 'state', state });
  }
}

export const hostBridge = new HostBridge();
