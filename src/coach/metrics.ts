import { clamp, mean, percentile, std } from '../core/math';
import type { MonitorStats } from './monitor';
import type { Sample } from './telemetry';
import { COMPONENT_META, COMPONENTS, type CoachEvent, type Component } from './types';

export type SubMetric = {
  id: string;
  component: Component;
  name: string;
  score: number | null;
  value: string;
  detail: string;
  /** One-line coach sentence shown in the category list. */
  tip: string;
  /** Longer advice opened when the metric is selected. */
  advice: string;
  /** Weight inside its component. */
  w: number;
};

/** Diagnostic scores shown in the detailed report. They do not enter the five-axis grade. */
export type InsightId = 'yorgunluk' | 'agresif' | 'odak';

export type Insight = {
  id: InsightId;
  title: string;
  score: number | null;
  color: string;
  tip: string;
  note: string;
  rows: Omit<SubMetric, 'component'>[];
};

export type RiskLevel = 'Düşük' | 'Orta' | 'Yüksek' | 'Kritik';

/** Personal driving style fingerprint (from calibration / clean sessions). */
export type StyleBaseline = {
  ready: boolean;
  sessions: number;
  speedRatio: number;
  accelP90: number;
  decelP90: number;
  latP90: number;
  jerkRms: number;
  srr: number;
  headwayMedian: number;
  reaction: number;
  mirrorRate: number;
  signalLead: number;
};

export function emptyBaseline(): StyleBaseline {
  return { ready: false, sessions: 0, speedRatio: 0, accelP90: 0, decelP90: 0, latP90: 0, jerkRms: 0, srr: 0, headwayMedian: 0, reaction: 0, mirrorRate: 0, signalLead: 0 };
}

export type SessionResult = {
  overall: number;
  grade: string;
  components: Record<Component, number>;
  subs: SubMetric[];
  risk: RiskLevel;
  tips: string[];
  strengths: string[];
  /** Fatigue, aggression and focus readings. Not part of the weighted overall. */
  insights: Insight[];
  style: StyleBaseline;
  styleAdherence: number | null;
  distanceKm: number;
  durationSec: number;
  avgKmh: number;
  maxKmh: number;
  confidence: number;
  caps: string[];
  clean: boolean;
};

export function letterGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  if (score >= 50) return 'E';
  return 'F';
}

const pct = (n: number, d: number) => (d > 0 ? n / d : 1);

/** Steering reversal rate: reversals larger than `gap` (rad of wheel angle) per minute. */
function steeringReversals(samples: Sample[], gap = 0.05): number {
  let n = 0;
  let dir = 0;
  let extreme = samples[0]?.wheelAngle ?? 0;
  for (const s of samples) {
    const a = s.wheelAngle;
    if (dir >= 0) {
      if (a > extreme) extreme = a;
      else if (extreme - a > gap) {
        n++;
        dir = -1;
        extreme = a;
      }
    }
    if (dir < 0) {
      if (a < extreme) extreme = a;
      else if (a - extreme > gap) {
        n++;
        dir = 1;
        extreme = a;
      }
    }
  }
  const moving = samples.filter((s) => s.kmh > 5).length / 10;
  return moving > 10 ? (n / moving) * 60 : 0;
}

export function computeStyle(samples: Sample[], stats: MonitorStats, signalLeads: number[], mirrorRate: number): StyleBaseline {
  const moving = samples.filter((s) => s.kmh > 8);
  const cruise = moving.filter((s) => !s.inJunction && s.limit > 0);
  const acc = moving.map((s) => s.accel);
  const jerks: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].kmh > 3) jerks.push((samples[i].accel - samples[i - 1].accel) * 10);
  const heads = samples.map((s) => s.headway).filter((h): h is number => h != null && h < 6);
  return {
    ready: moving.length > 150,
    sessions: 1,
    speedRatio: cruise.length ? mean(cruise.map((s) => s.kmh / s.limit)) : 0,
    accelP90: acc.length ? Math.max(0, percentile(acc, 90)) : 0,
    decelP90: acc.length ? Math.max(0, -percentile(acc, 10)) : 0,
    latP90: moving.length ? percentile(moving.map((s) => Math.abs(s.latAccel)), 90) : 0,
    jerkRms: jerks.length ? Math.sqrt(mean(jerks.map((j) => j * j))) : 0,
    srr: steeringReversals(samples),
    headwayMedian: heads.length ? percentile(heads, 50) : 0,
    reaction: stats.reactionTimes.length ? mean(stats.reactionTimes) : 0,
    mirrorRate,
    signalLead: signalLeads.length ? mean(signalLeads) : 0,
  };
}

export function blendBaseline(prev: StyleBaseline, obs: StyleBaseline, alpha = 0.25): StyleBaseline {
  if (!prev.ready) return { ...obs, sessions: 1 };
  const b = (a: number, o: number) => (o > 0 ? a * (1 - alpha) + o * alpha : a);
  return {
    ready: true,
    sessions: prev.sessions + 1,
    speedRatio: b(prev.speedRatio, obs.speedRatio),
    accelP90: b(prev.accelP90, obs.accelP90),
    decelP90: b(prev.decelP90, obs.decelP90),
    latP90: b(prev.latP90, obs.latP90),
    jerkRms: b(prev.jerkRms, obs.jerkRms),
    srr: b(prev.srr, obs.srr),
    headwayMedian: b(prev.headwayMedian, obs.headwayMedian),
    reaction: b(prev.reaction, obs.reaction),
    mirrorRate: b(prev.mirrorRate, obs.mirrorRate),
    signalLead: b(prev.signalLead, obs.signalLead),
  };
}

function styleAdherence(base: StyleBaseline, cur: StyleBaseline): number | null {
  if (!base.ready || !cur.ready) return null;
  const rel = (a: number, b: number, scale: number) => clamp(100 - (Math.abs(a - b) / Math.max(scale, Math.abs(b) * 0.5)) * 60, 0, 100);
  const parts = [
    rel(cur.speedRatio, base.speedRatio, 0.1),
    rel(cur.accelP90, base.accelP90, 0.4),
    rel(cur.decelP90, base.decelP90, 0.5),
    rel(cur.latP90, base.latP90, 0.4),
    rel(cur.srr, base.srr, 4),
  ];
  return Math.round(mean(parts));
}

export type ScoreInput = {
  samples: Sample[];
  stats: MonitorStats;
  events: CoachEvent[];
  durationSec: number;
  objectives: { total: number; done: number; failed: number } | null;
  mirrorRate: number;
  maxMirrorGap: number;
  shoulderChecks: number;
  signalLeads: number[];
  baseline: StyleBaseline | null;
  wet: boolean;
  night: boolean;
};

export function computeSession(inp: ScoreInput): SessionResult {
  const { samples, stats: st, events } = inp;
  const km = st.distance / 1000;
  const perKm = (n: number) => n / Math.max(0.4, km);
  const subs: SubMetric[] = [];
  const add = (id: string, component: Component, name: string, score: number | null, value: string, detail: string, w = 1) =>
    subs.push({ id, component, name, score: score == null ? null : Math.round(clamp(score, 0, 100)), value, detail, tip: detail, advice: detail, w });

  const moving = samples.filter((s) => s.kmh > 3);
  const movingTime = Math.max(1, st.movingTime);
  const count = (k: CoachEvent['kind']) => events.filter((e) => e.kind === k).length;

  // ——— Güvenlik ———
  const col = st.collisions;
  add(
    'collisions',
    'guvenlik',
    'Çarpışmalar',
    100 - col.vehicle * 35 - col.static * 12 - col.pedestrian * 100 - col.hard * 40,
    `${col.vehicle} araç · ${col.static} nesne · ${col.pedestrian} yaya`,
    col.vehicle + col.static + col.pedestrian === 0 ? 'Hiç çarpışma yok.' : 'Her çarpışma güvenlik puanını ciddi düşürür.',
    3
  );
  add('near_miss', 'guvenlik', 'Ramak kala (min TTC < 1.6 sn)', 100 - st.nearMiss * 22, `${st.nearMiss} olay · min TTC ${isFinite(st.minTTC) ? st.minTTC.toFixed(1) + ' sn' : '—'}`, 'Öndeki araca çarpma süresi (TTC) kritik eşiğin altına düştüğünde sayılır.', 2);
  const headwayOk = st.followTime > 5 ? 1 - st.headwayBelow2 / st.followTime : 1;
  add(
    'headway',
    'guvenlik',
    'Takip mesafesi (2 sn kuralı)',
    st.followTime > 5 ? headwayOk * 100 - (st.headwayBelow1 / st.followTime) * 40 : null,
    st.followTime > 5 ? `%${Math.round(headwayOk * 100)} güvenli · min ${st.minHeadway.toFixed(1)} sn` : 'araç takibi yok',
    inp.wet ? 'Islak zeminde en az 4 sn takip mesafesi önerilir.' : 'Öndeki araçla en az 2 saniyelik mesafe bırakın.',
    2
  );
  const hardRate = perKm(st.hardBrake * 1 + st.hardAccel * 0.5 + st.harshCorner * 0.8);
  add('hard_events', 'guvenlik', 'Ani manevra oranı', 100 - hardRate * 7, `${st.hardBrake} fren · ${st.hardAccel} gaz · ${st.harshCorner} viraj (${km.toFixed(2)} km)`, 'Olaylar mesafe (km) ile normalize edildi.', 1.2);
  if (st.reactionTimes.length) {
    const r = mean(st.reactionTimes);
    add('reaction', 'guvenlik', 'Tepki süresi', 100 - Math.max(0, r - 0.7) * 70, `${r.toFixed(2)} sn (ort. ${st.reactionTimes.length} ölçüm)`, 'Uyarı ile frene basma arasındaki süre. 1 sn altı iyi kabul edilir.', 1.5);
  }

  // ——— Kural ———
  const overFrac = st.overTime / movingTime;
  add('speed', 'kural', 'Hız sınırı uyumu', 100 - overFrac * 220 - (st.overSevereTime / movingTime) * 200, `%${Math.round((1 - overFrac) * 100)} sınır içinde · ${count('speeding')} ihlal`, 'Bölge hız sınırı + tolerans (okul bölgesi 3 km/h) üzerinden hesaplanır.', 2.5);
  add('red_light', 'kural', 'Trafik ışıkları', st.signalsPassed + st.redLights > 0 ? 100 - st.redLights * 45 - count('yellow_risky') * 12 - count('stopline_over') * 6 : null, `${st.signalsPassed} ışıklı kavşak · ${st.redLights} kırmızı`, 'Kırmızıda geçiş ağır ihlaldir.', 2);
  const ss = st.stopSigns;
  add('stop_sign', 'kural', 'DUR levhası', ss.total ? (ss.full / ss.total) * 100 - count('stop_ignored') * 20 : null, ss.total ? `${ss.full}/${ss.total} tam duruş` : 'DUR levhası yok', 'DUR levhasında tekerlekler tamamen durmalıdır.', 1.5);
  add('right_of_way', 'kural', 'Geçiş hakkı & yaya', 100 - count('yield_fail') * 35 - st.pedConflicts * 40, `${count('yield_fail')} öncelik · ${st.pedConflicts} yaya ihlali · ${st.pedYielded} yol verme`, 'Yaya geçidinde ve ana yol trafiğinde öncelik kuralları.', 2);
  const man = st.turns.total + st.laneChanges.total;
  const sig = st.turns.signaled + st.laneChanges.signaled;
  add('signals', 'kural', 'Sinyal kullanımı', man ? pct(sig, man) * 100 - count('wrong_signal') * 10 : null, man ? `${sig}/${man} manevrada sinyal` : 'manevra yok', 'Dönüş ve şerit değişimlerinden önce sinyal.', 2);
  add('lane_discipline', 'kural', 'Yön & şerit disiplini', 100 - (st.wrongWayTime / movingTime) * 400 - count('wrong_way') * 15 - (st.sidewalkTime / movingTime) * 300 - count('sidewalk') * 10 - count('median') * 12 - count('wrong_lane_turn') * 8 - count('lane_straddle') * 4 - st.solidLine * 15 - st.weaving * 10 - st.junctionBlocks * 8, `ters yön ${st.wrongWayTime.toFixed(1)} sn · kaldırım ${st.sidewalkTime.toFixed(1)} sn`, 'Ters yön, kaldırım/refüj, yanlış şeritten dönüş.', 2);
  // Highway / divided-road rules
  if (st.highwayTime > 20) {
    add(
      'highway',
      'kural',
      'Bölünmüş yol kuralları',
      100 - count('shoulder_drive') * 18 - st.rightOvertakes * 22 - st.leftLaneHog * 10 - st.tooSlow * 8 - (st.shoulderTime / Math.max(1, st.highwayTime)) * 200,
      `${(st.highwayDistance / 1000).toFixed(1)} km · ${st.rightOvertakes} sağdan sollama · ${st.leftLaneHog} sol şerit işgali · emniyet şeridi ${st.shoulderTime.toFixed(0)} sn`,
      'Sağ şeritten gidin, sollamayı soldan yapıp sağa dönün, emniyet şeridini kullanmayın.',
      1.5
    );
  }
  if (st.roundabouts.total) {
    const rb = st.roundabouts;
    add('roundabout', 'kural', 'Dönel kavşak', pct(rb.exitSignal, rb.total) * 100 - rb.yieldFail * 30, `${rb.exitSignal}/${rb.total} çıkışta sinyal · ${rb.yieldFail} yol vermeme`, 'Kavşak içindeki araç önceliklidir; çıkarken sağ sinyal verin.', 1.2);
  }
  const sensitiveTime = Object.entries(st.zones)
    .filter(([k]) => /OKUL|HASTANE|ÇARŞI/.test(k))
    .reduce((a, [, z]) => a + z.time, 0);
  const sensitiveOver = Object.entries(st.zones)
    .filter(([k]) => /OKUL|HASTANE|ÇARŞI/.test(k))
    .reduce((a, [, z]) => a + z.over, 0);
  if (sensitiveTime > 8 || st.hornViolations) {
    add('zone_rules', 'kural', 'Özel bölgeler (okul/hastane/çarşı)', 100 - count('zone_speeding') * 25 - st.hornViolations * 15 - (sensitiveOver / Math.max(1, sensitiveTime)) * 250, `${sensitiveTime.toFixed(0)} sn bölgede · ${count('zone_speeding')} hız · ${st.hornViolations} korna`, 'Okul/hastane çevresinde 30, yaya öncelikli çarşıda 20 km/h; hastane ve okul bölgesinde korna yasak.', 1.5);
  }
  if (st.emergency.total) {
    add('emergency', 'kural', 'Geçiş üstünlüğü (ambulans vb.)', pct(st.emergency.yielded, st.emergency.total) * 100, `${st.emergency.yielded}/${st.emergency.total} yol verildi`, 'Sirenli araç gelince sağa yanaşın ve yavaşlayın.', 1.2);
  }
  if (inp.night) add('lights', 'kural', 'Gece far kullanımı', 100 - (st.nightNoLightsTime / movingTime) * 250, `${st.nightNoLightsTime.toFixed(0)} sn farsız`, 'Karanlıkta kısa farlar açık olmalı.', 1);

  // ——— Tarama ———
  const lcM = st.laneChanges;
  const tnM = st.turns;
  const manM = lcM.total + tnM.total;
  add('mirror_before', 'tarama', 'Manevra öncesi ayna', manM ? pct(lcM.mirror + tnM.mirror, manM) * 100 : null, manM ? `${lcM.mirror + tnM.mirror}/${manM} manevra` : 'manevra yok', 'Şerit değişimi/dönüşten önceki 6 sn içinde ilgili ayna kontrolü.', 2.5);
  add('shoulder', 'tarama', 'Kör nokta (omuz) kontrolü', lcM.total ? pct(lcM.shoulder, lcM.total) * 100 : null, lcM.total ? `${lcM.shoulder}/${lcM.total} şerit değişimi` : 'şerit değişimi yok', 'Şerit değiştirmeden önce omuz üzerinden bakış.', 1.5);
  const rate = inp.mirrorRate;
  add('mirror_rate', 'tarama', 'Ayna kontrol sıklığı', movingTime > 30 ? clamp(rate / 6, 0, 1) * 100 - Math.max(0, inp.maxMirrorGap - 30) * 1.2 : null, `${rate.toFixed(1)} /dk · en uzun ara ${inp.maxMirrorGap.toFixed(0)} sn`, 'Önerilen: her 5–8 sn\'de bir dikiz/yan ayna.', 2);
  const js = st.junctionScans;
  add('junction_scan', 'tarama', 'Kavşak taraması', js.total ? pct(js.ok, js.total) * 100 : null, js.total ? `${js.ok}/${js.total} kavşak` : 'kontrolsüz kavşak yok', 'DUR/Yol ver kavşaklarında girmeden önce sol-sağ kontrol.', 1.5);
  add('attention', 'tarama', 'Dikkat proxy\'si (girdi boşluğu)', 100 - st.idleGaps * 12, `${st.idleGaps} uzun boşluk`, 'Klavye/kol hareketsizliği — klinik dikkat ölçümü değildir.', 0.6);

  // ——— Pürüzsüzlük ———
  const jerks: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].kmh > 3) jerks.push((samples[i].accel - samples[i - 1].accel) * 10);
  const jerkRms = jerks.length ? Math.sqrt(mean(jerks.map((j) => j * j))) : 0;
  add('jerk', 'puruzsuzluk', 'Sarsıntı (jerk RMS)', 100 - Math.max(0, jerkRms - 1.2) * 12, `${jerkRms.toFixed(2)} m/s³`, 'Gaz/fren geçişlerinin yumuşaklığı; düşük daha iyi.', 2);
  const longOk = moving.length ? moving.filter((s) => Math.abs(s.accel) < 2.5).length / moving.length : 1;
  add('long_comfort', 'puruzsuzluk', 'Boylamsal konfor', longOk * 100 - (1 - longOk) * 60, `%${Math.round(longOk * 100)} süre < 0.25 g`, 'Hızlanma/yavaşlama 0.25 g altında konforludur.', 1.5);
  const latOk = moving.length ? moving.filter((s) => Math.abs(s.latAccel) < 2.5).length / moving.length : 1;
  add('lat_comfort', 'puruzsuzluk', 'Yanal konfor', latOk * 100 - (1 - latOk) * 80, `%${Math.round(latOk * 100)} süre < 0.25 g`, 'Virajlarda yanal ivme yolcu konforunu belirler.', 1.5);
  const srr = steeringReversals(samples);
  add('srr', 'puruzsuzluk', 'Direksiyon yön değiştirme oranı (SRR)', srr > 0 ? 100 - Math.max(0, srr - 8) * 3 : null, `${srr.toFixed(1)} /dk`, 'Steering Reversal Rate — sık küçük düzeltmeler düşük dikkati/kararsızlığı gösterebilir.', 1);
  if (st.laneKeepN > 600) {
    const rms = Math.sqrt(st.laneKeepSq / st.laneKeepN);
    add('lane_keeping', 'puruzsuzluk', 'Şerit pozisyonu sapması (RMS)', 100 - Math.max(0, rms - 0.3) * 110, `RMS sapma ${rms.toFixed(2)} m`, 'Aracı şeridin ortasında tutma becerisi (küçük düzeltmeler şerit değişimi sayılmaz).', 1.2);
  }
  const cruise = moving.filter((s) => !s.inJunction && s.kmh > 20);
  const cv = cruise.length > 30 ? std(cruise.map((s) => s.kmh)) / Math.max(1, mean(cruise.map((s) => s.kmh))) : 0;
  add('speed_stability', 'puruzsuzluk', 'Hız istikrarı', cruise.length > 30 ? 100 - Math.max(0, cv - 0.12) * 220 : null, `değişim katsayısı ${(cv * 100).toFixed(0)}%`, 'Düz yolda gereksiz hız dalgalanması.', 1);

  // ——— Görev ———
  if (inp.objectives) {
    const o = inp.objectives;
    add('objectives', 'gorev', 'Görev hedefleri', o.total ? pct(o.done, o.total) * 100 - o.failed * 20 : null, `${o.done}/${o.total} tamamlandı`, 'Seçilen görevin adımları.', 3);
  }
  add('route', 'gorev', 'Rota uyumu', 100 - st.reroutes * 12, `${st.reroutes} sapma`, 'Navigasyon rotasından sapma sayısı.', 1.5);
  add('resets', 'gorev', 'Araç sıfırlama', 100 - st.resets * 25, `${st.resets} sıfırlama`, 'Aracı sıfırlama gerçek sürüşte mümkün değildir.', 1);

  // ——— Components ———
  const components = {} as Record<Component, number>;
  for (const c of COMPONENTS) {
    const list = subs.filter((s) => s.component === c && s.score != null);
    const w = list.reduce((a, s) => a + s.w, 0);
    components[c] = w > 0 ? Math.round(list.reduce((a, s) => a + (s.score as number) * s.w, 0) / w) : 75;
  }
  // Short sessions pull toward neutral 70 (low evidence), except safety-critical outcomes
  const confidence = clamp(Math.min(inp.durationSec / 120, km / 0.8) * 0.7 + 0.3, 0.3, 1);
  for (const c of COMPONENTS) components[c] = Math.round(components[c] * (0.6 + 0.4 * confidence) + 70 * (0.4 - 0.4 * confidence));

  let overall = Math.round(COMPONENTS.reduce((a, c) => a + components[c] * COMPONENT_META[c].weight, 0));
  const caps: string[] = [];
  const cap = (v: number, why: string) => {
    if (overall > v) {
      overall = v;
      caps.push(why);
    }
  };
  if (col.pedestrian > 0) cap(20, 'Yayaya çarpma — puan tavanı 20');
  if (col.hard > 0) cap(40, 'Ağır kaza — puan tavanı 40');
  if (st.redLights > 0) cap(72, 'Kırmızı ışık ihlali — puan tavanı 72');
  if (col.vehicle >= 2) cap(55, 'Birden fazla araç çarpışması — tavan 55');
  if (st.wrongWayTime > 6) cap(60, 'Uzun süre ters yön — tavan 60');

  let risk: RiskLevel = 'Düşük';
  // Risk is about safety and rules — comfort/smoothness events do not raise it
  const riskEvents = events.filter((e) => e.component === 'guvenlik' || e.component === 'kural');
  const critical = riskEvents.filter((e) => e.severity === 'critical').length;
  const major = riskEvents.filter((e) => e.severity === 'major').length;
  if (critical > 0 || col.hard > 0) risk = 'Kritik';
  else if (major >= 3 || components.guvenlik < 55) risk = 'Yüksek';
  else if (major > 0 || components.kural < 70 || overall < 70) risk = 'Orta';

  // ——— Coaching tips (most impactful first) ———
  const tips: string[] = [];
  const weak = subs.filter((s) => s.score != null && (s.score as number) < 75).sort((a, b) => (a.score as number) * 1 - (b.score as number) - (b.w - a.w) * 5);
  const TIP: Record<string, string> = {
    collisions: 'Çarpışmalardan kaçınmak için hızınızı düşürün ve takip mesafesini artırın.',
    near_miss: 'Öndeki aracın fren lambalarını erken fark edin; ayağınızı gazdan erken çekin.',
    headway: 'Öndeki araç bir sabit noktayı geçtiğinde "bin bir, bin iki" sayın — 2 saniyeden önce aynı noktaya varmayın.',
    hard_events: 'Frene ve gaza kademeli basın; trafiği uzaktan okuyarak ani manevralardan kaçının.',
    reaction: 'Bakışınızı yolun 10–15 sn ilerisinde tutun; tehlikeyi erken görmek tepkiyi hızlandırır.',
    speed: 'Hız levhalarını takip edin; okul bölgesinde 30 km/h sınırına özellikle dikkat edin.',
    red_light: 'Sarı ışıkta güvenle durabiliyorsanız durun; kırmızıda kesinlikle geçmeyin.',
    stop_sign: 'DUR levhasında tekerlekler tamamen durana kadar bekleyin, sonra sol-sağ kontrol edip geçin.',
    right_of_way: 'Yaya geçidine yaklaşırken yavaşlayın; yaya adımını attıysa mutlaka durun.',
    signals: 'Her dönüş ve şerit değişiminden en az 3 sn önce sinyal verin (Q / E).',
    lane_discipline: 'Şeridinizin ortasında kalın; tek yönlü yollarda "Girilmez" levhalarına dikkat edin.',
    lights: 'Karanlık ve yağışlı havada farları açın (L).',
    mirror_before: 'Manevradan önce ilgili aynaya bakın (Z sol, C sağ, X iç dikiz) — Ayna → Sinyal → Manevra.',
    shoulder: 'Şerit değiştirmeden önce kör noktayı omuz üzerinden kontrol edin (Shift+Z / Shift+C).',
    mirror_rate: 'Düzenli tarama alışkanlığı: her 5–8 saniyede bir dikiz aynasına kısa bir bakış.',
    junction_scan: 'Kontrolsüz kavşaklarda girmeden önce önce sola, sonra sağa, tekrar sola bakın.',
    attention: 'Sürüş boyunca kontrollerle sürekli etkileşimde kalın; dalgınlıktan kaçının.',
    jerk: 'Pedal geçişlerini yumuşatın: gazı bırakıp fren pedalına yavaşça yük bindirin.',
    long_comfort: 'Duruşları erken başlatın; son metrelerde frene hafifçe basın.',
    lat_comfort: 'Virajdan önce yavaşlayın, viraj içinde sabit gaz tutun.',
    srr: 'Direksiyonu küçük ve sakin düzeltmelerle kullanın; bakışınızı uzağa taşıyın.',
    speed_stability: 'Düz yollarda sabit hız tutmaya çalışın.',
    objectives: 'Görev yönergelerini ve navigasyon talimatlarını takip edin.',
    route: 'Navigasyon talimatını erken okuyun ve dönüş şeridine zamanında geçin.',
    resets: 'Hata sonrası aracı sıfırlamak yerine güvenle geri manevra yapmayı deneyin.',
    highway: 'Bölünmüş yolda sağ şeridi kullanın; sollamayı soldan yapın ve emniyet şeridine girmeyin.',
    roundabout: 'Dönel kavşakta içerideki araca yol verin ve çıkacağınız yoldan önce sağ sinyal verin.',
    zone_rules: 'Okul ve hastane bölgesinde 30, çarşıda 20 km/h sınırına uyun; bu bölgelerde korna çalmayın.',
    emergency: 'Sireni duyduğunuzda aynaya bakın, sağa yanaşın ve geçmesine izin verin.',
    lane_keeping: 'Bakışınızı uzağa, şeridin ortasına yöneltin; direksiyona küçük ve yumuşak düzeltmeler yapın.',
    fat_lane: 'Şerit içinde gezinme artıyorsa mola verin; bakışı uzağa alıp şeridin ortasını hedefleyin.',
    fat_srr: 'Direksiyon düzeltmeleri sıklaştıysa tempo düşün ve 15–20 dakikada bir kısa mola planlayın.',
    fat_speed: 'Hızınız dalgalanıyorsa seyir kontrolünü erken kurun; yorgunlukta gaz ayağı kararsızlaşır.',
    fat_reaction: 'Tepki uzadıysa takip mesafesini açın ve sürüşü bölün; 1 saniyenin üstü gecikme işaretidir.',
    fat_scan: 'Ayna araları uzadıysa her 5–8 saniyede bir kısa dikiz bakışıyla ritmi geri kurun.',
    fat_idle: 'Eller ve pedallar uzun süre susuyorsa dikkat dağılmıştır; oturuşu ve bakışı yenileyin.',
    fat_time: 'Uzun süre aralıksız sürmeyin. 2 saat dolmadan, tercihen 90 dakikada bir mola verin.',
    agg_speed: 'Sınırın üstünde gitmek en sık agresif davranış. Levha değişince gazı hemen bırakın.',
    agg_harsh: 'Sert gaz, fren ve virajı azaltın: trafiği erken okuyup kademeli pedal kullanın.',
    agg_tail: 'Öndeki araca yapışmayın. 2 saniye kuralı agresif takibin panzehiridir.',
    agg_weave: 'Şerit değişimini seyrek ve sinyalli yapın; zikzak hem kural hem risk puanını düşürür.',
    agg_miss: 'Ramak kala olayında hızı kesin ve mesafeyi açın; TTC 2 saniyenin altına inmesin.',
    agg_hostility: 'Kırmızı, korna ve yol vermeme “acele”nin değil ihlalin işaretidir. Bir ışık bekleyin.',
    foc_mirror: 'Odak, yola kilitlenmek değildir. Her 5–8 saniyede bir aynayı tarayın.',
    foc_gap: 'Uzun bakışsız aralar zihnin yoldan koptuğunu gösterir. Arayı 15 saniyenin altında tutun.',
    foc_junction: 'Kavşakta sol-sağ-sol bakmadan girmeyin; bu, odağın dışarıda olduğunu kanıtlar.',
    foc_before: 'Her manevradan önce ilgili aynaya bakın. Bakmadan yapılan iş, odak kaçırır.',
    foc_reaction: 'Tehlikeyi geç görmek odağın daraldığını gösterir. Bakışı 10–15 sn ileriye taşıyın.',
    foc_idle: 'Kontrollere uzun süre dokunmamak dalgınlıktır. Oturuşu ve pedal temasını tazeleyin.',
    foc_shoulder: 'Şerit değiştirmeden önce kör noktaya bakın; omuz kontrolü aktif dikkatin parçasıdır.',
    foc_lane: 'Şerit ortasından kaymak, bakışın içeri döndüğünün araçtaki karşılığıdır.',
  };
  const ADVICE: Record<string, string> = {
    collisions: 'Çarpışma puanı, araç, nesne ve yaya temaslarını ayrı ayrı sayar; yaya teması tek başına puanı tabana çeker. Bir sonraki sürüşte hızı görüş mesafenize göre seçin ve öndeki aracı “bin bir, bin iki” ile takip edin. Dar sokakta aynayı ve omzu manevradan önce kullanın; çarpmadan kaçınmak fren gücünden çok erken fark etmektir.',
    near_miss: 'TTC, öndeki araca mevcut hız farkıyla kaç saniyede çarpacağınızı söyler. 1,6 saniyenin altı “ramak kala” sayılır. Fren lambasını görür görmez gazı bırakın, mesafeyi 2 saniyenin üstüne çıkarın. Yağmurda eşiği daha erken, en az 4 saniye mesafe olarak düşünün.',
    headway: 'Takip puanı, bir aracı izlediğiniz sürenin ne kadarında 2 saniyenin üstünde kaldığınızı ölçer; 1 saniyenin altı ayrıca cezalandırılır. Öndeki araç bir direği geçince “bin bir, bin iki” deyin, siz o direğe daha erken varmayın. Islak zeminde aynı sayımı dörde çıkarın.',
    hard_events: 'Sert fren, sert gaz ve sert viraj kilometreye bölünür; kısa yolda tek bir panik freni puanı olduğundan fazla düşürmesin diye. Trafiği 10–15 saniye ileriden okuyun, duracağınız yeri erken seçin ve pedala kademeli yük bindirin. Viraja girmeden yavaşlayın, virajın içinde frene asılmayın.',
    reaction: 'Tepki süresi, uyarı ile frene gidiş arasındaki zamandır. 0,7–1,0 sn iyi bir aralıktır; 1,2 sn üstü gecikme sayılır. Bakışı kaputun hemen önünden kaldırıp yolun ilerisine taşıyın. Yorgunsanız mesafe açmak, refleks beklemekten daha güvenlidir.',
    speed: 'Puan, hareket sürenizin ne kadarında toleranslı sınırın içinde kaldığınıza bakar. Okul, hastane ve çarşıda tolerans yalnızca 3 km/h’tır. Levha veya bölge değişince gazı hemen bırakın; “biraz üstü” bu ölçümde birikimli süre olarak yazılır.',
    red_light: 'Kırmızıda geçiş ağır ihlaldir ve toplam nota tavan koyar. Sarı yandığında durma mesafeniz yetiyorsa durun; yetmiyorsa ve çizgiyi güvenle geçemeyecekseniz de durmayı seçin. Işığı kavşağa 50–80 m kala okumaya başlayın.',
    stop_sign: 'DUR levhasında tekerlekler tam olarak durmalıdır; yavaşlayıp akmak “tam duruş” sayılmaz. Durun, sola bakın, sağa bakın, tekrar sola bakın, sonra kalkın. Eğimli yerde durduktan sonra geri kaymamak için freni kalkışa kadar tutun.',
    right_of_way: 'Geçiş hakkı hem ana yol aracına hem de yaya geçidine bakar. Yaya adımını attıysa veya geçide yaklaşıyorsa durun. Ana yola çıkarken boşluk 2 saniyeden kısaysa bekleyin; “sıkışırsam frenler” diye girmeyin.',
    signals: 'Dönüş ve şerit değişimlerinin kaçında sinyal yandığını ölçer. Sinyali en az 3 saniye önce, manevra bitince kapatın. Yanlış yöne sinyal, hiç sinyal vermemekten ayrıca puan kırar.',
    lane_discipline: 'Ters yön süresi, kaldırım, refüj, yanlış şeritten dönüş, şerit çizgisinde seyir ve düz çizgide şerit değiştirme burada toplanır. Şeridin ortasını hedefleyin, tek yön levhasını kavşaktan önce okuyun. Düz çizgi kesiksizse şerit değiştirmeyin.',
    lights: 'Gece ve görüşün düştüğü yağışta far kapalı geçen süre puanı düşürür. Alacakaranlıkta da kısa far açın (L). Karşıdan gelen varsa uzun fara geçmeyin.',
    mirror_before: 'Şerit değişimi ve dönüşten önceki 6 saniyede ilgili aynaya bakılıp bakılmadığına bakar. Sıra sabittir: ayna, sinyal, manevra. Sol için Z, sağ için C, iç dikiz için X.',
    shoulder: 'Ayna kör noktayı göstermez. Şerit değiştirmeden hemen önce omzunuzun üstünden (Shift+Z / Shift+C) bakın. Bakış kısa olsun; başı yolda tutun.',
    mirror_rate: 'Hareket halinde dakikadaki ayna bakışı ve en uzun bakışsız ara birlikte değerlendirilir. Hedef her 5–8 saniyede bir kısa dikiz bakışıdır. 30 saniyeyi geçen ara, ritmin koptuğunu gösterir.',
    junction_scan: 'DUR ve yol ver kavşaklarında girmeden önce sol-sağ bakışı sayılır. Sıra: sola, sağa, tekrar sola. Taramadan kalkış, “yol boştur” varsayımıdır.',
    attention: 'Uzun süre direksiyon, gaz veya frende anlamlı hareket olmaması bir dikkat vekilidir; göz takibi değildir. Ara uzarsa oturuşu değiştirin, aynaya bakın, hızı bilinçli sabitleyin.',
    jerk: 'Jerk, ivmenin ne kadar ani değiştiğidir. Düşük RMS, gazdan frene yumuşak geçiş demektir. Ayağınızı gazdan erken çekin, frene bir anda değil kademeyle basın, duruşun sonunda pedalı biraz bırakın.',
    long_comfort: 'Hızlanma ve yavaşlamanın 0,25 g (yaklaşık 2,5 m/s²) altında kaldığı süreyi ölçer. Duruşu erken başlatın. Kalkışta gazı sonuna kadar değil, araç akana kadar açın.',
    lat_comfort: 'Virajda 0,25 g üstü yanal ivme yolcuyu yatırır ve lastik payını yer. Virajdan önce yavaşlayın, içinde sabit ve hafif gaz tutun. Direksiyonu tek harekette sonuna kadar kırmayın.',
    srr: 'Direksiyon yön değiştirme oranı, dakikada kaç kez belirgin yön değiştirdiğinizdir. Çok yüksek oran kararsız düzeltme veya yorgunluk belirtisi olabilir. Bakışı uzağa alın; küçük, yavaş düzeltmeler yeter.',
    speed_stability: 'Kavşak dışında, 20 km/h üstündeki hızın değişkenlik katsayısıdır. Düz yolda gereksiz gaz-fren dalgası hem konforu hem odağı bozar. Bir hedef hız seçip onu koruyun.',
    objectives: 'Seçilen görevin adımlarının kaçı bittiğine bakar. Başarısız adım ayrıca kırar. Yönergeyi sürüşten önce okuyun; navigasyon okuyla görevin istediği noktayı karıştırmayın.',
    route: 'Navigasyon rotasından her sapma yeniden hesaplatır. Dönüşten 150 m önce talimatı okuyun ve doğru şeride erken geçin. Son anda kesişen dönüş hem rota hem sinyal puanını bozar.',
    resets: 'Aracı sıfırlamak simülasyonda bir kurtarma tuşudur; gerçekte yoktur. Hata yaptıysanız durun, aynayı kontrol edin ve küçük bir geri manevrayla düzeltin.',
    highway: 'Bölünmüş yolda sağ şerit esastır, sollama soldan yapılır ve bitince sağa dönülür. Emniyet şeridi seyir şeridi değildir. Sol şeritte araç yokken oturmak da puan kırar.',
    roundabout: 'Ada içindeki araç önceliklidir. Girerken yol verin, çıkacağınız kolu görür görmez sağ sinyal verin. Sinyalsiz çıkış, arkadan gelenin sizi yanlış okumasına yol açar.',
    zone_rules: 'Okul ve hastane çevresi 30, yaya öncelikli çarşı 20 km/h’tır; bu iki bölgede korna da yasaktır. Tabela değişince hızı hemen düşürün, korna yerine fren ve mesafe kullanın.',
    emergency: 'Sirenli aracı duyunca önce aynaya bakın, sonra sağa yanaşıp yavaşlayın. Orta şeritte devam etmek “yol verdim” sayılmaz. Araç geçene kadar şeridinize dönmeyin.',
    lane_keeping: 'Şerit ortasına göre yanal sapmanın RMS değeridir. 0,3 m civarı sakin bir tutuştur; 0,8 m üstü belirgin gezinmedir. Bakışı şeridin uzağına koyun, çizgiye değil ortaya hizalayın.',
    fat_lane: 'Yorgunluk literatüründe şerit konumu sapması (SDLP) en çok kullanılan araç göstergesidir; NHTSA’nın uykululuk çalışması yaklaşık 1 m üstünü belirti sayar. Bu puan, şerit ortasına göre RMS sapmanızdan gelir. Sapma büyüyorsa hızı düşürün ve mola verin. Göz kapağı ölçümü olmadığı için bu, yorgunluğun kendisi değil belirtisidir.',
    fat_srr: 'Direksiyon yön değiştirme oranı, uykululukla birlikte artan büyük düzeltmeleri yakalar (saha çalışmalarında yaklaşık 6° eşiği en duyarlı bulunan aralıktadır; burada yaklaşık 3° üstü dönüşler sayılır). Sık düzeltme, şeridi geç fark ettiğinizi gösterir. Düz yolda oran yükseliyorsa bakışı uzağa alın ve sürüşü bölün.',
    fat_speed: 'Hızın standart sapması, alkol ve yorgunluk çalışmalarında şerit sapmasıyla birlikte bozulan ikinci uzun vadeli ölçüdür. Kavşak dışı seyirde hızınız bir inip bir çıkıyorsa gaz ayağı artık otomatik değildir. Bir seyir hızı seçin; tutamıyorsanız mola zamanı gelmiştir.',
    fat_reaction: 'Uykululuk ve zihin dağınıklığı, ani olaya gidiş süresini uzatır. 0,9 saniyenin üstü bu ölçekte kırılmaya başlar. Tek bir yavaş tepki yorgunluk teşhisi değildir; mesafe açmak ve süreyi kısaltmak ise her zaman işe yarar.',
    fat_scan: 'Yorulunca bakış yolun ortasına daralır, ayna taraması seyrekleşir. Dakikadaki ayna sayısı ve en uzun bakışsız ara bu daralmayı vekil olarak okur. Ritmi 5–8 saniyede bir kısa bakışa geri çekin. Bu bir göz izleyici değildir.',
    fat_idle: 'Uzun girdi boşluğu, ellerin ve ayakların sürüşü bırakıp “akışa” geçtiği anları sayar. Düz yolda bir miktar sükunet normaldir; üst üste boşluklar ise uyanıklığın düştüğünü düşündürür. Boşluk hissedince aynaya bakın ve oturuşu değiştirin.',
    fat_time: 'Süre tek başına yorgunluk değildir; zaman-görev etkisi ancak diğer belirtilerle birlikte anlam kazanır ve bu yüzden düşük ağırlıklıdır. Yaklaşık 15 dakikadan sonra puan yavaşça kırılır. 90 dakika dolmadan mola vermek, puanı kovalamaktan daha doğru bir kuraldır.',
    agg_speed: 'NHTSA hızı ölümlü kazalardaki en büyük agresif davranış olarak sayar. Bu ölçüm, toleransın üstünde geçen süreye ve aşırı aşımın payına bakar. Levha düşünce gazı aynı anda bırakın. “Akışa uydum” gerekçesi süreyi silmez.',
    agg_harsh: 'Telematik skorları sert gaz, sert fren ve sert virajı kilometreye böler; çünkü agresiflik bir olayın şiddeti kadar sıkılığıdır. Öndeki trafiği erken okuyup pedalı kademeli kullanın. Virajı frenle değil, girmeden önceki hızla çözer.',
    agg_tail: 'AAA ve OSHA yakın takibi temel agresif davranış sayar; sigorta verisinde sert fren de çoğu zaman bunun gölgesidir. 1 saniyenin altındaki takip ayrıca ağır kırılır. “Bin bir, bin iki” bitmeden öndeki aracın geçtiği noktaya varmayın.',
    agg_weave: 'Şeritler arasında sık geçiş ve zikzak, NHTSA’nın “tehlikeli şekilde araç kullanma” tanımına girer. Her değişim sinyalli, aynalı ve gerekli olsun. Kilometrede dörtten fazla şerit değişimi bu ölçekte “acele” olarak okunur.',
    agg_miss: 'Düşük çarpma süresi, agresif mesafenin sonucudur. 1,6 saniye altı ramak kala sayılır; 2 saniyenin altı da puanı törpüler. Olaydan sonra hızı kesin, mesafeyi açın ve bir sonraki araca aynı hatayla yapışmayın.',
    agg_hostility: 'Kırmızı ışık, yol vermeme, yasak yerde korna ve sağdan sollama, aceleciliğin kurallara çarptığı yerdir. Bunlar güvenlik ekseninde de durur; burada özellikle “diğer yol kullanıcısına yüklenen” davranış olarak okunur. Bir ışık veya bir korna, varış süresini değiştirmez.',
    foc_mirror: 'Zihin dağınıklığında bakış yolun merkezine daralır ve ayna taraması düşer (He ve arkadaşları). Dakikada yaklaşık altı kısa bakış, bu simülasyondaki hedef ritmdir. Ayna, düşünceyi yola geri çağıran en kolay çapadır.',
    foc_gap: 'En uzun bakışsız ara, odağın koptuğu en kötü pencereyi gösterir. 15 saniyeden sonra puan kırılır; 30 saniye ciddi bir boşluktur. Ara uzadığında iç dikize bir bakış yeter, başı yoldan çevirmeyin.',
    foc_junction: 'Kavşak taraması, dikkatin dış dünyaya dönük olduğunu gösteren aktif bir iştir. Sol-sağ-sol bakmadan girilen her DUR veya yol ver, “gördüm sandım” hatalarının kaynağıdır. Durunca taramayı bitirmeden kalkmayın.',
    foc_before: 'Manevra öncesi ayna, odağın niyetle birlikte hareket edip etmediğini ölçer. Şerit veya dönüşten önceki 6 saniyede bakılmadıysa o iş otomatik yapılmıştır. Sırayı sesli kurun: ayna, sinyal, manevra.',
    foc_reaction: 'Zihin dağınıklığı ani olaya gecikmeli gider (Yanko ve Spalek). 0,75 saniyenin üstü bu odak ölçeğinde kırılmaya başlar. Bakışı kaputtan kaldırıp yolun 10–15 saniye ilerisine koyun; tehlike o zaman erken görünür.',
    foc_idle: 'Uzun kontrol sessizliği, sürüşün bilinçli izlenmediği anların vekilidir. Klinik bir dikkat testi değildir. Boşluk hissedince pedala bilinçli bir düzeltme, aynaya bir bakış ve hızı bir kontrol yeter.',
    foc_shoulder: 'Omuz bakışı, şerit değiştirirken dikkatin kör noktaya kadar genişlediğini gösterir. Ayna yetmez. Değişimden hemen önce kısa bir omuz bakışı (Shift+Z veya Shift+C) bu puanı ve gerçek güvenliği birlikte düzeltir.',
    foc_lane: 'Şerit sapması odak için yalnızca yardımcı bir işarettir; bazı çalışmalarda dalgınlık sapmayı artırır, bazılarında azaltır. Bu yüzden ağırlığı düşüktür. Sapma varsa önce bakışın nereye gittiğini sorun, sonra direksiyonu değil bakışı düzeltin.',
  };
  for (const s of subs) {
    s.tip = TIP[s.id] ?? s.detail;
    s.advice = ADVICE[s.id] ?? s.tip;
  }
  for (const s of weak) {
    if (s.tip) tips.push(s.tip);
    if (tips.length >= 4) break;
  }
  if (!tips.length) tips.push('Harika bir sürüş! Gözlem alışkanlığını ve yumuşak sürüşü korumaya devam edin.');
  const strengths = subs
    .filter((s) => s.score != null && (s.score as number) >= 90)
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .map((s) => s.name);

  const weigh = (rows: { score: number | null; w: number }[]) => {
    let acc = 0;
    let w = 0;
    for (const r of rows) {
      if (r.score == null) continue;
      acc += r.score * r.w;
      w += r.w;
    }
    return w > 0 ? Math.round(clamp(acc / w, 0, 100)) : null;
  };
  const insightRow = (id: string, name: string, score: number | null, value: string, detail: string, w: number) => ({
    id,
    name,
    score: score == null ? null : Math.round(clamp(score, 0, 100)),
    value,
    detail,
    tip: TIP[id] ?? detail,
    advice: ADVICE[id] ?? TIP[id] ?? detail,
    w,
  });
  const laneRms = st.laneKeepN > 400 ? Math.sqrt(st.laneKeepSq / st.laneKeepN) : null;
  const reactionMean = st.reactionTimes.length ? mean(st.reactionTimes) : null;
  const shortRead = inp.durationSec < 180;
  const fatRows = [
    insightRow(
      'fat_lane',
      'Şerit sapması (SDLP vekili)',
      laneRms == null ? null : 100 - Math.max(0, laneRms - 0.22) * 90,
      laneRms == null ? 'yeterli şerit verisi yok' : `RMS ${laneRms.toFixed(2)} m`,
      'Şerit ortasına göre yanal sapma. Yaklaşık 1 m üstü belirgin belirtidir.',
      2.2
    ),
    insightRow(
      'fat_srr',
      'Direksiyon düzeltme sıklığı',
      srr > 0 ? 100 - Math.max(0, srr - 12) * 3.5 : null,
      srr > 0 ? `${srr.toFixed(1)} /dk` : 'ölçülemedi',
      'Yaklaşık 3° üstü yön değişimleri. Sık büyük düzeltme yorgunlukla birlikte artar.',
      1.8
    ),
    insightRow(
      'fat_speed',
      'Hız dalgalanması',
      cruise.length > 40 ? 100 - Math.max(0, cv - 0.08) * 200 : null,
      cruise.length > 40 ? `değişim %${(cv * 100).toFixed(0)}` : 'düz seyir az',
      'Kavşak dışı hızın değişkenlik katsayısı.',
      1.3
    ),
    insightRow(
      'fat_reaction',
      'Tepki gecikmesi',
      reactionMean == null ? null : 100 - Math.max(0, reactionMean - 0.9) * 60,
      reactionMean == null ? 'ölçüm yok' : `${reactionMean.toFixed(2)} sn`,
      'Uyarıdan frene kadar geçen süre. Uzama, uyanıklığın düştüğünü düşündürür.',
      1.6
    ),
    insightRow(
      'fat_scan',
      'Tarama seyrelmesi',
      movingTime > 40 ? clamp(inp.mirrorRate / 5, 0, 1) * 55 + clamp(1 - Math.max(0, inp.maxMirrorGap - 18) / 45, 0, 1) * 45 : null,
      movingTime > 40 ? `${inp.mirrorRate.toFixed(1)} /dk · ara ${inp.maxMirrorGap.toFixed(0)} sn` : 'süre kısa',
      'Ayna ritmi düşüp aralar uzadıkça bakış yola daralmış sayılır.',
      1.5
    ),
    insightRow('fat_idle', 'Kontrol sessizliği', 100 - st.idleGaps * 16, `${st.idleGaps} uzun boşluk`, 'Eller ve pedallarda uzun hareketsizlik.', 1),
    insightRow(
      'fat_time',
      'Süre (zaman-görev)',
      inp.durationSec >= 480 ? 100 - Math.max(0, inp.durationSec / 60 - 15) * 3 : null,
      `${Math.round(inp.durationSec / 60)} dk`,
      'Tek başına teşhis değildir; 15 dakikadan sonra düşük ağırlıkla kırılır.',
      0.5
    ),
  ];
  const follow = st.followTime > 5;
  const aggRows = [
    insightRow(
      'agg_speed',
      'Hız baskısı',
      100 - overFrac * 200 - (st.overSevereTime / movingTime) * 180,
      `%${Math.round((1 - overFrac) * 100)} sınır içinde`,
      'Tolerans üstü süre ve aşırı aşımın payı.',
      2.2
    ),
    insightRow(
      'agg_harsh',
      'Sert gaz, fren ve viraj',
      100 - ((st.hardBrake * 1.1 + st.hardAccel * 1.1 + st.harshCorner) / Math.max(0.4, km)) * 9,
      `${st.hardBrake} fren · ${st.hardAccel} gaz · ${st.harshCorner} viraj / ${km.toFixed(1)} km`,
      'Kilometreye bölünmüş sert kontrol olayları.',
      2
    ),
    insightRow(
      'agg_tail',
      'Yakın takip',
      follow ? 100 - (st.headwayBelow1 / st.followTime) * 140 - (st.headwayBelow2 / st.followTime) * 35 : null,
      follow ? `1 sn altı %${Math.round((st.headwayBelow1 / st.followTime) * 100)} · min ${st.minHeadway.toFixed(1)} sn` : 'takip yok',
      'İzleme süresinde 2 sn ve 1 sn kurallarının kırılması.',
      1.8
    ),
    insightRow(
      'agg_weave',
      'Zikzak ve sık şerit',
      100 - st.weaving * 16 - Math.max(0, st.laneChanges.total / Math.max(0.4, km) - 4) * 8,
      `${st.weaving} zikzak · ${st.laneChanges.total} şerit değişimi`,
      'Gereksiz şerit değişimi ve sık geçiş.',
      1.2
    ),
    insightRow(
      'agg_miss',
      'Ramak kala',
      100 - st.nearMiss * 20 - (isFinite(st.minTTC) && st.minTTC < 2 ? (2 - st.minTTC) * 15 : 0),
      `${st.nearMiss} olay · min TTC ${isFinite(st.minTTC) ? st.minTTC.toFixed(1) + ' sn' : '—'}`,
      'Çarpma süresinin kritik eşiğe inmesi.',
      1.5
    ),
    insightRow(
      'agg_hostility',
      'Aceleci ihlaller',
      100 - st.redLights * 30 - count('yield_fail') * 18 - st.hornViolations * 12 - st.rightOvertakes * 14,
      `${st.redLights} kırmızı · ${count('yield_fail')} yol vermeme · ${st.hornViolations} korna · ${st.rightOvertakes} sağdan sollama`,
      'Başkasına yüklenen kural ihlalleri.',
      1.1
    ),
  ];
  const manFocus = st.laneChanges.total + st.turns.total;
  const focRows = [
    insightRow(
      'foc_mirror',
      'Ayna ritmi',
      movingTime > 30 ? clamp(inp.mirrorRate / 6, 0, 1) * 100 : null,
      movingTime > 30 ? `${inp.mirrorRate.toFixed(1)} /dk` : 'süre kısa',
      'Dakikada yaklaşık 6 kısa bakış hedef alınır.',
      2
    ),
    insightRow(
      'foc_gap',
      'En uzun bakışsız ara',
      movingTime > 30 ? 100 - Math.max(0, inp.maxMirrorGap - 15) * 1.8 : null,
      movingTime > 30 ? `${inp.maxMirrorGap.toFixed(0)} sn` : 'süre kısa',
      '15 saniyeden uzun aralar odağın koptuğu penceredir.',
      1.6
    ),
    insightRow(
      'foc_junction',
      'Kavşak taraması',
      st.junctionScans.total ? pct(st.junctionScans.ok, st.junctionScans.total) * 100 : null,
      st.junctionScans.total ? `${st.junctionScans.ok}/${st.junctionScans.total}` : 'kavşak yok',
      'DUR ve yol ver öncesi sol-sağ bakış.',
      1.4
    ),
    insightRow(
      'foc_before',
      'Manevra öncesi ayna',
      manFocus ? pct(st.laneChanges.mirror + st.turns.mirror, manFocus) * 100 : null,
      manFocus ? `${st.laneChanges.mirror + st.turns.mirror}/${manFocus}` : 'manevra yok',
      'Şerit ve dönüşten önceki 6 saniye.',
      1.3
    ),
    insightRow(
      'foc_reaction',
      'Tehlikeye gidiş',
      reactionMean == null ? null : 100 - Math.max(0, reactionMean - 0.75) * 65,
      reactionMean == null ? 'ölçüm yok' : `${reactionMean.toFixed(2)} sn`,
      'Ani olaya gecikme, bakışın daraldığını düşündürür.',
      1.5
    ),
    insightRow('foc_idle', 'Dalgınlık boşluğu', 100 - st.idleGaps * 14, `${st.idleGaps} uzun boşluk`, 'Kontrol girdisinin kesildiği aralıklar.', 1.2),
    insightRow(
      'foc_shoulder',
      'Kör nokta bakışı',
      st.laneChanges.total ? pct(st.laneChanges.shoulder, st.laneChanges.total) * 100 : null,
      st.laneChanges.total ? `${st.laneChanges.shoulder}/${st.laneChanges.total}` : 'şerit değişimi yok',
      'Şerit değiştirmeden önceki omuz kontrolü.',
      0.9
    ),
    insightRow(
      'foc_lane',
      'Şerit tutuşu (yardımcı)',
      laneRms == null ? null : 100 - Math.max(0, laneRms - 0.28) * 70,
      laneRms == null ? 'yeterli veri yok' : `RMS ${laneRms.toFixed(2)} m`,
      'Düşük ağırlık. Dalgınlıkta sapma her çalışmada aynı yönde değişmez.',
      0.7
    ),
  ];
  const evidence = shortRead ? ' Kısa oturumda bu okuma ön göstergedir.' : '';
  const insights: Insight[] = [
    {
      id: 'yorgunluk',
      title: 'Yorgunluk belirtisi',
      score: weigh(fatRows),
      color: '#26c6da',
      tip: `100, az belirti demektir. Şerit sapması, direksiyon düzeltmesi, hız dalgalanması, tepki ve tarama seyrelmesinden okunur.${evidence}`,
      note: 'Göz kapağı (PERCLOS) ölçülmez. NHTSA araç-içi uykululuk çalışması ve direksiyon yön değiştirme araştırmalarına göre şerit sapması ile sık düzeltme esas alındı.',
      rows: fatRows,
    },
    {
      id: 'agresif',
      title: 'Agresif sürüş',
      score: weigh(aggRows),
      color: '#ff7043',
      tip: `100, sakin sürüş demektir. Hız baskısı, sert kontrol, yakın takip, zikzak ve aceleci ihlallerden okunur.${evidence}`,
      note: 'NHTSA ve AAA agresif sürüşü hız, yakın takip, zikzak, ani hız değişimi ve kuralları hiçe sayma olarak tanımlar. Telematik skorları gibi olaylar kilometreye bölünür.',
      rows: aggRows,
    },
    {
      id: 'odak',
      title: 'Odak puanı',
      score: weigh(focRows),
      color: '#7e57c2',
      tip: `100, sürüşe dönük dikkat demektir. Ayna ritmi, bakışsız ara, kavşak taraması, manevra öncesi bakış ve tepki süresinden okunur.${evidence}`,
      note: 'Zihin dağınıklığı çalışmalarında bakışın yola daralması, ayna taramasının düşmesi ve tepkinin uzaması birlikte görülür. Göz izleyici olmadığı için tarama tuşları ve kafa takibi vekil olarak kullanılır.',
      rows: focRows,
    },
  ];

  const style = computeStyle(samples, st, inp.signalLeads, inp.mirrorRate);
  const kmhs = moving.map((s) => s.kmh);
  const clean = col.vehicle + col.pedestrian + col.hard === 0 && st.redLights === 0 && st.wrongWayTime < 3 && critical === 0;
  return {
    overall,
    grade: letterGrade(overall),
    components,
    subs,
    risk,
    tips,
    strengths,
    insights,
    style,
    styleAdherence: inp.baseline ? styleAdherence(inp.baseline, style) : null,
    distanceKm: km,
    durationSec: inp.durationSec,
    avgKmh: kmhs.length ? mean(kmhs) : 0,
    maxKmh: kmhs.length ? Math.max(...kmhs) : 0,
    confidence,
    caps,
    clean,
  };
}

/** Star rating for missions. */
export function starsFor(success: boolean, overall: number, criticalEvents: number): number {
  if (!success) return 0;
  if (overall >= 85 && criticalEvents === 0) return 3;
  if (overall >= 70) return 2;
  return 1;
}
