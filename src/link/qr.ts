import qrcode from 'qrcode-generator';

/** QR code as an inline SVG string (dark modules on a white quiet zone). */
export function qrSvg(text: string, margin = 2): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      // merge horizontal runs into one rect-path segment
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c + margin} ${r + margin}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" class="qr-svg"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0d1117"/></svg>`;
}

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

export function cameraAvailable(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Webcam QR scanner. Uses the native BarcodeDetector where it exists and falls back to
 * jsQR (loaded on demand) everywhere else — desktop Chrome on Windows/Linux and Firefox
 * have no BarcodeDetector.
 */
export class QrScanner {
  readonly video: HTMLVideoElement;
  onResult: ((text: string) => void) | null = null;
  private stream: MediaStream | null = null;
  private timer = 0;
  private stopped = false;
  private canvas = document.createElement('canvas');

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (this.stopped) {
      this.stop();
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    let detector: Detector | null = null;
    const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
    if (BD) {
      try {
        const formats = (await BD.getSupportedFormats?.()) ?? ['qr_code'];
        if (formats.includes('qr_code')) detector = new BD({ formats: ['qr_code'] });
      } catch {
        detector = null;
      }
    }
    const jsQR = detector ? null : (await import('jsqr')).default;
    const g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    const tick = async () => {
      if (this.stopped) return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        let text: string | null = null;
        if (detector) {
          try {
            const r = await detector.detect(v);
            text = r[0]?.rawValue ?? null;
          } catch {
            text = null;
          }
        } else if (jsQR) {
          // Downscale for speed: a phone screen fills a good part of the frame anyway
          const scale = Math.min(1, 640 / v.videoWidth);
          const w = Math.round(v.videoWidth * scale);
          const h = Math.round(v.videoHeight * scale);
          this.canvas.width = w;
          this.canvas.height = h;
          g.drawImage(v, 0, 0, w, h);
          // Try both polarities: some phones show the code light-on-dark in dark mode
          text = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
        }
        if (text && !this.stopped) {
          this.onResult?.(text);
        }
      }
      if (!this.stopped) this.timer = window.setTimeout(() => void tick(), 120);
    };
    void tick();
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
