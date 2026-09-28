import { settings } from '../core/settings';
import { actionKeys, type BindAction } from './bindings';

/** What the on-screen prompts should look like. */
export type ControlDevice = 'keyboard' | 'xbox' | 'playstation' | 'wheel';

let current: ControlDevice = 'keyboard';

export function controlDevice(): ControlDevice {
  return current;
}

export function noteControlDevice(d: ControlDevice) {
  current = d;
}

/** Standard-mapping pads are Xbox-shaped unless the name is a PlayStation controller. */
export function familyFromId(id: string): 'xbox' | 'playstation' {
  const s = id.toLowerCase();
  if (/(054c|sony|dualsense|dualshock|playstation|\bps[345]\b)/.test(s)) return 'playstation';
  if (s.includes('wireless controller') && !s.includes('xbox')) return 'playstation';
  return 'xbox';
}

type Glyph = { text: string; kind: string };

function manual(): boolean {
  return settings.get().transmission === 'manual';
}

/** Button laid out the way the game actually reads a standard gamepad. */
function padGlyph(action: BindAction, ps: boolean): Glyph | null {
  const m = manual();
  const face = (xb: string, play: string, kind: string): Glyph => ({ text: ps ? play : xb, kind });
  switch (action) {
    case 'throttle':
      return { text: ps ? 'R2' : 'RT', kind: 'trig' };
    case 'brake':
      return { text: ps ? 'L2' : 'LT', kind: 'trig' };
    case 'steerLeft':
    case 'steerRight':
      return { text: ps ? 'Sol çubuk' : 'LS', kind: 'stick' };
    case 'handbrake':
      return face('B', '○', 'face-b');
    case 'horn':
      return face('A', '✕', 'face-a');
    case 'signalL':
      return { text: ps ? 'L1' : 'LB', kind: 'bump' };
    case 'signalR':
      return { text: ps ? 'R1' : 'RB', kind: 'bump' };
    case 'hazard':
      return face('X', '□', 'face-x');
    case 'camera':
      return face('Y', '△', 'face-y');
    case 'map':
      return { text: ps ? 'Share' : 'View', kind: 'sys' };
    case 'pause':
      return { text: ps ? 'Options' : 'Menu', kind: 'sys' };
    case 'missions':
      return { text: 'L3', kind: 'stick' };
    case 'cruise':
      return { text: 'R3', kind: 'stick' };
    case 'gearR':
      return { text: '←', kind: 'dpad' };
    case 'lights':
      return m ? null : { text: '↑', kind: 'dpad' };
    case 'reset':
      return m ? null : { text: '↓', kind: 'dpad' };
    case 'gearUp':
      return m ? { text: '↑', kind: 'dpad' } : null;
    case 'gearDown':
      return m ? { text: '↓', kind: 'dpad' } : null;
    case 'gearN':
      return m ? { text: '→', kind: 'dpad' } : null;
    case 'gearD':
      return m ? null : { text: '→', kind: 'dpad' };
    case 'mirrorL':
      return { text: 'RS ←', kind: 'stick' };
    case 'mirrorR':
      return { text: 'RS →', kind: 'stick' };
    case 'mirrorRear':
      return { text: 'RS ↑↓', kind: 'stick' };
    case 'shoulder':
      return { text: 'RS son', kind: 'stick' };
    case 'clutch':
      return null;
    default:
      return null;
  }
}

function wheelGlyph(action: BindAction): Glyph | null {
  switch (action) {
    case 'throttle':
      return { text: 'Gaz', kind: 'pedal' };
    case 'brake':
      return { text: 'Fren', kind: 'pedal' };
    case 'clutch':
      return { text: 'Debriyaj', kind: 'pedal' };
    case 'steerLeft':
    case 'steerRight':
      return { text: 'Direksiyon', kind: 'wheel' };
    default:
      return padGlyph(action, false);
  }
}

function glyph(action: BindAction, device: ControlDevice): { text: string; kind: string; family: string } | null {
  if (device === 'keyboard') return null;
  const g = device === 'wheel' ? wheelGlyph(action) : padGlyph(action, device === 'playstation');
  if (!g) return null;
  const family = device === 'playstation' ? 'ps' : device === 'wheel' ? 'wh' : 'xb';
  return { ...g, family };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Plain label, for toasts and mission text. */
export function promptPlain(action: BindAction, device: ControlDevice = current): string {
  if (device === 'keyboard') return actionKeys(action);
  return glyph(action, device)?.text ?? '—';
}

/** Button-shaped label. Keyboard stays a key cap; a pad uses that pad's face. */
export function promptHtml(action: BindAction, device: ControlDevice = current): string {
  if (device === 'keyboard') {
    const keys = actionKeys(action);
    if (keys === '—') return '—';
    return keys
      .split(' / ')
      .map((k) => `<kbd>${esc(k)}</kbd>`)
      .join(' ');
  }
  const g = glyph(action, device);
  if (!g) return '—';
  return `<kbd class="pad ${g.family} ${g.kind}">${esc(g.text)}</kbd>`;
}

/** Replace `{throttle}` style tokens with the active device's label. */
export function expandPromptText(text: string, device: ControlDevice = current): string {
  return text.replace(/\{([a-zA-Z]\w*)\}/g, (all, name: string) => {
    const plain = promptPlain(name as BindAction, device);
    return plain === '—' ? all : plain;
  });
}
