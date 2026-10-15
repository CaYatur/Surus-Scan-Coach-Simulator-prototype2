/**
 * End-to-end protection for the phone link. The relay brokers are public, so everything
 * on the wire must be useless to someone who subscribes to every topic:
 *
 * - The pairing code is never sent. PBKDF2 (SHA-256, many iterations) stretches it into
 *   an opaque topic id and a separate AES-GCM key; with a 10-character code from a
 *   31-letter alphabet (~49 bits) a brute-force search over the stretched code is out of reach.
 * - Every message is AES-GCM sealed (random IV) with the direction as associated data,
 *   so a message cannot be reflected back to its sender, and forged or altered messages —
 *   e.g. a fake "pause" command — fail authentication.
 * - The sealed envelope carries a timestamp and per-sender sequence number; ReplayGuard
 *   drops stale or repeated messages so a captured command cannot be replayed later.
 */

const SALT = new TextEncoder().encode('surus-kocu/link/v2');
export const PBKDF2_ITERATIONS = 210_000;
/** Maximum accepted clock difference between the two devices. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export type PairKeys = { topic: string; key: CryptoKey };

export function secureSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function deriveKeys(code: string, iterations = PBKDF2_ITERATIONS): Promise<PairKeys> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations }, base, 384));
  const topic = Array.from(bits.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}

export async function seal(keys: PairKeys, aad: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, keys.key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64(out);
}

/** Decrypt a sealed payload; null when it was not made with this key/direction or was altered. */
export async function unseal(keys: PairKeys, aad: string, payload: string): Promise<string | null> {
  const raw = unb64(payload);
  if (!raw || raw.length < 12 + 16) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: new TextEncoder().encode(aad) }, keys.key, raw.subarray(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

const SEQ_WINDOW = 2000;
const MAX_SENDERS = 32;

/** Rejects stale (clock window) and repeated (sender + sequence) messages. */
export class ReplayGuard {
  private senders = new Map<string, { max: number; seen: Set<number> }>();

  accept(from: string, seq: number, ts: number, now = Date.now()): boolean {
    if (!Number.isInteger(seq) || seq < 1 || !Number.isFinite(ts)) return false;
    if (Math.abs(now - ts) > MAX_SKEW_MS) return false;
    let s = this.senders.get(from);
    if (!s) {
      if (this.senders.size >= MAX_SENDERS) {
        const oldest = this.senders.keys().next().value;
        if (oldest !== undefined) this.senders.delete(oldest);
      }
      s = { max: 0, seen: new Set() };
      this.senders.set(from, s);
    }
    if (seq <= s.max - SEQ_WINDOW || s.seen.has(seq)) return false;
    s.seen.add(seq);
    if (seq > s.max) {
      s.max = seq;
      if (s.seen.size > SEQ_WINDOW) for (const n of s.seen) if (n <= s.max - SEQ_WINDOW) s.seen.delete(n);
    }
    return true;
  }

  clear() {
    this.senders.clear();
  }
}
