import type { Component, Severity, EventKind } from '../coach/types';

/** Messages exchanged between the game (host, usually a PC) and the companion display (phone). */

export type LinkEvent = {
  kind: EventKind;
  label: string;
  severity: Severity;
  component: Component;
  message: string;
  /** Segment time (s). */
  t: number;
  value?: number;
};

export type LinkMission = { icon: string; title: string; subtitle: string; objectives: { title: string; status: string }[] } | null;

export type LinkState = {
  mode: 'menu' | 'loading' | 'driving' | 'paused' | 'report';
  map: string;
  conditions: string;
  profile: string | null;
  mission: LinkMission;
};

export type LinkTelemetry = {
  kmh: number;
  limit: number;
  gear: string;
  signal: 'left' | 'right' | 'hazard' | 'none';
  overall: number | null;
  components: Record<Component, number> | null;
  /** Segment time (s). */
  t: number;
  km: number;
  mirrorRate: number;
};

export type LinkReport = {
  overall: number;
  grade: string;
  components: Record<Component, number>;
  mission: { title: string; success: boolean; stars: number; failReason: string } | null;
  durationSec: number;
  distanceKm: number;
  tips: string[];
  strengths: string[];
  counts: { crash: number; violation: number; warning: number; positive: number };
};

export type HostMsg =
  | { t: 'hello'; name: string }
  | { t: 'snapshot'; state: LinkState; events: LinkEvent[]; tele: LinkTelemetry | null; report: LinkReport | null }
  | { t: 'state'; state: LinkState }
  | { t: 'tele'; tele: LinkTelemetry }
  | { t: 'event'; event: LinkEvent }
  | { t: 'notice'; text: string; kind: 'info' | 'good' | 'warn' | 'bad' }
  | { t: 'segment' }
  | { t: 'report'; report: LinkReport }
  | { t: 'bye' };

export type DisplayMsg = { t: 'hello'; name: string } | { t: 'cmd'; cmd: 'pause' | 'resume' } | { t: 'bye' };

export type Envelope<M> = { from: string; seq: number; hb?: true; m?: M };

export type EventGroup = 'crash' | 'violation' | 'warning' | 'positive' | 'info';

/** Bucket a coaching event for the companion counters and filters. */
export function eventGroup(e: { kind: EventKind; severity: Severity; component: Component }): EventGroup {
  if (e.kind === 'collision_vehicle' || e.kind === 'collision_static' || e.kind === 'collision_pedestrian' || e.kind === 'hard_crash') return 'crash';
  if (e.severity === 'positive') return 'positive';
  if (e.severity === 'info') return 'info';
  if (e.component === 'kural') return 'violation';
  return 'warning';
}
