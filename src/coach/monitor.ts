import { angleDiff } from '../core/math';
import type { GlanceTarget } from '../input/input';
import type { RoadNetwork, RoadQuery, RoadNode, Dir4, Lane } from '../world/roadNetwork';
import type { SignalController } from '../traffic/signals';
import type { AICar } from '../traffic/aiTraffic';
import type { Pedestrian } from '../traffic/pedestrians';
import { ScanTracker } from './scan';
import { EVENT_META, type CoachEvent, type EventKind, type Severity } from './types';

export type MonitorFrame = {
  t: number;
  dt: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  kmh: number;
  accel: number;
  latAccel: number;
  q: RoadQuery;
  cornerSurfaces: string[];
  signal: 'none' | 'left' | 'right';
  lights: boolean;
  night: boolean;
  wet: boolean;
  brake: number;
  throttle: number;
  active: boolean;
  idleSec: number;
  headYaw: number;
  reached: GlanceTarget;
  length: number;
  width: number;
  lead: { gap: number; relSpeed: number } | null;
  peds: Pedestrian[];
  cars: AICar[];
  horn: boolean;
  /** Nearest emergency vehicle with siren (if any). */
  emergency: { id: number; x: number; z: number; heading: number; v: number } | null;
};

export type ZoneStat = { time: number; over: number; maxOver: number; limit: number };

export type ManeuverStats = { total: number; signaled: number; mirror: number; shoulder: number };

export type MonitorStats = {
  distance: number;
  movingTime: number;
  overTime: number;
  overSevereTime: number;
  overIntegral: number;
  wrongWayTime: number;
  sidewalkTime: number;
  offroadTime: number;
  followTime: number;
  headwayBelow2: number;
  headwayBelow1: number;
  minHeadway: number;
  minTTC: number;
  turns: ManeuverStats;
  laneChanges: ManeuverStats;
  stopSigns: { total: number; full: number };
  signalsPassed: number;
  redLights: number;
  junctionScans: { total: number; ok: number };
  pedConflicts: number;
  pedYielded: number;
  reactionTimes: number[];
  collisions: { vehicle: number; static: number; pedestrian: number; hard: number };
  nearMiss: number;
  hardBrake: number;
  hardAccel: number;
  harshCorner: number;
  resets: number;
  reroutes: number;
  nightNoLightsTime: number;
  idleGaps: number;
  signalOnTime: number;
  shoulderTime: number;
  rightOvertakes: number;
  leftLaneHog: number;
  tooSlow: number;
  solidLine: number;
  weaving: number;
  hornViolations: number;
  junctionBlocks: number;
  roundabouts: { total: number; exitSignal: number; yieldFail: number };
  highwayTime: number;
  highwayDistance: number;
  laneKeepSq: number;
  laneKeepN: number;
  zones: Record<string, ZoneStat>;
  emergency: { total: number; yielded: number };
};

function emptyStats(): MonitorStats {
  const m = (): ManeuverStats => ({ total: 0, signaled: 0, mirror: 0, shoulder: 0 });
  return {
    distance: 0,
    movingTime: 0,
    overTime: 0,
    overSevereTime: 0,
    overIntegral: 0,
    wrongWayTime: 0,
    sidewalkTime: 0,
    offroadTime: 0,
    followTime: 0,
    headwayBelow2: 0,
    headwayBelow1: 0,
    minHeadway: Infinity,
    minTTC: Infinity,
    turns: m(),
    laneChanges: m(),
    stopSigns: { total: 0, full: 0 },
    signalsPassed: 0,
    redLights: 0,
    junctionScans: { total: 0, ok: 0 },
    pedConflicts: 0,
    pedYielded: 0,
    reactionTimes: [],
    collisions: { vehicle: 0, static: 0, pedestrian: 0, hard: 0 },
    nearMiss: 0,
    hardBrake: 0,
    hardAccel: 0,
    harshCorner: 0,
    resets: 0,
    reroutes: 0,
    nightNoLightsTime: 0,
    idleGaps: 0,
    signalOnTime: 0,
    shoulderTime: 0,
    rightOvertakes: 0,
    leftLaneHog: 0,
    tooSlow: 0,
    solidLine: 0,
    weaving: 0,
    hornViolations: 0,
    junctionBlocks: 0,
    roundabouts: { total: 0, exitSignal: 0, yieldFail: 0 },
    highwayTime: 0,
    highwayDistance: 0,
    laneKeepSq: 0,
    laneKeepN: 0,
    zones: {},
    emergency: { total: 0, yielded: 0 },
  };
}

/** Sensitive zones get a tighter speed tolerance and stronger feedback. */
const SENSITIVE = new Set(['school', 'hospital', 'market']);

type Approach = {
  node: RoadNode;
  arm: Dir4;
  lane: Lane;
  minKmh: number;
  yellowShouldStop: boolean;
  passed: boolean;
};

type JunctionEntry = {
  node: RoadNode;
  arm: Dir4 | null;
  t: number;
  heading: number;
  laneIndex: number;
  lanesInDir: number;
  signalSide: 'none' | 'left' | 'right';
  signalSince: number;
  mirrorL: boolean;
  mirrorR: boolean;
  rbYieldFail: boolean;
};

/** Lane-keeping state with hysteresis: a lane change is only counted once it is clearly completed. */
type LaneTrack = {
  edge: number;
  dir: number;
  committed: number;
  cand: number;
  candT: number;
  side: 'left' | 'right';
  sig: 'ok' | 'late' | 'none' | 'wrong';
  mirror: boolean;
  shoulder: boolean;
  solid: boolean;
  lead: number;
};

/** Watches the drive every frame and turns it into coaching events + statistics. */
export class DrivingMonitor {
  readonly scan = new ScanTracker();
  events: CoachEvent[] = [];
  stats: MonitorStats = emptyStats();
  onEvent: ((e: CoachEvent) => void) | null = null;
  lastTurn: { side: 'left' | 'right'; t: number; signaled: boolean; mirror: boolean; node: number } | null = null;
  lastLaneChange: { side: 'left' | 'right'; t: number; signaled: boolean; mirror: boolean; shoulder: boolean } | null = null;
  lastStopLine: { t: number; control: string; minKmh: number; node: number } | null = null;
  /** Signal lead times (s) before manoeuvres — part of the style fingerprint. */
  signalLeads: number[] = [];
  private net: RoadNetwork;
  private signals: SignalController | null;
  private cool = new Map<string, number>();
  private t = 0;
  // state
  private lk: LaneTrack | null = null;
  private laneChangeTimes: number[] = [];
  /** When we entered the current edge (lane settling after a junction is not a lane change). */
  private edgeEnterT = -99;
  private signalState: { side: 'none' | 'left' | 'right'; since: number; maneuverDone: boolean; doneT: number; dist0: number; doneDist: number } = { side: 'none', since: 0, maneuverDone: false, doneT: 0, dist0: 0, doneDist: 0 };
  private lastRoadLane = { index: -1, lanes: 1, t: -99 };
  private approach: Approach | null = null;
  private junction: JunctionEntry | null = null;
  private lastQ: RoadQuery | null = null;
  private speeding: { start: number; max: number; active: boolean; below: number } = { start: 0, max: 0, active: false, below: 0 };
  private wrongWayT = 0;
  private hardBrakeT = 0;
  private hardAccelT = 0;
  private cornerT = 0;
  private tailT = 0;
  private straddleT = 0;
  private noLightsT = 0;
  private surfaceT = 0;
  private reaction: { start: number; label: string } | null = null;
  private reactionEndT = -99;
  private yieldedPeds = new Set<number>();
  private conflictPeds = new Set<number>();
  private lastImpactT = -99;
  private recentKmh: { t: number; kmh: number; x: number; z: number }[] = [];
  private shoulderT = 0;
  private hogT = 0;
  private slowT = 0;
  private blockT = 0;
  private lastRightSignalT = -99;
  private relPos = new Map<number, number>();
  private emergencySeen = new Map<number, { t: number; ok: boolean; judged: boolean; closeT: number }>();
  private zoneKey: string | null = null;

  constructor(net: RoadNetwork, signals: SignalController | null) {
    this.net = net;
    this.signals = signals;
  }

  reset() {
    this.events = [];
    this.stats = emptyStats();
    this.scan.reset();
    this.cool.clear();
    this.t = 0;
    this.lk = null;
    this.laneChangeTimes = [];
    this.relPos.clear();
    this.emergencySeen.clear();
    this.shoulderT = this.hogT = this.slowT = this.blockT = 0;
    this.zoneKey = null;
    this.approach = null;
    this.junction = null;
    this.lastQ = null;
    this.speeding = { start: 0, max: 0, active: false, below: 0 };
    this.signalState = { side: 'none', since: 0, maneuverDone: false, doneT: 0, dist0: 0, doneDist: 0 };
    this.reaction = null;
    this.yieldedPeds.clear();
    this.conflictPeds.clear();
    this.recentKmh = [];
    this.lastTurn = null;
    this.lastLaneChange = null;
    this.lastStopLine = null;
    this.signalLeads = [];
  }

  emit(kind: EventKind, x: number, z: number, message?: string, value?: number, severity?: Severity, cooldownKey?: string, cooldown = 0) {
    const key = cooldownKey ?? kind;
    if (cooldown > 0) {
      const last = this.cool.get(key) ?? -999;
      if (this.t - last < cooldown) return;
      this.cool.set(key, this.t);
    }
    const meta = EVENT_META[kind];
    const ev: CoachEvent = {
      kind,
      t: this.t,
      x,
      z,
      severity: severity ?? meta.severity,
      component: meta.component,
      message: message ?? meta.label,
      value,
    };
    this.events.push(ev);
    this.onEvent?.(ev);
  }

  /** Start measuring perception–reaction time (stimulus shown now). */
  startReaction(label: string) {
    this.reaction = { start: this.t, label };
  }

  get reactionPending() {
    return !!this.reaction;
  }

  registerImpact(kind: 'vehicle' | 'static' | 'pedestrian', impactKmh: number, x: number, z: number, hard: boolean) {
    this.lastImpactT = this.t;
    if (kind === 'pedestrian') {
      this.stats.collisions.pedestrian++;
      this.emit('collision_pedestrian', x, z, `Yayaya çarpma (${Math.round(impactKmh)} km/h)`, impactKmh);
      return;
    }
    if (hard) {
      this.stats.collisions.hard++;
      this.emit('hard_crash', x, z, `Ağır kaza — ${Math.round(impactKmh)} km/h`, impactKmh);
    }
    if (kind === 'vehicle') {
      this.stats.collisions.vehicle++;
      this.emit('collision_vehicle', x, z, `Araçla çarpışma (${Math.round(impactKmh)} km/h)`, impactKmh, impactKmh > 20 ? 'critical' : 'major', 'colv', 1.2);
    } else {
      this.stats.collisions.static++;
      this.emit('collision_static', x, z, `Çarpma (${Math.round(impactKmh)} km/h)`, impactKmh, impactKmh > 25 ? 'major' : 'minor', 'cols', 1.5);
    }
  }

  registerReset(x: number, z: number) {
    this.stats.resets++;
    this.emit('reset', x, z);
  }

  registerReroute(x: number, z: number) {
    this.stats.reroutes++;
    this.emit('reroute', x, z, 'Rotadan sapıldı — yeniden hesaplandı', undefined, 'info', 'reroute', 3);
  }

  update(f: MonitorFrame) {
    this.t = f.t;
    const st = this.stats;
    const moving = f.kmh > 3;
    st.distance += Math.abs(f.speed) * f.dt;
    if (moving) st.movingTime += f.dt;
    this.scan.update(f.t, f.dt, f.reached, f.headYaw, f.kmh > 5);
    this.recentKmh.push({ t: f.t, kmh: f.kmh, x: f.x, z: f.z });
    while (this.recentKmh.length && f.t - this.recentKmh[0].t > 12) this.recentKmh.shift();

    if (f.signal === 'right') this.lastRightSignalT = f.t;
    this.trackSignal(f);
    this.trackLanes(f);
    this.trackApproachAndJunction(f);
    this.trackSpeed(f);
    this.trackHighway(f);
    this.trackZoneRules(f);
    this.trackEmergency(f);
    this.trackSurface(f);
    this.trackDynamics(f);
    this.trackFollowing(f);
    this.trackPedestrians(f);
    this.trackAttention(f);
    this.trackReaction(f);
    this.lastQ = f.q;
  }

  // ———————————————————————— signals & lanes ————————————————————————

  private trackSignal(f: MonitorFrame) {
    const s = this.signalState;
    if (f.signal !== s.side) {
      this.signalState = { side: f.signal, since: f.t, maneuverDone: false, doneT: 0, dist0: this.stats.distance, doneDist: 0 };
      return;
    }
    if (s.side !== 'none') {
      this.stats.signalOnTime += f.dt;
      if (s.maneuverDone && !s.doneDist) s.doneDist = this.stats.distance;
      if (s.maneuverDone && f.t - s.doneT > 7 && this.stats.distance - s.doneDist > 60 && f.kmh > 15 && !this.junction) {
        this.emit('signal_left_on', f.x, f.z, 'Sinyal açık kaldı — manevradan sonra kapatın', undefined, undefined, 'sigleft', 30);
      } else if (!s.maneuverDone && f.t - s.since > 25 && this.stats.distance - s.dist0 > 300 && f.kmh > 25) {
        this.emit('signal_left_on', f.x, f.z, 'Sinyal uzun süredir açık', undefined, undefined, 'sigleft', 30);
      }
    }
  }

  private signalFor(side: 'left' | 'right', t: number, minLead: number): 'ok' | 'late' | 'none' | 'wrong' {
    const s = this.signalState;
    if (s.side === side) return t - s.since >= minLead ? 'ok' : 'late';
    if (s.side !== 'none') return 'wrong';
    return 'none';
  }

  private trackLanes(f: MonitorFrame) {
    const q = f.q;
    if (q.kind !== 'road' || !q.edge || q.laneIndex < 0) {
      if (q.kind !== 'parking' && q.kind !== 'shoulder') this.lk = null;
      this.straddleT = 0;
      return;
    }
    const e = q.edge;
    this.lastRoadLane = { index: q.laneIndex, lanes: e.spec.lanes, t: f.t };
    const lanesInDir = e.spec.lanes;
    if (!this.lk || this.lk.edge !== e.id || this.lk.dir !== q.travelDir) {
      if (!this.lk || this.lk.edge !== e.id) this.edgeEnterT = f.t;
      this.lk = { edge: e.id, dir: q.travelDir, committed: q.laneIndex, cand: -1, candT: 0, side: 'left', sig: 'none', mirror: false, shoulder: false, solid: false, lead: -1 };
      return;
    }
    const lk = this.lk;
    const sLane = q.travelDir === 1 ? q.along : e.length - q.along;
    // Settling after entering the edge (choosing a lane after a turn) and entering the next junction
    if (f.t - this.edgeEnterT < 3.5 || sLane < 12 || e.length - sLane < 6 || q.wrongWay || f.kmh < 8) {
      if (lk.cand < 0 || sLane < 12) lk.committed = q.laneIndex;
      lk.cand = -1;
      this.straddleT = 0;
      return;
    }
    const lane = q.lane;
    const offC = lane ? q.lateral - lane.lateral : 0;
    const toLine = lane ? lane.width / 2 - Math.abs(offC) : 1;
    // Straddling a lane line for a long time (multi-lane roads only)
    if (lanesInDir >= 2 && f.kmh > 15 && toLine < 0.32 && f.signal === 'none') {
      this.straddleT += f.dt;
      if (this.straddleT > 4) this.emit('lane_straddle', f.x, f.z, 'İki şerit arasında seyir — şeridinizi seçin', undefined, undefined, 'straddle', 20);
    } else this.straddleT = 0;

    if (q.laneIndex === lk.committed) {
      // back in the original lane: whatever happened was a correction, not a lane change
      lk.cand = -1;
      if (lane && f.kmh > 20) {
        this.stats.laneKeepSq += offC * offC;
        this.stats.laneKeepN++;
      }
      return;
    }
    if (lk.cand !== q.laneIndex) {
      // the car centre just crossed a lane line — snapshot the preparation at this moment
      const side: 'left' | 'right' = q.laneIndex > lk.committed ? 'left' : 'right';
      lk.cand = q.laneIndex;
      lk.candT = f.t;
      lk.side = side;
      lk.sig = this.signalFor(side, f.t, 1.0);
      const mirrorKinds = side === 'left' ? (['mirrorL', 'mirrorRear'] as const) : (['mirrorR', 'mirrorRear'] as const);
      lk.mirror = this.scan.checked([...mirrorKinds], f.t, 6);
      lk.shoulder = this.scan.checked([side === 'left' ? 'shoulderL' : 'shoulderR'], f.t, 6);
      const lanes = e.oneway !== 0 ? (e.oneway === 1 ? e.lanesFwd : e.lanesBwd) : q.travelDir === 1 ? e.lanesFwd : e.lanesBwd;
      const from = lanes[lk.committed];
      lk.solid = !!from && sLane >= from.solidFromS - 1;
      lk.lead = this.signalState.side === side ? f.t - this.signalState.since : -1;
    }
    // Confirm only when the car is clearly established in the new lane
    const held = f.t - lk.candT;
    const depth = toLine; // distance of the car centre from the new lane's nearest line
    const confirmed = Math.abs(q.laneIndex - lk.committed) >= 2 || (held > 0.8 && depth > 0.9) || (held > 2.5 && depth > 0.5);
    if (!confirmed) return;
    lk.committed = q.laneIndex;
    lk.cand = -1;
    this.onLaneChange(f, lk);
  }

  private onLaneChange(f: MonitorFrame, lk: LaneTrack) {
    const side = lk.side;
    const lc = this.stats.laneChanges;
    lc.total++;
    const sig = lk.sig;
    if (sig === 'ok' || sig === 'late') lc.signaled++;
    if (lk.mirror) lc.mirror++;
    if (lk.shoulder) lc.shoulder++;
    const sideTr = side === 'left' ? 'sola' : 'sağa';
    if (lk.solid) {
      this.stats.solidLine++;
      this.emit('solid_line_change', f.x, f.z, 'Kavşak yaklaşımında düz (kesintisiz) çizgiyi geçerek şerit değiştirdiniz');
    }
    if (sig === 'none') this.emit('no_signal_lane', f.x, f.z, `Sinyal vermeden ${sideTr} şerit değiştirdiniz`);
    else if (sig === 'wrong') this.emit('wrong_signal', f.x, f.z, 'Sinyal yönü ile şerit değişimi uyuşmuyor');
    else if (sig === 'late') this.emit('late_signal', f.x, f.z, 'Sinyal çok geç verildi (en az 1–3 sn önce)');
    if (!lk.mirror) this.emit('no_mirror_lane', f.x, f.z, `Şerit değişiminden önce ${side === 'left' ? 'sol' : 'sağ'} ayna kontrolü yok`);
    if (!lk.shoulder) this.emit('no_shoulder_lane', f.x, f.z, 'Kör nokta (omuz) kontrolü yapılmadı');
    if (sig === 'ok' && lk.mirror && !lk.solid) this.emit('msm_good', f.x, f.z, lk.shoulder ? 'Mükemmel: Ayna → Sinyal → Omuz → Manevra' : 'İyi: Ayna → Sinyal → Manevra');
    if (lk.lead >= 0) this.signalLeads.push(lk.lead);
    this.lastLaneChange = { side, t: f.t, signaled: sig === 'ok' || sig === 'late', mirror: lk.mirror, shoulder: lk.shoulder };
    if (this.signalState.side === side) {
      this.signalState.maneuverDone = true;
      this.signalState.doneT = f.t;
    }
    // Weaving: many lane changes in a short time
    this.laneChangeTimes.push(f.t);
    this.laneChangeTimes = this.laneChangeTimes.filter((t) => f.t - t < 25);
    if (this.laneChangeTimes.length >= 3) {
      const before = (this.cool.get('weave') ?? -99) < f.t - 30;
      if (before) this.stats.weaving++;
      this.emit('weaving', f.x, f.z, `Kısa sürede ${this.laneChangeTimes.length} kez şerit değiştirdiniz (zikzak)`, undefined, undefined, 'weave', 30);
    }
  }

  // ———————————————————————— junctions ————————————————————————

  private trackApproachAndJunction(f: MonitorFrame) {
    const q = f.q;
    const st = this.stats;
    // Build / update the approach we are on
    if (q.kind === 'road' || q.kind === 'parking') {
      const e = q.edge!;
      const node = q.travelDir === 1 ? e.b : e.a;
      const arm = this.net.armOf(node, e)!;
      const lanes = this.net.incomingLanes(node, arm);
      if (!q.wrongWay && lanes.length && Math.abs(angleDiff(f.heading, lanes[0].heading)) < 1.0) {
        if (!this.approach || this.approach.node !== node || this.approach.arm !== arm) {
          this.approach = { node, arm, lane: lanes[0], minKmh: f.kmh, yellowShouldStop: false, passed: false };
        }
        const a = this.approach;
        // distance from the front bumper to the stop line (in edge coords)
        const stopEdge = q.travelDir === 1 ? a.lane.stopS : e.length - a.lane.stopS;
        const front = q.along + (q.travelDir === 1 ? f.length / 2 : -f.length / 2);
        const dist = (stopEdge - front) * q.travelDir;
        if (dist < 25 && dist > -1) a.minKmh = Math.min(a.minKmh, f.kmh);
        const ctl = node.control[arm];
        if (ctl === 'signal' && this.signals && !a.passed) {
          const s = this.signals.state(node, arm);
          const v = Math.abs(f.speed);
          if (s === 'yellow' && !a.yellowShouldStop && dist > (v * v) / (2 * 4) + v * 0.8 + 1) a.yellowShouldStop = true;
          if (s === 'green') a.yellowShouldStop = false;
        }
        if (!a.passed && dist <= 0 && dist > -4) {
          a.passed = true;
          this.onStopLine(f, a);
        }
      }
    }
    // Junction entry / exit (highway bends are just road curves)
    if (q.kind === 'junction' && q.node && q.node.kind === 'bend') {
      this.junction = null;
      return;
    }
    if (q.kind === 'junction' && q.node) {
      if (!this.junction || this.junction.node !== q.node) {
        const prev = this.lastQ;
        const arm = prev?.edge ? this.net.armOf(q.node, prev.edge) : null;
        const fresh = f.t - this.lastRoadLane.t < 3;
        const lanesInDir = fresh ? this.lastRoadLane.lanes : 1;
        this.junction = {
          node: q.node,
          arm,
          t: f.t,
          heading: prev?.edge ? (prev.travelDir === 1 ? prev.edge.heading : prev.edge.heading + Math.PI) : f.heading,
          laneIndex: fresh ? this.lastRoadLane.index : -1,
          lanesInDir,
          signalSide: this.signalState.side,
          signalSince: this.signalState.since,
          mirrorL: this.scan.checked(['mirrorL', 'mirrorRear', 'shoulderL'], f.t, 7),
          mirrorR: this.scan.checked(['mirrorR', 'mirrorRear', 'shoulderR'], f.t, 7),
          rbYieldFail: false,
        };
        if (q.node.kind === 'roundabout') this.checkRoundaboutEntry(f, this.junction);
      } else if (q.node.signalized && f.kmh < 2 && this.junction.arm && this.signals && f.signal === 'none' && Math.abs(angleDiff(f.heading, this.junction.heading)) < 0.35) {
        // stuck in the junction box while our own approach is red → blocking the junction
        const st2 = this.signals.state(q.node, this.junction.arm);
        if (st2 === 'red') {
          this.blockT += f.dt;
          if (this.blockT > 4) {
            if ((this.cool.get('jblock') ?? -99) < f.t - 30) this.stats.junctionBlocks++;
            this.emit('junction_block', f.x, f.z, 'Kavşak içinde kaldınız — çıkış boş değilse kavşağa girmeyin', undefined, undefined, 'jblock', 30);
          }
        } else this.blockT = 0;
      } else this.blockT = 0;
    } else if (this.junction && q.edge && (q.kind === 'road' || q.kind === 'parking')) {
      const j = this.junction;
      this.junction = null;
      this.blockT = 0;
      if (!j.arm) return;
      if (j.node.kind === 'roundabout') {
        this.onRoundaboutExit(f, j);
        return;
      }
      // A plain corner (two arms) is the road bending — no turn-signal rule applies
      if (j.node.armCount <= 2) return;
      const exitHeading = q.travelDir === 1 ? q.edge.heading : q.edge.heading + Math.PI;
      const dh = angleDiff(exitHeading, j.heading);
      if (Math.abs(dh) < 0.5 || Math.abs(dh) > 2.6) return; // straight or U-turn
      const side: 'left' | 'right' = dh > 0 ? 'left' : 'right';
      const tn = st.turns;
      tn.total++;
      const sideTr = side === 'left' ? 'Sola' : 'Sağa';
      const signaled = j.signalSide === side && j.t - j.signalSince > 1.5;
      if (j.signalSide === side) tn.signaled++;
      if (j.signalSide === 'none') this.emit('no_signal_turn', f.x, f.z, `${sideTr} dönüşte sinyal verilmedi`);
      else if (j.signalSide !== side) this.emit('wrong_signal', f.x, f.z, `${sideTr} dönüşte ters sinyal`);
      else if (!signaled) this.emit('late_signal', f.x, f.z, 'Dönüş sinyali geç verildi (kavşaktan ~30 m önce verin)');
      const mirror = side === 'left' ? j.mirrorL : j.mirrorR;
      if (mirror) tn.mirror++;
      else this.emit('no_mirror_turn', f.x, f.z, `${sideTr} dönmeden önce ${side === 'left' ? 'sol' : 'sağ'} ayna kontrolü yapılmadı`);
      if (j.lanesInDir >= 2 && j.laneIndex >= 0) {
        const correct = side === 'right' ? j.laneIndex === 0 : j.laneIndex === j.lanesInDir - 1;
        if (!correct) this.emit('wrong_lane_turn', f.x, f.z, `${sideTr} dönüş için ${side === 'right' ? 'en sağ' : 'en sol'} şeridi kullanın`);
      }
      if (j.signalSide === side) {
        this.signalState.maneuverDone = true;
        this.signalState.doneT = f.t;
        this.signalLeads.push(j.t - j.signalSince);
      }
      this.lastTurn = { side, t: f.t, signaled: j.signalSide === side, mirror, node: j.node.id };
      if (signaled && mirror) this.emit('msm_good', f.x, f.z, `${sideTr} dönüş: ayna + sinyal doğru`);
    }
  }

  /** Entering a roundabout: circulating traffic approaching our entry point has priority. */
  private checkRoundaboutEntry(f: MonitorFrame, j: JunctionEntry) {
    const n = j.node;
    const ae = Math.atan2(f.z - n.z, f.x - n.x);
    for (const c of f.cars) {
      if (!c.conn || c.conn.node !== n || c.v < 1) continue;
      const dc = Math.hypot(c.x - n.x, c.z - n.z);
      if (dc > n.ringOuter + 0.5 || dc < n.radius) continue;
      const ac = Math.atan2(c.z - n.z, c.x - n.x);
      let da = ac - ae;
      while (da < 0) da += Math.PI * 2;
      while (da >= Math.PI * 2) da -= Math.PI * 2;
      // circulation decreases the angle: a car at a slightly larger angle is about to reach us
      if (da > 0.05 && da < 1.7 && (da * n.ringR) / c.v < 2.4) {
        j.rbYieldFail = true;
        this.stats.roundabouts.yieldFail++;
        this.emit('rb_yield_fail', f.x, f.z, 'Göbekli kavşakta içerideki (dönen) araca yol vermediniz');
        break;
      }
    }
  }

  private onRoundaboutExit(f: MonitorFrame, j: JunctionEntry) {
    const rb = this.stats.roundabouts;
    rb.total++;
    const signaled = f.t - this.lastRightSignalT < 1.6;
    if (signaled) rb.exitSignal++;
    else this.emit('rb_no_exit_signal', f.x, f.z, 'Göbekli kavşaktan çıkarken sağ sinyal verin');
    if (signaled && !j.rbYieldFail) this.emit('rb_good', f.x, f.z, 'Göbekli kavşak: yol verme ve çıkış sinyali doğru');
    if (this.signalState.side !== 'none') {
      this.signalState.maneuverDone = true;
      this.signalState.doneT = f.t;
    }
  }

  private onStopLine(f: MonitorFrame, a: Approach) {
    const ctl = a.node.control[a.arm] ?? 'none';
    const st = this.stats;
    this.lastStopLine = { t: f.t, control: ctl, minKmh: a.minKmh, node: a.node.id };
    if (ctl === 'signal' && this.signals) {
      st.signalsPassed++;
      const s = this.signals.state(a.node, a.arm);
      if (s === 'red' || s === 'redyellow') {
        st.redLights++;
        this.emit('red_light', f.x, f.z, 'Kırmızı ışıkta geçtiniz!');
      } else if (s === 'yellow' && a.yellowShouldStop) {
        this.emit('yellow_risky', f.x, f.z, 'Sarı ışıkta durabilecekken geçtiniz');
      }
    }
    if (ctl === 'stop') {
      st.stopSigns.total++;
      if (a.minKmh < 3) {
        st.stopSigns.full++;
        this.emit('stop_full', f.x, f.z, 'DUR levhasında tam durdunuz');
      } else if (a.minKmh < 12) this.emit('stop_rolling', f.x, f.z, `DUR levhasında tam durmadınız (en düşük ${Math.round(a.minKmh)} km/h)`);
      else this.emit('stop_ignored', f.x, f.z, `DUR levhasını ${Math.round(a.minKmh)} km/h ile geçtiniz`);
    }
    if (ctl === 'stop' || ctl === 'yield' || ctl === 'none') {
      // Junction side scan before entering (only where cross traffic has to be judged)
      if (ctl !== 'none' || a.node.armCount >= 3) {
        const l = this.scan.sideLooked('left', f.t, 6);
        const r = this.scan.sideLooked('right', f.t, 6);
        if (ctl !== 'none') {
          st.junctionScans.total++;
          if (l || r) {
            st.junctionScans.ok++;
            this.emit('junction_scan_ok', f.x, f.z, 'Kavşağa girmeden önce yanlar kontrol edildi', undefined, undefined, 'jscan', 4);
          } else this.emit('junction_no_scan', f.x, f.z, 'Kavşağa girmeden önce sol/sağ kontrol edilmedi');
        }
      }
    }
    if (ctl === 'stop' || ctl === 'yield') {
      // right of way: priority traffic arriving within ~3 s
      for (const c of f.cars) {
        if (!c.lane || c.lane.endNode !== a.node || c.lane.arm === a.arm) continue;
        const pc = a.node.control[c.lane.arm] ?? 'none';
        if (pc !== 'none') continue;
        const rem = c.lane.path.length - c.s;
        if (c.v > 3 && rem / c.v < 3.2) {
          this.emit('yield_fail', f.x, f.z, 'Ana yoldaki araca yol vermediniz');
          break;
        }
      }
    }
  }

  // ———————————————————————— speed / surface / dynamics ————————————————————————

  private trackSpeed(f: MonitorFrame) {
    const st = this.stats;
    const lim = f.q.limit;
    const zone = f.q.zone;
    const sensitive = !!zone && SENSITIVE.has(zone.kind);
    const tol = sensitive ? 3 : Math.max(6, Math.round(lim * 0.1));
    const over = f.kmh - lim;
    // per-zone bookkeeping (road type when outside special zones)
    const key = zone ? zone.label : f.q.edge ? `${f.q.edge.spec.label} (${lim})` : f.q.node?.kind === 'bend' ? `Çevre yolu virajı (${lim})` : f.q.node?.kind === 'roundabout' ? `Göbekli kavşak (${lim})` : null;
    if (key && f.kmh > 3) {
      const zs = st.zones[key] ?? (st.zones[key] = { time: 0, over: 0, maxOver: 0, limit: lim });
      zs.time += f.dt;
      if (over > tol) zs.over += f.dt;
      zs.maxOver = Math.max(zs.maxOver, over);
    }
    if (over > 0) st.overIntegral += over * f.dt;
    if (over > tol) {
      st.overTime += f.dt;
      if (over > 20) st.overSevereTime += f.dt;
    }
    const sp = this.speeding;
    if (over > tol) {
      if (!sp.active) {
        sp.start = sp.start || f.t;
        if (f.t - sp.start > 1.5) {
          sp.active = true;
          sp.max = over;
        }
      } else sp.max = Math.max(sp.max, over);
      sp.below = 0;
    } else {
      if (!sp.active) sp.start = 0;
      if (sp.active) {
        sp.below += f.dt;
        if (sp.below > 1.0) {
          const sev: Severity = sp.max > 30 ? 'critical' : sp.max > 15 ? 'major' : 'minor';
          const dur = f.t - sp.start;
          if (sensitive && zone) {
            this.emit('zone_speeding', f.x, f.z, `${zone.label}: ${zone.limit} km/h sınırı ${Math.round(sp.max)} km/h aşıldı (${dur.toFixed(0)} sn)`, sp.max, sev === 'minor' ? 'major' : sev);
          } else {
            const where = zone ? `${zone.label.toLocaleLowerCase('tr-TR')} — ` : '';
            this.emit('speeding', f.x, f.z, `${where}hız sınırı (${lim}) ${Math.round(sp.max)} km/h aşıldı (${dur.toFixed(0)} sn)`, sp.max, sev);
          }
          this.speeding = { start: 0, max: 0, active: false, below: 0 };
        }
      }
    }
    // wrong way
    if (f.q.wrongWay && f.kmh > 5) {
      this.wrongWayT += f.dt;
      st.wrongWayTime += f.dt;
      if (this.wrongWayT > 0.8) this.emit('wrong_way', f.x, f.z, 'Ters yöndesiniz! Hemen güvenli şekilde düzeltin', undefined, undefined, 'wrongway', 8);
    } else this.wrongWayT = 0;
    // headlights at night
    if (f.night && !f.lights && f.kmh > 5) {
      this.noLightsT += f.dt;
      st.nightNoLightsTime += f.dt;
      if (this.noLightsT > 5) this.emit('no_headlights', f.x, f.z, 'Karanlıkta farlar kapalı (L)', undefined, undefined, 'lights', 45);
    } else this.noLightsT = 0;
  }

  // ———————————————————————— highway rules ————————————————————————

  private trackHighway(f: MonitorFrame) {
    const st = this.stats;
    const q = f.q;
    const hw = q.edge?.cls === 'highway' || q.node?.kind === 'bend';
    if (hw) {
      st.highwayTime += f.dt;
      st.highwayDistance += Math.abs(f.speed) * f.dt;
    }
    // Emergency lane (paved shoulder) is not a travel lane
    if (q.kind === 'shoulder' && f.kmh > 8) {
      this.shoulderT += f.dt;
      st.shoulderTime += f.dt;
      if (this.shoulderT > 1.5) this.emit('shoulder_drive', f.x, f.z, 'Emniyet şeridinde seyir yasaktır — şeridinize dönün', undefined, undefined, 'shoulder', 15);
    } else this.shoulderT = 0;
    if (!hw || q.kind !== 'road' || !q.edge) {
      this.hogT = 0;
      this.slowT = 0;
      this.relPos.clear();
      return;
    }
    const e = q.edge;
    const fx = Math.sin(f.heading);
    const fz = Math.cos(f.heading);
    const sLane = q.travelDir === 1 ? q.along : e.length - q.along;
    // Relative positions of cars on the same carriageway
    let slowerAheadRight = false;
    const seen = new Set<number>();
    for (const c of f.cars) {
      if (!c.lane || c.lane.edge !== e || c.lane.dir !== q.travelDir) continue;
      const rel = (c.x - f.x) * fx + (c.z - f.z) * fz;
      if (Math.abs(rel) > 160) continue;
      seen.add(c.id);
      if (c.lane.index < q.laneIndex && rel > -5 && rel < 150 && c.v * 3.6 < f.kmh + 5) slowerAheadRight = true;
      const prev = this.relPos.get(c.id);
      this.relPos.set(c.id, rel);
      // we just passed this car: were we on its right side after cutting back to the right?
      if (prev !== undefined && prev > 0 && rel <= 0 && q.laneIndex < c.lane.index && f.kmh > 50 && f.kmh - c.v * 3.6 > 8) {
        const recentRight = this.lastLaneChange && this.lastLaneChange.side === 'right' && f.t - this.lastLaneChange.t < 15;
        if (recentRight) {
          if ((this.cool.get('rovt') ?? -99) < f.t - 20) st.rightOvertakes++;
          this.emit('right_overtake', f.x, f.z, 'Sağdan sollama yaptınız — sollama soldan yapılır', undefined, undefined, 'rovt', 20);
        }
      }
    }
    for (const id of [...this.relPos.keys()]) if (!seen.has(id)) this.relPos.delete(id);
    // Keep right: staying in the leftmost lane without overtaking anyone
    if (e.spec.lanes >= 2 && q.laneIndex === e.spec.lanes - 1 && f.kmh > 50 && !slowerAheadRight) {
      this.hogT += f.dt;
      if (this.hogT > 30) {
        this.hogT = 0;
        st.leftLaneHog++;
        this.emit('left_lane_hog', f.x, f.z, 'Sol şerit sollama içindir — sollamadan sonra sağ şeritlere dönün', undefined, undefined, 'hog', 60);
      }
    } else this.hogT = 0;
    // Driving far below the limit on a free highway obstructs traffic
    const leadClose = f.lead && f.lead.gap < 70;
    if (f.kmh > 2 && f.kmh < 45 && q.limit >= 90 && !leadClose && sLane > 160) {
      this.slowT += f.dt;
      if (this.slowT > 8) {
        this.slowT = 0;
        st.tooSlow++;
        this.emit('too_slow', f.x, f.z, 'Bölünmüş yolda trafiği engelleyecek kadar yavaş gidiyorsunuz', undefined, undefined, 'slow', 40);
      }
    } else this.slowT = 0;
  }

  // ———————————————————————— zones ————————————————————————

  private trackZoneRules(f: MonitorFrame) {
    const zone = f.q.zone;
    this.zoneKey = zone ? zone.label : null;
    if (f.horn && zone?.noHorn) {
      if ((this.cool.get('horn') ?? -99) < f.t - 10) this.stats.hornViolations++;
      this.emit('horn_prohibited', f.x, f.z, `${zone.label}: korna çalmak yasaktır`, undefined, undefined, 'horn', 10);
    }
  }

  /** Current zone label (for HUD). */
  get currentZone() {
    return this.zoneKey;
  }

  // ———————————————————————— emergency vehicles ————————————————————————

  private trackEmergency(f: MonitorFrame) {
    const em = f.emergency;
    if (!em) return;
    const dx = f.x - em.x;
    const dz = f.z - em.z;
    const d = Math.hypot(dx, dz);
    // is the emergency vehicle behind us, travelling the same way?
    const behind = dx * Math.sin(em.heading) + dz * Math.cos(em.heading) > 0;
    const same = Math.abs(angleDiff(em.heading, f.heading)) < 0.6;
    let rec = this.emergencySeen.get(em.id);
    if (!rec) {
      if (d < 60 && behind && same) {
        rec = { t: f.t, ok: false, judged: false, closeT: 0 };
        this.emergencySeen.set(em.id, rec);
      } else return;
    }
    if (rec.judged) return;
    // yielding = pulling over to the right or slowing right down so it can pass
    const lat = -dx * Math.cos(em.heading) + dz * Math.sin(em.heading);
    if ((lat > 1.4 || f.kmh < 12 || f.signal === 'right') && d < 45) rec.ok = true;
    if (behind && same && d < 40) rec.closeT += f.dt;
    const judge = (ok: boolean) => {
      rec!.judged = true;
      this.stats.emergency.total++;
      if (ok) {
        this.stats.emergency.yielded++;
        this.emit('emergency_yield_ok', f.x, f.z, 'Geçiş üstünlüğü olan araca yol verdiniz');
      } else this.emit('emergency_yield_fail', f.x, f.z, 'Sirenli araca yol vermediniz — sağa yanaşıp yavaşlayın');
    };
    if (!behind && same && d < 30) judge(rec.ok || rec.closeT < 8); // it has passed us
    else if (rec.closeT > 14 && !rec.ok) judge(false); // kept it stuck behind us
    else if (!same && d > 25) {
      // we turned off before it reached us — only judge if we had been blocking it
      if (rec.closeT > 10) judge(rec.ok);
      else rec.judged = true;
    }
  }

  private trackSurface(f: MonitorFrame) {
    const st = this.stats;
    const bad = f.cornerSurfaces.find((s) => s === 'sidewalk' || s === 'median') ?? (f.q.kind === 'offroad' ? 'offroad' : null);
    if (bad && f.kmh > 1) {
      this.surfaceT += f.dt;
      if (bad === 'sidewalk' || bad === 'median') st.sidewalkTime += f.dt;
      else st.offroadTime += f.dt;
      if (this.surfaceT > 0.25) {
        if (bad === 'sidewalk') this.emit('sidewalk', f.x, f.z, 'Kaldırıma çıktınız', undefined, undefined, 'surface', 6);
        else if (bad === 'median') this.emit('median', f.x, f.z, 'Refüje çıktınız', undefined, undefined, 'surface', 6);
        else this.emit('offroad', f.x, f.z, 'Yol dışına çıktınız', undefined, undefined, 'surface', 6);
      }
    } else this.surfaceT = 0;
  }

  private trackDynamics(f: MonitorFrame) {
    const st = this.stats;
    const recentImpact = f.t - this.lastImpactT < 0.8;
    if (recentImpact) return;
    // an emergency stop requested by a reaction test is not a smoothness fault
    const inReaction = !!this.reaction || f.t - this.reactionEndT < 4;
    if (f.accel < -4.3 && f.kmh > 5 && !inReaction) {
      this.hardBrakeT += f.dt;
      if (this.hardBrakeT > 0.25 && (this.cool.get('hb') ?? -99) < f.t - 2.5) {
        st.hardBrake++;
        const severe = f.accel < -6.5;
        const mirror = this.scan.checked(['mirrorRear', 'mirrorL', 'mirrorR'], f.t, 5);
        const extra = mirror ? '' : ' — öncesinde dikiz aynası kontrolü yok';
        this.emit('hard_brake', f.x, f.z, `Sert fren (${(-f.accel / 9.81).toFixed(2)} g)${extra}`, -f.accel, severe ? 'major' : 'minor', 'hb', 2.5);
      }
    } else this.hardBrakeT = 0;
    if (f.accel > 3.3 && f.kmh > 8) {
      this.hardAccelT += f.dt;
      if (this.hardAccelT > 0.6) {
        st.hardAccel += (this.cool.get('ha') ?? -99) < f.t - 3 ? 1 : 0;
        this.emit('hard_accel', f.x, f.z, `Sert hızlanma (${(f.accel / 9.81).toFixed(2)} g)`, f.accel, undefined, 'ha', 3);
      }
    } else this.hardAccelT = 0;
    if (Math.abs(f.latAccel) > 4.5 && f.kmh > 15) {
      this.cornerT += f.dt;
      if (this.cornerT > 0.4) {
        st.harshCorner += (this.cool.get('hc') ?? -99) < f.t - 3 ? 1 : 0;
        this.emit('harsh_corner', f.x, f.z, `Virajı hızlı aldınız (${(Math.abs(f.latAccel) / 9.81).toFixed(2)} g yanal)`, Math.abs(f.latAccel), undefined, 'hc', 3);
      }
    } else this.cornerT = 0;
  }

  private trackFollowing(f: MonitorFrame) {
    const st = this.stats;
    const lead = f.lead;
    if (!lead || f.kmh < 15 || lead.gap > 60) {
      this.tailT = 0;
      return;
    }
    const v = Math.abs(f.speed);
    const headway = lead.gap / Math.max(0.1, v);
    st.followTime += f.dt;
    st.minHeadway = Math.min(st.minHeadway, headway);
    if (headway < 2) st.headwayBelow2 += f.dt;
    if (headway < 1) st.headwayBelow1 += f.dt;
    const limit = f.wet ? 2.0 : 1.2;
    if (headway < limit) {
      this.tailT += f.dt;
      if (this.tailT > 3) this.emit('tailgating', f.x, f.z, `Takip mesafesi ${headway.toFixed(1)} sn — en az ${f.wet ? 4 : 2} sn olmalı`, headway, headway < 0.7 ? 'major' : 'minor', 'tail', 12);
    } else this.tailT = 0;
    if (lead.relSpeed > 0.5) {
      const ttc = lead.gap / lead.relSpeed;
      st.minTTC = Math.min(st.minTTC, ttc);
      if (ttc < 1.6) {
        const before = (this.cool.get('ttc') ?? -99) < f.t - 6;
        if (before) st.nearMiss++;
        this.emit('near_miss', f.x, f.z, `Ramak kala! Çarpışmaya ${ttc.toFixed(1)} sn`, ttc, ttc < 0.9 ? 'critical' : 'major', 'ttc', 6);
      }
    }
  }

  private trackPedestrians(f: MonitorFrame) {
    if (!f.peds.length) return;
    const fx = Math.sin(f.heading);
    const fz = Math.cos(f.heading);
    for (const p of f.peds) {
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (along > 0 && along < 16 && Math.abs(lat) < 3) {
        if (f.kmh < 2 && !this.yieldedPeds.has(p.id)) {
          this.yieldedPeds.add(p.id);
          this.stats.pedYielded++;
          this.emit('ped_yielded', f.x, f.z, 'Yayaya yol verdiniz');
        }
      }
      if (along > 0 && along < f.length / 2 + 2.5 && Math.abs(lat) < f.width / 2 + 1.1 && f.kmh > 4 && !this.conflictPeds.has(p.id)) {
        this.conflictPeds.add(p.id);
        this.stats.pedConflicts++;
        this.emit('ped_not_yielded', f.x, f.z, 'Karşıya geçen yayaya yol vermediniz!');
      }
    }
  }

  private trackAttention(f: MonitorFrame) {
    if (f.kmh > 20 && this.scan.secondsSinceAny(f.t) > 28 && f.t > 30) {
      this.emit('mirror_neglect', f.x, f.z, 'Uzun süredir aynalara bakmadınız (5–8 sn\'de bir dikiz)', undefined, undefined, 'neglect', 30);
    }
    if (f.kmh > 10 && f.idleSec > 5) {
      if ((this.cool.get('idle') ?? -99) < f.t - 15) this.stats.idleGaps++;
      this.emit('idle_attention', f.x, f.z, 'Uzun süre kontrollere dokunulmadı (dikkat proxy)', undefined, undefined, 'idle', 15);
    }
  }

  private trackReaction(f: MonitorFrame) {
    const r = this.reaction;
    if (!r) return;
    const dt = f.t - r.start;
    if (f.brake > 0.3) {
      this.stats.reactionTimes.push(dt);
      const verdict = dt < 0.8 ? 'çok iyi' : dt < 1.2 ? 'iyi' : dt < 1.6 ? 'orta' : 'yavaş';
      this.reactionEndT = f.t;
      this.emit('reaction', f.x, f.z, `${r.label}: tepki süresi ${dt.toFixed(2)} sn (${verdict})`, dt, dt < 1.2 ? 'positive' : dt < 1.6 ? 'info' : 'minor');
      this.reaction = null;
    } else if (dt > 4) {
      this.stats.reactionTimes.push(4);
      this.emit('reaction', f.x, f.z, `${r.label}: tepki yok (4 sn+)`, 4, 'major');
      this.reaction = null;
    }
  }

  /** Count of events of a kind. */
  count(kind: EventKind): number {
    let n = 0;
    for (const e of this.events) if (e.kind === kind) n++;
    return n;
  }
}
