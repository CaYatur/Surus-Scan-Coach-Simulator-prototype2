/**
 * Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only).
 * Enough to use a public broker as a message relay between two browsers — the
 * app is a static site, so there is no server of our own to talk through.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function packet(type: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const head: number[] = [type];
  let x = len;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    head.push(byte);
  } while (x > 0);
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export type MqttState = 'connecting' | 'open' | 'closed';

export class MqttClient {
  readonly url: string;
  state: MqttState = 'connecting';
  onMessage: ((topic: string, payload: string) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private ws: WebSocket;
  private buf = new Uint8Array(0);
  private pingTimer = 0;
  private packetId = 1;
  private keepalive = 30;

  constructor(url: string, clientId: string) {
    this.url = url;
    this.ws = new WebSocket(url, ['mqtt']);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      const flags = 0x02; // clean session
      const vh = new Uint8Array([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, flags, this.keepalive >> 8, this.keepalive & 0xff]);
      this.send(packet(0x10, vh, str(clientId)));
    };
    this.ws.onmessage = (e) => this.receive(new Uint8Array(e.data as ArrayBuffer));
    this.ws.onclose = () => this.closed();
    this.ws.onerror = () => this.closed();
  }

  subscribe(topic: string) {
    const id = this.packetId++ & 0xffff || 1;
    this.send(packet(0x82, new Uint8Array([id >> 8, id & 0xff]), str(topic), new Uint8Array([0])));
  }

  publish(topic: string, payload: string) {
    this.send(packet(0x30, str(topic), enc.encode(payload)));
  }

  close() {
    if (this.state === 'closed') return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array([0xe0, 0]));
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.closed();
  }

  private send(p: Uint8Array<ArrayBuffer>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(p);
  }

  private closed() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    window.clearInterval(this.pingTimer);
    this.onClose?.();
  }

  private receive(chunk: Uint8Array) {
    // A WebSocket frame may hold a partial packet or several packets
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    let o = 0;
    while (merged.length - o >= 2) {
      let len = 0;
      let mul = 1;
      let i = o + 1;
      let complete = false;
      while (i < merged.length) {
        const b = merged[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) {
          complete = true;
          break;
        }
      }
      if (!complete || merged.length - i < len) break;
      this.handle(merged[o], merged.subarray(i, i + len));
      o = i + len;
    }
    this.buf = merged.slice(o);
  }

  private handle(head: number, body: Uint8Array) {
    const type = head >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) {
        this.close();
        return;
      }
      this.state = 'open';
      this.pingTimer = window.setInterval(() => this.send(new Uint8Array([0xc0, 0])), (this.keepalive * 1000) / 2);
      this.onOpen?.();
    } else if (type === 3) {
      // PUBLISH
      const qos = (head >> 1) & 3;
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      let p = 2 + tl;
      if (qos > 0) {
        const id = body.subarray(p, p + 2);
        p += 2;
        if (qos === 1) this.send(packet(0x40, id)); // PUBACK
      }
      this.onMessage?.(topic, dec.decode(body.subarray(p)));
    }
    // SUBACK (9) and PINGRESP (13) need no handling
  }
}
