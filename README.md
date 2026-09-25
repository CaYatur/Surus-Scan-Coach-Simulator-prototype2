# Sürüş Koçu — Scan Coach Simülatörü

Tarayıcıda çalışan, **güvenli sürüş ve tarama (ayna / omuz kontrolü) alışkanlıklarını ölçen ve koçluk yapan** 3B sürüş simülatörü.
Gerçek trafik kurallarına yakın bir şehirde sürersin; her oturumun sonunda ayrıntılı bir rapor alırsın ve puanların kişisel **Sürücü Karnesi**'ne işlenir.

> Vite + TypeScript + Three.js · harici görsel/ses dosyası yok (tüm modeller, dokular ve sesler prosedürel olarak üretilir) · veriler cihazda (localStorage) kalır.

## Hızlı başlangıç

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ — göreli yollar, herhangi bir alt dizinde/statik hostta çalışır
npm run preview    # build önizleme (http://localhost:4173)
```

Mutlak bir taban yol gerekirse: `VITE_BASE=/scan-coach/ npm run build`.

## Neler var?

### İki harita
| Harita | Amaç |
|---|---|
| **Merkez Şehir** (~1,3 km²) | Serbest sürüş + seçmeli görevler. Bulvarlar (refüjlü, 2+2 şerit), caddeler, tek yönlü yollar, park şeritli sokaklar, 30 km/h okul bölgesi, çarşı, meydan (saat kulesi, belediye), camiler, hastane, üniversite, sanayi, parklar. |
| **Eğitim Alanı** | Görev odaklı: kalibrasyon programı ve beceri atölyeleri. Işıklı bulvar, DUR levhalı sokak, park alanı (çizgili park yerleri, slalom). |

Şehir tamamen bildirimsel harita tanımlarından (`src/world/mapDefs.ts`) üretilir: şerit grafiği, kavşak kontrolü (sinyalizasyon / DUR / yol ver), yaya geçitleri, bloklar, binalar ve donatılar.

### Görevler
- **Kalibrasyon:** 10 adımlı *Kalibrasyon Programı* (hızlanma, sola/sağa dönüş, şerit değişimi, tepki testi, DUR levhası, park) ve *Hızlı Kalibrasyon* (2 dk serbest). Kişisel sürüş profilini (stil parmak izi) çıkarır.
- **Beceri:** Ayna–Sinyal–Manevra atölyesi, park etme, tepki testi serisi.
- **Şehir:** Şehir turu, taksi (yolcu konforu), okul bölgesi (çocuk yaya olayı), yoğun saat (ani fren eden araç), gece sürüşü, yağmurlu yol, paralel park, bulvar şeritleri.
- Serbest sürüşte **J** ile görev panosunu açıp bulunduğun yerden görev başlatabilirsin; **M** ile haritadan tıklayarak hedef seçebilirsin.
- Görev sonunda başarı/başarısızlık, yıldız (0–3), hedef listesi ve ölçüm satırları (ör. tepki süresi, park hizası) gösterilir.

### Sürüş ve araç
- Bisiklet modeli + lastik tutuş limiti (yağmurda azalır), tork eğrisi, 6 ileri otomatik şanzıman, ABS'li fren, el freni, otomatik D/R veya vites seçici (P/R/N/D).
- Klavye (analog benzetimli), **gamepad** ve **direksiyon seti** (eksen eşleme + otomatik algılama sihirbazı).
- Prosedürel araç modelleri: hatchback, sedan, SUV, hafif ticari, taksi, otobüs, kamyon (yuvarlatılmış kaporta, jant, far/stop/sinyal lambaları).

### İç mekân ve kameralar
6 kamera modu (**V**): sürücü koltuğu, eğitmen koltuğu, kaput, yakın/uzak takip, kuşbakışı.
Kokpitte canlı analog göstergeler, gerçekten dönen direksiyon ve eller, vites/el freni kolu, navigasyon ekranı, **gerçek zamanlı yansıtan iç dikiz ve yan aynalar**, yağmurda silecekler ve camda damlalar. FOV, koltuk yüksekliği/konumu, g-kuvveti baş hareketi ve fareyle serbest bakış ayarlanabilir.

### Tarama (scan) ölçümü — 3 mod
| Mod | Açıklama |
|---|---|
| **Bakış tuşları + sinyal** (varsayılan) | Z sol ayna, C sağ ayna, X iç dikiz, Shift+Z/C omuz kontrolü. Sürücünün başı gerçekten o yöne döner; bakış hedefe ulaşınca "kontrol" sayılır. |
| **Webcam kafa takibi** | MediaPipe Face Landmarker ile kafanı çevirerek aynalara bak. Görüntü cihazda işlenir; model ilk kullanımda CDN'den indirilir. |
| **Tek tuş (eski)** | Space/F = yön ayırt etmeyen tarama proxy'si (referans prototip ile uyumluluk). |

### Koçluk motoru
Canlı olay tespiti (`src/coach/monitor.ts`):
- **Manevralar:** şerit değişimi ve dönüşlerde *Ayna → Sinyal → Omuz → Manevra* sırası, geç/ters sinyal, açık unutulan sinyal, yanlış şeritten dönüş.
- **Kurallar:** hız bölgeleri (okul bölgesi toleransı daha dar), kırmızı ve riskli sarı ışık, DUR levhasında tam duruş, geçiş önceliği, yaya geçidinde yol verme, ters yön, kaldırım/refüj, gece far kullanımı.
- **Güvenlik:** araç/nesne/yaya çarpışmaları (şiddete göre), ramak kala (TTC), takip mesafesi (2 sn, yağmurda 4 sn), sert fren/hızlanma/viraj, tepki süresi.
- **Tarama:** ayna kontrol sıklığı, en uzun aynasız süre, kontrolsüz kavşaklarda yan tarama, girdi boşlukları (dikkat proxy'si).
- **Pürüzsüzlük:** jerk RMS, boylamsal/yanal konfor, direksiyon düzeltme oranı (SRR), hız istikrarı.

Puanlama 5 bileşen: **Güvenlik %30 · Kural %25 · Tarama %20 · Pürüzsüzlük %15 · Görev %10**. Kısa oturumlar düşük güvenle nötre çekilir; ağır ihlaller toplam puana tavan koyar.

### Rapor ve karne
- Rapor sekmeleri: özet (5 eksen + radar, koç önerileri, güçlü yönler), olay zaman çizelgesi, hız renkli rota haritası, hız/ivme/takip mesafesi grafikleri, tüm alt metrikler, kişisel profil karşılaştırması.
- Dışa aktarma: bağımsız HTML rapor, 10 Hz telemetri CSV, oturum JSON.
- Karne: EWMA ile güncellenen genel not ve 5 eksen, gelişim grafiği, rozetler, son oturumlar, kişisel sürüş profili; profiller JSON olarak dışa/içe aktarılabilir.

### Grafik
Gökyüzü + güneş/ay, gölgeler, PBR malzemeler, ortam yansımaları, bloom, FXAA/SMAA, zaman (sabah/öğle/gün batımı/gece) ve hava (açık/bulutlu/yağmur/sis). Gece aydınlatılmış pencereler, sokak lambası ışık havuzları ve gerçek far ışıkları.
**Kalite ön ayarları** (Düşük/Orta/Yüksek/Ultra) ilk açılışta GPU'ya göre otomatik önerilir.

## Kontroller

| Tuş | İşlev | Tuş | İşlev |
|---|---|---|---|
| W / ↑ | Gaz | Z / C / X | Sol / sağ / iç dikiz ayna |
| S / ↓ | Fren (durunca basılı: geri) | Shift+Z / Shift+C | Omuz kontrolü |
| A / D | Direksiyon | Q / E | Sinyal |
| Space / B | El freni | G | Dörtlü flaşör |
| 1–4 | Vites D/R/N/P | L | Farlar |
| V | Kamera | I | Silecek |
| M | Harita / hedef seç | J | Görev panosu |
| R | Aracı şeride al | U | HUD modu |
| Esc / P | Duraklat | F1 | Yardım |

Gamepad: sol çubuk direksiyon, RT gaz, LT fren, B el freni, LB/RB sinyal, sağ çubuk ayna/omuz bakışı, Y kamera.

## Proje yapısı

```
src/
  core/       matematik, ayarlar + kalite profilleri, güvenli depolama
  world/      harita tanımları, yol ağı (şerit grafiği), şehir/bina üretimi, dokular, ortam
  vehicle/    araç dinamiği, prosedürel modeller, kokpit, kamera rig'i, aynalar
  traffic/    trafik ışıkları, IDM tabanlı yapay zekâ trafiği, yayalar, instanced çizim
  missions/   A* rota, navigasyon, görev çalıştırıcı ve görev kataloğu
  coach/      olay tespiti, tarama takibi, telemetri, puanlama, profil/karne
  game/       oturum (ana döngü) ve harita paketi
  ui/         HUD, menüler, rapor, grafikler, harita çizimi
  audio/      sentezlenmiş sesler + Türkçe sesli yönlendirme
```

## Notlar
- Tarama ölçümleri davranışsal proxy'lerdir; klinik göz takibi değildir.
- Eğitim ve farkındalık amaçlı bir prototiptir; gerçek sürüş eğitiminin yerini tutmaz.
