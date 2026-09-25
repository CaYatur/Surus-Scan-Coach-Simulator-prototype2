import { settings } from '../core/settings';
import type { GlanceTarget } from './input';

export type HeadTrackStatus = 'off' | 'loading' | 'running' | 'no-face' | 'error';

type Landmarker = {
  detectForVideo(video: HTMLVideoElement, ts: number): { faceLandmarks: { x: number; y: number; z: number }[][] };
  close(): void;
};

type VisionModule = {
  FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
  FaceLandmarker: {
    createFromOptions(
      fileset: unknown,
      opts: {
        baseOptions: { modelAssetPath: string; delegate: 'GPU' | 'CPU' };
        runningMode: 'VIDEO';
        numFaces: number;
      },
    ): Promise<Landmarker>;
  };
};

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Optional webcam head tracking (MediaPipe Face Landmarker, runs locally in the browser).
 * Produces head yaw/pitch relative to a calibrated neutral pose and maps them to glances.
 * Video never leaves the device.
 */
export class HeadTracker {
  status: HeadTrackStatus = 'off';
  error = '';
  /** Radians, + = head turned to the driver's left. */
  yaw = 0;
  /** Radians, + = looking up. */
  pitch = 0;
  glance: GlanceTarget = 'none';
  private raw = { yaw: 0, pitch: 0 };
  private neutral = { yaw: 0, pitch: 0 };
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: Landmarker | null = null;
  private lastTs = -1;
  private frame = 0;
  private previewEl: HTMLElement | null = null;
  private calibrateNext = true;
  invert = false;

  async start(previewHost?: HTMLElement): Promise<boolean> {
    if (this.status === 'running' || this.status === 'loading') return true;
    this.status = 'loading';
    this.error = '';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;
      // Load from CDN (not Vite-bundled): bundling @mediapipe creates a circular
      // chunk (vision_bundle ↔ index) that breaks dynamic import on GitHub Pages
      // after asset hash changes / partial cache. WASM/model already use CDN URLs.
      const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm';
      // @vite-ignore — keep out of Rollup graph (avoids circular vision↔index chunk).
      const vision = (await import(/* @vite-ignore */ MEDIAPIPE_ESM)) as VisionModule;
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      try {
        this.landmarker = (await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
        })) as unknown as Landmarker;
      } catch {
        // Some devices reject the GPU delegate; fall back to CPU.
        this.landmarker = (await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
        })) as unknown as Landmarker;
      }
      this.status = 'running';
      this.calibrateNext = true;
      if (previewHost) this.attachPreview(previewHost);
      return true;
    } catch (e) {
      this.status = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      this.error = /Failed to fetch dynamically imported module|Loading module|import/i.test(msg)
        ? `Modül yüklenemedi (${msg}). Sayfayı hard-refresh deneyin (Ctrl+Shift+R); CDN engeli varsa ağ/eklentiyi kontrol edin.`
        : msg;
      this.stop(false);
      return false;
    }
  }

  stop(resetStatus = true) {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.video = null;
    this.previewEl?.remove();
    this.previewEl = null;
    if (resetStatus) this.status = 'off';
    this.glance = 'none';
    this.yaw = this.pitch = 0;
  }

  /** Use the current head pose as "looking straight at the road". */
  recenter() {
    this.calibrateNext = true;
  }

  private attachPreview(host: HTMLElement) {
    if (!this.video) return;
    const wrap = document.createElement('div');
    wrap.className = 'webcam-preview';
    this.video.className = 'webcam-video';
    wrap.appendChild(this.video);
    const tag = document.createElement('div');
    tag.className = 'webcam-tag';
    tag.textContent = 'Kafa takibi';
    wrap.appendChild(tag);
    host.appendChild(wrap);
    this.previewEl = wrap;
    this.previewEl.style.display = settings.get().webcamPreview ? '' : 'none';
  }

  setPreviewVisible(v: boolean) {
    if (this.previewEl) this.previewEl.style.display = v ? '' : 'none';
  }

  update() {
    if (this.status !== 'running' && this.status !== 'no-face') return;
    if (!this.video || !this.landmarker) return;
    this.frame++;
    if (this.frame % 2) return; // ~30 Hz is plenty
    const ts = performance.now();
    if (ts <= this.lastTs) return;
    this.lastTs = ts;
    let res;
    try {
      res = this.landmarker.detectForVideo(this.video, ts);
    } catch {
      return;
    }
    const lm = res.faceLandmarks?.[0];
    if (!lm || lm.length < 455) {
      this.status = 'no-face';
      this.glance = 'none';
      return;
    }
    this.status = 'running';
    const nose = lm[1];
    const left = lm[234];
    const right = lm[454];
    const eyeL = lm[33];
    const eyeR = lm[263];
    const chin = lm[152];
    const width = right.x - left.x || 1e-3;
    const ratio = (nose.x - left.x) / width; // 0.5 when facing camera
    const eyeY = (eyeL.y + eyeR.y) / 2;
    const vr = (nose.y - eyeY) / ((chin.y - eyeY) || 1e-3);
    const yawRaw = Math.asin(Math.max(-1, Math.min(1, (ratio - 0.5) * 2.2))) * (this.invert ? -1 : 1);
    const pitchRaw = -(vr - 0.42) * 2.4;
    // light smoothing
    this.raw.yaw += (yawRaw - this.raw.yaw) * 0.5;
    this.raw.pitch += (pitchRaw - this.raw.pitch) * 0.5;
    if (this.calibrateNext) {
      this.neutral = { ...this.raw };
      this.calibrateNext = false;
    }
    this.yaw = this.raw.yaw - this.neutral.yaw;
    this.pitch = this.raw.pitch - this.neutral.pitch;
    const th = (settings.get().webcamYawThreshold * Math.PI) / 180;
    const deg = (r: number) => (r * 180) / Math.PI;
    if (this.yaw > th * 2.4) this.glance = 'shoulderL';
    else if (this.yaw > th) this.glance = 'mirrorL';
    else if (this.yaw < -th * 2.4) this.glance = 'shoulderR';
    else if (this.yaw < -th) this.glance = 'mirrorR';
    else if (deg(this.pitch) > 9) this.glance = 'mirrorRear';
    else this.glance = 'none';
  }
}
