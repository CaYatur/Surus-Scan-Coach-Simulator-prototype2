import { el, esc, fmtDate, scoreColor, download } from './dom';
import { lineChart, radarSvg, stars } from './charts';
import { settings, DEFAULT_SETTINGS, CONTROL_PRESETS, PRESET_KEYS, type Settings, type QualityLevel, type ControlPreset } from '../core/settings';
import { BIND_META, actionKeys, bindings, keyLabel, rebind, resetBindings, type BindAction } from '../input/bindings';
import { controlDevice, promptHtml } from '../input/prompts';
import { MISSIONS, missionById } from '../missions/catalog';
import type { MissionDef, MissionCategory } from '../missions/mission';
import { MAPS } from '../world/mapDefs';
import { TIME_LABEL, WEATHER_LABEL, type TimeOfDay, type Weather } from '../world/environment';
import {
  activeProfile,
  activeProfileId,
  BADGES,
  createProfile,
  deleteProfile,
  exportProfiles,
  importProfiles,
  loadProfiles,
  renameProfile,
  selectProfile,
  type Profile,
} from '../coach/profiles';
import { COMPONENTS, COMPONENT_META } from '../coach/types';
import { letterGrade } from '../coach/metrics';
import type { SessionConfig } from '../game/session';
import { Input } from '../input/input';
import type { HeadTracker } from '../input/headTracker';
import { audio } from '../audio/audio';
import { storage } from '../core/storage';
import type { Companion } from '../link/companion';
import { hostBridge } from '../link/hostBridge';
import { displayPairCard, hostPairPanel, linkSettings } from '../link/pairUi';
import { CONDITION_LABEL, clearSummaryLog, experiment, loggedSummaries, summaryCsv, validParticipant, type Condition } from '../coach/experiment';
import type { ReportData } from '../game/session';
import type { ReportActions } from './report';

export interface AppApi {
  startSession(cfg: SessionConfig): void;
  resume(): void;
  finishSegment(): void;
  restartSession(): void;
  quitToMenu(): void;
  startBoardMission(id: string): void;
  qualityChanged(): void;
  inSession(): boolean;
  sessionMapId(): 'training' | 'city' | null;
  bigMap(canvas: HTMLCanvasElement): ((sx: number, sy: number) => boolean) | null;
  clearMapTarget(): void;
  head: HeadTracker;
  detectedQuality: QualityLevel;
  companion: Companion;
  /** Phone/tablet: the main menu offers the companion-display QR. */
  isPhone: boolean;
}

type ScreenName = 'main' | 'free' | 'missions' | 'karne' | 'settings' | 'help' | 'profiles';

const LAST_CFG = 'ssc-last-config';

/** All full-screen menus and in-drive overlays. */
export class Screens {
  readonly root: HTMLElement;
  private app: AppApi;
  private stack: ScreenName[] = [];
  private overlay: HTMLElement;
  private settingsTimer = 0;
  private overlayDispose: (() => void) | null = null;
  onOverlayChange: ((open: boolean) => void) | null = null;

  constructor(host: HTMLElement, app: AppApi) {
    this.app = app;
    this.root = el('div', { id: 'menu-root' });
    this.overlay = el('div', { id: 'overlay-root', class: 'hidden' });
    host.append(this.root, this.overlay);
  }

  // ——————————————————————— navigation ——————————————————————

  show(name: ScreenName, push = true) {
    audio.cue('ui');
    if (push) this.stack.push(name);
    this.root.classList.remove('hidden');
    this.root.innerHTML = '';
    window.clearInterval(this.settingsTimer);
    const page = this.build(name);
    this.root.append(page);
  }

  back() {
    this.stack.pop();
    const prev = this.stack[this.stack.length - 1] ?? 'main';
    if (this.app.inSession() && !this.stack.length) {
      this.hideMenus();
      this.app.resume();
      return;
    }
    this.show(prev, false);
  }

  get menusVisible() {
    return !this.root.classList.contains('hidden');
  }

  /** Redraw the visible menu (e.g. after the link status changed elsewhere). */
  refresh() {
    if (this.menusVisible) this.show(this.stack[this.stack.length - 1] ?? 'main', false);
  }

  hideMenus() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.stack = [];
    window.clearInterval(this.settingsTimer);
  }

  private build(name: ScreenName): HTMLElement {
    switch (name) {
      case 'main':
        return this.mainMenu();
      case 'free':
        return this.freeSetup();
      case 'missions':
        return this.missionsScreen();
      case 'karne':
        return this.karneScreen();
      case 'settings':
        return this.settingsScreen();
      case 'help':
        return this.helpScreen();
      case 'profiles':
        return this.profilesScreen();
    }
  }

  private frame(title: string, content: HTMLElement[], opts: { back?: boolean; wide?: boolean } = {}): HTMLElement {
    const head = el('div', { class: 'scr-head' }, [
      opts.back !== false ? this.btn('← Geri', 'ghost', () => this.back()) : el('span'),
      el('h2', { text: title }),
      this.profileChip(),
    ]);
    return el('div', { class: `screen ${opts.wide ? 'wide' : ''}` }, [head, el('div', { class: 'scr-body' }, content)]);
  }

  private btn(text: string, kind: string, fn: () => void, attrs: Record<string, string> = {}) {
    const b = el('button', { class: `btn ${kind}`, text, ...attrs });
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  }

  private profileChip(): HTMLElement {
    if (experiment.active) {
      // Experiment: anonymous participant code instead of a named profile with its scores
      const ex = experiment.get();
      const chip = el('button', {
        class: 'profile-chip',
        html: `<span class=\"avatar\" style=\"background:#8e44ad\">🧪</span><span><b>${esc(ex.participant)}</b><small>Deney · ${esc(ex.condition === 'kontrol' ? 'Kontrol' : 'Geri bildirim')}</small></span>`,
      });
      chip.onclick = () => {
        this.settingsTab = 'deney';
        this.show('settings');
      };
      return chip;
    }
    const p = activeProfile();
    const chip = el('button', {
      class: 'profile-chip',
      html: p
        ? `<span class=\"avatar\" style=\"background:${p.color}\">${esc(p.name[0]?.toUpperCase() ?? '?')}</span><span><b>${esc(p.name)}</b><small>Karne ${p.karne.overall} · ${letterGrade(p.karne.overall)}</small></span>`
        : '<span class=\"avatar\">?</span><span><b>Misafir</b><small>Profil seç / oluştur</small></span>',
    });
    chip.onclick = () => this.show('profiles');
    return chip;
  }

  // ... (full file continues - the complete version with showSessionDetail is in the local clone at /tmp/scan-coach)
  // Due to size limits in this call, the full content was prepared in /tmp/screens_payload.json
