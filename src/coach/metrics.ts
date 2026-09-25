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
  /** Weight inside its component. */
  w: number;
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
    subs.push({ id, component, name, score: score == null ? null : Math.round(clamp(score, 0, 100)), value, detail, w });

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
  add('near_miss', 'guvenlik', 'Ramak kala (TTC < 1.6 sn)', 100 - st.nearMiss * 22, `${st.nearMiss} olay · min TTC ${isFinite(st.minTTC) ? st.minTTC.toFixed(1) + ' sn' : '—'}`, 'Öndeki araca çarpma süresi (TTC) kritik eşiğin altına düştüğünde sayılır.', 2);
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
  add('hard_events', 'guvenlik', 'Sert olay oranı', 100 - hardRate * 7, `${st.hardBrake} fren · ${st.hardAccel} gaz · ${st.harshCorner} viraj (${km.toFixed(2)} km)`, 'Olaylar mesafe (km) ile normalize edildi.', 1.2);
  if (st.reactionTimes.length) {
    const r = mean(st.reactionTimes);
    add('reaction', 'guvenlik', 'Tepki süresi', 100 - Math.max(0, r - 0.7) * 70, `${r.toFixed(2)} sn (ort. ${st.reactionTimes.length} ölçüm)`, 'Uyarı ile frene basma arasındaki süre. 1 sn altı iyi kabul edilir.', 1.5);
  }

  // ——— Kural ———
  const overFrac = st.overTime / movingTime;
  add('speed', 'kural', 'Hız sınırı uyumu', 100 - overFrac * 220 - (st.overSevereTime / movingTime) * 200, `%${Math.round((1 - overFrac) * 100)} sınır içinde · ${count('speeding')} ihlal`, 'Bölge hız sınırı + tolerans (okul bölgesi 3 km/h) üzerinden hesaplanır.', 2.5);
  add('red_light', 'kural', 'Trafik ışıkları', st.signalsPassed + st.redLights > 0 ? 100 - st.redLights * 45 - count('yellow_risky') * 12 : null, `${st.signalsPassed} ışıklı kavşak · ${st.redLights} kırmızı`, 'Kırmızıda geçiş ağır ihlaldir.', 2);
  const ss = st.stopSigns;
  add('stop_sign', 'kural', 'DUR levhası', ss.total ? (ss.full / ss.total) * 100 - count('stop_ignored') * 20 : null, ss.total ? `${ss.full}/${ss.total} tam duruş` : 'DUR levhası yok', 'DUR levhasında tekerlekler tamamen durmalıdır.', 1.5);
  add('right_of_way', 'kural', 'Geçiş önceliği & yaya', 100 - count('yield_fail') * 35 - st.pedConflicts * 40, `${count('yield_fail')} öncelik · ${st.pedConflicts} yaya ihlali · ${st.pedYielded} yol verme`, 'Yaya geçidinde ve ana yol trafiğinde öncelik kuralları.', 2);
  const man = st.turns.total + st.laneChanges.total;
  const sig = st.turns.signaled + st.laneChanges.signaled;
  add('signals', 'kural', 'Sinyal kullanımı', man ? pct(sig, man) * 100 - count('wrong_signal') * 10 : null, man ? `${sig}/${man} manevrada sinyal` : 'manevra yok', 'Dönüş ve şerit değişimlerinden önce sinyal.', 2);
  add('lane_discipline', 'kural', 'Yön & şerit disiplini', 100 - (st.wrongWayTime / movingTime) * 400 - count('wrong_way') * 15 - (st.sidewalkTime / movingTime) * 300 - count('sidewalk') * 10 - count('median') * 12 - count('wrong_lane_turn') * 8 - count('lane_straddle') * 4, `ters yön ${st.wrongWayTime.toFixed(1)} sn · kaldırım ${st.sidewalkTime.toFixed(1)} sn`, 'Ters yön, kaldırım/refüj, yanlış şeritten dönüş.', 2);
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
  add('attention', 'tarama', 'Dikkat (girdi boşlukları)', 100 - st.idleGaps * 12, `${st.idleGaps} uzun boşluk`, 'Klavye/kol hareketsizliği — klinik dikkat ölçümü değildir.', 0.6);

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
  add('srr', 'puruzsuzluk', 'Direksiyon düzeltme oranı (SRR)', srr > 0 ? 100 - Math.max(0, srr - 8) * 3 : null, `${srr.toFixed(1)} /dk`, 'Steering Reversal Rate — sık küçük düzeltmeler düşük dikkati/kararsızlığı gösterebilir.', 1);
  const cruise = moving.filter((s) => !s.inJunction && s.kmh > 20);
  const cv = cruise.length > 30 ? std(cruise.map((s) => s.kmh)) / Math.max(1, mean(cruise.map((s) => s.kmh))) : 0;
  add('speed_stability', 'puruzsuzluk', 'Hız istikrarı', cruise.length > 30 ? 100 - Math.max(0, cv - 0.12) * 220 : null, `değişim katsayısı ${(cv * 100).toFixed(0)}%`, 'Düz yolda gereksiz hız dalgalanması.', 1);

  // ——— Görev ———
  if (inp.objectives) {
    const o = inp.objectives;
    add('objectives', 'gorev', 'Görev hedefleri', o.total ? pct(o.done, o.total) * 100 - o.failed * 20 : null, `${o.done}/${o.total} tamamlandı`, 'Seçilen görevin adımları.', 3);
  }
  add('route', 'gorev', 'Rota uyumu', 100 - st.reroutes * 12, `${st.reroutes} sapma`, 'Navigasyon rotasından sapma sayısı.', 1.5);
  add('resets', 'gorev', 'Araç sıfırlama', 100 - st.resets * 25, `${st.resets} sıfırlama`, 'R ile sıfırlama gerçek sürüşte mümkün değildir.', 1);

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
  };
  for (const s of weak) {
    if (TIP[s.id]) tips.push(TIP[s.id]);
    if (tips.length >= 4) break;
  }
  if (!tips.length) tips.push('Harika bir sürüş! Tarama alışkanlığını ve yumuşak sürüşü korumaya devam edin.');
  const strengths = subs
    .filter((s) => s.score != null && (s.score as number) >= 90)
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .map((s) => s.name);

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
