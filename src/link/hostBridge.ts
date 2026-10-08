import { EVENT_META, type CoachEvent } from '../coach/types';
import type { ReportData } from '../game/session';
import { DeviceLink, savedLink } from './link';
import { deviceName } from './device';
import { eventGroup, type DisplayMsg, type HostMsg, type LinkEvent, type LinkReport, type LinkState, type LinkTelemetry } from './protocol';

/** What the game exposes to the link. */
export interface HostSource {
  linkState(): LinkState;
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

  constructor() {
    this.link.on('peer', () => {
      this.link.send({ t: 'hello', name: deviceName() });
      this.sendSnapshot();
    });
    this.link.on('message', ({ from, msg }) => {
      if (msg.t === 'hello') {
        this.displays.set(from, msg.name);
        this.link.send({ t: 'hello', name: deviceName() });
        this.sendSnapshot();
      } else if (msg.t === 'bye') this.displays.delete(from);
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
        return;
      }
      this.teleTimer = window.setInterval(() => this.sendTelemetry(), 250);
      this.stateTimer = window.setInterval(() => this.syncState(), 500);
    });
  }

  attach(src: HostSource) {
    this.src = src;
    const saved = savedLink();
    if (saved?.role === 'host') this.link.start(saved.code);
  }

  connect(code: string) {
    this.link.start(code);
  }

  disconnect() {
    this.link.stop();
  }

  // ——————————————————————————— game hooks ———————————————————————————

  coachEvent(e: CoachEvent) {
    const ev: LinkEvent = { kind: e.kind, label: EVENT_META[e.kind].label, severity: e.severity, component: e.component, message: e.message, t: Math.round(e.t * 10) / 10 };
    if (e.value != null) ev.value = Math.round(e.value * 10) / 10;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.lastEventText = e.message;
    this.lastEventAt = performance.now();
    if (this.live) this.link.send({ t: 'event', event: ev });
  }

  notice(text: string, kind: 'info' | 'good' | 'warn' | 'bad') {
    if (!this.live) return;
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
      tips: r.tips.slice(0, 3),
      strengths: r.strengths.slice(0, 3),
      counts,
    };
    if (this.live) {
      this.syncState();
      this.link.send({ t: 'report', report: this.lastReport });
    }
  }

  // ——————————————————————————— sending ———————————————————————————

  private get live() {
    return this.link.status === 'connected';
  }

  private sendSnapshot() {
    if (!this.src) return;
    const state = this.src.linkState();
    this.lastState = JSON.stringify(state);
    this.link.send({ t: 'snapshot', state, events: this.events.slice(-40), tele: this.src.linkTelemetry(), report: this.lastReport });
  }

  private sendTelemetry() {
    const tele = this.src?.linkTelemetry();
    if (tele) this.link.send({ t: 'tele', tele });
  }

  private syncState() {
    if (!this.src) return;
    const state = this.src.linkState();
    const key = JSON.stringify(state);
    if (key === this.lastState) return;
    this.lastState = key;
    this.link.send({ t: 'state', state });
  }
}

export const hostBridge = new HostBridge();
