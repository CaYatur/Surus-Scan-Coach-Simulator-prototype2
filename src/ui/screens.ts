import { el, esc, fmtDate, scoreColor, download } from './dom';
import { lineChart, radarSvg, stars } from './charts';
import { settings, DEFAULT_SETTINGS, type Settings, type QualityLevel } from '../core/settings';
import { MISSIONS, missionById } from '../missions/catalog';
import type { MissionDef, MissionCategory } from '../missions/mission';
import { MAPS } from '../world/mapDefs';
import { TIME_LABEL, WEATHER_LABEL, type TimeOfDay, type Weather } from '../world/environment';
import {
  activeProfile,
  activeProfileId,
  BADGES,
  createProfile,
  deleteProfile,
  exportProfiles,
  importProfiles,
  loadProfiles,
  renameProfile,
  selectProfile,
  type Profile,
} from '../coach/profiles';
import { COMPONENTS, COMPONENT_META } from '../coach/types';
import { letterGrade } from '../coach/metrics';
import type { SessionConfig } from '../game/session';
import { Input } from '../input/input';
import type { HeadTracker } from '../input/headTracker';
import { audio } from '../audio/audio';
import { storage } from '../core/storage';

export interface AppApi {
  startSession(cfg: SessionConfig): void;
  resume(): void;
  finishSegment(): void;
  restartSession(): void;
  quitToMenu(): void;
  startBoardMission(id: string): void;
  qualityChanged(): void;
  inSession(): boolean;
  sessionMapId(): 'training' | 'city' | null;
  bigMap(canvas: HTMLCanvasElement): ((sx: number, sy: number) => void) | null;
  head: HeadTracker;
  detectedQuality: QualityLevel;
}

type ScreenName = 'main' | 'free' | 'missions' | 'karne' | 'settings' | 'help' | 'profiles';

const LAST_CFG = 'ssc-last-config';

/** All full-screen menus and in-drive overlays. */
export class Screens {
  readonly root: HTMLElement;
  private app: AppApi;
  private stack: ScreenName[] = [];
  private overlay: HTMLElement;
  private settingsTimer = 0;
  onOverlayChange: ((open: boolean) => void) | null = null;

  constructor(host: HTMLElement, app: AppApi) {
    this.app = app;
    this.root = el('div', { id: 'menu-root' });
    this.overlay = el('div', { id: 'overlay-root', class: 'hidden' });
    host.append(this.root, this.overlay);
  }

  // ——————————————————————————— navigation ———————————————————————————

  show(name: ScreenName, push = true) {
    audio.cue('ui');
    if (push) this.stack.push(name);
    this.root.classList.remove('hidden');
    this.root.innerHTML = '';
    window.clearInterval(this.settingsTimer);
    const page = this.build(name);
    this.root.append(page);
  }

  back() {
    this.stack.pop();
    const prev = this.stack[this.stack.length - 1] ?? 'main';
    if (this.app.inSession() && !this.stack.length) {
      this.hideMenus();
      this.app.resume();
      return;
    }
    this.show(prev, false);
  }

  hideMenus() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.stack = [];
    window.clearInterval(this.settingsTimer);
  }

  private build(name: ScreenName): HTMLElement {
    switch (name) {
      case 'main':
        return this.mainMenu();
      case 'free':
        return this.freeSetup();
      case 'missions':
        return this.missionsScreen();
      case 'karne':
        return this.karneScreen();
      case 'settings':
        return this.settingsScreen();
      case 'help':
        return this.helpScreen();
      case 'profiles':
        return this.profilesScreen();
    }
  }

  private frame(title: string, content: HTMLElement[], opts: { back?: boolean; wide?: boolean } = {}): HTMLElement {
    const head = el('div', { class: 'scr-head' }, [
      opts.back !== false ? this.btn('← Geri', 'ghost', () => this.back()) : el('span'),
      el('h2', { text: title }),
      this.profileChip(),
    ]);
    return el('div', { class: `screen ${opts.wide ? 'wide' : ''}` }, [head, el('div', { class: 'scr-body' }, content)]);
  }

  private btn(text: string, kind: string, fn: () => void, attrs: Record<string, string> = {}) {
    const b = el('button', { class: `btn ${kind}`, text, ...attrs });
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  }

  private profileChip(): HTMLElement {
    const p = activeProfile();
    const chip = el('button', {
      class: 'profile-chip',
      html: p
        ? `<span class="avatar" style="background:${p.color}">${esc(p.name[0]?.toUpperCase() ?? '?')}</span><span><b>${esc(p.name)}</b><small>Karne ${p.karne.overall} · ${letterGrade(p.karne.overall)}</small></span>`
        : '<span class="avatar">?</span><span><b>Misafir</b><small>Profil seç / oluştur</small></span>',
    });
    chip.onclick = () => this.show('profiles');
    return chip;
  }

  // ——————————————————————————— main ———————————————————————————

  private mainMenu(): HTMLElement {
    const p = activeProfile();
    const calibrated = !!p?.baseline.ready;
    const tile = (icon: string, title: string, sub: string, fn: () => void, cls = '') => {
      const t = el('button', { class: `menu-tile ${cls}`, html: `<span class="mt-i">${icon}</span><span class="mt-t">${esc(title)}</span><span class="mt-s">${esc(sub)}</span>` });
      t.onclick = fn;
      return t;
    };
    const hero = el('div', {
      class: 'hero',
      html: `<div class="logo"><span class="logo-mark">◎</span><div><h1>SÜRÜŞ KOÇU</h1><p>Scan Coach Simülatörü · tarama, kural ve güvenli sürüş eğitimi</p></div></div>`,
    });
    const tiles = el('div', { class: 'menu-tiles' }, [
      tile('🚗', 'Serbest Sürüş', 'Şehirde dolaş, istediğin görevi seç', () => this.show('free'), 'primary'),
      tile('🎯', 'Görevler', 'Kalibrasyon, beceri ve şehir görevleri', () => this.show('missions')),
      tile(calibrated ? '✅' : '🧭', calibrated ? 'Kalibrasyonu Yenile' : 'Kalibrasyon Programı', calibrated ? 'Kişisel profilin hazır' : 'Önerilen ilk adım (~7 dk)', () => this.startMission('calibration')),
      tile('📋', 'Sürücü Karnesi', p ? `${p.karne.sessions} oturum · ${p.badges.length} rozet` : 'Profil gerektirir', () => this.show('karne')),
      tile('⚙️', 'Ayarlar', 'Grafik, kontrol, direksiyon, tarama modu', () => this.show('settings')),
      tile('❓', 'Nasıl Oynanır', 'Kontroller ve puanlama', () => this.show('help')),
    ]);
    const note = el('div', {
      class: 'main-note',
      html: !p
        ? 'İpucu: Karne ve kişisel profil için <b>profil oluşturun</b> (sağ üst). Misafir sürüşleri kaydedilmez.'
        : !calibrated
          ? 'İpucu: Önce <b>Kalibrasyon Programı</b>\'nı tamamlayın — kişisel sürüş stiliniz çıkarılır ve sonraki sürüşler buna göre de yorumlanır.'
          : `Hoş geldin <b>${esc(p.name)}</b>. Son oturum: ${p.sessions[0] ? `${esc(p.sessions[0].missionTitle ?? (p.sessions[0].kind === 'free' ? 'Serbest sürüş' : p.sessions[0].kind))} — ${p.sessions[0].overall} puan` : '—'}`,
    });
    const wrap = el('div', { class: 'main' }, [el('div', { class: 'main-top' }, [el('span'), this.profileChip()]), hero, tiles, note, el('div', { class: 'version', text: 'v1.0 · Three.js · tarayıcıda çalışır, veriler cihazında kalır' })]);
    return wrap;
  }

  // ——————————————————————————— free drive setup ———————————————————————————

  private lastCfg(): SessionConfig {
    return storage.get<SessionConfig>(LAST_CFG, { mapId: 'city', mode: 'free', time: 'noon', weather: 'clear', traffic: 1, peds: 1 });
  }

  private freeSetup(): HTMLElement {
    const cfg = { ...this.lastCfg(), mode: 'free' as const };
    const s = settings.get();
    const maps = el('div', { class: 'map-cards' });
    const renderMaps = () => {
      maps.innerHTML = '';
      for (const id of ['city', 'training'] as const) {
        const m = MAPS[id];
        const c = el('button', {
          class: `map-card ${cfg.mapId === id ? 'sel' : ''}`,
          html: `<div class="mc-img mc-${id}"></div><div class="mc-t">${esc(m.name)}</div><div class="mc-s">${esc(m.subtitle)}</div><p>${esc(m.description)}</p>`,
        });
        c.onclick = () => {
          cfg.mapId = id;
          renderMaps();
        };
        maps.append(c);
      }
    };
    renderMaps();
    const seg = <T extends string>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void) => {
      const row = el('div', { class: 'seg' });
      const draw = () => {
        row.innerHTML = '';
        for (const [v, t] of opts) {
          const b = el('button', { class: get() === v ? 'active' : '', text: t });
          b.onclick = () => {
            set(v);
            draw();
          };
          row.append(b);
        }
      };
      draw();
      return el('div', { class: 'field' }, [el('label', { text: label }), row]);
    };
    const range = (label: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const val = el('span', { class: 'rv', text: fmt(get()) });
      const inp = el('input', { type: 'range', min: 0, max: 2, step: 0.1, value: get() });
      inp.oninput = () => {
        set(parseFloat(inp.value));
        val.textContent = fmt(get());
      };
      return el('div', { class: 'field' }, [el('label', {}, [label, val]), inp]);
    };
    const density = (v: number) => (v === 0 ? 'Yok' : v < 0.6 ? 'Az' : v < 1.3 ? 'Normal' : v < 1.7 ? 'Yoğun' : 'Çok yoğun');
    const colors = ['#f2f4f7', '#1f2328', '#b3262b', '#27496d', '#9aa0a6', '#2f5a3a', '#c9a227', '#6f5a45'];
    const carRow = el('div', { class: 'car-pick' });
    const drawCars = () => {
      carRow.innerHTML = '';
      for (const [t, name] of [['hatch', 'Hatchback'], ['sedan', 'Sedan'], ['suv', 'SUV']] as const) {
        const b = el('button', { class: `seg-btn ${settings.get().playerCar === t ? 'active' : ''}`, text: name });
        b.onclick = () => {
          settings.update({ playerCar: t });
          drawCars();
        };
        carRow.append(b);
      }
      for (const c of colors) {
        const sw = el('button', { class: `swatch ${settings.get().playerColor === c ? 'active' : ''}`, style: `background:${c}` });
        sw.onclick = () => {
          settings.update({ playerColor: c });
          drawCars();
        };
        carRow.append(sw);
      }
    };
    drawCars();
    const form = el('div', { class: 'card form' }, [
      seg<TimeOfDay>('Zaman', (Object.keys(TIME_LABEL) as TimeOfDay[]).map((k) => [k, TIME_LABEL[k]]), () => cfg.time, (v) => (cfg.time = v)),
      seg<Weather>('Hava', (Object.keys(WEATHER_LABEL) as Weather[]).map((k) => [k, WEATHER_LABEL[k]]), () => cfg.weather, (v) => (cfg.weather = v)),
      range('Trafik yoğunluğu', () => cfg.traffic, (v) => (cfg.traffic = v), density),
      range('Yaya yoğunluğu', () => cfg.peds, (v) => (cfg.peds = v), density),
      el('div', { class: 'field' }, [el('label', { text: 'Araç' }), carRow]),
      this.toggleRow('Sürpriz olaylar', 'surpriseEvents', 'Ani fren yapan araçlar, yola çıkan yayalar (tepki ölçümü)'),
      this.toggleRow('Yol rehber çizgisi', 'routeGuideLine', 'Navigasyon rotası yolda mavi oklarla gösterilir'),
    ]);
    void s;
    const start = this.btn('Sürüşe Başla ▶', 'primary big', () => {
      storage.set(LAST_CFG, cfg);
      this.app.startSession({ ...cfg });
    });
    return this.frame('Serbest Sürüş', [el('div', { class: 'grid-setup' }, [maps, form]), el('div', { class: 'actions' }, [start])], { wide: true });
  }

  // ——————————————————————————— missions ———————————————————————————

  private missionTab: MissionCategory = 'calibration';

  private missionsScreen(): HTMLElement {
    const tabs = el('div', { class: 'seg tabs-big' });
    const grid = el('div', { class: 'mission-grid' });
    const p = activeProfile();
    const draw = () => {
      tabs.innerHTML = '';
      for (const [k, t] of [['calibration', '🎯 Kalibrasyon'], ['skill', '🧩 Beceri'], ['city', '🏙️ Şehir']] as [MissionCategory, string][]) {
        const b = el('button', { class: this.missionTab === k ? 'active' : '', text: t });
        b.onclick = () => {
          this.missionTab = k;
          draw();
        };
        tabs.append(b);
      }
      grid.innerHTML = '';
      for (const m of MISSIONS.filter((x) => x.category === this.missionTab)) grid.append(this.missionCard(m, p));
    };
    draw();
    return this.frame('Görevler', [tabs, grid], { wide: true });
  }

  private missionCard(m: MissionDef, p: Profile | null): HTMLElement {
    const best = p?.missionBest[m.id];
    const cond = m.conditions ? `${m.conditions.time ? TIME_LABEL[m.conditions.time] : ''}${m.conditions.weather ? ' · ' + WEATHER_LABEL[m.conditions.weather] : ''}` : '';
    const card = el('button', {
      class: 'mission-card',
      html: `<div class="mc-top"><span class="mc-icon">${m.icon}</span><span class="mc-diff">${'●'.repeat(m.difficulty)}<span class="off">${'●'.repeat(3 - m.difficulty)}</span></span></div>
        <div class="mc-title">${esc(m.title)}</div><div class="mc-sub">${esc(m.subtitle)}</div>
        <p>${esc(m.description)}</p>
        <div class="mc-tags">${m.skills.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
        <div class="mc-foot"><span>⏱ ~${m.minutes} dk · ${esc(MAPS[m.map].name)}${cond ? ' · ' + esc(cond) : ''}</span>${best ? `<span>${stars(best.stars)} ${best.score}</span>` : '<span class="muted">Yeni</span>'}</div>`,
    });
    card.onclick = () => this.startMission(m.id);
    return card;
  }

  private startMission(id: string) {
    const m = missionById(id);
    if (!m) return;
    const base = this.lastCfg();
    this.app.startSession({ mapId: m.map, mode: 'mission', missionId: id, time: m.conditions?.time ?? 'noon', weather: m.conditions?.weather ?? 'clear', traffic: m.conditions?.traffic ?? base.traffic, peds: m.conditions?.peds ?? 1 });
  }

  // ——————————————————————————— karne ———————————————————————————

  private karneScreen(): HTMLElement {
    const p = activeProfile();
    if (!p) {
      return this.frame('Sürücü Karnesi', [
        el('div', { class: 'card center', html: '<p>Karne için bir profil seçin veya oluşturun.</p>' }, [this.btn('Profiller', 'primary', () => this.show('profiles'))]),
      ]);
    }
    const k = p.karne;
    const hist = k.history;
    const trend = hist.length
      ? lineChart(
          [
            { values: [{ x: 0, y: 70 }, ...hist.map((h, i) => ({ x: i + 1, y: h.overall }))], color: '#35a7ff', label: 'Karne notu', fill: true },
            { values: hist.map((h, i) => ({ x: i + 1, y: h.session })), color: '#ffa726', label: 'Oturum puanı', dashed: true },
          ],
          { yMin: 0, yMax: 100, h: 180, xFmt: (x) => (Math.round(x) === 0 ? 'başlangıç' : `#${Math.round(x)}`) }
        )
      : '<p class="muted">Henüz oturum yok.</p>';
    const b = p.baseline;
    const badgeHtml = Object.entries(BADGES)
      .map(([id, bd]) => `<div class="badge ${p.badges.includes(id) ? 'got' : ''}" title="${esc(bd.desc)}"><span>${bd.icon}</span><b>${esc(bd.title)}</b><small>${esc(bd.desc)}</small></div>`)
      .join('');
    const sessions = p.sessions
      .slice(0, 15)
      .map(
        (s) =>
          `<tr><td>${fmtDate(s.at)}</td><td>${esc(s.missionTitle ?? (s.kind === 'free' ? 'Serbest sürüş' : s.kind === 'calibration' ? 'Kalibrasyon' : 'Görev'))}${s.stars != null ? ' ' + stars(s.stars) : ''}</td><td>${esc(s.map)}</td><td>${esc(s.conditions)}</td><td>${s.distanceKm.toFixed(1)} km</td><td style="color:${scoreColor(s.overall)}"><b>${s.overall}</b> ${s.grade}</td></tr>`
      )
      .join('');
    const content = el('div', {
      html: `<div class="karne-top">
        <div class="card kt-main"><span class="avatar big" style="background:${p.color}">${esc(p.name[0]?.toUpperCase() ?? '?')}</span>
          <div><h3>${esc(p.name)}</h3><div class="muted">${k.sessions} oturum · ${p.totals.km.toFixed(1)} km · ${Math.round(p.totals.minutes)} dk</div>
          <div class="muted">${p.calibratedAt ? `Kalibre: ${fmtDate(p.calibratedAt)}` : 'Kalibre edilmedi'}</div></div>
          <div class="kt-score" style="color:${scoreColor(k.overall)}"><b>${k.overall}</b><span>${letterGrade(k.overall)}</span></div></div>
        <div class="card center">${radarSvg(k.components, undefined, 250)}</div>
      </div>
      <div class="card"><h3>Gelişim</h3>${trend}</div>
      <div class="grid2">
        <div class="card"><h3>Kişisel sürüş profili</h3>${
          b.ready
            ? `<table class="tbl"><tbody>
              <tr><td>Hız tercihi</td><td>sınırın %${Math.round(b.speedRatio * 100)}'i</td></tr>
              <tr><td>Hızlanma / yavaşlama (P90)</td><td>${b.accelP90.toFixed(2)} / ${b.decelP90.toFixed(2)} m/s²</td></tr>
              <tr><td>Yanal ivme (P90)</td><td>${b.latP90.toFixed(2)} m/s²</td></tr>
              <tr><td>Direksiyon düzeltme</td><td>${b.srr.toFixed(1)} /dk</td></tr>
              <tr><td>Takip mesafesi</td><td>${b.headwayMedian ? b.headwayMedian.toFixed(1) + ' sn' : '—'}</td></tr>
              <tr><td>Tepki süresi</td><td>${b.reaction ? b.reaction.toFixed(2) + ' sn' : '—'}</td></tr>
              <tr><td>Ayna sıklığı</td><td>${b.mirrorRate.toFixed(1)} /dk</td></tr>
              <tr><td>Sinyal öncesi süre</td><td>${b.signalLead ? b.signalLead.toFixed(1) + ' sn' : '—'}</td></tr>
              </tbody></table><p class="muted small">${b.sessions} temiz oturumdan öğrenildi (yavaş güncellenen ortalama).</p>`
            : '<p class="muted">Kalibrasyon Programı\'nı tamamlayınca kişisel profil burada görünür.</p>'
        }</div>
        <div class="card"><h3>Bileşenler</h3>${COMPONENTS.map((c) => `<div class="sc-row big"><span>${COMPONENT_META[c].title}</span><div class="sc-bar"><i style="width:${k.components[c]}%;background:${scoreColor(k.components[c])}"></i></div><b>${k.components[c]}</b></div>`).join('')}</div>
      </div>
      <div class="card"><h3>Rozetler (${p.badges.length}/${Object.keys(BADGES).length})</h3><div class="badges">${badgeHtml}</div></div>
      <div class="card"><h3>Son oturumlar</h3>${sessions ? `<table class="tbl"><thead><tr><th>Tarih</th><th>Oturum</th><th>Harita</th><th>Koşullar</th><th>Mesafe</th><th>Puan</th></tr></thead><tbody>${sessions}</tbody></table>` : '<p class="muted">—</p>'}</div>`,
    });
    return this.frame('Sürücü Karnesi', [content], { wide: true });
  }

  // ——————————————————————————— profiles ———————————————————————————

  private profilesScreen(): HTMLElement {
    const list = el('div', { class: 'profile-list' });
    const draw = () => {
      list.innerHTML = '';
      const act = activeProfileId();
      const guest = el('div', { class: `profile-row ${!act ? 'sel' : ''}`, html: '<span class="avatar">?</span><div><b>Misafir</b><small>Kayıt tutulmaz</small></div>' });
      guest.append(this.btn(act ? 'Seç' : 'Seçili', act ? '' : 'ghost', () => {
        selectProfile(null);
        draw();
      }));
      list.append(guest);
      for (const p of loadProfiles()) {
        const row = el('div', {
          class: `profile-row ${act === p.id ? 'sel' : ''}`,
          html: `<span class="avatar" style="background:${p.color}">${esc(p.name[0]?.toUpperCase() ?? '?')}</span><div><b>${esc(p.name)}</b><small>Karne ${p.karne.overall} · ${p.karne.sessions} oturum · ${p.baseline.ready ? 'kalibre' : 'kalibre değil'}</small></div>`,
        });
        row.append(
          this.btn(act === p.id ? 'Seçili' : 'Seç', act === p.id ? 'ghost' : 'primary', () => {
            selectProfile(p.id);
            draw();
          }),
          this.btn('Ad', 'ghost', () => {
            const n = prompt('Yeni ad:', p.name);
            if (n) renameProfile(p.id, n);
            draw();
          }),
          this.btn('Sil', 'danger', () => {
            if (confirm(`"${p.name}" profili ve tüm karnesi silinsin mi?`)) deleteProfile(p.id);
            draw();
          })
        );
        list.append(row);
      }
    };
    draw();
    const name = el('input', { type: 'text', placeholder: 'Sürücü adı', maxlength: 28 });
    const create = this.btn('Profil oluştur', 'primary', () => {
      if (!name.value.trim()) {
        name.focus();
        return;
      }
      createProfile(name.value);
      name.value = '';
      draw();
    });
    return this.frame('Profiller', [el('div', { class: 'card' }, [list]), el('div', { class: 'card row' }, [name, create])]);
  }

  // ——————————————————————————— settings ———————————————————————————

  private settingsTab = 'grafik';

  private toggleRow(label: string, key: keyof Settings, desc = ''): HTMLElement {
    const inp = el('input', { type: 'checkbox' }) as HTMLInputElement;
    inp.checked = !!settings.get()[key];
    inp.onchange = () => settings.update({ [key]: inp.checked } as Partial<Settings>);
    return el('label', { class: 'toggle-row' }, [el('div', {}, [el('b', { text: label }), desc ? el('small', { text: desc }) : null]), el('span', { class: 'switch' }, [inp, el('i')])]);
  }

  private sliderRow(label: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string, desc = ''): HTMLElement {
    const v = settings.get()[key] as number;
    const out = el('span', { class: 'rv', text: fmt(v) });
    const inp = el('input', { type: 'range', min, max, step, value: v }) as HTMLInputElement;
    inp.oninput = () => {
      settings.update({ [key]: parseFloat(inp.value) } as Partial<Settings>);
      out.textContent = fmt(parseFloat(inp.value));
    };
    return el('div', { class: 'field' }, [el('label', {}, [label, out]), inp, desc ? el('small', { class: 'muted', text: desc }) : null]);
  }

  private settingsScreen(): HTMLElement {
    const tabs: [string, string][] = [
      ['grafik', 'Grafik'],
      ['kamera', 'Kamera'],
      ['kontrol', 'Kontroller'],
      ['tarama', 'Tarama modu'],
      ['ses', 'Ses'],
      ['koc', 'Koçluk'],
      ['veri', 'Veri'],
    ];
    const bar = el('div', { class: 'seg tabs-big' });
    const body = el('div', { class: 'card settings-body' });
    const draw = () => {
      window.clearInterval(this.settingsTimer);
      bar.innerHTML = '';
      for (const [k, t] of tabs) {
        const b = el('button', { class: this.settingsTab === k ? 'active' : '', text: t });
        b.onclick = () => {
          this.settingsTab = k;
          draw();
        };
        bar.append(b);
      }
      body.innerHTML = '';
      body.append(...this.settingsTabContent(this.settingsTab, draw));
    };
    draw();
    return this.frame('Ayarlar', [bar, body], { wide: true });
  }

  private settingsTabContent(tab: string, redraw: () => void): HTMLElement[] {
    const s = settings.get();
    switch (tab) {
      case 'grafik': {
        const seg = el('div', { class: 'seg quality' });
        const names: Record<QualityLevel, string> = { low: 'Düşük', medium: 'Orta', high: 'Yüksek', ultra: 'Ultra' };
        for (const q of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) {
          const b = el('button', { class: s.quality === q ? 'active' : '', html: `${names[q]}${this.app.detectedQuality === q ? '<small>önerilen</small>' : ''}` });
          b.onclick = () => {
            settings.update({ quality: q, qualityAuto: false });
            this.app.qualityChanged();
            redraw();
          };
          seg.append(b);
        }
        return [
          el('div', { class: 'field' }, [el('label', { text: 'Kalite ön ayarı' }), seg, el('small', { class: 'muted', text: 'Gölgeler, ışıma (bloom), kenar yumuşatma, çözünürlük, çizim mesafesi, trafik/yaya yoğunluğu ve ayna çözünürlüğü birlikte ayarlanır.' })]),
          this.toggleRow('FPS göstergesi', 'showFps'),
        ];
      }
      case 'kamera':
        return [
          this.sliderRow('Görüş açısı (FOV)', 'fov', 55, 95, 1, (v) => `${v}°`, 'Kokpit ve kaput kamerası için'),
          this.sliderRow('Koltuk yüksekliği', 'seatHeight', -1, 1, 0.1, (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))),
          this.sliderRow('Koltuk ileri/geri', 'seatForward', -1, 1, 0.1, (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))),
          this.toggleRow('Baş hareketi (g kuvveti)', 'headMotion', 'Hızlanma ve virajda baş hafifçe hareket eder'),
          this.toggleRow('Fare ile serbest bakış', 'mouseLook', 'Sağ tuşu basılı tutup sürükleyin'),
          el('p', { class: 'muted small', html: 'Kamera modları (V): Sürücü koltuğu · Kaput · Takip (yakın) · Takip (uzak) · Kuşbakışı · Eğitmen koltuğu. Takip kameralarında fare tekerleği ile yakınlaştırın.' }),
        ];
      case 'kontrol': {
        const axes = el('div', { class: 'axes' });
        const pad = el('div', { class: 'muted small' });
        this.settingsTimer = window.setInterval(() => {
          const a = Input.padAxes();
          pad.textContent = Input.padName() ? `Bağlı cihaz: ${Input.padName()}` : 'Gamepad / direksiyon bağlı değil (bir tuşa basın).';
          axes.innerHTML = a ? a.map((v, i) => `<div class="axis"><span>Eksen ${i}</span><div class="ax-bar"><i style="left:${((v + 1) / 2) * 100}%"></i></div><b>${v.toFixed(2)}</b></div>`).join('') : '';
        }, 100);
        const axisSel = (label: string, key: 'wheelSteerAxis' | 'wheelThrottleAxis' | 'wheelBrakeAxis') => {
          const sel = el('select') as HTMLSelectElement;
          for (let i = 0; i < 8; i++) sel.append(el('option', { value: i, text: `Eksen ${i}` }));
          sel.value = String(settings.get()[key]);
          sel.onchange = () => settings.update({ [key]: parseInt(sel.value) } as Partial<Settings>);
          const detect = this.btn('Algıla', 'ghost', () => this.detectAxis(key, sel));
          return el('div', { class: 'field inline' }, [el('label', { text: label }), sel, detect]);
        };
        const trans = el('div', { class: 'seg' });
        for (const [v, t] of [['auto', 'Otomatik D/R (S ile geri)'], ['selector', 'Vites seçici (1=D 2=R 3=N 4=P)']] as const) {
          const b = el('button', { class: s.transmission === v ? 'active' : '', text: t });
          b.onclick = () => {
            settings.update({ transmission: v });
            redraw();
          };
          trans.append(b);
        }
        return [
          el('div', { class: 'field' }, [el('label', { text: 'Şanzıman' }), trans]),
          this.sliderRow('Klavye direksiyon hızı', 'keyboardSteerSpeed', 0.5, 2, 0.1, (v) => `${v.toFixed(1)}x`),
          this.toggleRow('Hıza duyarlı direksiyon (klavye)', 'speedSensitiveSteering', 'Yüksek hızda direksiyon açısı otomatik azalır'),
          el('h4', { text: 'Gamepad / Direksiyon seti' }),
          pad,
          axes,
          this.sliderRow('Ölü bölge', 'gamepadDeadzone', 0, 0.3, 0.01, (v) => v.toFixed(2)),
          this.sliderRow('Direksiyon eğrisi', 'gamepadSteerGamma', 1, 2.5, 0.05, (v) => v.toFixed(2), '1 = doğrusal, yüksek = merkezde daha hassas'),
          this.toggleRow('Direksiyon seti eşlemesi kullan', 'useWheelMapping', 'Logitech G29/G920, Thrustmaster vb. için eksen tabanlı pedal eşlemesi'),
          axisSel('Direksiyon ekseni', 'wheelSteerAxis'),
          axisSel('Gaz pedalı ekseni', 'wheelThrottleAxis'),
          axisSel('Fren pedalı ekseni', 'wheelBrakeAxis'),
          this.toggleRow('Pedallar ters (1 = bırakılmış)', 'wheelPedalsInverted'),
          el('div', { class: 'keymap', html: KEYMAP_HTML }),
        ];
      }
      case 'tarama': {
        const modes: [Settings['scanMode'], string, string][] = [
          ['keys', 'Bakış tuşları + sinyal (önerilen)', 'Z sol ayna, C sağ ayna, X iç dikiz, Shift+Z / Shift+C omuz kontrolü. Kamera gerçekten o yöne döner; manevra öncesi Ayna → Sinyal → Omuz sırası puanlanır.'],
          ['webcam', 'Webcam kafa takibi', 'Kafanızı çevirerek aynalara bakın (MediaPipe, tamamen cihazınızda çalışır; görüntü hiçbir yere gönderilmez). Tuşlar da çalışmaya devam eder.'],
          ['legacy', 'Tek tuş proxy (eski)', 'Space veya F = "ayna/omuz baktım". Basit ama yön ayırt etmez. Bu modda el freni yalnızca B tuşundadır.'],
        ];
        const list = el('div', { class: 'radio-cards' });
        for (const [v, t, d] of modes) {
          const c = el('button', { class: `radio-card ${s.scanMode === v ? 'sel' : ''}`, html: `<b>${t}</b><small>${d}</small>` });
          c.onclick = () => {
            settings.update({ scanMode: v });
            if (v !== 'webcam') this.app.head.stop();
            redraw();
          };
          list.append(c);
        }
        const out: HTMLElement[] = [list];
        if (s.scanMode === 'webcam') {
          const st = el('div', { class: 'webcam-status' });
          const upd = () => {
            const h = this.app.head;
            const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
            st.innerHTML = `Durum: <b>${{ off: 'kapalı', loading: 'yükleniyor…', running: 'çalışıyor', 'no-face': 'yüz görünmüyor', error: 'hata' }[h.status]}</b>${h.error ? ` — ${esc(h.error)}` : ''}${h.status === 'running' ? ` · yaw ${deg(h.yaw)}° · pitch ${deg(h.pitch)}° · bakış: <b>${h.glance}</b>` : ''}`;
          };
          this.settingsTimer = window.setInterval(() => {
            this.app.head.update();
            upd();
          }, 100);
          upd();
          out.push(
            el('div', { class: 'row' }, [
              this.btn('Kamerayı başlat', 'primary', async () => {
                await this.app.head.start(document.getElementById('app')!);
                upd();
              }),
              this.btn('Düz bak → merkezle', '', () => this.app.head.recenter()),
              this.btn('Yönü ters çevir', 'ghost', () => (this.app.head.invert = !this.app.head.invert)),
              this.btn('Durdur', 'ghost', () => this.app.head.stop()),
            ]),
            st,
            this.sliderRow('Ayna eşiği (kafa dönüşü)', 'webcamYawThreshold', 10, 35, 1, (v) => `${v}°`, 'Bu açının üzerinde yan ayna, ~2.4 katında omuz kontrolü sayılır. Yukarı bakış iç dikizdir.'),
            this.toggleRow('Kafa hareketi kamerayı döndürsün', 'webcamDrivesCamera'),
            this.toggleRow('Webcam önizlemesi', 'webcamPreview'),
            el('p', { class: 'muted small', text: 'Gizlilik: Görüntü işleme tarayıcıda yerel olarak yapılır. Model dosyaları ilk kullanımda CDN\'den indirilir (internet gerekir).' })
          );
        }
        return out;
      }
      case 'ses':
        return [
          this.sliderRow('Ana ses', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
          this.sliderRow('Motor sesi', 'engineVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
          this.toggleRow('Sesli navigasyon', 'voiceNav', 'Türkçe konuşma sentezi (tarayıcı desteğine bağlı)'),
          this.toggleRow('Sesli koç uyarıları', 'voiceCoach', 'İhlalleri sesli okur'),
        ];
      case 'koc': {
        const hud = el('div', { class: 'seg' });
        for (const [v, t] of [['full', 'Tam'], ['minimal', 'Sade'], ['off', 'Kapalı']] as const) {
          const b = el('button', { class: s.hudMode === v ? 'active' : '', text: t });
          b.onclick = () => {
            settings.update({ hudMode: v });
            redraw();
          };
          hud.append(b);
        }
        return [
          el('div', { class: 'field' }, [el('label', { text: 'Gösterge (HUD) modu — U tuşu' }), hud]),
          this.toggleRow('Canlı koç ipuçları', 'liveCoachHints', 'İhlal ve olumlu davranışlar anında ekranda gösterilir'),
          this.toggleRow('Yol rehber çizgisi', 'routeGuideLine'),
          this.toggleRow('Sürpriz olaylar', 'surpriseEvents'),
          this.toggleRow('Ağır kazada oturumu bitir', 'endOnHardCrash'),
        ];
      }
      case 'veri':
      default: {
        const file = el('input', { type: 'file', accept: '.json', class: 'hidden' }) as HTMLInputElement;
        file.onchange = async () => {
          const f = file.files?.[0];
          if (!f) return;
          try {
            const n = importProfiles(await f.text());
            alert(`${n} profil içe aktarıldı.`);
          } catch (e) {
            alert('İçe aktarma başarısız: ' + (e as Error).message);
          }
          redraw();
        };
        return [
          el('p', { class: 'muted', text: 'Tüm veriler tarayıcınızın yerel depolamasında tutulur. Yedeklemek veya başka cihaza taşımak için dışa aktarın.' }),
          el('div', { class: 'row' }, [
            this.btn('Profilleri dışa aktar (JSON)', 'primary', () => download('surus-kocu-profiller.json', exportProfiles(), 'application/json')),
            this.btn('İçe aktar', '', () => file.click()),
            file,
          ]),
          el('div', { class: 'row' }, [
            this.btn('Ayarları sıfırla', 'ghost', () => {
              settings.update({ ...DEFAULT_SETTINGS });
              this.app.qualityChanged();
              redraw();
            }),
            this.btn('Tüm verileri sil', 'danger', () => {
              if (confirm('Tüm profiller, karneler ve ayarlar silinsin mi?')) {
                for (const p of loadProfiles()) deleteProfile(p.id);
                settings.reset();
                redraw();
              }
            }),
          ]),
        ];
      }
    }
  }

  private detectAxis(key: 'wheelSteerAxis' | 'wheelThrottleAxis' | 'wheelBrakeAxis', sel: HTMLSelectElement) {
    const base = Input.padAxes();
    if (!base) {
      alert('Önce direksiyon/gamepad bağlayın ve bir tuşa basın.');
      return;
    }
    const what = key === 'wheelSteerAxis' ? 'Direksiyonu bir yöne sonuna kadar çevirin' : key === 'wheelThrottleAxis' ? 'Gaz pedalına sonuna kadar basın' : 'Fren pedalına sonuna kadar basın';
    const note = el('div', { class: 'detect-note', text: `${what}… (3 sn)` });
    sel.parentElement?.append(note);
    let best = { i: 0, d: 0 };
    const t0 = performance.now();
    const iv = window.setInterval(() => {
      const a = Input.padAxes();
      if (a) a.forEach((v, i) => {
        const d = Math.abs(v - (base[i] ?? 0));
        if (d > best.d) best = { i, d };
      });
      if (performance.now() - t0 > 3000) {
        window.clearInterval(iv);
        note.remove();
        if (best.d > 0.3) {
          settings.update({ [key]: best.i } as Partial<Settings>);
          sel.value = String(best.i);
          if (key !== 'wheelSteerAxis') {
            const a2 = Input.padAxes();
            // pressed value near −1 means inverted pedals
            if (a2) settings.update({ wheelPedalsInverted: (a2[best.i] ?? 0) < 0 });
          }
        } else alert('Hareket algılanmadı.');
      }
    }, 50);
  }

  // ——————————————————————————— help ———————————————————————————

  private helpScreen(): HTMLElement {
    return this.frame('Nasıl Oynanır', [el('div', { class: 'help', html: HELP_HTML })], { wide: true });
  }

  // ——————————————————————————— in-drive overlays ———————————————————————————

  private openOverlay(content: HTMLElement, cls = '') {
    this.overlay.innerHTML = '';
    this.overlay.className = `overlay ${cls}`;
    const panel = el('div', { class: 'overlay-panel' }, [content]);
    this.overlay.append(panel);
    this.overlay.classList.remove('hidden');
    this.onOverlayChange?.(true);
    return panel;
  }

  closeOverlay() {
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
    this.onOverlayChange?.(false);
  }

  get overlayOpen() {
    return !this.overlay.classList.contains('hidden');
  }

  pauseMenu() {
    const box = el('div', { class: 'pause' }, [
      el('h2', { text: 'Duraklatıldı' }),
      this.btn('Devam et', 'primary big', () => {
        this.closeOverlay();
        this.app.resume();
      }),
      this.btn('Oturumu bitir ve raporu gör', '', () => {
        this.closeOverlay();
        this.app.finishSegment();
      }),
      this.btn('Yeniden başlat', '', () => {
        this.closeOverlay();
        this.app.restartSession();
      }),
      this.btn('Ayarlar', '', () => {
        this.closeOverlay();
        this.show('settings');
      }),
      this.btn('Nasıl oynanır', '', () => {
        this.closeOverlay();
        this.show('help');
      }),
      this.btn('Ana menü', 'ghost', () => {
        this.closeOverlay();
        this.app.quitToMenu();
      }),
    ]);
    this.openOverlay(box, 'dim');
  }

  missionBoard(inMission: boolean) {
    const map = this.app.sessionMapId();
    const list = MISSIONS.filter((m) => m.board && m.map === map);
    const p = activeProfile();
    const grid = el('div', { class: 'mission-grid compact' });
    for (const m of list) {
      const c = this.missionCard(m, p);
      c.onclick = () => {
        this.closeOverlay();
        this.app.startBoardMission(m.id);
      };
      grid.append(c);
    }
    const box = el('div', {}, [
      el('div', { class: 'ov-head' }, [el('h2', { text: '📋 Görev Panosu' }), this.btn('Kapat (J)', 'ghost', () => {
        this.closeOverlay();
        this.app.resume();
      })]),
      inMission ? el('p', { class: 'warn-text', text: 'Yeni görev seçersen mevcut görev raporsuz sonlanır.' }) : el('p', { class: 'muted', text: 'Görev bulunduğun yerden başlar. Koşullar (saat/hava/trafik) göreve göre değişebilir.' }),
      list.length ? grid : el('p', { class: 'muted', text: 'Bu haritada panodan başlatılabilen görev yok. Görevler menüsünü kullanın.' }),
    ]);
    this.openOverlay(box, 'dim wide');
  }

  bigMap() {
    const cv = el('canvas', { class: 'bigmap', width: 1100, height: 780 }) as HTMLCanvasElement;
    const box = el('div', {}, [
      el('div', { class: 'ov-head' }, [el('h2', { text: '🗺️ Harita' }), el('span', { class: 'muted', text: 'Hedef seçmek için tıklayın · M / Esc kapat' }), this.btn('Kapat', 'ghost', () => {
        this.closeOverlay();
        this.app.resume();
      })]),
      cv,
    ]);
    this.openOverlay(box, 'dim wide');
    const pick = this.app.bigMap(cv);
    cv.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      pick?.((e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height));
      this.closeOverlay();
      this.app.resume();
    };
  }

  helpOverlay() {
    const box = el('div', {}, [
      el('div', { class: 'ov-head' }, [el('h2', { text: 'Kontroller' }), this.btn('Kapat', 'ghost', () => {
        this.closeOverlay();
        this.app.resume();
      })]),
      el('div', { class: 'keymap', html: KEYMAP_HTML }),
    ]);
    this.openOverlay(box, 'dim');
  }

  report(): HTMLElement {
    this.overlay.innerHTML = '';
    this.overlay.className = 'overlay dim report';
    const panel = el('div', { class: 'overlay-panel report-panel' });
    this.overlay.append(panel);
    this.overlay.classList.remove('hidden');
    this.onOverlayChange?.(true);
    return panel;
  }

  loading(text: string | null) {
    let l = document.getElementById('loading');
    if (!text) {
      l?.classList.add('hidden');
      return;
    }
    if (!l) {
      l = el('div', { id: 'loading' });
      document.getElementById('app')!.append(l);
    }
    l.classList.remove('hidden');
    l.innerHTML = `<div class="spinner"></div><div>${esc(text)}</div>`;
  }
}

const KEYMAP_HTML = `
<table class="tbl keys"><tbody>
<tr><th colspan="2">Sürüş</th><th colspan="2">Tarama & sinyal</th></tr>
<tr><td><kbd>W</kbd>/<kbd>↑</kbd></td><td>Gaz</td><td><kbd>Z</kbd></td><td>Sol ayna</td></tr>
<tr><td><kbd>S</kbd>/<kbd>↓</kbd></td><td>Fren · durunca basılı tut: geri vites</td><td><kbd>C</kbd></td><td>Sağ ayna</td></tr>
<tr><td><kbd>A</kbd> <kbd>D</kbd></td><td>Direksiyon</td><td><kbd>X</kbd></td><td>İç dikiz aynası</td></tr>
<tr><td><kbd>Space</kbd>/<kbd>B</kbd></td><td>El freni</td><td><kbd>Shift</kbd>+<kbd>Z</kbd>/<kbd>C</kbd></td><td>Sol / sağ omuz kontrolü</td></tr>
<tr><td><kbd>1</kbd>-<kbd>4</kbd></td><td>Vites D / R / N / P</td><td><kbd>Q</kbd> <kbd>E</kbd></td><td>Sol / sağ sinyal</td></tr>
<tr><td><kbd>H</kbd></td><td>Korna</td><td><kbd>G</kbd></td><td>Dörtlü flaşör</td></tr>
<tr><th colspan="2">Görünüm</th><th colspan="2">Diğer</th></tr>
<tr><td><kbd>V</kbd></td><td>Kamera değiştir (6 mod)</td><td><kbd>L</kbd></td><td>Farlar</td></tr>
<tr><td>Sağ tık + sürükle</td><td>Serbest bakış</td><td><kbd>I</kbd></td><td>Silecek</td></tr>
<tr><td><kbd>M</kbd></td><td>Harita / hedef seç</td><td><kbd>R</kbd></td><td>Aracı şeride al</td></tr>
<tr><td><kbd>J</kbd></td><td>Görev panosu</td><td><kbd>U</kbd></td><td>HUD modu</td></tr>
<tr><td><kbd>Esc</kbd>/<kbd>P</kbd></td><td>Duraklat</td><td><kbd>O</kbd></td><td>Kafa takibini merkezle</td></tr>
<tr><th colspan="4">Gamepad</th></tr>
<tr><td colspan="4">Sol çubuk direksiyon · RT gaz · LT fren · B el freni · LB/RB sinyal · Sağ çubuk ayna/omuz bakışı · Y kamera · X dörtlü · A korna · Start duraklat · Back harita</td></tr>
</tbody></table>`;

const HELP_HTML = `
<div class="grid2">
<div class="card"><h3>Amaç</h3><p>Sürüş Koçu, gerçek trafik kurallarına yakın bir şehirde <b>güvenli ve dikkatli sürüş alışkanlıklarını</b> ölçer. Her oturumun sonunda ayrıntılı bir rapor alırsın; profil oluşturduysan puanların <b>Sürücü Karnesi</b>'ne işlenir.</p>
<ol><li><b>Kalibrasyon Programı</b> ile başla: kişisel sürüş stilin çıkarılır.</li><li><b>Beceri</b> görevleriyle zayıf yönlerini çalış (park, MSM, tepki).</li><li><b>Şehir</b>de serbest sür, görev panosundan (J) görev seç.</li></ol></div>
<div class="card"><h3>Ayna → Sinyal → Manevra</h3><p>Şerit değiştirirken ve dönerken güvenli sıra:</p><ol><li>İç dikiz + ilgili yan ayna (<kbd>X</kbd>, <kbd>Z</kbd>/<kbd>C</kbd>)</li><li>Sinyal (<kbd>Q</kbd>/<kbd>E</kbd>) — en az 1–3 sn önce</li><li>Kör nokta: omuz kontrolü (<kbd>Shift</kbd>+<kbd>Z</kbd>/<kbd>C</kbd>)</li><li>Manevra, sonra sinyali kapat</li></ol><p class="muted small">Dönüşlerde sinyal direksiyon düzelince kendiliğinden kapanır; şerit değişiminde kapatmak sana kalır.</p></div>
<div class="card"><h3>Puanlama</h3><p>5 bileşen: <b>Güvenlik %30</b> (çarpışma, ramak kala/TTC, takip mesafesi, sert olaylar, tepki) · <b>Kural %25</b> (hız, ışık, DUR, öncelik, yaya, sinyal, yön) · <b>Tarama %20</b> (manevra öncesi ayna, omuz, ayna sıklığı, kavşak taraması) · <b>Pürüzsüzlük %15</b> (jerk, konfor, direksiyon düzeltme) · <b>Görev %10</b>.</p><p>Ağır ihlaller toplam puana tavan koyar (ör. kırmızı ışık 72, ağır kaza 40, yayaya çarpma 20).</p></div>
<div class="card"><h3>Trafik kuralları</h3><ul><li>Hız sınırları: sokak 30, cadde 50, bulvar 70, okul bölgesi 30 km/h.</li><li>Kırmızı ve kırmızı+sarıda geçilmez; sarıda güvenle durabiliyorsan dur.</li><li>DUR levhasında tam dur (0 km/h), yol ver levhasında ana yola öncelik ver.</li><li>Tek yönlü yollara girilmez levhasından girme.</li><li>Yaya geçidinde yayaya yol ver.</li><li>Takip mesafesi en az 2 sn (yağmurda 4 sn).</li><li>Gece ve yağmurda farlar açık.</li></ul></div>
</div>
<div class="card">${KEYMAP_HTML}</div>`;
