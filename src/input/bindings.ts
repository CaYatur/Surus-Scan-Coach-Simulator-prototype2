import { settings } from '../core/settings';

/** Everything a key can be bound to. */
export type BindAction =
  | 'throttle'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'handbrake'
  | 'clutch'
  | 'horn'
  | 'signalL'
  | 'signalR'
  | 'hazard'
  | 'lights'
  | 'wipers'
  | 'mirrorL'
  | 'mirrorR'
  | 'mirrorRear'
  | 'shoulder'
  | 'gearP'
  | 'gearR'
  | 'gearN'
  | 'gearD'
  | 'gearUp'
  | 'gearDown'
  | 'gear1'
  | 'gear2'
  | 'gear3'
  | 'gear4'
  | 'gear5'
  | 'gear6'
  | 'cruise'
  | 'cruiseUp'
  | 'cruiseDown'
  | 'camera'
  | 'map'
  | 'missions'
  | 'pause'
  | 'help'
  | 'hud'
  | 'recenter'
  | 'reset';

export type BindGroup = 'Sürüş' | 'Sinyal & ışıklar' | 'Tarama (bakış)' | 'Vites' | 'Hız sabitleyici' | 'Görünüm & menü';

export const BIND_META: { action: BindAction; label: string; group: BindGroup; defaults: string[]; hint?: string }[] = [
  { action: 'throttle', label: 'Gaz', group: 'Sürüş', defaults: ['KeyW', 'ArrowUp'] },
  { action: 'brake', label: 'Fren', group: 'Sürüş', defaults: ['KeyS', 'ArrowDown'], hint: 'Kolay modda durunca basılı tutarsanız geri vitese geçer' },
  { action: 'steerLeft', label: 'Direksiyon sola', group: 'Sürüş', defaults: ['KeyA', 'ArrowLeft'] },
  { action: 'steerRight', label: 'Direksiyon sağa', group: 'Sürüş', defaults: ['KeyD', 'ArrowRight'] },
  { action: 'handbrake', label: 'El freni', group: 'Sürüş', defaults: ['Space'] },
  { action: 'clutch', label: 'Debriyaj', group: 'Sürüş', defaults: ['KeyB'], hint: 'Manuel vites + debriyaj yardımı kapalıyken' },
  { action: 'horn', label: 'Korna', group: 'Sürüş', defaults: ['KeyH'] },
  { action: 'signalL', label: 'Sol sinyal', group: 'Sinyal & ışıklar', defaults: ['KeyQ'] },
  { action: 'signalR', label: 'Sağ sinyal', group: 'Sinyal & ışıklar', defaults: ['KeyE'] },
  { action: 'hazard', label: 'Dörtlü flaşör', group: 'Sinyal & ışıklar', defaults: ['KeyG'] },
  { action: 'lights', label: 'Farlar', group: 'Sinyal & ışıklar', defaults: ['KeyL'] },
  { action: 'wipers', label: 'Silecek', group: 'Sinyal & ışıklar', defaults: ['KeyI'] },
  { action: 'mirrorL', label: 'Sol ayna', group: 'Tarama (bakış)', defaults: ['KeyZ'] },
  { action: 'mirrorRear', label: 'İç dikiz aynası', group: 'Tarama (bakış)', defaults: ['KeyX'] },
  { action: 'mirrorR', label: 'Sağ ayna', group: 'Tarama (bakış)', defaults: ['KeyC'] },
  { action: 'shoulder', label: 'Omuz kontrolü (+ Z / C)', group: 'Tarama (bakış)', defaults: ['ShiftLeft', 'ShiftRight'] },
  { action: 'gearD', label: 'D — Sürüş', group: 'Vites', defaults: ['KeyF'], hint: 'Vites seçici modunda' },
  { action: 'gearR', label: 'R — Geri', group: 'Vites', defaults: ['KeyR'] },
  { action: 'gearN', label: 'N — Boş', group: 'Vites', defaults: ['KeyN'] },
  { action: 'gearP', label: 'P — Park', group: 'Vites', defaults: ['KeyP'] },
  { action: 'gearUp', label: 'Vites yükselt', group: 'Vites', defaults: ['PageUp', 'BracketRight'], hint: 'Manuel şanzıman' },
  { action: 'gearDown', label: 'Vites düşür', group: 'Vites', defaults: ['PageDown', 'BracketLeft'], hint: 'Manuel şanzıman' },
  { action: 'gear1', label: '1. vites', group: 'Vites', defaults: ['Digit1'] },
  { action: 'gear2', label: '2. vites', group: 'Vites', defaults: ['Digit2'] },
  { action: 'gear3', label: '3. vites', group: 'Vites', defaults: ['Digit3'] },
  { action: 'gear4', label: '4. vites', group: 'Vites', defaults: ['Digit4'] },
  { action: 'gear5', label: '5. vites', group: 'Vites', defaults: ['Digit5'] },
  { action: 'gear6', label: '6. vites', group: 'Vites', defaults: ['Digit6'] },
  { action: 'cruise', label: 'Hız sabitleyici aç/kapa', group: 'Hız sabitleyici', defaults: ['KeyK'] },
  { action: 'cruiseUp', label: 'Sabit hız +5', group: 'Hız sabitleyici', defaults: ['Equal', 'NumpadAdd'] },
  { action: 'cruiseDown', label: 'Sabit hız −5', group: 'Hız sabitleyici', defaults: ['Minus', 'NumpadSubtract'] },
  { action: 'camera', label: 'Kamera değiştir', group: 'Görünüm & menü', defaults: ['KeyV'] },
  { action: 'map', label: 'Harita', group: 'Görünüm & menü', defaults: ['KeyM'] },
  { action: 'missions', label: 'Görev panosu', group: 'Görünüm & menü', defaults: ['KeyJ', 'Tab'] },
  { action: 'pause', label: 'Duraklat / menü', group: 'Görünüm & menü', defaults: ['Escape'] },
  { action: 'help', label: 'Yardım', group: 'Görünüm & menü', defaults: ['F1'] },
  { action: 'hud', label: 'HUD modu', group: 'Görünüm & menü', defaults: ['KeyU'] },
  { action: 'recenter', label: 'Kafa takibini merkezle', group: 'Görünüm & menü', defaults: ['KeyO'] },
  { action: 'reset', label: 'Aracı şeride al', group: 'Görünüm & menü', defaults: ['Backspace'] },
];

export const DEFAULT_BINDINGS: Record<BindAction, string[]> = Object.fromEntries(BIND_META.map((m) => [m.action, m.defaults])) as Record<BindAction, string[]>;

let cache: { src: unknown; map: Record<BindAction, string[]>; byCode: Map<string, BindAction[]> } | null = null;

/** Effective bindings (defaults merged with the user's overrides). */
export function bindings(): Record<BindAction, string[]> {
  return resolved().map;
}

/** Actions bound to a key code. */
export function actionsFor(code: string): BindAction[] {
  return resolved().byCode.get(code) ?? [];
}

function resolved() {
  const src = settings.get().keyBindings;
  if (cache && cache.src === src) return cache;
  const map = { ...DEFAULT_BINDINGS };
  for (const [k, v] of Object.entries(src ?? {})) if (k in map && Array.isArray(v)) map[k as BindAction] = v as string[];
  const byCode = new Map<string, BindAction[]>();
  for (const [a, codes] of Object.entries(map) as [BindAction, string[]][]) {
    for (const c of codes) {
      const list = byCode.get(c) ?? [];
      list.push(a);
      byCode.set(c, list);
    }
  }
  cache = { src, map, byCode };
  return cache;
}

/** Replace the keys of one action (the first key of other actions using it is released). */
export function rebind(action: BindAction, code: string, slot = 0) {
  const cur = bindings();
  const next: Record<string, string[]> = { ...(settings.get().keyBindings ?? {}) };
  // a key can only drive one action group: remove it elsewhere
  for (const [a, codes] of Object.entries(cur)) {
    if (a !== action && codes.includes(code)) next[a] = codes.filter((c) => c !== code);
  }
  const mine = [...cur[action]];
  mine[slot] = code;
  next[action] = [...new Set(mine.filter(Boolean))];
  settings.update({ keyBindings: next });
}

export function resetBindings() {
  settings.update({ keyBindings: {} });
}

const PRETTY: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Boşluk',
  ShiftLeft: 'Shift',
  ShiftRight: 'Sağ Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Sağ Ctrl',
  AltLeft: 'Alt',
  Escape: 'Esc',
  Backspace: '⌫ Geri',
  Enter: 'Enter',
  Tab: 'Tab',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  CapsLock: 'Caps',
};

/** Human label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (PRETTY[code]) return PRETTY[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

/** "W / ↑" style label for an action. */
export function actionKeys(action: BindAction): string {
  return bindings()[action].map(keyLabel).join(' / ') || '—';
}
