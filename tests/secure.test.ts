import { describe, expect, it } from 'vitest';
import { MAX_SKEW_MS, ReplayGuard, deriveKeys, seal, unseal } from '../src/link/secure';

describe('Canlı Koç uçtan uca şifreleme', () => {
  it('aynı koddan iki cihaz aynı konuyu ve anahtarı türetir; konu kodu içermez', async () => {
    const a = await deriveKeys('ABCDE23456', 1000);
    const b = await deriveKeys('ABCDE23456', 1000);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(a.topic).not.toContain('ABCDE');
    const other = await deriveKeys('ABCDE23457', 1000);
    expect(other.topic).not.toBe(a.topic);
    const msg = await seal(a, 'to-host', '{"t":"cmd","cmd":"pause"}');
    expect(await unseal(b, 'to-host', msg)).toBe('{"t":"cmd","cmd":"pause"}');
  });

  it('yanlış anahtar, ters yön veya değiştirilmiş mesaj reddedilir', async () => {
    const k = await deriveKeys('ABCDE23456', 1000);
    const wrong = await deriveKeys('ZZZZZ99999', 1000);
    const msg = await seal(k, 'to-host', 'hello');
    expect(await unseal(wrong, 'to-host', msg)).toBeNull();
    // a message for the host cannot be reflected back to the display
    expect(await unseal(k, 'to-display', msg)).toBeNull();
    const flipped = msg.slice(0, -2) + (msg.at(-2) === 'A' ? 'B' : 'A') + msg.at(-1);
    expect(await unseal(k, 'to-host', flipped)).toBeNull();
    expect(await unseal(k, 'to-host', 'not-base64!')).toBeNull();
    // fresh IV every time
    expect(await seal(k, 'to-host', 'hello')).not.toBe(msg);
  });
});

describe('ReplayGuard', () => {
  const now = 1_800_000_000_000;
  it('aynı mesajı (gönderen + sıra) yalnızca bir kez kabul eder', () => {
    const g = new ReplayGuard();
    expect(g.accept('a', 1, now, now)).toBe(true);
    expect(g.accept('a', 1, now, now)).toBe(false);
    expect(g.accept('b', 1, now, now)).toBe(true);
    // out-of-order delivery through another broker is fine
    expect(g.accept('a', 3, now, now)).toBe(true);
    expect(g.accept('a', 2, now, now)).toBe(true);
  });

  it('saat penceresi dışındaki (eski / gelecekten) mesajları reddeder', () => {
    const g = new ReplayGuard();
    expect(g.accept('a', 1, now - MAX_SKEW_MS - 1, now)).toBe(false);
    expect(g.accept('a', 2, now + MAX_SKEW_MS + 1, now)).toBe(false);
    expect(g.accept('a', 3, now - MAX_SKEW_MS + 1000, now)).toBe(true);
  });

  it('çok eski sıra numaraları pencere dışına düşer', () => {
    const g = new ReplayGuard();
    expect(g.accept('a', 5000, now, now)).toBe(true);
    expect(g.accept('a', 2000, now, now)).toBe(false);
    expect(g.accept('a', 4500, now, now)).toBe(true);
  });

  it('geçersiz alanları reddeder', () => {
    const g = new ReplayGuard();
    expect(g.accept('a', 0, now, now)).toBe(false);
    expect(g.accept('a', 1.5, now, now)).toBe(false);
    expect(g.accept('a', 2, Number.NaN, now)).toBe(false);
  });
});
