import { el, esc } from '../ui/dom';
import { hostBridge } from './hostBridge';
import type { Companion } from './companion';
import { customBroker, DEFAULT_BROKERS, formatCode, linkUrl, newLinkCode, parseLinkCode, setCustomBroker, type LinkStatus } from './link';
import { cameraAvailable, QrScanner, qrSvg } from './qr';

/** Pairing widgets shared by the main menu, the settings tab and the pause menu. */

const HOST_STATUS: Record<LinkStatus, string> = {
  off: 'Bağlı değil',
  connecting: 'Sunucuya bağlanıyor…',
  waiting: 'Telefon bekleniyor…',
  connected: 'Bağlı',
  error: 'Bağlantı sunucusuna ulaşılamıyor — tekrar deneniyor',
};

const DISPLAY_STATUS: Record<LinkStatus, string> = {
  off: 'Kapalı',
  connecting: 'Sunucuya bağlanıyor…',
  waiting: 'Bilgisayarın QR kodu okutması bekleniyor',
  connected: 'Bilgisayara bağlandı',
  error: 'Bağlantı sunucusuna ulaşılamıyor — tekrar deneniyor',
};

/** Run `fn` on every status change for as long as `node` stays in the document. */
function whileMounted(node: HTMLElement, subscribe: (fn: () => void) => () => void, fn: () => void) {
  let off: (() => void) | null = null;
  let mounted = false;
  let busy = false;
  let again = false;
  const run = () => {
    if (node.isConnected) mounted = true;
    else if (mounted) {
      off?.();
      off = null;
      return;
    }
    // A redraw can itself change the link status — finish this pass, then redraw once more
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        fn();
      } while (again);
    } finally {
      busy = false;
    }
  };
  off = subscribe(run);
  run();
}

function isLocalHost() {
  return /^(localhost|127\.|\[::1\])/.test(location.hostname);
}

/**
 * Phone side: QR + code that the PC scans. Starts listening as soon as it is shown.
 * `compact` is the main-menu variant.
 */
export function displayPairCard(companion: Companion, compact = false): HTMLElement {
  const card = el('div', { class: `pair-card display ${compact ? 'compact' : ''}` });
  const draw = () => {
    const link = companion.link;
    const s = link.status;
    card.innerHTML = '';
    if (s === 'connected') {
      card.append(
        el('div', { class: 'pair-ok', html: `<span class="pair-ok-i">✓</span><div><b>Bilgisayara bağlı</b><small>${esc(companion.hostName || 'Sürüş Koçu')}</small></div>` }),
        btn('📱 Canlı Koç Ekranını aç', 'primary big', () => companion.open()),
        btn('Bağlantıyı kes', 'ghost', () => {
          companion.disconnect();
          draw();
        })
      );
      return;
    }
    const code = companion.ensureListening();
    card.append(
      el('div', { class: 'pair-head', html: `${compact ? '<span class="pair-badge">📱 TELEFON ALGILANDI</span>' : ''}<h3>Bu telefonu canlı uyarı ekranı yap</h3><p>Bilgisayarda oyunu açın, <b>Telefonu Bağla</b>’ya basın ve bu QR kodu bilgisayarın kamerasına gösterin. Kazalar, cezalar ve uyarılar anında burada görünür.</p>` }),
      el('div', { class: 'pair-qr', html: qrSvg(linkUrl(code)) }),
      el('div', { class: 'pair-code-row' }, [el('small', { text: 'veya kodu bilgisayara yazın' }), el('div', { class: 'pair-code', text: formatCode(code) })]),
      el('div', { class: `pair-status ${s}`, html: `<i></i>${esc(DISPLAY_STATUS[s])}` }),
      el('div', { class: 'row' }, [
        btn('Yeni kod', 'ghost', () => {
          companion.newCode();
          draw();
        }),
        btn('Ekranı önizle', 'ghost', () => companion.open()),
      ])
    );
  };
  whileMounted(card, (fn) => companion.link.on('status', fn), draw);
  return card;
}

/** PC side: webcam QR scanner + manual code + reverse QR for the phone's own camera. */
export function hostPairPanel(onClose: () => void): { root: HTMLElement; dispose: () => void } {
  let scanner: QrScanner | null = null;
  let hostCode: string | null = null;
  /** Code the panel opened by itself (not scanned) — dropped again if nobody joins. */
  let autoCode: string | null = null;
  const root = el('div', { class: 'pair-host' });

  const stopScanner = () => {
    scanner?.stop();
    scanner = null;
  };

  const connectTo = (code: string) => {
    stopScanner();
    hostBridge.connect(code);
    draw();
  };

  let drawing = false;
  const draw = () => {
    if (drawing) return;
    drawing = true;
    try {
      drawPanel();
    } finally {
      drawing = false;
    }
  };
  const drawPanel = () => {
    const link = hostBridge.link;
    const s = link.status;
    root.innerHTML = '';
    const head = el('div', { class: 'pair-host-head' }, [
      el('div', { html: '<h2>📱 Telefonu Bağla</h2><p class="muted">Telefonun, sürüş sırasında kazaların, cezaların ve uyarıların anlık göründüğü <b>Canlı Koç Ekranı</b> olur.</p>' }),
      btn('Kapat', 'ghost', onClose),
    ]);
    root.append(head);

    if (s === 'connected') {
      const names = [...hostBridge.displays.values()];
      root.append(
        el('div', { class: 'pair-ok big', html: `<span class="pair-ok-i">✓</span><div><b>Telefon bağlandı</b><small>${esc(names.length ? names.join(', ') : 'Canlı Koç Ekranı')} · ${esc(link.brokerName)}</small></div>` }),
        el('p', { class: 'muted', text: 'Sürüşe başladığınızda hız, canlı puan, görev hedefleri ve tüm olaylar telefona akar. Telefondan oyunu duraklatıp devam ettirebilirsiniz.' }),
        el('div', { class: 'row' }, [btn('Sürüşe dön', 'primary', onClose), btn('Bağlantıyı kes', 'danger', () => {
          hostBridge.disconnect();
          draw();
        })])
      );
      return;
    }

    // ① scan the phone's QR with the webcam
    const video = el('div', { class: 'scan-box' });
    const scanMsg = el('div', { class: 'scan-msg' });
    const scanCol = el('div', { class: 'pair-col' }, [
      el('h4', { html: '<span class="step">1</span> Telefondaki QR kodu kameraya gösterin' }),
      el('p', { class: 'muted small', text: 'Telefonda bu sayfayı açın — ana ekranda QR kod çıkar (çıkmazsa Ayarlar → Telefon Ekranı).' }),
      video,
      scanMsg,
    ]);
    const startScan = () => {
      stopScanner();
      video.innerHTML = '';
      if (!cameraAvailable()) {
        scanMsg.innerHTML = 'Kamera bu bağlamda kullanılamıyor (HTTPS veya <code>localhost</code> gerekir). Kodu aşağıya yazın.';
        video.classList.add('off');
        return;
      }
      const sc = new QrScanner();
      scanner = sc;
      video.classList.remove('off');
      video.append(sc.video, el('div', { class: 'scan-frame', html: '<i></i><i></i><i></i><i></i><b></b>' }));
      scanMsg.textContent = 'Kamera açılıyor…';
      sc.onResult = (text) => {
        const code = parseLinkCode(text);
        if (code) {
          scanMsg.textContent = `Kod okundu: ${formatCode(code)}`;
          connectTo(code);
        } else scanMsg.textContent = 'Bu QR kod Sürüş Koçu’na ait değil.';
      };
      sc.start().then(
        () => {
          if (scanner === sc) scanMsg.textContent = 'QR kodu çerçeveye getirin…';
        },
        (e: Error) => {
          if (scanner !== sc) return;
          video.classList.add('off');
          scanMsg.textContent = e.name === 'NotAllowedError' ? 'Kamera izni verilmedi. İzin verip yeniden deneyin veya kodu yazın.' : e.name === 'NotFoundError' ? 'Kamera bulunamadı — kodu aşağıya yazın.' : `Kamera açılamadı (${e.message}).`;
        }
      );
    };

    // manual code
    const input = el('input', { class: 'code-input', placeholder: 'ABCD-EFGH', maxlength: 12, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const codeMsg = el('small', { class: 'muted' });
    const submit = () => {
      const code = parseLinkCode(input.value);
      if (!code) {
        codeMsg.textContent = 'Kod 8 karakter olmalı (ör. ABCD-EFGH).';
        return;
      }
      connectTo(code);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    };
    scanCol.append(el('div', { class: 'code-row' }, [input, btn('Bağlan', 'primary', submit), btn('Kamerayı yenile', 'ghost', startScan)]), codeMsg);

    // ② or: the phone's own camera scans this QR
    if (!hostCode || !link.active || link.code !== hostCode) {
      // Listen on a code of our own so a phone can join by scanning the PC's screen
      if (!link.active || link.status === 'error') {
        hostCode = newLinkCode();
        autoCode = hostCode;
        hostBridge.connect(hostCode);
      } else hostCode = link.code;
    }
    const url = hostCode ? linkUrl(hostCode) : '';
    const altCol = el('div', { class: 'pair-col alt' }, [
      el('h4', { html: '<span class="step">2</span> ya da telefon kamerasıyla bunu okutun' }),
      el('div', { class: 'pair-qr small', html: url ? qrSvg(url) : '' }),
      hostCode ? el('div', { class: 'pair-code', text: formatCode(hostCode) }) : null,
      isLocalHost()
        ? el('p', { class: 'warn-note small', html: 'Bu sayfa <b>localhost</b> üzerinden açık; telefon bu adrese gidemez. Telefonda ağ adresini (ör. <code>npm run dev</code> çıktısındaki “Network”) açın ve telefonun gösterdiği QR’ı soldan okutun.' })
        : el('p', { class: 'muted small', text: 'Telefon bu adresi açınca otomatik olarak Canlı Koç Ekranı olarak bağlanır.' }),
      el('div', { class: `pair-status ${s}`, html: `<i></i>${esc(HOST_STATUS[s])}` }),
    ]);

    root.append(el('div', { class: 'pair-cols' }, [scanCol, altCol]));
    startScan();
  };

  const offStatus = hostBridge.link.on('status', () => {
    // Redraw on meaningful changes only; the scanner keeps running while waiting
    const s = hostBridge.link.status;
    if (s === 'connected' || s === 'off') draw();
    else root.querySelectorAll('.pair-status').forEach((n) => {
      n.className = `pair-status ${s}`;
      n.innerHTML = `<i></i>${esc(HOST_STATUS[s])}`;
    });
  });
  draw();
  return {
    root,
    dispose: () => {
      offStatus();
      stopScanner();
      const l = hostBridge.link;
      if (l.status !== 'connected' && l.code === autoCode) hostBridge.disconnect();
    },
  };
}

/** Settings → "Telefon Ekranı" tab. */
export function linkSettings(companion: Companion, openHostPanel: () => void, isPhone: boolean): HTMLElement[] {
  const hostCard = el('div', { class: 'pair-card host' });
  whileMounted(
    hostCard,
    (fn) => hostBridge.link.on('status', fn),
    () => {
      const s = hostBridge.link.status;
      const names = [...hostBridge.displays.values()];
      hostCard.innerHTML = '';
      hostCard.append(
        el('div', { class: 'pair-head', html: `<h3>💻 Bu cihaz oyun ekranı</h3><p class="muted">Telefonu ikinci ekran olarak bağlayın: kaza, ceza ve uyarılar telefonda canlı görünür.</p>` }),
        el('div', { class: `pair-status ${s}`, html: `<i></i>${esc(s === 'connected' ? `Bağlı — ${names.join(', ') || 'telefon'}` : HOST_STATUS[s])}` }),
        el('div', { class: 'row' }, [
          btn(s === 'connected' ? 'Bağlantı ayrıntıları' : '📷 Telefonu Bağla (QR okut)', 'primary', openHostPanel),
          s !== 'off' ? btn('Bağlantıyı kes', 'ghost', () => hostBridge.disconnect()) : null,
        ])
      );
    }
  );
  const displayCard = displayPairCard(companion);
  const broker = el('input', { class: 'broker-input', placeholder: DEFAULT_BROKERS[0], value: customBroker(), spellcheck: 'false' }) as HTMLInputElement;
  broker.onkeydown = (e) => e.stopPropagation();
  broker.onchange = () => setCustomBroker(broker.value);
  const adv = el('details', { class: 'pair-adv' }, [
    el('summary', { text: 'Gelişmiş: bağlantı sunucusu' }),
    el('p', {
      class: 'muted small',
      html: `Cihazlar, herkese açık MQTT (WebSocket) sunucuları üzerinden rastgele bir eşleşme koduna ait kanalda haberleşir; yalnızca sürüş olayları ve puanlar gönderilir. Varsayılan: ${DEFAULT_BROKERS.map((b) => `<code>${esc(new URL(b).hostname)}</code>`).join(', ')} (hangisi çalışıyorsa). Kendi sunucunuzu kullanmak için <code>wss://…</code> adresini girin — iki cihazda da aynı olmalı.`,
    }),
    broker,
  ]);
  const order = isPhone ? [displayCard, hostCard] : [hostCard, displayCard];
  return [el('div', { class: 'pair-settings' }, order), adv];
}

function btn(text: string, kind: string, fn: () => void): HTMLButtonElement {
  const b = el('button', { class: `btn ${kind}`, text });
  b.onclick = (e) => {
    e.stopPropagation();
    fn();
  };
  return b;
}
