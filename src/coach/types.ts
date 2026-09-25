export type Component = 'guvenlik' | 'kural' | 'tarama' | 'puruzsuzluk' | 'gorev';

export const COMPONENTS: Component[] = ['guvenlik', 'kural', 'tarama', 'puruzsuzluk', 'gorev'];

export const COMPONENT_META: Record<Component, { title: string; weight: number; tip: string; color: string }> = {
  guvenlik: { title: 'Güvenli sürüş', weight: 0.3, tip: 'Çarpışma, ramak kala, takip mesafesi, ani manevralar', color: '#ef5350' },
  kural: { title: 'Trafik kurallarına uyum', weight: 0.25, tip: 'Hız, ışık, dur/yol ver, sinyal, yön, yaya önceliği', color: '#ffa726' },
  tarama: { title: 'Gözlem', weight: 0.2, tip: 'Ayna / omuz kontrolü, dikiz sıklığı, kavşak taraması', color: '#42a5f5' },
  puruzsuzluk: { title: 'Araç hâkimiyeti', weight: 0.15, tip: 'Sarsıntı (jerk), ivme, yanal g, direksiyon yön değiştirmeleri', color: '#66bb6a' },
  gorev: { title: 'Görev & güzergâh', weight: 0.1, tip: 'Hedefler, rota uyumu, zaman', color: '#ab47bc' },
};

export type Severity = 'positive' | 'info' | 'minor' | 'major' | 'critical';

export type EventKind =
  | 'collision_vehicle'
  | 'collision_static'
  | 'collision_pedestrian'
  | 'hard_crash'
  | 'red_light'
  | 'yellow_risky'
  | 'stop_rolling'
  | 'stop_ignored'
  | 'stop_full'
  | 'yield_fail'
  | 'speeding'
  | 'wrong_way'
  | 'sidewalk'
  | 'median'
  | 'offroad'
  | 'no_signal_turn'
  | 'no_signal_lane'
  | 'late_signal'
  | 'wrong_signal'
  | 'signal_left_on'
  | 'no_mirror_lane'
  | 'no_shoulder_lane'
  | 'no_mirror_turn'
  | 'msm_good'
  | 'wrong_lane_turn'
  | 'hard_brake'
  | 'hard_accel'
  | 'harsh_corner'
  | 'tailgating'
  | 'near_miss'
  | 'ped_not_yielded'
  | 'ped_yielded'
  | 'lane_straddle'
  | 'no_headlights'
  | 'idle_attention'
  | 'mirror_neglect'
  | 'junction_no_scan'
  | 'junction_scan_ok'
  | 'reaction'
  | 'reset'
  | 'reroute'
  | 'objective'
  | 'solid_line_change'
  | 'weaving'
  | 'shoulder_drive'
  | 'right_overtake'
  | 'left_lane_hog'
  | 'too_slow'
  | 'horn_prohibited'
  | 'junction_block'
  | 'rb_yield_fail'
  | 'rb_no_exit_signal'
  | 'rb_good'
  | 'emergency_yield_fail'
  | 'emergency_yield_ok'
  | 'stall'
  | 'zone_speeding'
  | 'stopline_over';

export type CoachEvent = {
  kind: EventKind;
  t: number;
  x: number;
  z: number;
  severity: Severity;
  component: Component;
  message: string;
  value?: number;
};

export const EVENT_META: Record<EventKind, { label: string; component: Component; severity: Severity }> = {
  collision_vehicle: { label: 'Araçla çarpışma', component: 'guvenlik', severity: 'major' },
  collision_static: { label: 'Nesneye/binaya çarpma', component: 'guvenlik', severity: 'minor' },
  collision_pedestrian: { label: 'Yayaya çarpma', component: 'guvenlik', severity: 'critical' },
  hard_crash: { label: 'Ağır kaza', component: 'guvenlik', severity: 'critical' },
  red_light: { label: 'Kırmızı ışık ihlali', component: 'kural', severity: 'major' },
  yellow_risky: { label: 'Riskli sarı ışık geçişi', component: 'kural', severity: 'minor' },
  stop_rolling: { label: 'DUR levhasında tam durmama', component: 'kural', severity: 'minor' },
  stop_ignored: { label: 'DUR levhasını ihlal', component: 'kural', severity: 'major' },
  stop_full: { label: 'DUR levhasında tam duruş', component: 'kural', severity: 'positive' },
  yield_fail: { label: 'Geçiş hakkına uymama', component: 'kural', severity: 'major' },
  speeding: { label: 'Hız ihlali', component: 'kural', severity: 'minor' },
  wrong_way: { label: 'Ters yön', component: 'kural', severity: 'major' },
  sidewalk: { label: 'Kaldırıma çıkma', component: 'kural', severity: 'major' },
  median: { label: 'Refüje çıkma', component: 'kural', severity: 'major' },
  offroad: { label: 'Yol dışı', component: 'kural', severity: 'minor' },
  no_signal_turn: { label: 'Dönüşte sinyal yok', component: 'kural', severity: 'minor' },
  no_signal_lane: { label: 'Şerit değişiminde sinyal yok', component: 'kural', severity: 'minor' },
  late_signal: { label: 'Geç sinyal', component: 'kural', severity: 'info' },
  wrong_signal: { label: 'Ters yöne sinyal', component: 'kural', severity: 'minor' },
  signal_left_on: { label: 'Sinyal açık unutuldu', component: 'kural', severity: 'info' },
  no_mirror_lane: { label: 'Şerit değişiminde ayna kontrolü yok', component: 'tarama', severity: 'minor' },
  no_shoulder_lane: { label: 'Şerit değişiminde omuz kontrolü yok', component: 'tarama', severity: 'info' },
  no_mirror_turn: { label: 'Dönüşte ayna kontrolü yok', component: 'tarama', severity: 'minor' },
  msm_good: { label: 'Ayna → Sinyal → Manevra doğru', component: 'tarama', severity: 'positive' },
  wrong_lane_turn: { label: 'Yanlış şeritten dönüş', component: 'kural', severity: 'minor' },
  hard_brake: { label: 'Sert fren', component: 'puruzsuzluk', severity: 'minor' },
  hard_accel: { label: 'Sert hızlanma', component: 'puruzsuzluk', severity: 'minor' },
  harsh_corner: { label: 'Sert viraj (yanal g)', component: 'puruzsuzluk', severity: 'minor' },
  tailgating: { label: 'Yakın takip', component: 'guvenlik', severity: 'minor' },
  near_miss: { label: 'Ramak kala (TTC)', component: 'guvenlik', severity: 'major' },
  ped_not_yielded: { label: 'Yayaya yol vermeme', component: 'kural', severity: 'major' },
  ped_yielded: { label: 'Yayaya yol verildi', component: 'kural', severity: 'positive' },
  lane_straddle: { label: 'Şerit çizgisi üzerinde seyir', component: 'kural', severity: 'info' },
  no_headlights: { label: 'Gece farlar kapalı', component: 'kural', severity: 'minor' },
  idle_attention: { label: 'Uzun girdi boşluğu (dikkat)', component: 'tarama', severity: 'info' },
  mirror_neglect: { label: 'Uzun süre ayna kontrolü yok', component: 'tarama', severity: 'minor' },
  junction_no_scan: { label: 'Kavşakta yan tarama yok', component: 'tarama', severity: 'minor' },
  junction_scan_ok: { label: 'Kavşak taraması yapıldı', component: 'tarama', severity: 'positive' },
  reaction: { label: 'Tepki süresi ölçümü', component: 'guvenlik', severity: 'info' },
  reset: { label: 'Araç sıfırlandı', component: 'gorev', severity: 'info' },
  reroute: { label: 'Rotadan sapma', component: 'gorev', severity: 'info' },
  objective: { label: 'Görev hedefi', component: 'gorev', severity: 'positive' },
  solid_line_change: { label: 'Düz çizgide şerit değiştirme', component: 'kural', severity: 'major' },
  weaving: { label: 'Zikzak / sık şerit değiştirme', component: 'kural', severity: 'minor' },
  shoulder_drive: { label: 'Emniyet şeridinde seyir', component: 'kural', severity: 'major' },
  right_overtake: { label: 'Sağdan sollama', component: 'kural', severity: 'major' },
  left_lane_hog: { label: 'Sol şeridi gereksiz işgal', component: 'kural', severity: 'minor' },
  too_slow: { label: 'Trafiği engelleyen yavaş seyir', component: 'kural', severity: 'minor' },
  horn_prohibited: { label: 'Korna yasağı ihlali', component: 'kural', severity: 'minor' },
  junction_block: { label: 'Kavşağı tıkama', component: 'kural', severity: 'minor' },
  rb_yield_fail: { label: 'Dönel kavşakta yol vermeme', component: 'kural', severity: 'major' },
  rb_no_exit_signal: { label: 'Dönel kavşak çıkışında sinyal yok', component: 'kural', severity: 'minor' },
  rb_good: { label: 'Dönel kavşak doğru kullanıldı', component: 'kural', severity: 'positive' },
  emergency_yield_fail: { label: 'Geçiş üstünlüğü olan araca yol vermeme', component: 'kural', severity: 'major' },
  emergency_yield_ok: { label: 'Geçiş üstünlüğü olan araca yol verildi', component: 'kural', severity: 'positive' },
  stall: { label: 'Motor stop etti', component: 'puruzsuzluk', severity: 'minor' },
  zone_speeding: { label: 'Özel bölgede hız ihlali', component: 'kural', severity: 'major' },
  stopline_over: { label: 'Durma çizgisi aşıldı', component: 'kural', severity: 'minor' },
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  positive: 'Olumlu',
  info: 'Bilgi',
  minor: 'Hafif',
  major: 'Ciddi',
  critical: 'Kritik',
};
