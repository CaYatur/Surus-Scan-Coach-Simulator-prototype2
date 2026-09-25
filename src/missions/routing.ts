import { angleDiff } from '../core/math';
import type { Connector, Dir4, Lane, RoadEdge, RoadNetwork, RoadNode, Turn } from '../world/roadNetwork';

export type RouteStep = { edge: RoadEdge; dir: 1 | -1; from: RoadNode; to: RoadNode; turnAtEnd: Turn | 'end' };

export type Route = {
  steps: RouteStep[];
  dest: { x: number; z: number };
  destName: string;
  /** Polyline along lanes & junction curves (flat x,z pairs). */
  line: number[];
  length: number;
};

type State = { node: RoadNode; arm: Dir4 | null };

function laneFor(edge: RoadEdge, dir: 1 | -1): Lane[] {
  return dir === 1 ? edge.lanesFwd : edge.lanesBwd;
}

/** Turn made when leaving `edge` (travelling `dir`) into `next` (travelling `ndir`). */
function turnBetween(edge: RoadEdge, dir: 1 | -1, next: RoadEdge, ndir: 1 | -1): Turn {
  const h1 = dir === 1 ? edge.heading : edge.heading + Math.PI;
  const h2 = ndir === 1 ? next.heading : next.heading + Math.PI;
  const d = angleDiff(h2, h1);
  if (Math.abs(d) < 0.4) return 'S';
  return d > 0 ? 'L' : 'R';
}

/**
 * A* over junctions. States carry the arm we arrived from so U-turns are never planned.
 * Start: the lane the player is on (its end node). Goal: any lane of the destination edge.
 */
export function findRoute(net: RoadNetwork, startLane: Lane, startS: number, destX: number, destZ: number, destName: string): Route | null {
  const goal = net.nearestLane(destX, destZ, undefined, 80);
  if (!goal) return null;
  const goalEdge = goal.lane.edge;
  const goalDir = goal.lane.dir;

  // Destination on the current lane, ahead of us
  if (startLane.edge === goalEdge && startLane.dir === goalDir && goal.s > startS + 5) {
    return build([{ edge: goalEdge, dir: goalDir, from: startLane.startNode, to: startLane.endNode, turnAtEnd: 'end' }], startLane, startS, goal.lane, goal.s, destName);
  }

  const key = (s: State) => `${s.node.id}:${s.arm ?? '-'}`;
  const open: { st: State; g: number; f: number }[] = [];
  const came = new Map<string, { prev: string | null; step: RouteStep | null; st: State }>();
  const gScore = new Map<string, number>();
  const h = (n: RoadNode) => Math.hypot(n.x - destX, n.z - destZ) / 16;
  const start: State = { node: startLane.endNode, arm: startLane.arm };
  const sk = key(start);
  gScore.set(sk, (startLane.path.length - startS) / (startLane.limit / 3.6));
  came.set(sk, { prev: null, step: null, st: start });
  open.push({ st: start, g: gScore.get(sk)!, f: gScore.get(sk)! + h(start.node) });
  let endKey: string | null = null;
  let endStep: RouteStep | null = null;
  let guard = 0;
  while (open.length && guard++ < 20000) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    const ck = key(cur.st);
    if (cur.g > (gScore.get(ck) ?? Infinity) + 1e-6) continue;
    const n = cur.st.node;
    const inLanes = cur.st.arm ? net.incomingLanes(n, cur.st.arm) : [];
    for (const d of ['N', 'E', 'S', 'W'] as Dir4[]) {
      if (d === cur.st.arm) continue;
      const e = n.arms[d];
      if (!e) continue;
      const dir: 1 | -1 = e.a === n ? 1 : -1;
      const lanes = laneFor(e, dir);
      if (!lanes.length) continue;
      // must be reachable from the incoming lanes (turn restrictions)
      if (inLanes.length && !inLanes.some((l) => l.outs.some((c) => c.to.edge === e))) continue;
      const to = dir === 1 ? e.b : e.a;
      let turnCost = 0;
      if (cur.st.arm && inLanes.length) {
        const t = turnBetween(inLanes[0].edge, inLanes[0].dir, e, dir);
        turnCost = t === 'L' ? 9 : t === 'R' ? 4 : 0;
        if (n.signalized) turnCost += 6;
        else if (n.control[cur.st.arm] === 'stop') turnCost += 5;
      }
      const cost = e.length / (e.limit / 3.6) + turnCost;
      const step: RouteStep = { edge: e, dir, from: n, to, turnAtEnd: 'end' };
      if (e === goalEdge && dir === goalDir) {
        // Goal edge reached — A* ordering makes this near-optimal
        endKey = ck;
        endStep = step;
        open.length = 0;
        break;
      }
      const arm = net.armOf(to, e);
      const ns: State = { node: to, arm };
      const nk = key(ns);
      const g = cur.g + cost;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        came.set(nk, { prev: ck, step, st: ns });
        open.push({ st: ns, g, f: g + h(to) });
      }
    }
  }
  if (!endKey || !endStep) return null;
  const steps: RouteStep[] = [endStep];
  let k: string | null = endKey;
  while (k) {
    const c: { prev: string | null; step: RouteStep | null } = came.get(k)!;
    if (c.step) steps.unshift(c.step);
    k = c.prev;
  }
  steps.unshift({ edge: startLane.edge, dir: startLane.dir, from: startLane.startNode, to: startLane.endNode, turnAtEnd: 'end' });
  for (let i = 0; i < steps.length - 1; i++) steps[i].turnAtEnd = turnBetween(steps[i].edge, steps[i].dir, steps[i + 1].edge, steps[i + 1].dir);
  return build(steps, startLane, startS, goal.lane, goal.s, destName);
}

function build(steps: RouteStep[], startLane: Lane, startS: number, goalLane: Lane, goalS: number, destName: string): Route {
  const line: number[] = [];
  const p = { x: 0, z: 0, h: 0 };
  const push = (x: number, z: number) => {
    const n = line.length;
    if (n >= 2 && Math.hypot(line[n - 2] - x, line[n - 1] - z) < 0.5) return;
    line.push(x, z);
  };
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const lanes = laneFor(st.edge, st.dir);
    const t = st.turnAtEnd;
    const lane = i === 0 ? startLane : t === 'L' ? lanes[lanes.length - 1] : lanes[0];
    const s0 = i === 0 ? startS : 0;
    const s1 = i === steps.length - 1 ? goalS : lane.path.length;
    for (let s = s0; s < s1; s += 8) {
      lane.path.sample(s, p);
      push(p.x, p.z);
    }
    lane.path.sample(s1, p);
    push(p.x, p.z);
    if (i < steps.length - 1) {
      const next = steps[i + 1];
      const conn: Connector | undefined = lane.outs.find((c) => c.to.edge === next.edge) ?? laneFor(st.edge, st.dir).flatMap((l) => l.outs).find((c) => c.to.edge === next.edge);
      if (conn) {
        for (let s = 0; s <= conn.path.length; s += 2) {
          conn.path.sample(s, p);
          push(p.x, p.z);
        }
      }
    }
  }
  goalLane.path.sample(goalS, p);
  let length = 0;
  for (let i = 2; i < line.length; i += 2) length += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  return { steps, dest: { x: p.x, z: p.z }, destName, line, length };
}
