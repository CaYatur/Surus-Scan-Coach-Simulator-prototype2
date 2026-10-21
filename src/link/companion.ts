import { el, esc, scoreColor } from '../ui/dom';
import { storage } from '../core/storage';
import { COMPONENTS, COMPONENT_META, type EventKind } from '../coach/types';
import { DeviceLink, formatCode, linkUrl, newLinkCode, savedLink, type LinkStatus } from './link';
import { deviceName } from './device';
import { qrSvg } from './qr';
import { eventGroup, type DisplayMsg, type EventGroup, type HostMsg, type LinkEvent, type LinkReport, type LinkState, type LinkTelemetry, type LinkHistory } from './protocol';

/**
 * Companion display ("Canlı Koç Ekranı"): a phone paired with the game PC turns into a
 * live second screen for crashes, penalties, warnings, score and mission progress.
 */

const PREFS_KEY = 'ssc-companion-prefs';
type Prefs = { vibrate: boolean; sound: boolean; voice: boolean };

const GROUP_META: Record<EventGroup, { title: string; icon: string; color: string }> = {
  crash: { title: 'Kaza', icon: '💥', color: '#ff4d6d' },
  violation: { title: 'İhlal', icon: '⛔', color: '#ff9f43' },
  warning: { title: 'Uyarı', icon: '⚠️', color: '#f5c542' },
  positive: { title: 'Olumlu', icon: '✓', color: '#4cd07d' },
  info: { title: 'Bilgi', icon: 'ℹ️', color: '#6aa9ff' },
};

// ... (full 780-line file with toggleHistory, renderHistory, historyBox, etc.)
// The complete working version is pushed from local clone
