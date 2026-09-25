import { clamp } from '../core/math';
import { settings } from '../core/settings';

/** Fully synthesised audio (no sample files): engine, tyres, wind, indicator, horn, crash, rain, UI. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private tyreGain!: GainNode;
  private tyreFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private rainGain!: GainNode;
  private hornGain!: GainNode;
  private sirenOsc!: OscillatorNode;
  private sirenGain!: GainNode;
  private started = false;
  private tickPrev = false;
  private voice: SpeechSynthesisVoice | null = null;
  private lastSay = new Map<string, number>();

  /** Must be called from a user gesture. */
  unlock() {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.applyVolume();
    // noise buffer
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // engine: two detuned oscillators through a low-pass
    this.engineFilter = c.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineFilter.Q.value = 2;
    this.engineGain = c.createGain();
    this.engineGain.gain.value = 0;
    this.oscA = c.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = c.createOscillator();
    this.oscB.type = 'square';
    const gb = c.createGain();
    gb.gain.value = 0.35;
    this.oscA.connect(this.engineFilter);
    this.oscB.connect(gb).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.oscA.start();
    this.oscB.start();
    // tyres
    const tyreSrc = this.loopNoise();
    this.tyreFilter = c.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1400;
    this.tyreFilter.Q.value = 6;
    this.tyreGain = c.createGain();
    this.tyreGain.gain.value = 0;
    tyreSrc.connect(this.tyreFilter).connect(this.tyreGain).connect(this.master);
    // wind / road noise
    const windSrc = this.loopNoise();
    const wf = c.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 500;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(wf).connect(this.windGain).connect(this.master);
    // rain
    const rainSrc = this.loopNoise();
    const rf = c.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 2500;
    this.rainGain = c.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rf).connect(this.rainGain).connect(this.master);
    // horn
    this.hornGain = c.createGain();
    this.hornGain.gain.value = 0;
    for (const f of [415, 520]) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const hf = c.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 1800;
      o.connect(hf).connect(this.hornGain);
      o.start();
    }
    this.hornGain.connect(this.master);
    // siren (frequency driven per frame: two-tone for ambulance, wail for police)
    this.sirenOsc = c.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 800;
    const sf = c.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 2400;
    this.sirenGain = c.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(sf).connect(this.sirenGain).connect(this.master);
    this.sirenOsc.start();
    this.started = true;
    this.pickVoice();
    settings.on('change', () => this.applyVolume());
  }

  private pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const choose = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => v.lang.toLowerCase().startsWith('tr')) ?? null;
    };
    choose();
    speechSynthesis.onvoiceschanged = choose;
  }

  private loopNoise(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start();
    return s;
  }

  private applyVolume() {
    if (!this.ctx) return;
    this.master.gain.value = settings.get().masterVolume;
  }

  setActive(active: boolean) {
    if (!this.ctx) return;
    if (active) void this.ctx.resume();
    else {
      this.engineGain.gain.value = 0;
      this.tyreGain.gain.value = 0;
      this.windGain.gain.value = 0;
      this.hornGain.gain.value = 0;
      this.sirenGain.gain.value = 0;
    }
  }

  update(p: { rpm: number; throttle: number; kmh: number; slip: number; horn: boolean; blink: boolean; blinking: boolean; rain: number; interior: boolean; siren?: { dist: number; police: boolean } | null }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const ev = settings.get().engineVolume;
    const f = (p.rpm / 60) * 2; // 4-stroke 4-cyl firing frequency
    this.oscA.frequency.setTargetAtTime(f, t, 0.03);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(300 + p.throttle * 1400 + p.rpm * 0.12, t, 0.05);
    const inside = p.interior ? 0.75 : 1;
    this.engineGain.gain.setTargetAtTime((0.05 + p.throttle * 0.09) * ev * inside, t, 0.05);
    this.tyreGain.gain.setTargetAtTime(clamp(p.slip - 0.15, 0, 1) * 0.35 * clamp(p.kmh / 20, 0, 1), t, 0.05);
    this.windGain.gain.setTargetAtTime(clamp(p.kmh / 110, 0, 1) * 0.16 * inside, t, 0.2);
    this.rainGain.gain.setTargetAtTime(p.rain * 0.08, t, 0.5);
    this.hornGain.gain.setTargetAtTime(p.horn ? 0.14 : 0, t, 0.01);
    if (p.siren) {
      const f = p.siren.police ? 750 + 550 * (0.5 - 0.5 * Math.cos((t % 2.6) / 2.6 * Math.PI * 2)) : t % 1.1 < 0.55 ? 960 : 770;
      this.sirenOsc.frequency.setTargetAtTime(f, t, p.siren.police ? 0.05 : 0.01);
      const vol = clamp(1 - p.siren.dist / 160, 0, 1) ** 1.5 * 0.12 * (p.interior ? 0.6 : 1);
      this.sirenGain.gain.setTargetAtTime(vol, t, 0.1);
    } else this.sirenGain.gain.setTargetAtTime(0, t, 0.2);
    // indicator relay tick
    if (p.blinking && p.blink !== this.tickPrev) this.click(p.blink ? 1800 : 1200, 0.025, 0.12);
    this.tickPrev = p.blink;
  }

  private click(freq: number, dur: number, vol: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(c.currentTime + dur + 0.02);
  }

  crash(strength: number) {
    if (!this.ctx) return;
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = c.createGain();
    const v = clamp(strength, 0.1, 1) * 0.9;
    g.gain.setValueAtTime(v, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.5 + strength * 0.4);
    s.connect(f).connect(g).connect(this.master);
    s.start();
    s.stop(c.currentTime + 1.2);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(90, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(35, c.currentTime + 0.3);
    const og = c.createGain();
    og.gain.setValueAtTime(v * 0.8, c.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.35);
    o.connect(og).connect(this.master);
    o.start();
    o.stop(c.currentTime + 0.4);
  }

  /** UI / coaching cues. */
  cue(kind: 'good' | 'warn' | 'bad' | 'ui' | 'stimulus' | 'complete') {
    if (!this.ctx) return;
    const c = this.ctx;
    const seq: [number, number][] =
      kind === 'good' ? [[880, 0.08], [1320, 0.12]] : kind === 'warn' ? [[660, 0.12]] : kind === 'bad' ? [[330, 0.16], [247, 0.22]] : kind === 'stimulus' ? [[1000, 0.35]] : kind === 'complete' ? [[523, 0.1], [659, 0.1], [784, 0.1], [1046, 0.25]] : [[1200, 0.03]];
    let t = c.currentTime;
    for (const [f, d] of seq) {
      const o = c.createOscillator();
      o.type = kind === 'stimulus' ? 'square' : 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(kind === 'ui' ? 0.05 : 0.14, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d * 0.9;
    }
  }

  say(text: string, kind: 'nav' | 'coach' = 'nav', minGap = 4) {
    const s = settings.get();
    if (kind === 'nav' && !s.voiceNav) return;
    if (kind === 'coach' && !s.voiceCoach) return;
    if (!('speechSynthesis' in window)) return;
    const now = performance.now() / 1000;
    if (now - (this.lastSay.get(text) ?? -99) < minGap) return;
    this.lastSay.set(text, now);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'tr-TR';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.volume = clamp(s.masterVolume * 1.2, 0, 1);
    if (kind === 'nav') speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

export const audio = new AudioEngine();
