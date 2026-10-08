import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';
import { MqttClient } from './mqtt';
import type { Envelope } from './protocol';

/**
 * Device-to-device link (game PC ⇄ companion phone) through public MQTT-over-WebSocket
 * brokers. Both sides connect to every broker in the list and talk on a topic derived
 * from a random pairing code; once the peer is heard, messages go through the broker
 * that last delivered from it. Messages carry sender id + sequence number, so the same
 * message arriving through several brokers is handled once.
 */

export type LinkRole = 'host' | 'display';
export type LinkStatus = 'off' | 'connecting' | 'waiting' | 'connected' | 'error';

export const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];

const TOPIC_ROOT = 'surus-kocu/v1';
const STORE_KEY = 'ssc-link-v1';
const CUSTOM_BROKER_KEY = 'ssc-link-broker';
const HEARTBEAT_MS = 4000;
const PEER_TIMEOUT_MS = 13000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function newLinkCode(): string {
  const r = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(r);
  return Array.from(r, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

export function formatCode(code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/** Pull a pairing code out of a scanned QR text (link URL) or a typed code. */
export function parseLinkCode(text: string): string | null {
  let raw = text.trim();
  try {
    const u = new URL(raw);
    raw = u.searchParams.get('baglan') ?? '';
  } catch {
    /* not a URL — treat as a typed code */
  }
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** The URL a phone camera opens to join as the companion display. */
export function linkUrl(code: string): string {
  return `${location.origin}${location.pathname}?baglan=${code}`;
}

export function customBroker(): string {
  return storage.get<string>(CUSTOM_BROKER_KEY, '');
}

export function setCustomBroker(url: string) {
  if (url.trim()) storage.set(CUSTOM_BROKER_KEY, url.trim());
  else storage.remove(CUSTOM_BROKER_KEY);
}

export function savedLink(): { role: LinkRole; code: string } | null {
  return storage.get<{ role: LinkRole; code: string } | null>(STORE_KEY, null);
}

type Peer = { lastSeen: number; broker: number };

type LinkEvents<In> = {
  status: LinkStatus;
  message: { from: string; msg: In };
  peer: string;
};

export class DeviceLink<In, Out> extends Emitter<LinkEvents<In>> {
  readonly role: LinkRole;
  readonly id = Math.random().toString(36).slice(2, 10);
  code: string | null = null;
  status: LinkStatus = 'off';
  /** Last time any message came from a peer (ms, performance clock). */
  lastHeard = 0;
  private brokers: string[] = [];
  private clients: (MqttClient | null)[] = [];
  private retry: number[] = [];
  private retryTimers: number[] = [];
  private failed: boolean[] = [];
  private peers = new Map<string, Peer>();
  private seen = new Set<string>();
  private seq = 0;
  private beat = 0;

  constructor(role: LinkRole) {
    super();
    this.role = role;
  }

  get active() {
    return this.status !== 'off';
  }

  get peerCount() {
    return this.peers.size;
  }

  /** Name of the broker currently carrying the link (for the status line). */
  get brokerName(): string {
    const p = this.bestPeer();
    const url = p ? this.brokers[p.broker] : this.brokers[this.clients.findIndex((c) => c?.state === 'open')];
    if (!url) return '';
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  start(code: string) {
    if (this.code === code && this.active) return;
    this.teardown();
    this.code = code;
    storage.set(STORE_KEY, { role: this.role, code });
    const custom = customBroker();
    this.brokers = custom ? [custom] : [...DEFAULT_BROKERS];
    this.clients = this.brokers.map(() => null);
    this.retry = this.brokers.map(() => 0);
    this.retryTimers = this.brokers.map(() => 0);
    this.failed = this.brokers.map(() => false);
    this.setStatus('connecting');
    this.brokers.forEach((_, i) => this.connect(i));
    this.beat = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS / 4);
  }

  /** Disconnect; `forget` also drops the remembered pairing. */
  stop(forget = true) {
    this.teardown();
    if (forget) {
      storage.remove(STORE_KEY);
      this.code = null;
    }
    this.setStatus('off');
  }

  /** Close every broker connection without touching the status (used when switching codes). */
  private teardown() {
    if (this.code && this.active) this.sendAll({ t: 'bye' } as Out);
    window.clearInterval(this.beat);
    for (const t of this.retryTimers) window.clearTimeout(t);
    for (const c of this.clients) {
      if (!c) continue;
      c.onClose = null;
      c.close();
    }
    this.clients = [];
    this.peers.clear();
  }

  send(msg: Out) {
    const p = this.bestPeer();
    const c = p ? this.clients[p.broker] : null;
    if (c && c.state === 'open') c.publish(this.outTopic(), this.wrap(msg));
    else this.sendAll(msg);
  }

  private sendAll(msg: Out) {
    const payload = this.wrap(msg);
    for (const c of this.clients) if (c?.state === 'open') c.publish(this.outTopic(), payload);
  }

  private wrap(msg?: Out): string {
    const env: Envelope<Out> = { from: this.id, seq: ++this.seq };
    if (msg) env.m = msg;
    else env.hb = true;
    return JSON.stringify(env);
  }

  private inTopic() {
    return `${TOPIC_ROOT}/${this.code}/${this.role === 'host' ? 'h' : 'd'}`;
  }

  private outTopic() {
    return `${TOPIC_ROOT}/${this.code}/${this.role === 'host' ? 'd' : 'h'}`;
  }

  private connect(i: number) {
    let c: MqttClient;
    try {
      c = new MqttClient(this.brokers[i], `ssc${this.role[0]}${this.id}${i}`);
    } catch {
      this.failed[i] = true;
      this.scheduleRetry(i);
      return;
    }
    this.clients[i] = c;
    c.onOpen = () => {
      this.retry[i] = 0;
      this.failed[i] = false;
      c.subscribe(this.inTopic());
      // Announce right away so the other side does not wait for a heartbeat
      c.publish(this.outTopic(), this.wrap());
      this.refresh();
    };
    c.onMessage = (_topic, payload) => this.receive(i, payload);
    c.onClose = () => {
      this.clients[i] = null;
      this.failed[i] = true;
      for (const [id, p] of this.peers) if (p.broker === i) this.peers.delete(id);
      this.refresh();
      this.scheduleRetry(i);
    };
  }

  private scheduleRetry(i: number) {
    if (!this.code) return;
    const wait = Math.min(30000, 2000 * 2 ** this.retry[i]++);
    this.retryTimers[i] = window.setTimeout(() => {
      if (this.code && this.status !== 'off' && !this.clients[i]) this.connect(i);
    }, wait);
    this.refresh();
  }

  private receive(broker: number, payload: string) {
    let env: Envelope<In>;
    try {
      env = JSON.parse(payload) as Envelope<In>;
    } catch {
      return;
    }
    if (!env || typeof env.from !== 'string' || env.from === this.id) return;
    const key = `${env.from}:${env.seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 400) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    const now = performance.now();
    this.lastHeard = now;
    const known = this.peers.get(env.from);
    const bye = !!env.m && (env.m as { t?: string }).t === 'bye';
    if (bye) this.peers.delete(env.from);
    else this.peers.set(env.from, { lastSeen: now, broker });
    if (!known && !bye) {
      this.refresh();
      this.emit('peer', env.from);
    }
    if (env.m) this.emit('message', { from: env.from, msg: env.m });
    if (bye) this.refresh();
  }

  private bestPeer(): Peer | null {
    let best: Peer | null = null;
    for (const p of this.peers.values()) if (!best || p.lastSeen > best.lastSeen) best = p;
    return best;
  }

  private lastBeat = 0;

  private heartbeat() {
    const now = performance.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.refresh();
    if (now - this.lastBeat >= HEARTBEAT_MS) {
      this.lastBeat = now;
      const payload = this.wrap();
      for (const c of this.clients) if (c?.state === 'open') c.publish(this.outTopic(), payload);
    }
  }

  private refresh() {
    if (!this.code) return;
    const open = this.clients.some((c) => c?.state === 'open');
    let s: LinkStatus;
    if (this.peers.size) s = 'connected';
    else if (open) s = 'waiting';
    else if (this.failed.every(Boolean)) s = 'error';
    else s = 'connecting';
    this.setStatus(s);
  }

  private setStatus(s: LinkStatus) {
    if (s === this.status) return;
    this.status = s;
    this.emit('status', s);
  }
}
