import { angleDiff, mulberry32 } from '../core/math';
import { actionKeys } from '../input/bindings';
import type { Lane } from '../world/roadNetwork';
import type { Constraint, MissionDef, MissionHost, Step, StepCtx } from './mission';

// ———————————————————————————— step library ————————————————————————————

const n = (c: StepCtx, k: string, v?: number) => {
  if (v !== undefined) c.data[k] = v;
  return (c.data[k] as number) ?? 0;
};

/** Drive to a point using navigation; optionally must stop there. */
export function driveTo(title: string, x: number, z: number, name: string, opts: { radius?: number; stop?: boolean; hint?: string; voice?: string } = {}): Step {
  const radius = opts.radius ?? 14;
  return {
    title,
    hint: opts.hint ?? 'Navigasyon talimatlarını izleyin. Mavi oklar rotayı gösterir.',
    voice: opts.voice,
    start(h) {
      h.navigate(x, z, name);
      h.marker('goal', x, z, { kind: 'beacon', color: 0x35a7ff, label: name });
    },
    update(h, dt, c) {
      const p = h.player();
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius && !(h.nav.arrived && d < radius * 2)) return null;
      if (!opts.stop) return 'done';
      if (p.kmh < 1) n(c, 'hold', n(c, 'hold') + dt);
      else n(c, 'hold', 0);
      return n(c, 'hold') > 1.2 ? 'done' : null;
    },
    end(h) {
      h.clearMarker('goal');
    },
  };
}

export function driveToLandmark(h: MissionHost, id: string, title?: string, opts: { stop?: boolean; hint?: string } = {}): Step {
  const lm = h.map.landmarks.find((l) => l.id === id)!;
  // Aim for the nearest lane point next to the landmark
  const near = h.net.nearestLane(lm.x, lm.z, undefined, 120);
  let x = lm.x;
  let z = lm.z;
  if (near) {
    const p = { x: 0, z: 0, h: 0 };
    near.lane.path.sample(Math.min(near.lane.path.length - 10, Math.max(10, near.s)), p);
    x = p.x;
    z = p.z;
  }
  return driveTo(title ?? `${lm.icon} ${lm.name}'na git`, x, z, lm.name, { stop: opts.stop, hint: opts.hint });
}

export function reachSpeed(kmh: number, title?: string): Step {
  return {
    title: title ?? `${kmh} km/h hıza çık`,
    hint: 'Gaza kademeli basın (W / sağ tetik). Sert hızlanmadan kaçının.',
    update(h) {
      return h.player().kmh >= kmh ? 'done' : null;
    },
  };
}

export function turn(side: 'left' | 'right', title: string, target?: { x: number; z: number; name: string }): Step {
  return {
    title,
    hint: `Ayna (${side === 'left' ? 'Z' : 'C'}) → Sinyal (${side === 'left' ? 'Q' : 'E'}) → yavaşla → dön. Dönüş için doğru şeritte olun.`,
    start(h, c) {
      c.data.t0 = h.time();
      if (target) h.navigate(target.x, target.z, target.name);
    },
    update(h, _dt, c) {
      // Reaching the navigation target also completes the step (e.g. after a detour / reroute)
      if (target) {
        const p = h.player();
        if (Math.hypot(p.x - target.x, p.z - target.z) < 16) return 'done';
      }
      const lt = h.monitor.lastTurn;
      if (lt && lt.t > (c.data.t0 as number)) {
        if (lt.side === side) return 'done';
        c.data.t0 = h.time();
        h.toast(`Yanlış yöne döndünüz — ${side === 'left' ? 'sola' : 'sağa'} dönün`, 'warn');
        if (target) h.navigate(target.x, target.z, target.name);
      }
      return null;
    },
  };
}

export function laneChange(side: 'left' | 'right' | 'any', title: string): Step {
  let res = '';
  return {
    title,
    hint: `Önce ayna (${actionKeys('mirrorL')}/${actionKeys('mirrorR')}), sonra sinyal (${actionKeys('signalL')}/${actionKeys('signalR')}), omuz kontrolü (${actionKeys('shoulder')} + ayna tuşu), sonra yavaşça şerit değiştirin.`,
    start(h, c) {
      c.data.t0 = h.time();
      c.data.lane0 = h.player().lane;
    },
    update(h, _dt, c) {
      const l = h.monitor.lastLaneChange;
      if (l && l.t > (c.data.t0 as number) && (side === 'any' || l.side === side)) {
        res = `${title}: sinyal ${l.signaled ? '✓' : '✗'} · ayna ${l.mirror ? '✓' : '✗'} · omuz ${l.shoulder ? '✓' : '✗'}`;
        return 'done';
      }
      // lane changed where it cannot be judged (e.g. right at a junction) — accept, but note it
      const p = h.player();
      const l0 = c.data.lane0 as number;
      // (give the monitor time to confirm the change first — it waits until the car settles in the lane)
      if (p.lane >= 0 && l0 >= 0 && p.lane !== l0 && (side === 'any' || (side === 'left') === p.lane > l0)) {
        c.data.diffT = ((c.data.diffT as number) ?? 0) + _dt;
        if ((c.data.diffT as number) > 4) {
          res = `${title}: kavşak yakınında değiştirildi (değerlendirilemedi)`;
          return 'done';
        }
      } else c.data.diffT = 0;
      if (p.lane >= 0 && l0 < 0) c.data.lane0 = p.lane;
      return null;
    },
    result: () => res,
  };
}

export function stopSignPass(title: string): Step {
  let res = '';
  return {
    title,
    hint: 'DUR levhasında çizgiden önce tamamen durun (0 km/h), sonra sola-sağa bakıp geçin.',
    start(h, c) {
      c.data.t0 = h.time();
    },
    update(h, _dt, c) {
      const s = h.monitor.lastStopLine;
      if (s && s.t > (c.data.t0 as number) && s.control === 'stop') {
        res = `DUR levhası: en düşük hız ${Math.round(s.minKmh)} km/h ${s.minKmh < 3 ? '✓' : '✗'}`;
        return 'done';
      }
      return null;
    },
    result: () => res,
  };
}

/** Perception–reaction test: at speed, a sudden "DUR!" stimulus; measures reaction + stopping distance. */
export function reactionTest(minKmh: number, title = 'Tepki testi', nav?: { x: number; z: number; name: string }): Step {
  let res = '';
  const rng = mulberry32(Date.now() & 0xffff);
  return {
    title,
    hint: `${minKmh}+ km/h ile ilerleyin. Ekranda "DUR!" görünce hemen frene basın ve durun.`,
    voice: `${title}. ${minKmh} kilometre hıza çıkın ve dur uyarısını bekleyin`,
    start(h, c) {
      c.data.phase = 0;
      c.data.wait = 1.2 + rng() * 2.5;
      if (nav) h.navigate(nav.x, nav.z, nav.name);
    },
    update(h, dt, c) {
      const p = h.player();
      const phase = c.data.phase as number;
      if (phase === 0) {
        if (p.kmh >= minKmh) {
          c.data.phase = 1;
          c.data.arm = 0;
        }
      } else if (phase === 1) {
        if (p.kmh < minKmh - 8) {
          c.data.phase = 0;
          return null;
        }
        n(c, 'arm', n(c, 'arm') + dt);
        if (n(c, 'arm') > (c.data.wait as number)) {
          c.data.phase = 2;
          c.data.x0 = p.x;
          c.data.z0 = p.z;
          c.data.v0 = p.kmh;
          h.stimulus('DUR!');
          h.monitor.startReaction(title);
        }
      } else if (phase === 2) {
        if (p.kmh < 0.8) {
          const dist = Math.hypot(p.x - (c.data.x0 as number), p.z - (c.data.z0 as number));
          const rt = h.monitor.stats.reactionTimes[h.monitor.stats.reactionTimes.length - 1] ?? 0;
          res = `${title}: tepki ${rt.toFixed(2)} sn · ${Math.round(c.data.v0 as number)} km/h'ten ${dist.toFixed(1)} m'de durdu`;
          h.stimulus(null);
          return 'done';
        }
        if (n(c, 't2', n(c, 't2') + dt) > 12) {
          h.stimulus(null);
          return 'fail';
        }
      }
      return null;
    },
    end(h) {
      h.stimulus(null);
    },
    result: () => res,
    failText: 'Tepki testinde durulmadı',
  };
}

/** Park inside a marked bay (either direction) and pull the handbrake. */
export function parkIn(title: string, bay: { x: number; z: number; heading: number; w: number; l: number }, opts: { parallel?: boolean } = {}): Step {
  let res = '';
  return {
    title,
    hint: opts.parallel
      ? 'Öndeki aracın yanına hizalanın, geri vitese alın, sağa kırarak girin, sonra düzeltin. Durunca el frenini çekin.'
      : 'Yavaşça park yerine girin, çizgilere paralel durun. Durunca el frenini çekin.',
    start(h) {
      h.marker('bay', bay.x, bay.z, { kind: 'bay', heading: bay.heading, w: bay.w, l: bay.l, color: 0x3ddc84 });
      // Only navigate to kerbside slots; lot bays are reached by eye (the marker glows)
      const near = h.net.nearestLane(bay.x, bay.z, undefined, 12);
      if (near && near.dist < 7) h.navigate(bay.x, bay.z, 'Park yeri');
      else h.nav.clear();
    },
    update(h, dt, c) {
      const p = h.player();
      const dx = p.x - bay.x;
      const dz = p.z - bay.z;
      const fx = Math.sin(bay.heading);
      const fz = Math.cos(bay.heading);
      const along = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      let dh = Math.abs(angleDiff(p.heading, bay.heading));
      if (!opts.parallel) dh = Math.min(dh, Math.abs(angleDiff(p.heading, bay.heading + Math.PI)));
      const inside = Math.abs(lat) < (bay.w - p.width) / 2 + 0.25 && Math.abs(along) < (bay.l - p.length) / 2 + 0.45 && dh < 0.21;
      h.meter('Park hizası', inside ? 100 : Math.max(0, 100 - Math.hypot(lat, along) * 25 - dh * 120));
      if (inside && p.kmh < 0.5 && (p.handbrake || p.gear === 'P')) {
        n(c, 'hold', n(c, 'hold') + dt);
        if (n(c, 'hold') > 0.8) {
          const acc = Math.max(0, Math.round(100 - Math.abs(lat) * 60 - Math.abs(along) * 25 - dh * 180));
          res = `${title}: hizalama %${acc} (yanal ${Math.abs(lat).toFixed(2)} m, açı ${((dh * 180) / Math.PI).toFixed(0)}°)`;
          return 'done';
        }
      } else n(c, 'hold', 0);
      return null;
    },
    end(h) {
      h.clearMarker('bay');
      h.meter(null);
      h.nav.clear();
    },
    result: () => res,
  };
}

/** Wait for a leading vehicle, then make it brake hard. */
export function leadBrakeEvent(title = 'Öndeki araç ani fren yapacak — dikkat!'): Step {
  let res = '';
  return {
    title,
    hint: 'Takip mesafesini (2 sn) koruyun; fren lambalarını görünce hemen tepki verin.',
    voice: 'Trafikte dikkatli ilerleyin',
    start(_h, c) {
      c.data.phase = 0;
    },
    update(h, dt, c) {
      const p = h.player();
      const phase = c.data.phase as number;
      if (phase === 0) {
        n(c, 'wait', n(c, 'wait') + dt);
        if (p.kmh > 22) {
          const lead = h.traffic.leadOf(p, 45);
          if (lead && lead.gap > 8 && lead.gap < 40) {
            h.traffic.triggerLeadBrake(p, 8, 40);
            h.monitor.startReaction('Öndeki araç ani fren');
            c.data.phase = 1;
            c.data.t1 = 0;
          } else if (n(c, 'wait') > 10 && !lead) {
            h.traffic.spawnAhead(p, 34, 0.75);
            c.data.wait = 0;
          }
        }
      } else {
        n(c, 't1', n(c, 't1') + dt);
        if (!h.monitor.reactionPending && n(c, 't1') > 3) {
          const rt = h.monitor.stats.reactionTimes[h.monitor.stats.reactionTimes.length - 1] ?? 0;
          res = `Ani fren olayı: tepki ${rt.toFixed(2)} sn · min TTC ${isFinite(h.monitor.stats.minTTC) ? h.monitor.stats.minTTC.toFixed(1) + ' sn' : '—'}`;
          return 'done';
        }
      }
      return null;
    },
    result: () => res,
  };
}

/** A pedestrian suddenly steps onto the road ahead. */
export function jaywalkerEvent(title = 'Beklenmedik yaya — hazır olun'): Step {
  let res = '';
  return {
    title,
    hint: 'Park etmiş araçların arasından çıkabilecek yayalara karşı hızınızı düşük tutun.',
    start(_h, c) {
      c.data.phase = 0;
    },
    update(h, dt, c) {
      const p = h.player();
      if (c.data.phase === 0) {
        if (p.kmh > 18) {
          n(c, 'arm', n(c, 'arm') + dt);
          if (n(c, 'arm') > 1.5 && h.peds.spawnJaywalker(p, Math.max(22, p.kmh * 0.75))) {
            h.monitor.startReaction('Yola çıkan yaya');
            c.data.phase = 1;
          }
        }
      } else {
        n(c, 't1', n(c, 't1') + dt);
        if (n(c, 't1') > 6) {
          const rt = h.monitor.stats.reactionTimes[h.monitor.stats.reactionTimes.length - 1] ?? 0;
          const hit = h.monitor.stats.collisions.pedestrian > 0;
          res = `Yaya olayı: tepki ${rt.toFixed(2)} sn · ${hit ? 'ÇARPIŞMA' : 'güvenle durdu/kaçındı'}`;
          return hit ? 'fail' : 'done';
        }
      }
      return null;
    },
    result: () => res,
    failText: 'Yayaya çarpıldı',
  };
}

export function pickup(title: string, x: number, z: number, name: string): Step {
  const base = driveTo(title, x, z, name, { stop: true, radius: 9, hint: 'Yolcunun yanında sağa yanaşın ve tamamen durun (sinyal vermeyi unutmayın).' });
  return {
    ...base,
    start(h, c) {
      base.start?.(h, c);
      h.marker('goal', x, z, { kind: 'beacon', color: 0xffc107, label: name });
    },
    end(h, c) {
      base.end?.(h, c);
      h.toast('🧍 Yolcu bindi', 'good');
    },
  };
}

/** Drive through a roundabout and on to a target beyond it. */
export function roundaboutPass(title: string, target: { x: number; z: number; name: string }): Step {
  return {
    title,
    hint: 'Dönele yaklaşırken yavaşlayın, içerideki araca yol verin; çıkmadan önce sağ sinyal verin.',
    start(h, c) {
      c.data.rb0 = h.monitor.stats.roundabouts.total;
      h.navigate(target.x, target.z, target.name);
      h.marker('goal', target.x, target.z, { kind: 'beacon', color: 0x35a7ff, label: target.name });
    },
    update(h, _dt, c) {
      const p = h.player();
      const passed = h.monitor.stats.roundabouts.total > (c.data.rb0 as number);
      if (passed && Math.hypot(p.x - target.x, p.z - target.z) < 20) return 'done';
      if (!passed && Math.hypot(p.x - target.x, p.z - target.z) < 12) {
        // arrived without using the roundabout (detour) — re-route through it
        return 'done';
      }
      return null;
    },
    end(h) {
      h.clearMarker('goal');
    },
    result: () => null,
  };
}

/** An emergency vehicle approaches from behind — make way. */
export function emergencyEvent(title: string): Step {
  let res = '';
  return {
    title,
    hint: 'Sireni duyduğunuzda iç dikize bakın, sağa yanaşın ve yavaşlayın; geçmesine izin verin.',
    voice: 'Arkadan ambulans geliyor. Yol verin.',
    start(h, c) {
      c.data.n0 = h.monitor.count('emergency_yield_ok') + h.monitor.count('emergency_yield_fail');
      c.data.spawned = 0;
    },
    update(h, dt, c) {
      c.data.retry = ((c.data.retry as number) ?? 0) - dt;
      if (!c.data.spawned && (c.data.retry as number) <= 0) {
        const p = h.player();
        if (p.kmh > 15) {
          const car = h.traffic.spawnEmergency(p, 70, 'ambulance');
          if (car) {
            c.data.spawned = 1;
            h.toast('🚑 Arkadan sirenli ambulans geliyor!', 'warn');
          }
        }
        c.data.retry = 2;
      }
      const n = h.monitor.count('emergency_yield_ok') + h.monitor.count('emergency_yield_fail');
      if (n > (c.data.n0 as number)) {
        res = h.monitor.count('emergency_yield_fail') ? 'Ambulansa yol verilmedi ✗' : 'Ambulansa yol verildi ✓';
        return 'done';
      }
      if (c.data.spawned && c.t > 95) {
        res = 'Ambulans değerlendirilemedi';
        return 'done';
      }
      return null;
    },
    result: () => res,
  };
}

// ———————————————————————————— constraints ————————————————————————————

const noRedLight = (): Constraint => ({ title: 'Kırmızı ışık ihlali yok', ok: (h) => h.monitor.stats.redLights === 0 });
const noCollision = (fatal = false): Constraint => ({
  title: 'Çarpışma yok',
  ok: (h) => h.monitor.stats.collisions.vehicle + h.monitor.stats.collisions.pedestrian + h.monitor.stats.collisions.hard === 0,
  fatal,
});
const noPedHit = (): Constraint => ({ title: 'Yayaya çarpma yok', ok: (h) => h.monitor.stats.collisions.pedestrian === 0, fatal: true });
const noSpeeding = (): Constraint => ({ title: 'Hız sınırı ihlali yok', ok: (h) => h.monitor.count('speeding') === 0 });
const headway = (): Constraint => ({ title: 'Yakın takip yok', ok: (h) => h.monitor.count('tailgating') === 0 && h.monitor.stats.nearMiss === 0 });
const lightsOn = (): Constraint => ({ title: 'Farlar açık', ok: (h) => h.monitor.count('no_headlights') === 0 });
const comfort = (): Constraint => ({
  title: 'Yolcu konforu (sert fren/gaz/viraj yok)',
  ok: (h) => h.monitor.stats.hardBrake + h.monitor.stats.hardAccel + h.monitor.stats.harshCorner < 2,
});
const noShoulder = (): Constraint => ({ title: 'Emniyet şeridine girmeden', ok: (h) => h.monitor.count('shoulder_drive') === 0 });
const noRightOvertake = (): Constraint => ({ title: 'Sağdan sollama yok', ok: (h) => h.monitor.stats.rightOvertakes === 0 });
const rbRules = (): Constraint => ({ title: 'Dönelde yol verme + çıkış sinyali', ok: (h) => h.monitor.count('rb_yield_fail') + h.monitor.count('rb_no_exit_signal') === 0 });
const zoneRules = (): Constraint => ({ title: 'Bölge hız sınırlarına uy', ok: (h) => h.monitor.count('zone_speeding') + h.monitor.count('speeding') === 0 });
const noHorn = (): Constraint => ({ title: 'Korna yasağına uy', ok: (h) => h.monitor.stats.hornViolations === 0 });
const yieldEmergency = (): Constraint => ({ title: 'Sirenli araca yol ver', ok: (h) => h.monitor.count('emergency_yield_fail') === 0 });
const msmAll = (): Constraint => ({
  title: 'Tüm manevralarda ayna + sinyal',
  ok: (h) => h.monitor.count('no_signal_lane') + h.monitor.count('no_signal_turn') + h.monitor.count('no_mirror_lane') + h.monitor.count('no_mirror_turn') === 0,
});

// ———————————————————————————— helpers ————————————————————————————

function lanePoint(h: MissionHost, x: number, z: number, heading?: number) {
  const near = h.net.nearestLane(x, z, heading, 60);
  if (!near) return { x, z };
  const p = { x: 0, z: 0, h: 0 };
  near.lane.path.sample(Math.min(near.lane.path.length - 6, Math.max(6, near.s)), p);
  return { x: p.x, z: p.z };
}

/** Free parking slot on a quiet street near the player for parallel parking. */
function parallelSlot(h: MissionHost) {
  const p = h.player();
  let best: (typeof h.world.parking)[number] | null = null;
  let bd = Infinity;
  for (const s of h.world.parking) {
    if (s.edge.cls === 'boulevard' || s.edge.cls === 'avenue') continue;
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < 60 || d > 400) continue;
    // right-hand side of travel only
    const lanes: Lane[] = s.side === 1 ? s.edge.lanesFwd : s.edge.lanesBwd;
    if (!lanes.length) continue;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (!best) return null;
  h.traffic.freeSlot(best);
  return { x: best.x, z: best.z, heading: best.heading, w: 2.3, l: 6.0 };
}

// ———————————————————————————— catalogue ————————————————————————————

export const MISSIONS: MissionDef[] = [
  {
    id: 'calibration',
    title: 'Kalibrasyon Programı',
    subtitle: 'Kişisel sürüş profilini çıkar',
    description:
      'Yönlendirmeli 10 adım: hızlanma, sola/sağa dönüş, şerit değiştirme (Ayna–Sinyal–Manevra), tepki testi, DUR levhası ve park. Sonunda kişisel sürüş stilin (hız tercihi, ivme, direksiyon, tarama alışkanlığı, tepki süresi) profiline kaydedilir.',
    map: 'training',
    icon: '🎯',
    difficulty: 1,
    minutes: 7,
    category: 'calibration',
    conditions: { time: 'noon', weather: 'clear', traffic: 0.5, peds: 0.6 },
    skills: ['Temel kontrol', 'MSM', 'Tepki', 'Park'],
    steps: (h) => [
      reachSpeed(25, 'Yola çık ve 25 km/h hıza ulaş'),
      turn('left', 'Sola dön — Eğitim Bulvarı', { ...lanePoint(h, 10, -46, Math.PI / 2), name: 'Eğitim Bulvarı' }),
      laneChange('left', 'Sol şeride geç (Ayna → Sinyal → Omuz)'),
      laneChange('right', 'Tekrar sağ şeride dön'),
      turn('right', 'Sağa dön — Sinyal Caddesi', { ...lanePoint(h, 148, 20, 0), name: 'Sinyal Caddesi' }),
      turn('left', 'Sola dön — Dur Sokak', { ...lanePoint(h, 225, 63, Math.PI / 2), name: 'Dur Sokak' }),
      stopSignPass('DUR levhasında tam dur, sağı-solu kontrol et ve geç'),
      driveTo('Güney Yolu\'na geç', ...(Object.values(lanePoint(h, 200, 167, -Math.PI / 2)) as [number, number]), 'Güney Yolu', { radius: 12 }),
      reactionTest(35, 'Tepki testi', { ...lanePoint(h, -180, 167, -Math.PI / 2), name: 'Güney Yolu' }),
      driveTo('Park alanının girişine git', -196, 66, 'Park alanı girişi', { radius: 8 }),
      parkIn('İşaretli park yerine park et', h.world.parkingBays[Math.min(h.world.parkingBays.length - 1, 12)] ?? { x: -190, z: 90, heading: 0, w: 2.8, l: 5.2 }),
    ],
    constraints: () => [noCollision(), noRedLight()],
  },
  {
    id: 'quick-calibration',
    title: 'Hızlı Kalibrasyon',
    subtitle: '2 dakika serbest sürüş',
    description: 'Eğitim alanında 2 dakika boyunca kendi tarzında sür. Hız, ivme ve direksiyon alışkanlıkların temel profil olarak kaydedilir.',
    map: 'training',
    icon: '⏱️',
    difficulty: 1,
    minutes: 2,
    category: 'calibration',
    conditions: { time: 'noon', weather: 'clear', traffic: 0.5 },
    skills: ['Stil profili'],
    steps: () => [
      {
        title: '2 dakika boyunca doğal tarzında sür',
        hint: 'Kuralları izleyerek normal sürüşünü yap. Süre sağ üstte.',
        update: (h, _dt, c) => {
          h.meter('Kalibrasyon', Math.min(100, (c.t / 120) * 100));
          return c.t >= 120 ? 'done' : null;
        },
        end: (h) => h.meter(null),
      },
    ],
    constraints: () => [noCollision()],
  },
  {
    id: 'msm-workshop',
    title: 'Ayna–Sinyal–Manevra Atölyesi',
    subtitle: 'Şerit değiştirme ve dönüş disiplini',
    description: 'Bulvarda 4 şerit değişimi ve 2 dönüş. Her manevradan önce ilgili ayna, sinyal ve kör nokta kontrolü beklenir.',
    map: 'training',
    icon: '🪞',
    difficulty: 2,
    minutes: 5,
    category: 'skill',
    conditions: { time: 'morning', weather: 'clear', traffic: 0.7 },
    skills: ['Ayna', 'Sinyal', 'Kör nokta'],
    steps: (h) => [
      turn('left', 'Sola dön — Eğitim Bulvarı', { ...lanePoint(h, 230, -52, Math.PI / 2), name: 'Eğitim Bulvarı' }),
      laneChange('left', 'Sol şeride geç'),
      laneChange('right', 'Sağ şeride dön'),
      laneChange('left', 'Tekrar sol şeride geç'),
      laneChange('right', 'Sağ şeride dön'),
      turn('right', 'Sağa dön — Park Sokak', { ...lanePoint(h, 262, 100, 0), name: 'Park Sokak' }),
    ],
    constraints: () => [msmAll(), noCollision()],
  },
  {
    id: 'parking',
    title: 'Park Etme Alıştırması',
    subtitle: 'Düz ve geri park',
    description: 'Park alanında iki farklı park yerine park et. Hizalama doğruluğu ve çarpmadan park puanlanır.',
    map: 'training',
    icon: '🅿️',
    difficulty: 2,
    minutes: 4,
    category: 'skill',
    conditions: { time: 'noon', weather: 'clear', traffic: 0.3 },
    spawn: { x: -150, z: 76, heading: -Math.PI / 2 },
    skills: ['Park', 'Düşük hız kontrolü'],
    steps: (h) => {
      const bays = h.world.parkingBays;
      const a = bays[Math.min(bays.length - 1, 20)];
      const b = bays[Math.min(bays.length - 1, Math.floor(bays.length / 2) + 22)];
      return [parkIn('1. park yerine ileri park et', a), reachSpeed(5, 'Park yerinden çık'), parkIn('2. park yerine park et (geri park önerilir)', b)];
    },
    constraints: () => [noCollision()],
  },
  {
    id: 'reaction-series',
    title: 'Tepki Testi Serisi',
    subtitle: '3 ölçümle tepki süresi',
    description: 'Bulvarda farklı hızlarda üç ani "DUR!" uyarısı. Ortalama tepki süren ve duruş mesafen raporlanır.',
    map: 'training',
    icon: '⚡',
    difficulty: 1,
    minutes: 4,
    category: 'skill',
    conditions: { time: 'noon', weather: 'clear', traffic: 0.2 },
    spawn: { x: -240, z: -48, heading: Math.PI / 2 },
    skills: ['Tepki', 'Fren'],
    steps: () => [reactionTest(30, 'Tepki testi 1'), reactionTest(40, 'Tepki testi 2'), reactionTest(45, 'Tepki testi 3')],
    constraints: () => [noCollision()],
  },
  // ——— City ———
  {
    id: 'city-tour',
    title: 'Şehir Turu',
    subtitle: 'Meydan → Park → Cami',
    description: 'Navigasyonla şehrin üç noktasına git. Işıklar, yayalar, tek yönlü yollar ve farklı hız bölgeleri.',
    map: 'city',
    icon: '🗺️',
    difficulty: 2,
    minutes: 8,
    category: 'city',
    board: true,
    conditions: { time: 'morning', weather: 'clear', traffic: 1 },
    skills: ['Navigasyon', 'Kavşaklar', 'Hız bölgeleri'],
    steps: (h) => [driveToLandmark(h, 'meydan'), driveToLandmark(h, 'park'), driveToLandmark(h, 'cami', undefined, { stop: true })],
    constraints: () => [noRedLight(), noCollision()],
  },
  {
    id: 'taxi',
    title: 'Taksi: Hastaneye Yolcu',
    subtitle: 'Konforlu ve güvenli taşıma',
    description: 'Çarşı önünden yolcuyu al ve hastaneye götür. Yolcu konforu için sert fren, gaz ve virajdan kaçın.',
    map: 'city',
    icon: '🚕',
    difficulty: 2,
    minutes: 7,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'cloudy', traffic: 1 },
    skills: ['Yumuşak sürüş', 'Yanaşma'],
    steps: (h) => {
      const lm = h.map.landmarks.find((l) => l.id === 'carsi')!;
      const p = lanePoint(h, lm.x, lm.z);
      return [pickup('🧍 Çarşı önünde yolcuyu al', p.x, p.z, 'Yolcu'), driveToLandmark(h, 'hastane', '🏥 Yolcuyu hastaneye bırak', { stop: true })];
    },
    constraints: () => [comfort(), noCollision(), noRedLight()],
  },
  {
    id: 'school-zone',
    title: 'Okul Bölgesi',
    subtitle: '30 km/h ve çocuk yayalar',
    description: 'Okul bölgesinden geç. Hız 30 km/h ile sınırlı; çocuklar aniden yola çıkabilir.',
    map: 'city',
    icon: '🏫',
    difficulty: 2,
    minutes: 6,
    category: 'city',
    board: true,
    conditions: { time: 'morning', weather: 'clear', traffic: 0.9, peds: 1.6 },
    skills: ['Hız bölgesi', 'Yaya', 'Tepki'],
    steps: (h) => [driveToLandmark(h, 'okul', '🏫 Okul bölgesine git'), jaywalkerEvent('Okul önünde dikkatli ilerle'), driveToLandmark(h, 'botanik', '🌷 Botanik Bahçesi\'ne devam et')],
    constraints: () => [noPedHit(), noSpeeding()],
  },
  {
    id: 'rush-hour',
    title: 'Yoğun Saat',
    subtitle: 'Takip mesafesi ve ani fren',
    description: 'Akşam trafiği yoğun. Öndeki araç aniden fren yapacak; takip mesafeni koru ve zamanında tepki ver.',
    map: 'city',
    icon: '🚦',
    difficulty: 3,
    minutes: 7,
    category: 'city',
    board: true,
    conditions: { time: 'sunset', weather: 'clear', traffic: 1.8 },
    skills: ['Takip mesafesi', 'Tepki', 'Sabır'],
    steps: (h) => [leadBrakeEvent(), driveToLandmark(h, 'carsi', '🛍️ Kapalı Çarşı\'ya ulaş')],
    constraints: () => [headway(), noCollision(true)],
  },
  {
    id: 'night',
    title: 'Gece Sürüşü',
    subtitle: 'Farlar ve sınırlı görüş',
    description: 'Gece karanlığında üniversite kampüsüne git. Farları açmayı unutma (L).',
    map: 'city',
    icon: '🌙',
    difficulty: 2,
    minutes: 6,
    category: 'city',
    board: true,
    conditions: { time: 'night', weather: 'clear', traffic: 0.7 },
    skills: ['Farlar', 'Görüş'],
    steps: (h) => [driveToLandmark(h, 'kampus', '🎓 Üniversite kampüsüne git')],
    constraints: () => [lightsOn(), noCollision(), noRedLight()],
  },
  {
    id: 'rain',
    title: 'Yağmurlu Yol',
    subtitle: 'Kaygan zemin, uzun duruş',
    description: 'Yağmurda yol tutuşu azalır; takip mesafesi en az 4 saniye olmalı. Hastaneye güvenle ulaş.',
    map: 'city',
    icon: '🌧️',
    difficulty: 3,
    minutes: 6,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'rain', traffic: 1 },
    skills: ['Islak zemin', 'Takip mesafesi'],
    steps: (h) => [driveToLandmark(h, 'hastane', '🏥 Hastaneye git')],
    constraints: () => [headway(), noCollision(), lightsOn()],
  },
  {
    id: 'parallel',
    title: 'Paralel Park',
    subtitle: 'Cadde kenarına park',
    description: 'Yakındaki bir caddede işaretlenen boşluğa paralel park yap.',
    map: 'city',
    icon: '🅿️',
    difficulty: 3,
    minutes: 4,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'clear', traffic: 0.6 },
    skills: ['Paralel park', 'Geri manevra'],
    steps: (h) => {
      const slot = parallelSlot(h);
      if (!slot) return [driveToLandmark(h, 'meydan')];
      return [parkIn('İşaretli boşluğa paralel park et', slot, { parallel: true })];
    },
    constraints: () => [noCollision()],
  },
  {
    id: 'boulevard',
    title: 'Bulvar Şeritleri',
    subtitle: 'Çok şeritli yolda disiplin',
    description: 'Atatürk Bulvarı\'nda şerit değiştir ve meydana git. Her manevrada Ayna → Sinyal → Omuz.',
    map: 'city',
    icon: '🛣️',
    difficulty: 2,
    minutes: 6,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'clear', traffic: 1.2 },
    skills: ['Şerit disiplini', 'MSM'],
    steps: (h) => [laneChange('left', 'Sol şeride geç'), laneChange('right', 'Sağ şeride dön'), laneChange('any', 'Bir şerit değişimi daha yap'), driveToLandmark(h, 'meydan', '🏛️ Belediye Meydanı\'na git')],
    constraints: () => [msmAll(), noCollision()],
  },
  {
    id: 'highway',
    title: 'Çevre Yolu (D-200)',
    subtitle: 'Bölünmüş yolda hız, şerit ve viraj',
    description:
      'Şehir dışındaki 2×3 şeritli çevre yoluna çık. Akışa uygun hızlan, sollamayı soldan yapıp sağa dön, emniyet şeridine girme, virajı 90 km/h ile al ve Millet Bulvarı kavşağından şehre dön.',
    map: 'city',
    icon: '🛣️',
    difficulty: 3,
    minutes: 9,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'clear', traffic: 1 },
    skills: ['Bölünmüş yol', 'Sollama', 'Hız bölgeleri'],
    steps: (h) => [
      driveTo('D-200 çevre yoluna çık (doğu yönü)', ...(Object.values(lanePoint(h, 200, 1166, Math.PI / 2)) as [number, number]), 'D-200 Çevre Yolu', { radius: 14 }),
      reachSpeed(80, 'Akışa uy: 80 km/h üzerine çık (sınır 110)'),
      laneChange('left', 'Sollama için sol şeride geç (ayna → sinyal → omuz)'),
      laneChange('right', 'Sollamayı bitir, sağ şeride dön'),
      driveTo('Virajı dönüp kuzeye devam et', ...(Object.values(lanePoint(h, 1326, 500, Math.PI)) as [number, number]), 'D-200 Kuzey yönü', { radius: 16 }),
      driveToLandmark(h, 'hastane', '🏥 Millet Bulvarı kavşağından şehre dön — Hastane'),
    ],
    constraints: () => [noShoulder(), noRightOvertake(), noCollision(), noRedLight()],
  },
  {
    id: 'roundabouts',
    title: 'Dönel Kavşaklar',
    subtitle: 'Öncelik ve çıkış sinyali',
    description: 'İki dönel kavşaktan geç. Kavşak içindeki araç önceliklidir; girerken yol ver, çıkacağın yoldan önce sağ sinyal ver.',
    map: 'city',
    icon: '⭕',
    difficulty: 2,
    minutes: 7,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'clear', traffic: 1.3 },
    skills: ['Dönel kavşak', 'Geçiş hakkı', 'Sinyal'],
    steps: (h) => [
      roundaboutPass('⭕ Botanik dönelinden batıya (Mevlana Cd.) çık', { ...lanePoint(h, 230, -320, -Math.PI / 2), name: 'Mevlana Caddesi' }),
      roundaboutPass('⭕ Yıldırım dönelinden güneye (İstiklal Cd.) çık', { ...lanePoint(h, -370, 440, 0), name: 'İstiklal Caddesi' }),
    ],
    constraints: () => [rbRules(), noCollision()],
  },
  {
    id: 'zones',
    title: 'Hız Bölgeleri Turu',
    subtitle: '20 · 30 · 40 km/h bölgeler',
    description: 'Yaya öncelikli çarşı (20), hastane (30, korna yasak), şehir merkezi (40) ve okul bölgesinden (30) geç. Levhaları takip et, bölge sınırlarına uy.',
    map: 'city',
    icon: '🚸',
    difficulty: 2,
    minutes: 8,
    category: 'city',
    board: true,
    conditions: { time: 'morning', weather: 'clear', traffic: 1, peds: 1.3 },
    skills: ['Levha okuma', 'Hız bölgeleri', 'Korna yasağı'],
    steps: (h) => [driveToLandmark(h, 'carsi', '🛍️ Yaya öncelikli çarşıdan geç (20 km/h)'), driveToLandmark(h, 'hastane', '🏥 Hastane bölgesi (30 km/h, korna yasak)'), driveToLandmark(h, 'okul', '🏫 Okul bölgesi (30 km/h)', { stop: true })],
    constraints: () => [zoneRules(), noHorn(), noPedHit()],
  },
  {
    id: 'ambulance',
    title: 'Ambulansa Yol Ver',
    subtitle: 'Geçiş üstünlüğü',
    description: 'Sürüş sırasında arkadan sirenli bir ambulans gelecek. Dikizden fark et, sağa yanaş, yavaşla ve geçmesine izin ver.',
    map: 'city',
    icon: '🚑',
    difficulty: 2,
    minutes: 5,
    category: 'city',
    board: true,
    conditions: { time: 'noon', weather: 'clear', traffic: 0.9 },
    skills: ['Geçiş üstünlüğü', 'Ayna kullanımı'],
    steps: (h) => [reachSpeed(30, 'Yola çık, 30 km/h üzerine çık'), emergencyEvent('🚑 Ambulansa yol ver'), driveToLandmark(h, 'meydan', '🏛️ Belediye Meydanı\'na git')],
    constraints: () => [yieldEmergency(), noCollision()],
  },
];

export function missionById(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}
