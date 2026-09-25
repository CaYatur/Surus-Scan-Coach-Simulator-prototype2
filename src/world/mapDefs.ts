/**
 * Declarative map layouts. Roads are straight lines on a (non-uniform) grid:
 *  - `ns` lines have constant x and run along z (north = −z, south = +z)
 *  - `ew` lines have constant z and run along x (west = −x, east = +x)
 * The road network, blocks, buildings and props are all generated from this.
 * Where two highway lines meet at a corner the junction becomes a large-radius bend;
 * listed crossings can be built as roundabouts.
 */

export type RoadClass = 'highway' | 'boulevard' | 'avenue' | 'street' | 'residential' | 'oneway';

export type LineDef = {
  pos: number;
  cls: RoadClass;
  name: string;
  /** Extent along the line (defaults to the map extent). */
  from?: number;
  to?: number;
  /** Removed spans along the line, in line coordinates. */
  gaps?: [number, number][];
  /** One-way direction: +1 = toward increasing coordinate, −1 = decreasing. */
  oneway?: 1 | -1;
  /** Speed limit override (km/h). */
  limit?: number;
};

export type District =
  | 'downtown'
  | 'commercial'
  | 'residential'
  | 'suburb'
  | 'park'
  | 'plaza'
  | 'school'
  | 'industrial'
  | 'lot'
  | 'hospital'
  | 'mosque'
  | 'campus'
  | 'farm'
  | 'forest'
  | 'fuel';

export type Landmark = { id: string; name: string; x: number; z: number; icon: string };

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export type ZoneKind = 'school' | 'hospital' | 'market' | 'downtown' | 'campus' | 'park' | 'approach' | 'rural';

export type SpeedZone = {
  rect: Rect;
  limit: number;
  label: string;
  kind: ZoneKind;
  /** Only roads of these classes are affected (default: all). */
  classes?: RoadClass[];
  /** 'cap' lowers the class limit (default); 'set' replaces it (e.g. 90 outside town). */
  mode?: 'cap' | 'set';
  /** Horn use is prohibited (hospital / school). */
  noHorn?: boolean;
};

export type MapDef = {
  id: 'training' | 'city';
  name: string;
  subtitle: string;
  description: string;
  seed: number;
  extent: Rect;
  ns: LineDef[];
  ew: LineDef[];
  district: (x: number, z: number) => District;
  /** Areas where the sidewalk is cut for a driveway (drivable, not a violation). */
  sidewalkCuts: Rect[];
  /** Areas that are legal to drive in although not road (parking lots, driveways). */
  drivableAreas: Rect[];
  /** Areas with their own speed limit (school zone, hospital, outside town …). */
  zones: SpeedZone[];
  /** Crossings built as roundabouts (grid intersection points). */
  roundabouts?: { x: number; z: number; island?: number }[];
  /** Centre-line radius of highway corner bends (m). */
  bendRadius?: number;
  /** Built-up area (town entry / exit signs are placed on its boundary). */
  town?: { rect: Rect; name: string };
  landmarks: Landmark[];
  spawn: { x: number; z: number; heading: number };
  /** Ambient car population multiplier. */
  trafficScale: number;
};

const CITY_W = -640;
const CITY_N = -580;
const CITY_S = 580;
const CITY_E = 700;
// Highway ring (divided 2×3-lane road) around the town
const HW_W = -1260;
const HW_E = 1320;
const HW_N = -1160;
const HW_S = 1160;

/** Tiny deterministic value noise for field / forest patches. */
function patch(x: number, z: number): number {
  const s = Math.sin(x * 0.0061 + z * 0.0047) * 0.5 + Math.sin(x * 0.0023 - z * 0.0089 + 1.7) * 0.5;
  return s;
}

export const CITY_MAP: MapDef = {
  id: 'city',
  name: 'Merkez Şehir',
  subtitle: 'Serbest sürüş + seçmeli görevler',
  description:
    'Bulvarlar, tek yönlü caddeler, göbekli kavşaklar, okul/hastane/çarşı hız bölgeleri ve şehri çevreleyen ~10 km\'lik 2×3 şeritli bölünmüş çevre yolu. Görev panosundan (J) istediğin görevi seç.',
  seed: 20260925,
  extent: { minX: HW_W - 260, maxX: HW_E + 260, minZ: HW_N - 260, maxZ: HW_S + 260 },
  ns: [
    { pos: HW_W, cls: 'highway', name: 'D-200 Çevre Yolu', from: HW_N, to: HW_S },
    { pos: CITY_W, cls: 'boulevard', name: 'Kuşak Yolu Batı', from: CITY_N, to: CITY_S },
    { pos: -500, cls: 'street', name: 'Lale Caddesi', from: CITY_N, to: CITY_S },
    { pos: -370, cls: 'avenue', name: 'İstiklal Caddesi', from: CITY_N, to: CITY_S },
    { pos: -250, cls: 'residential', name: 'Menekşe Sokak', from: -440, to: 470, gaps: [[-90, 20]] },
    { pos: -140, cls: 'oneway', name: 'Kıbrıs Caddesi', oneway: 1, from: -440, to: 470 },
    { pos: -20, cls: 'boulevard', name: 'Atatürk Bulvarı', from: HW_N, to: HW_S, limit: 60 },
    { pos: 100, cls: 'oneway', name: 'Gazi Caddesi', oneway: -1, from: -440, to: 470 },
    { pos: 210, cls: 'residential', name: 'Papatya Sokak', from: -440, to: 470, gaps: [[-320, -200]] },
    { pos: 320, cls: 'avenue', name: 'Cumhuriyet Caddesi', from: CITY_N, to: CITY_S },
    { pos: 440, cls: 'street', name: 'Zafer Caddesi', from: CITY_N, to: HW_S },
    { pos: 570, cls: 'residential', name: 'Çınar Sokak', from: -440, to: 470 },
    { pos: CITY_E, cls: 'boulevard', name: 'Kuşak Yolu Doğu', from: CITY_N, to: CITY_S },
    { pos: HW_E, cls: 'highway', name: 'D-200 Çevre Yolu', from: HW_N, to: HW_S },
  ],
  ew: [
    { pos: HW_N, cls: 'highway', name: 'D-200 Çevre Yolu', from: HW_W, to: HW_E },
    { pos: CITY_N, cls: 'boulevard', name: 'Kuşak Yolu Kuzey', from: CITY_W, to: CITY_E },
    { pos: -440, cls: 'street', name: 'Karanfil Caddesi', from: HW_W, to: CITY_E },
    { pos: -320, cls: 'avenue', name: 'Mevlana Caddesi', from: CITY_W, to: CITY_E },
    { pos: -200, cls: 'residential', name: 'Akasya Sokak', from: -500, to: 570, gaps: [[-20, 100]] },
    { pos: -90, cls: 'oneway', name: 'Fatih Caddesi', oneway: 1, from: -500, to: 570 },
    { pos: 20, cls: 'boulevard', name: 'Millet Bulvarı', from: HW_W, to: HW_E, limit: 60 },
    { pos: 130, cls: 'oneway', name: 'Barış Caddesi', oneway: -1, from: -500, to: 570 },
    { pos: 240, cls: 'residential', name: 'Gül Sokak', from: -500, to: 570, gaps: [[-370, -250]] },
    { pos: 360, cls: 'avenue', name: 'Yıldırım Caddesi', from: CITY_W, to: CITY_E },
    { pos: 470, cls: 'street', name: 'Ihlamur Caddesi', from: CITY_W, to: CITY_E },
    { pos: CITY_S, cls: 'boulevard', name: 'Kuşak Yolu Güney', from: CITY_W, to: CITY_E },
    { pos: HW_S, cls: 'highway', name: 'D-200 Çevre Yolu', from: HW_W, to: HW_E },
  ],
  district: (x, z) => {
    const inTown = x > CITY_W - 1 && x < CITY_E + 1 && z > CITY_N - 1 && z < CITY_S + 1;
    if (!inTown) {
      // Rural band between the town and the ring road
      if (x > -20 && x < 100 && z > CITY_S && z < HW_S) return 'fuel';
      if (x > HW_W && x < CITY_W && z > 20 && z < 130) return 'fuel';
      if (x > 440 && z > CITY_S - 1 && z < HW_S) return 'industrial';
      return patch(x, z) > 0.35 ? 'forest' : 'farm';
    }
    if (x > -250 && x < -140 && z > -90 && z < 20) return 'park';
    if (x > 210 && x < 320 && z > -320 && z < -200) return 'park';
    if (x > -20 && x < 100 && z > 20 && z < 130) return 'plaza';
    if (x > 210 && x < 320 && z > 240 && z < 360) return 'school';
    if (x > 440 && x < 570 && z > -90 && z < 20) return 'hospital';
    if (x > -370 && x < -250 && z > 130 && z < 240) return 'mosque';
    if (x > 100 && x < 210 && z > -440 && z < -320) return 'mosque';
    if (x > -500 && x < -370 && z > -440 && z < -320) return 'campus';
    if (x > 440 && z > 360) return 'industrial';
    if (x < -500 && z > 360) return 'industrial';
    const r = Math.max(Math.abs((x - 40) / 330), Math.abs((z + 30) / 300));
    if (r < 0.55) return 'downtown';
    if (r < 0.9) return 'commercial';
    if (r < 1.55) return 'residential';
    return 'suburb';
  },
  sidewalkCuts: [],
  drivableAreas: [],
  zones: [
    { rect: { minX: 190, maxX: 340, minZ: 225, maxZ: 375 }, limit: 30, label: 'OKUL BÖLGESİ', kind: 'school', noHorn: true },
    { rect: { minX: 425, maxX: 585, minZ: -105, maxZ: 35 }, limit: 30, label: 'HASTANE BÖLGESİ', kind: 'hospital', noHorn: true },
    { rect: { minX: 95, maxX: 215, minZ: -205, maxZ: -85 }, limit: 20, label: 'YAYA ÖNCELİKLİ ÇARŞI', kind: 'market' },
    { rect: { minX: -505, maxX: -365, minZ: -445, maxZ: -315 }, limit: 30, label: 'KAMPÜS', kind: 'campus' },
    { rect: { minX: -255, maxX: -135, minZ: -95, maxZ: 25 }, limit: 30, label: 'PARK ÇEVRESİ', kind: 'park' },
    { rect: { minX: 205, maxX: 325, minZ: -325, maxZ: -195 }, limit: 30, label: 'PARK ÇEVRESİ', kind: 'park' },
    { rect: { minX: -145, maxX: 225, minZ: -210, maxZ: 140 }, limit: 40, label: 'ŞEHİR MERKEZİ', kind: 'downtown', classes: ['street', 'oneway', 'avenue'] },
    // Outside the built-up area the general limit applies (cars: 90 km/h)
    { rect: { minX: HW_W, maxX: CITY_W - 12, minZ: HW_N, maxZ: HW_S }, limit: 90, label: 'YERLEŞİM YERİ DIŞI', kind: 'rural', classes: ['street', 'avenue', 'boulevard'], mode: 'set' },
    { rect: { minX: CITY_E + 12, maxX: HW_E, minZ: HW_N, maxZ: HW_S }, limit: 90, label: 'YERLEŞİM YERİ DIŞI', kind: 'rural', classes: ['street', 'avenue', 'boulevard'], mode: 'set' },
    { rect: { minX: CITY_W, maxX: CITY_E, minZ: HW_N, maxZ: CITY_N - 12 }, limit: 90, label: 'YERLEŞİM YERİ DIŞI', kind: 'rural', classes: ['street', 'avenue', 'boulevard'], mode: 'set' },
    { rect: { minX: CITY_W, maxX: CITY_E, minZ: CITY_S + 12, maxZ: HW_S }, limit: 90, label: 'YERLEŞİM YERİ DIŞI', kind: 'rural', classes: ['street', 'avenue', 'boulevard'], mode: 'set' },
    // Signalised junctions on the ring road: step-down to 70
    { rect: { minX: -340, maxX: 300, minZ: HW_S - 30, maxZ: HW_S + 30 }, limit: 70, label: 'KAVŞAK YAKLAŞIMI', kind: 'approach', classes: ['highway'] },
    { rect: { minX: 120, maxX: 760, minZ: HW_S - 30, maxZ: HW_S + 30 }, limit: 70, label: 'KAVŞAK YAKLAŞIMI', kind: 'approach', classes: ['highway'] },
    { rect: { minX: -340, maxX: 300, minZ: HW_N - 30, maxZ: HW_N + 30 }, limit: 70, label: 'KAVŞAK YAKLAŞIMI', kind: 'approach', classes: ['highway'] },
    { rect: { minX: HW_W - 30, maxX: HW_W + 30, minZ: -760, maxZ: 340 }, limit: 70, label: 'KAVŞAK YAKLAŞIMI', kind: 'approach', classes: ['highway'] },
    { rect: { minX: HW_E - 30, maxX: HW_E + 30, minZ: -300, maxZ: 340 }, limit: 70, label: 'KAVŞAK YAKLAŞIMI', kind: 'approach', classes: ['highway'] },
  ],
  roundabouts: [
    { x: 320, z: -320, island: 8 },
    { x: -370, z: 360, island: 8 },
  ],
  bendRadius: 210,
  town: { rect: { minX: CITY_W - 10, maxX: CITY_E + 10, minZ: CITY_N - 10, maxZ: CITY_S + 10 }, name: 'MERKEZ' },
  landmarks: [
    { id: 'meydan', name: 'Belediye Meydanı', x: 40, z: 75, icon: '🏛️' },
    { id: 'park', name: 'Kent Parkı', x: -195, z: -35, icon: '🌳' },
    { id: 'okul', name: 'Atatürk İlkokulu', x: 265, z: 300, icon: '🏫' },
    { id: 'hastane', name: 'Devlet Hastanesi', x: 505, z: -35, icon: '🏥' },
    { id: 'cami', name: 'Merkez Camii', x: -310, z: 185, icon: '🕌' },
    { id: 'kampus', name: 'Üniversite Kampüsü', x: -435, z: -380, icon: '🎓' },
    { id: 'sanayi', name: 'Sanayi Sitesi', x: 560, z: 520, icon: '🏭' },
    { id: 'botanik', name: 'Botanik Bahçesi', x: 265, z: -260, icon: '🌷' },
    { id: 'carsi', name: 'Kapalı Çarşı', x: 160, z: -145, icon: '🛍️' },
    { id: 'akaryakit', name: 'Akaryakıt İstasyonu', x: 20, z: 650, icon: '⛽' },
    { id: 'lojistik', name: 'Lojistik Merkezi', x: 470, z: 880, icon: '🚚' },
    { id: 'orman', name: 'Orman Yolu', x: -1000, z: -440, icon: '🌲' },
    { id: 'cevreyolu', name: 'D-200 Çevre Yolu', x: 200, z: 1166, icon: '🛣️' },
  ],
  spawn: { x: -14.9, z: 200, heading: Math.PI },
  trafficScale: 1,
};

const T_W = -260;
const T_E = 260;
const T_N = -170;
const T_S = 170;

export const TRAINING_MAP: MapDef = {
  id: 'training',
  name: 'Eğitim Alanı',
  subtitle: 'Kalibrasyon programı ve temel beceri alıştırmaları',
  description:
    'Sakin trafikli, işaretli kavşaklar, bulvar, dur levhası ve park alanı içeren sürücü kursu bölgesi. Yönlendirmeli adımlarla kişisel sürüş profilin çıkarılır.',
  seed: 7719,
  extent: { minX: T_W - 140, maxX: T_E + 140, minZ: T_N - 140, maxZ: T_S + 140 },
  ns: [
    { pos: T_W, cls: 'street', name: 'Kurs Sokak' },
    { pos: -100, cls: 'street', name: 'Direksiyon Caddesi', from: T_N, to: 60 },
    { pos: 30, cls: 'residential', name: 'Ayna Sokak', from: T_N, to: 60 },
    { pos: 150, cls: 'street', name: 'Sinyal Caddesi', from: T_N, to: 60 },
    { pos: T_E, cls: 'street', name: 'Park Sokak' },
  ],
  ew: [
    { pos: T_N, cls: 'street', name: 'Kuzey Yolu' },
    { pos: -50, cls: 'avenue', name: 'Eğitim Bulvarı' },
    { pos: 60, cls: 'residential', name: 'Dur Sokak' },
    { pos: T_S, cls: 'street', name: 'Güney Yolu' },
  ],
  district: (x, z) => {
    if (z > 60 && x < -60) return 'lot';
    if (z > 60 && x < 120) return 'park';
    if (x > -100 && x < 30 && z > -170 && z < -50) return 'school';
    if (z > 60) return 'suburb';
    if (z < -50) return 'commercial';
    return 'residential';
  },
  sidewalkCuts: [{ minX: -205, maxX: -187, minZ: 60, maxZ: 72 }],
  drivableAreas: [
    { minX: -250, maxX: -110, minZ: 70, maxZ: 162 },
    { minX: -205, maxX: -187, minZ: 60, maxZ: 72 },
  ],
  zones: [],
  landmarks: [
    { id: 'kurs', name: 'Sürücü Kursu', x: -160, z: -110, icon: '🚗' },
    { id: 'otopark', name: 'Park Alanı', x: -180, z: 115, icon: '🅿️' },
  ],
  spawn: { x: -102, z: -140, heading: 0 },
  trafficScale: 0.55,
};

export const MAPS: Record<MapDef['id'], MapDef> = {
  training: TRAINING_MAP,
  city: CITY_MAP,
};
