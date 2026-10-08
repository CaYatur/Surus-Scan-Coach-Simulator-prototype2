/** Rough "is this a phone/tablet" check — decides whether the main menu offers the companion QR. */
export function isPhoneLike(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod|iPad|Mobile|IEMobile|Opera Mini|Silk|Kindle/i.test(ua)) return true;
  // iPadOS reports itself as a Mac — catch it by touch points
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(screen.width, screen.height) < 820;
}

/** Short human label for this device, shown on the other side of the link. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android telefon' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows bilgisayar';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux bilgisayar';
  return 'Cihaz';
}
