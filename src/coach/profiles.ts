import { storage } from '../core/storage';
import { clamp } from '../core/math';
import { blendBaseline, emptyBaseline, letterGrade, type SessionResult, type StyleBaseline } from './metrics';
import { COMPONENTS, COMPONENT_META, type Component } from './types';

export type SessionKind = 'calibration' | 'mission' | 'free';

export type SessionSummary = {
  id: string;
  at: number;
  map: string;
  kind: SessionKind;
  missionId?: string;
  missionTitle?: string;
  success?: boolean;
  stars?: number;
  overall: number;
  grade: string;
  components: Record<Component, number>;
  distanceKm: number;
  durationSec: number;
  risk: string;
  conditions: string;
  highlights: string[];
};

export type Profile = {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  baseline: StyleBaseline;
  calibratedAt: number | null;
  karne: {
    overall: number;
    sessions: number;
    components: Record<Component, number>;
    history: { at: number; overall: number; delta: number; session: number }[];
  };
  sessions: SessionSummary[];
  missionBest: Record<string, { stars: number; score: number }>;
  totals: { km: number; minutes: number };
  badges: string[];
};

const KEY = 'ssc-profiles-v1';
const ACTIVE = 'ssc-active-profile';
const COLORS = ['#42a5f5', '#ef5350', '#66bb6a', '#ffa726', '#ab47bc', '#26c6da', '#ec407a', '#8d6e63'];

export const BADGES: Record<string, { icon: string; title: string; desc: string }> = {
  ilk: { icon: '🚗', title: 'İlk Sürüş', desc: 'İlk oturumunu tamamladın.' },
  kalibre: { icon: '🎯', title: 'Kalibre Edildi', desc: 'Kalibrasyon programını bitirdin.' },
  ayna: { icon: '🪞', title: 'Ayna Ustası', desc: 'Bir oturumda manevraların %90+ öncesinde ayna kontrolü.' },
  sinyal: { icon: '↔️', title: 'Sinyal Ustası', desc: 'En az 5 manevranın hepsinde sinyal.' },
  temiz: { icon: '🧼', title: 'Temiz Sicil', desc: '3 km+ ihlalsiz sürüş.' },
  yaya: { icon: '🚸', title: 'Yaya Dostu', desc: 'Bir oturumda 3+ yayaya yol verdin, hiç ihlal yok.' },
  yildiz: { icon: '⭐', title: 'Üç Yıldız', desc: 'Bir görevi 3 yıldızla tamamladın.' },
  gece: { icon: '🌙', title: 'Gece Kuşu', desc: 'Gece sürüşünde 80+ puan.' },
  yagmur: { icon: '🌧️', title: 'Islak Zemin', desc: 'Yağmurda 80+ puan.' },
  km10: { icon: '🛣️', title: '10 km', desc: 'Toplam 10 km sürüş.' },
  km50: { icon: '🏁', title: '50 km', desc: 'Toplam 50 km sürüş.' },
};

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function defaults(): Record<Component, number> {
  return { guvenlik: 70, kural: 70, tarama: 70, puruzsuzluk: 70, gorev: 70 };
}

export function loadProfiles(): Profile[] {
  const list = storage.get<Profile[]>(KEY, []);
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({
    ...p,
    baseline: { ...emptyBaseline(), ...(p.baseline ?? {}) },
    karne: Object.assign({ overall: 70, sessions: 0, components: defaults(), history: [] }, p.karne ?? {}),
    sessions: Array.isArray(p.sessions) ? p.sessions : [],
    missionBest: p.missionBest ?? {},
    totals: p.totals ?? { km: 0, minutes: 0 },
    badges: p.badges ?? [],
  }));
}

function save(list: Profile[]) {
  storage.set(KEY, list);
}

export function activeProfileId(): string | null {
  return storage.get<string | null>(ACTIVE, null);
}

export function activeProfile(): Profile | null {
  const id = activeProfileId();
  return id ? loadProfiles().find((p) => p.id === id) ?? null : null;
}

export function selectProfile(id: string | null) {
  if (id) storage.set(ACTIVE, id);
  else storage.remove(ACTIVE);
}

export function createProfile(name: string): Profile {
  const list = loadProfiles();
  const p: Profile = {
    id: uid(),
    name: name.trim().slice(0, 28) || 'Sürücü',
    color: COLORS[list.length % COLORS.length],
    createdAt: Date.now(),
    baseline: emptyBaseline(),
    calibratedAt: null,
    karne: { overall: 70, sessions: 0, components: defaults(), history: [] },
    sessions: [],
    missionBest: {},
    totals: { km: 0, minutes: 0 },
    badges: [],
  };
  list.push(p);
  save(list);
  selectProfile(p.id);
  return p;
}

export function renameProfile(id: string, name: string) {
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (p) {
    p.name = name.trim().slice(0, 28) || p.name;
    save(list);
  }
}

export function deleteProfile(id: string) {
  save(loadProfiles().filter((p) => p.id !== id));
  if (activeProfileId() === id) selectProfile(null);
}

export function updateProfile(p: Profile) {
  const list = loadProfiles();
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  save(list);
}

export function exportProfiles(): string {
  return JSON.stringify(loadProfiles(), null, 2);
}

export function importProfiles(json: string): number {
  const data = JSON.parse(json) as Profile[];
  if (!Array.isArray(data)) throw new Error('Geçersiz dosya');
  const list = loadProfiles();
  let n = 0;
  for (const p of data) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    n++;
  }
  save(list);
  return n;
}

export type KarneUpdate = { profile: Profile; delta: number; newBadges: string[] };

/** Apply a finished session to the persistent report card (Sürücü Karnesi). */
export function applySession(
  profile: Profile,
  res: SessionResult,
  summary: SessionSummary,
  extra: { mirrorBefore: number | null; maneuvers: number; signalsAll: boolean; pedYielded: number; pedConflicts: number; night: boolean; rain: boolean; calibration: boolean }
): KarneUpdate {
  const p: Profile = JSON.parse(JSON.stringify(profile));
  const k = p.karne;
  for (const c of COMPONENTS) {
    const gap = res.components[c] - k.components[c];
    const a = gap < -12 ? 0.42 : gap > 12 ? 0.36 : 0.3;
    k.components[c] = Math.round(clamp(k.components[c] * (1 - a) + res.components[c] * a, 0, 100));
  }
  const fromCats = Math.round(COMPONENTS.reduce((acc, c) => acc + k.components[c] * COMPONENT_META[c].weight, 0));
  let target = Math.round(res.overall * 0.65 + fromCats * 0.35);
  if (res.risk === 'Kritik') target = Math.min(target, 55);
  const gap = target - k.overall;
  let step = Math.round(gap * 0.4);
  if (Math.abs(gap) < 1.5) step = 0;
  else if (step === 0) step = gap > 0 ? 1 : -1;
  step = clamp(step, -12, 12);
  if (res.confidence < 0.5) step = Math.round(step * (0.5 + res.confidence));
  const prev = k.overall;
  k.overall = clamp(prev + step, 0, 100);
  k.sessions++;
  k.history = [...k.history, { at: summary.at, overall: k.overall, delta: k.overall - prev, session: res.overall }].slice(-40);
  p.sessions = [summary, ...p.sessions].slice(0, 40);
  p.totals.km += res.distanceKm;
  p.totals.minutes += res.durationSec / 60;
  if (summary.missionId && summary.success) {
    const best = p.missionBest[summary.missionId];
    if (!best || (summary.stars ?? 0) > best.stars || res.overall > best.score) {
      p.missionBest[summary.missionId] = { stars: Math.max(best?.stars ?? 0, summary.stars ?? 0), score: Math.max(best?.score ?? 0, res.overall) };
    }
  }
  // Style baseline: only clean sessions with enough data update it (calibration counts double)
  if (res.clean && res.style.ready) {
    p.baseline = blendBaseline(p.baseline, res.style, extra.calibration ? 0.5 : 0.18);
    if (extra.calibration) p.calibratedAt = summary.at;
  }
  const earned: string[] = [];
  const give = (b: string, cond: boolean) => {
    if (cond && !p.badges.includes(b)) {
      p.badges.push(b);
      earned.push(b);
    }
  };
  give('ilk', true);
  give('kalibre', extra.calibration && !!summary.success);
  give('ayna', extra.maneuvers >= 4 && (extra.mirrorBefore ?? 0) >= 90);
  give('sinyal', extra.maneuvers >= 5 && extra.signalsAll);
  give('temiz', res.distanceKm >= 3 && res.risk === 'Düşük' && res.overall >= 85);
  give('yaya', extra.pedYielded >= 3 && extra.pedConflicts === 0);
  give('yildiz', (summary.stars ?? 0) >= 3);
  give('gece', extra.night && res.overall >= 80);
  give('yagmur', extra.rain && res.overall >= 80);
  give('km10', p.totals.km >= 10);
  give('km50', p.totals.km >= 50);
  updateProfile(p);
  return { profile: p, delta: k.overall - prev, newBadges: earned };
}

export { letterGrade };
