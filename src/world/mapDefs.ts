/**
 * Declarative map layouts. Roads are straight lines on a (non-uniform) grid:
 *  - `ns` lines have constant x and run along z (north = −z, south = +z)
 *  - `ew` lines have constant z and run along x (west = −x, east = +x)
 * The road network, blocks, buildings and props are all generated from this.
 */

export type RoadClass = 'boulevard' | 'avenue' | 'street' | 'residential' | 'oneway';

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
  | 'campus';

export type Landmark = { id: string; name: string; x: number; z: number; icon: string };

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

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
  /** Areas with a reduced speed limit (e.g. school zone). */
  zones: { rect: Rect; limit: number; label: string }[];
  landmarks: Landmark[];
  spawn: { x: number; z: number; heading: number };
  /** Ambient car population multiplier. */
  trafficScale: number;
};

const CITY_W = 640;
const CITY_N = -580;
const CITY_S = 580;
const CITY_E = 700;

export const CITY_MAP: MapDef = {
  id: 'city',
  name: 'Merkez Şehir',
  subtitle: 'Serbest sürüş + seçmeli görevler',
  description:
    'Bulvarlar, tek yönlü caddeler, okul bölgesi, çarşı ve sanayi bölgesiyle ~1,3 km² şehir. Görev panosundan (J) istediğin görevi seç.',
  seed: 20260925,
  extent: { minX: -CITY_W - 160, maxX: CITY_E + 160, minZ: CITY_N - 160, maxZ: CITY_S + 160 },
  ns: [
    { pos: -CITY_W, cls: 'boulevard', name: 'Çevre Yolu Batı' },
    { pos: -500, cls: 'street', name: 'Lale Caddesi', from: CITY_N, to: CITY_S },
    { pos: -370, cls: 'avenue', name: 'İstiklal Caddesi' },
    { pos: -250, cls: 'residential', name: 'Menekşe Sokak', from: -440, to: 470, gaps: [[-90, 20]] },
    { pos: -140, cls: 'oneway', name: 'Kıbrıs Caddesi', oneway: 1, from: -440, to: 470 },
    { pos: -20, cls: 'boulevard', name: 'Atatürk Bulvarı' },
    { pos: 100, cls: 'oneway', name: 'Gazi Caddesi', oneway: -1, from: -440, to: 470 },
    { pos: 210, cls: 'residential', name: 'Papatya Sokak', from: -440, to: 470, gaps: [[-320, -200]] },
    { pos: 320, cls: 'avenue', name: 'Cumhuriyet Caddesi' },
    { pos: 440, cls: 'street', name: 'Zafer Caddesi', from: CITY_N, to: CITY_S },
    { pos: 570, cls: 'residential', name: 'Çınar Sokak', from: -440, to: 470 },
    { pos: CITY_E, cls: 'boulevard', name: 'Çevre Yolu Doğu' },
  ],
  ew: [
    { pos: CITY_N, cls: 'boulevard', name: 'Çevre Yolu Kuzey' },
    { pos: -440, cls: 'street', name: 'Karanfil Caddesi' },
    { pos: -320, cls: 'avenue', name: 'Mevlana Caddesi' },
    { pos: -200, cls: 'residential', name: 'Akasya Sokak', from: -500, to: 570, gaps: [[-20, 100]] },
    { pos: -90, cls: 'oneway', name: 'Fatih Caddesi', oneway: 1, from: -500, to: 570 },
    { pos: 20, cls: 'boulevard', name: 'Millet Bulvarı' },
    { pos: 130, cls: 'oneway', name: 'Barış Caddesi', oneway: -1, from: -500, to: 570 },
    { pos: 240, cls: 'residential', name: 'Gül Sokak', from: -500, to: 570, gaps: [[-370, -250]] },
    { pos: 360, cls: 'avenue', name: 'Yıldırım Caddesi' },
    { pos: 470, cls: 'street', name: 'Ihlamur Caddesi' },
    { pos: CITY_S, cls: 'boulevard', name: 'Çevre Yolu Güney' },
  ],
  district: (x, z) => {
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
  zones: [{ rect: { minX: 190, maxX: 340, minZ: 225, maxZ: 375 }, limit: 30, label: 'OKUL BÖLGESİ' }],
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
