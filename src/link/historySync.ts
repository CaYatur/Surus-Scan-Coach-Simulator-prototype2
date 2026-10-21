import type { LinkHistory } from './protocol';

export type HistoryRow = LinkHistory['sessions'][number];

const CACHE_KEY = 'ssc-companion-history-v1';

/** Host list wins membership. Details already on the phone are kept when the new packet omits them. */
export function mergeHistory(prev: LinkHistory | null, next: LinkHistory): LinkHistory {
  if (!next.profileId && prev && prev.sessions.length > 0 && next.sessions.length === 0) return prev;
  if (prev?.profileId && next.profileId && prev.profileId !== next.profileId) return next;
  const known = new Map((prev?.sessions ?? []).map((s) => [s.id, s]));
  return {
    ...next,
    sessions: next.sessions.map((s) => ({ ...known.get(s.id), ...s, detail: s.detail ?? known.get(s.id)?.detail })),
  };
}

export function upsertSession(prev: LinkHistory | null, row: HistoryRow): LinkHistory {
  const base: LinkHistory = prev ?? {
    profileId: '',
    karneOverall: row.overall,
    karneGrade: row.grade,
    karneComponents: row.components,
    sessions: [],
  };
  const old = base.sessions.find((s) => s.id === row.id);
  const next = { ...old, ...row, detail: row.detail ?? old?.detail };
  return { ...base, sessions: [next, ...base.sessions.filter((s) => s.id !== row.id)].slice(0, 20) };
}

export function loadHistoryCache(): LinkHistory | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as LinkHistory;
    if (!h || !Array.isArray(h.sessions)) return null;
    return h;
  } catch {
    return null;
  }
}

export function saveHistoryCache(h: LinkHistory | null) {
  try {
    if (!h) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify(h));
  } catch {
    /* quota: the live list still works for this page */
  }
}
