import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/math';

/** Procedural canvas textures — no external image assets needed. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean; aniso?: number } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (opts.repeat ?? true) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Rng, amount: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

export function asphaltTexture(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const rng = mulberry32(11);
  const S = 512;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, S, S);
  noise(ctx, S, S, rng, 38);
  // aggregate speckles
  for (let i = 0; i < 9000; i++) {
    const g = 40 + rng() * 90;
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.35 + rng() * 0.4})`;
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 1.6, 1 + rng() * 1.6);
  }
  // patches & cracks
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = `rgba(${20 + rng() * 25},${22 + rng() * 25},${26 + rng() * 25},0.18)`;
    ctx.beginPath();
    ctx.ellipse(rng() * S, rng() * S, 30 + rng() * 90, 20 + rng() * 60, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(15,15,18,0.45)';
  for (let i = 0; i < 6; i++) {
    ctx.lineWidth = 0.8 + rng();
    ctx.beginPath();
    let x = rng() * S;
    let y = rng() * S;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rng() - 0.5) * 40;
      y += (rng() - 0.5) * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const [rc, rctx] = canvas(256, 256);
  rctx.drawImage(c, 0, 0, 256, 256);
  const img = rctx.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + (img.data[i] - 60) * 1.2;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(80, Math.min(255, v));
  }
  rctx.putImageData(img, 0, 0);
  return { map: tex(c), rough: tex(rc, { srgb: false }) };
}

export function paverTexture(): THREE.CanvasTexture {
  const rng = mulberry32(21);
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#8d8b86';
  ctx.fillRect(0, 0, S, S);
  const n = 8;
  const cell = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const off = y % 2 ? cell / 2 : 0;
      const g = 150 + rng() * 40;
      ctx.fillStyle = `rgb(${g},${g - 4},${g - 10})`;
      ctx.fillRect(x * cell + off + 1.5, y * cell + 1.5, cell - 3, cell - 3);
      if (off && x === n - 1) ctx.fillRect(-cell / 2 + 1.5, y * cell + 1.5, cell - 3, cell - 3);
    }
  }
  noise(ctx, S, S, rng, 22);
  return tex(c);
}

export function grassTexture(): THREE.CanvasTexture {
  const rng = mulberry32(31);
  const S = 512;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#4d7a35';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${60 + rng() * 40},${100 + rng() * 50},${30 + rng() * 30},0.25)`;
    ctx.beginPath();
    ctx.ellipse(rng() * S, rng() * S, 40 + rng() * 120, 30 + rng() * 90, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 26000; i++) {
    const g = 90 + rng() * 90;
    ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.35},0.5)`;
    ctx.fillRect(rng() * S, rng() * S, 1, 2 + rng() * 2);
  }
  return tex(c);
}

export function concreteTexture(): THREE.CanvasTexture {
  const rng = mulberry32(41);
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#a7a6a1';
  ctx.fillRect(0, 0, S, S);
  noise(ctx, S, S, rng, 26);
  ctx.strokeStyle = 'rgba(80,80,80,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, S, S);
  return tex(c);
}

export type FacadeKind = 'apartment' | 'office' | 'brick' | 'modern' | 'storefront' | 'house' | 'industrial' | 'school';

type FacadeTex = { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture };

/**
 * Facade texture covering 4 bays × 4 floors (12.8 m × 12.8 m). Walls are light grey so
 * per-building vertex colours tint them; windows are dark / reflective.
 * The emissive map contains randomly lit windows for night.
 */
export function facadeTexture(kind: FacadeKind, seed: number): FacadeTex {
  const rng = mulberry32(seed);
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const [ec, ectx] = canvas(S, S);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, S, S);
  const bay = S / 4;
  const litColor = () => {
    const warm = rng();
    return warm < 0.7 ? `rgb(255,${200 + rng() * 40},${130 + rng() * 60})` : `rgb(${190 + rng() * 40},${215 + rng() * 30},255)`;
  };
  const windowGlass = (x: number, y: number, w: number, h: number, frame = '#d8d8d8') => {
    ctx.fillStyle = frame;
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#2a3a4c');
    g.addColorStop(0.55, '#46607a');
    g.addColorStop(1, '#1d2733');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // reflection streak
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.1, y + h);
    ctx.lineTo(x + w * 0.45, y);
    ctx.lineTo(x + w * 0.6, y);
    ctx.lineTo(x + w * 0.25, y + h);
    ctx.fill();
    if (rng() < 0.38) {
      ectx.fillStyle = litColor();
      ectx.fillRect(x, y, w, h);
      // curtain partial
      if (rng() < 0.5) {
        ectx.fillStyle = 'rgba(0,0,0,0.55)';
        ectx.fillRect(x, y, w * (0.2 + rng() * 0.4), h);
      }
    }
  };

  switch (kind) {
    case 'apartment': {
      ctx.fillStyle = '#e9e6df';
      ctx.fillRect(0, 0, S, S);
      noise(ctx, S, S, rng, 14);
      for (let f = 0; f < 4; f++) {
        // floor slab line
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(0, f * bay + bay - 6, S, 6);
        for (let b = 0; b < 4; b++) {
          const x = b * bay + 22;
          const y = f * bay + 26;
          const w = b % 2 === 0 ? bay - 44 : bay - 60;
          windowGlass(x, y, w, bay - 56, '#f4f2ee');
          // shutters / railing hint
          if (rng() < 0.3) {
            ctx.fillStyle = 'rgba(90,70,50,0.6)';
            ctx.fillRect(x, y, w, (bay - 56) * 0.35);
          }
        }
      }
      break;
    }
    case 'office': {
      ctx.fillStyle = '#9fb2c4';
      ctx.fillRect(0, 0, S, S);
      for (let f = 0; f < 4; f++) {
        for (let b = 0; b < 8; b++) {
          const x = b * (S / 8);
          const y = f * bay;
          const g = ctx.createLinearGradient(x, y, x + S / 8, y + bay);
          const t = 0.25 + rng() * 0.2;
          g.addColorStop(0, `rgba(${40 + t * 60},${70 + t * 80},${100 + t * 90},1)`);
          g.addColorStop(1, `rgba(${20 + t * 40},${40 + t * 50},${60 + t * 60},1)`);
          ctx.fillStyle = g;
          ctx.fillRect(x + 2, y + 2, S / 8 - 4, bay - 12);
          if (rng() < 0.45) {
            ectx.fillStyle = `rgba(${200 + rng() * 55},${220 + rng() * 35},255,${0.5 + rng() * 0.5})`;
            ectx.fillRect(x + 2, y + 2, S / 8 - 4, bay - 12);
          }
        }
        ctx.fillStyle = '#c9d3dc';
        ctx.fillRect(0, f * bay + bay - 10, S, 10);
      }
      for (let b = 0; b <= 8; b++) {
        ctx.fillStyle = '#cfd8e0';
        ctx.fillRect(b * (S / 8) - 2, 0, 4, S);
      }
      break;
    }
    case 'brick': {
      ctx.fillStyle = '#a4553d';
      ctx.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 8) {
        for (let x = (y / 8) % 2 ? -8 : 0; x < S; x += 16) {
          const r = 150 + rng() * 40;
          ctx.fillStyle = `rgb(${r},${r * 0.45},${r * 0.33})`;
          ctx.fillRect(x + 1, y + 1, 14, 6);
        }
      }
      for (let f = 0; f < 4; f++) {
        for (let b = 0; b < 4; b++) {
          const x = b * bay + 30;
          const y = f * bay + 22;
          ctx.fillStyle = '#e6dccd';
          ctx.fillRect(x - 6, y + bay - 58, bay - 48, 8);
          windowGlass(x, y, bay - 60, bay - 60, '#efe8dc');
        }
      }
      break;
    }
    case 'modern': {
      ctx.fillStyle = '#d4d6d8';
      ctx.fillRect(0, 0, S, S);
      noise(ctx, S, S, rng, 10);
      for (let f = 0; f < 4; f++) {
        const y = f * bay + 30;
        const g = ctx.createLinearGradient(0, y, 0, y + 60);
        g.addColorStop(0, '#34485c');
        g.addColorStop(1, '#1e2a36');
        ctx.fillStyle = g;
        ctx.fillRect(0, y, S, 62);
        for (let b = 0; b < 8; b++) {
          ctx.fillStyle = '#e0e2e4';
          ctx.fillRect(b * 64 - 2, y, 4, 62);
          if (rng() < 0.4) {
            ectx.fillStyle = litColor();
            ectx.fillRect(b * 64 + 2, y, 60, 62);
          }
        }
      }
      break;
    }
    case 'storefront': {
      // one texture tile = 4 shops × 1 floor (repeat vertically is avoided by UV)
      ctx.fillStyle = '#d9d4cc';
      ctx.fillRect(0, 0, S, S);
      const signColors = ['#c62828', '#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f', '#ad1457', '#f9a825'];
      for (let b = 0; b < 4; b++) {
        const x = b * bay;
        ctx.fillStyle = signColors[Math.floor(rng() * signColors.length)];
        ctx.fillRect(x + 6, 40, bay - 12, 70);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        const names = ['FIRIN', 'BAKKAL', 'ECZANE', 'KAFE', 'BERBER', 'MARKET', 'KIRTASİYE', 'LOKANTA', 'OPTİK', 'BÜFE', 'TERZİ', 'ÇİÇEKÇİ'];
        ctx.fillText(names[Math.floor(rng() * names.length)], x + bay / 2, 86, bay - 20);
        ectx.fillStyle = 'rgba(255,240,220,0.9)';
        ectx.fillRect(x + 6, 40, bay - 12, 70);
        const g = ctx.createLinearGradient(x, 130, x, S);
        g.addColorStop(0, '#50677d');
        g.addColorStop(1, '#23303c');
        ctx.fillStyle = g;
        ctx.fillRect(x + 12, 140, bay - 24, S - 150);
        ctx.fillStyle = '#9ea5ab';
        ctx.fillRect(x + bay / 2 - 2, 140, 4, S - 150);
        ectx.fillStyle = `rgb(255,${210 + rng() * 30},${150 + rng() * 50})`;
        ectx.fillRect(x + 12, 140, bay - 24, S - 150);
      }
      break;
    }
    case 'house': {
      ctx.fillStyle = '#efe7da';
      ctx.fillRect(0, 0, S, S);
      noise(ctx, S, S, rng, 12);
      for (let f = 0; f < 4; f++) {
        for (let b = 0; b < 4; b++) {
          if ((b + f) % 3 === 2) continue;
          const x = b * bay + 36;
          const y = f * bay + 30;
          windowGlass(x, y, bay - 72, bay - 64, '#ffffff');
          ctx.fillStyle = '#5d6d4a';
          ctx.fillRect(x - 16, y - 3, 12, bay - 58);
          ctx.fillRect(x + bay - 68, y - 3, 12, bay - 58);
        }
      }
      break;
    }
    case 'industrial': {
      ctx.fillStyle = '#b8bcbf';
      ctx.fillRect(0, 0, S, S);
      for (let x = 0; x < S; x += 16) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(x, 0, 3, S);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(x + 8, 0, 2, S);
      }
      noise(ctx, S, S, rng, 16);
      for (let b = 0; b < 4; b++) {
        ctx.fillStyle = '#39444e';
        ctx.fillRect(b * bay + 20, 40, bay - 40, 30);
        if (rng() < 0.3) {
          ectx.fillStyle = '#ffe6b0';
          ectx.fillRect(b * bay + 20, 40, bay - 40, 30);
        }
      }
      break;
    }
    case 'school': {
      ctx.fillStyle = '#f0c27a';
      ctx.fillRect(0, 0, S, S);
      noise(ctx, S, S, rng, 12);
      for (let f = 0; f < 4; f++) {
        ctx.fillStyle = '#e8e2d6';
        ctx.fillRect(0, f * bay + bay - 14, S, 14);
        for (let b = 0; b < 4; b++) windowGlass(b * bay + 14, f * bay + 24, bay - 28, bay - 58, '#ffffff');
      }
      break;
    }
  }
  return { map: tex(c), emissive: tex(ec) };
}

export function roofTexture(): THREE.CanvasTexture {
  const rng = mulberry32(51);
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#6d6a66';
  ctx.fillRect(0, 0, S, S);
  noise(ctx, S, S, rng, 40);
  return tex(c);
}

export function tileRoofTexture(): THREE.CanvasTexture {
  const rng = mulberry32(61);
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#9c3f25';
  ctx.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 16) {
    for (let x = (y / 16) % 2 ? -12 : 0; x < S; x += 24) {
      const r = 150 + rng() * 50;
      ctx.fillStyle = `rgb(${r},${r * 0.42},${r * 0.26})`;
      ctx.beginPath();
      ctx.ellipse(x + 12, y + 10, 11, 9, 0, 0, Math.PI);
      ctx.fill();
    }
  }
  return tex(c);
}

export function waterTexture(): THREE.CanvasTexture {
  const rng = mulberry32(71);
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#2f5d73';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 300; i++) {
    ctx.strokeStyle = `rgba(200,230,255,${0.05 + rng() * 0.12})`;
    ctx.beginPath();
    const x = rng() * S;
    const y = rng() * S;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 8, y - 3, x + 16, y);
    ctx.stroke();
  }
  return tex(c);
}

/** Radial glow used for lamp light pools and flares. */
export function glowTexture(inner = 'rgba(255,220,160,1)', outer = 'rgba(255,200,120,0)'): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return tex(c, { repeat: false });
}

export type SignKind =
  | 'limit30'
  | 'limit50'
  | 'limit70'
  | 'stop'
  | 'yield'
  | 'crosswalk'
  | 'school'
  | 'noentry'
  | 'oneway'
  | 'parking'
  | 'bus'
  | 'hospital';

export const SIGN_KINDS: SignKind[] = [
  'limit30',
  'limit50',
  'limit70',
  'stop',
  'yield',
  'crosswalk',
  'school',
  'noentry',
  'oneway',
  'parking',
  'bus',
  'hospital',
];

/** Atlas of traffic sign faces (4 × 4 cells of 128 px). Returns UV rect lookup. */
export function signAtlas(): { texture: THREE.CanvasTexture; uv: (k: SignKind) => [number, number, number, number] } {
  const C = 128;
  const N = 4;
  const [c, ctx] = canvas(C * N, C * N);
  ctx.clearRect(0, 0, C * N, C * N);
  const cell = (k: SignKind) => {
    const i = SIGN_KINDS.indexOf(k);
    return [(i % N) * C, Math.floor(i / N) * C] as const;
  };
  const circle = (x: number, y: number, r: number, fill: string, stroke?: string, lw = 0) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  };
  const text = (s: string, x: number, y: number, size: number, color: string) => {
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  };
  for (const k of SIGN_KINDS) {
    const [ox, oy] = cell(k);
    const cx = ox + C / 2;
    const cy = oy + C / 2;
    switch (k) {
      case 'limit30':
      case 'limit50':
      case 'limit70':
        circle(cx, cy, 60, '#ffffff', '#d01f1f', 14);
        text(k.slice(5), cx, cy + 3, 56, '#111');
        break;
      case 'stop': {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 8 + (i * Math.PI) / 4;
          ctx.lineTo(cx + Math.cos(a) * 62, cy + Math.sin(a) * 62);
        }
        ctx.closePath();
        ctx.fillStyle = '#c81e1e';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        text('DUR', cx, cy + 3, 40, '#fff');
        break;
      }
      case 'yield':
        ctx.beginPath();
        ctx.moveTo(cx - 62, cy - 50);
        ctx.lineTo(cx + 62, cy - 50);
        ctx.lineTo(cx, cy + 60);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 12;
        ctx.strokeStyle = '#d01f1f';
        ctx.stroke();
        break;
      case 'crosswalk':
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(ox + 6, oy + 6, C - 12, C - 12);
        ctx.beginPath();
        ctx.moveTo(cx, oy + 16);
        ctx.lineTo(ox + C - 16, oy + C - 18);
        ctx.lineTo(ox + 16, oy + C - 18);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
        // walker
        circle(cx, cy - 8, 7, '#111');
        ctx.fillStyle = '#111';
        ctx.fillRect(cx - 4, cy, 8, 22);
        ctx.fillRect(cx - 14, cy + 28, 28, 4);
        break;
      case 'school':
        ctx.beginPath();
        ctx.moveTo(cx, oy + 8);
        ctx.lineTo(ox + C - 8, oy + C - 14);
        ctx.lineTo(ox + 8, oy + C - 14);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 10;
        ctx.strokeStyle = '#d01f1f';
        ctx.stroke();
        circle(cx - 12, cy + 2, 7, '#111');
        circle(cx + 12, cy + 8, 6, '#111');
        ctx.fillStyle = '#111';
        ctx.fillRect(cx - 17, cy + 10, 10, 24);
        ctx.fillRect(cx + 8, cy + 15, 9, 20);
        break;
      case 'noentry':
        circle(cx, cy, 60, '#d01f1f');
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - 44, cy - 11, 88, 22);
        break;
      case 'oneway':
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(ox + 6, oy + 6, C - 12, C - 12);
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - 9, cy - 20, 18, 60);
        ctx.beginPath();
        ctx.moveTo(cx, oy + 14);
        ctx.lineTo(cx + 30, cy - 18);
        ctx.lineTo(cx - 30, cy - 18);
        ctx.closePath();
        ctx.fill();
        break;
      case 'parking':
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(ox + 6, oy + 6, C - 12, C - 12);
        text('P', cx, cy + 4, 90, '#fff');
        break;
      case 'bus':
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(ox + 6, oy + 6, C - 12, C - 12);
        text('DURAK', cx, cy + 32, 22, '#fff');
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - 28, cy - 36, 56, 44);
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(cx - 22, cy - 30, 44, 18);
        break;
      case 'hospital':
        ctx.fillStyle = '#1d5fbf';
        ctx.fillRect(ox + 6, oy + 6, C - 12, C - 12);
        ctx.fillStyle = '#fff';
        ctx.fillRect(ox + 20, oy + 20, C - 40, C - 40);
        text('H', cx, cy + 4, 72, '#d01f1f');
        break;
    }
  }
  const t = tex(c, { repeat: false });
  return {
    texture: t,
    uv: (k) => {
      const [x, y] = cell(k);
      const S = C * N;
      return [x / S, 1 - (y + C) / S, (x + C) / S, 1 - y / S];
    },
  };
}

export function flagTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 170);
  ctx.fillStyle = '#e30a17';
  ctx.fillRect(0, 0, 256, 170);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(95, 85, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e30a17';
  ctx.beginPath();
  ctx.arc(106, 85, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 9 : 22;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(160 + Math.cos(a) * r, 85 + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  return tex(c, { repeat: false });
}

export function textTexture(
  text: string,
  opts: { w?: number; h?: number; bg?: string; fg?: string; font?: string } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 512;
  const h = opts.h ?? 128;
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = opts.bg ?? '#1d5fbf';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opts.fg ?? '#fff';
  ctx.font = opts.font ?? `bold ${Math.floor(h * 0.55)}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2, w - 20);
  return tex(c, { repeat: false });
}
