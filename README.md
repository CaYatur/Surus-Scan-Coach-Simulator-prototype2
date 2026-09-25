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
| **Merkez Şehir** (~6 km², şehir çekirdeği ~1,6 km²) | Serbest sürüş + seçmeli görevler. Bulvarlar (refüjlü, 2+2 şerit), caddeler, tek yönlü yollar, park şeritli sokaklar, **iki dönel kavşak**, meydan, camiler, hastane, üniversite, çarşı, sanayi, parklar. Şehri çevreleyen **~10 km'lik D-200 çevre yolu** (2×3 şerit, beton bariyer, emniyet şeridi, bariyerler, geniş virajlar, üst geçit tabelaları), şehir dışında tarlalar, çiftlikler, orman, akaryakıt istasyonu ve lojistik merkezi. |
| **Eğitim Alanı** | Görev odaklı: kalibrasyon programı ve beceri atölyeleri. Işıklı bulvar, DUR levhalı sokak, park alanı (çizgili park yerleri, slalom). |

Şehir tamamen bildirimsel harita tanımlarından (`src/world/mapDefs.ts`) üretilir: şerit grafiği, kavşak kontrolü (sinyalizasyon / DUR / yol ver / dönel kavşak), yaya geçitleri, bloklar, binalar ve donatılar.

**Bölgesel hız sınırları** (levhalarla işaretli, bölgeye girince HUD uyarısı):

| Bölge / yol | Sınır |
|---|---|
| Yaya öncelikli çarşı | 20 |
| Sokak, okul bölgesi, hastane bölgesi (korna yasak), park çevresi, kampüs, dönel kavşak | 30 |
| Şehir merkezi (cadde/tek yön) | 40 |
| Cadde | 50 |
| Atatürk / Millet bulvarları | 60 |
| Kuşak yolu bulvarları | 70 |
| Yerleşim yeri dışı yollar | 90 |
| D-200 bölünmüş çevre yolu (kavşak yaklaşımında 70, virajda 90) | 110 |

### Görevler
- **Kalibrasyon:** 10 adımlı *Kalibrasyon Programı* (hızlanma, sola/sağa dönüş, şerit değişimi, tepki testi, DUR levhası, park) ve *Hızlı Kalibrasyon* (2 dk serbest). Kişisel sürüş profilini (Sürüş stili profili) çıkarır.
- **Beceri:** Ayna–Sinyal–Manevra atölyesi, park etme, tepki testi serisi.
- **Şehir:** Şehir turu, taksi (yolcu konforu), okul bölgesi (çocuk yaya olayı), yoğun saat (ani fren eden araç), gece sürüşü, yağmurlu yol, paralel park, bulvar şeritleri, **Çevre Yolu (D-200)** (bölünmüş yol, sollama, viraj), **Dönel Kavşaklar**, **Hız Bölgeleri Turu**, **Ambulansa Yol Ver**.
- Serbest sürüşte **J** ile görev panosunu açıp bulunduğun yerden görev başlatabilirsin; **M** ile haritadan tıklayarak hedef seçebilirsin.
- Görev sonunda başarı/başarısızlık, yıldız (0–3), hedef listesi ve ölçüm satırları (ör. tepki süresi, park hizası) gösterilir.

### Sürüş ve araç
- Bisiklet modeli + lastik tutuş limiti (yağmurda azalır), tork eğrisi, el freni.
- **Kontrol ön ayarları** (Ayarlar → Kontroller):
  - **Kolay:** otomatik şanzıman (fren tuşuyla durup basılı tutunca geri vitese geçer), ABS, otomatik far, sinyal otomatik kapanır, hıza duyarlı direksiyon.
  - **Gelişmiş:** **manuel şanzıman + debriyaj** (vites 1–6 / R / N, sıralı vites yükselt-düşür; debriyaj yardımı kapalıysa vites debriyajsız girmez ve **motor stop edebilir**), fren yalnızca frendir, farlar elle.
  - **Özel:** şanzıman (otomatik / vites seçici P-R-N-D / manuel), debriyaj yardımı, ABS (kapalıyken sert frende tekerlek kilitlenir), otomatik far, otomatik sinyal kapanması ayrı ayrı.
- **Hız sabitleyici** (K, =/− ile ±5 km/h; fren/debriyaj/el freni iptal eder).
- **Tüm tuşlar yeniden atanabilir** (tıkla → yeni tuşa bas); yardım ekranı ve alt ipucu çubuğu atamalara göre güncellenir.
- Klavye (analog benzetimli), **gamepad** ve **direksiyon seti** (eksen eşleme + otomatik algılama sihirbazı; manuel modda 5. eksen debriyaj pedalı).
- Prosedürel araç modelleri: hatchback, sedan, station wagon, SUV, pikap, hafif ticari, taksi, dolmuş/minibüs, otobüs, kamyon, **TIR (çekici + dorse, virajda dorse gerçekçi şekilde içeriden döner)**, motosiklet (kurye), **polis** ve **ambulans** (tepe lambaları + siren).

### Trafik (botlar)
- IDM araç takibi; bölge hız sınırlarına uyar (ağır vasıtalar en fazla 85 km/h ve sağ şeritlerde kalır).
- Çok şeritli yollarda **sinyal vererek şerit değiştirir**: yavaş aracı soldan sollar, sonra sağa döner (bölünmüş yolda sağdan gitme kuralı); kavşak yaklaşımındaki düz çizgide şerit değiştirmez.
- Işık, DUR, yol ver kurallarına ve **dönel kavşakta içerideki araca** yol verir; dönüşlerde ve göbekten çıkarken sinyal verir.
- **Sirenli ambulans/polis** zaman zaman arkadan gelir (Ayarlar → Koçluk ile kapatılabilir); diğer araçlar sağa geçer veya kenara yanaşır, acil araç engeli soldan geçer.
- Yol tipine göre araç karışımı (çevre yolunda TIR/kamyon, merkezde taksi/dolmuş/motosiklet).

### İç mekân ve kameralar
6 kamera modu (**V**): sürücü koltuğu, eğitmen koltuğu, kaput, yakın/uzak takip, kuşbakışı.
Kokpitte canlı analog göstergeler, gerçekten dönen direksiyon ve eller, vites/el freni kolu, navigasyon ekranı, **gerçek zamanlı yansıtan iç dikiz ve yan aynalar**, yağmurda silecekler ve camda damlalar. FOV, koltuk yüksekliği/konumu, g-kuvveti baş hareketi ve fareyle serbest bakış ayarlanabilir.

### Tarama (scan) ölçümü — 3 mod
| Mod | Açıklama |
|---|---|
| **Bakış tuşları + sinyal** (varsayılan) | Z sol ayna, C sağ ayna, X iç dikiz, Shift+Z/C omuz kontrolü. Sürücünün başı gerçekten o yöne döner; bakış hedefe ulaşınca "kontrol" sayılır. |
| **Webcam kafa takibi** | MediaPipe Face Landmarker ile kafanı çevirerek aynalara bak. Görüntü cihazda işlenir; model ilk kullanımda CDN'den indirilir. |
| **Tek tuş (eski)** | Bakış tuşlarından herhangi biri = yön ayırt etmeyen tarama proxy'si (referans prototip ile uyumluluk). |

### Koçluk motoru
Canlı olay tespiti (`src/coach/monitor.ts`):
- **Manevralar:** şerit değişimi ve dönüşlerde *Ayna → Sinyal → Omuz → Manevra* sırası, geç/ters sinyal, açık unutulan sinyal, yanlış şeritten dönüş.
- **Yanlış pozitife dayanıklı şerit değişimi:** araç çizgiyi geçtiği an hazırlık (ayna/sinyal/omuz) kaydedilir, ama şerit değişimi ancak araç yeni şeride yerleşince (≈0,8 sn + çizgiden ≥0,9 m içeride) sayılır. Aracı dengelemek için yapılan küçük sağ-sol düzeltmeler veya çizgiye yaklaşıp geri dönmek şerit değişimi sayılmaz; iki kolu olan köşelerde ve çevre yolu virajlarında dönüş sinyali aranmaz.
- **Kurallar:** bölgeye göre hız (okul/hastane/çarşıda 3 km/h, diğer yollarda %10 tolerans), kırmızı ve riskli sarı ışık, DUR levhasında tam duruş, geçiş hakkı, yaya geçidinde yol verme, ters yön, kaldırım/refüj, gece far kullanımı, **düz çizgide şerit değiştirme**, **zikzak (sık şerit değiştirme)**, **emniyet şeridinde seyir**, **sağdan sollama**, **sol şeridi gereksiz işgal**, bölünmüş yolda **trafiği engelleyen yavaş seyir**, **korna yasağı** (okul/hastane), **kavşağı tıkama**, **dönel kavşakta yol vermeme / çıkışta sinyal vermeme**, **sirenli araca yol vermeme**, motor stop etme (manuel).
- **Güvenli sürüş:** araç/nesne/yaya çarpışmaları (şiddete göre), ramak kala (TTC), takip mesafesi (2 sn, yağmurda 4 sn), sert fren/hızlanma/viraj, tepki süresi.
- **Gözlem:** ayna kontrol sıklığı, en uzun aynasız süre, kontrolsüz kavşaklarda yan tarama, girdi boşlukları (dikkat proxy'si).
- **Araç hâkimiyeti:** jerk RMS, boylamsal/yanal konfor, direksiyon yön değiştirme oranı (SRR), hız istikrarı, **şerit pozisyonu sapması (RMS)**.

Puanlama 5 bileşen: **Güvenli sürüş %30 · Kural %25 · Gözlem %20 · Araç hâkimiyeti %15 · Görev & güzergâh %10**. Kısa oturumlar düşük güvenle nötre çekilir; ağır ihlaller toplam puana tavan koyar.

### Rapor ve karne
- Rapor sekmeleri: özet (5 eksen + radar, koç önerileri, güçlü yönler), olay zaman çizelgesi, hız renkli rota haritası, hız/ivme/takip mesafesi grafikleri, tüm alt metrikler (bölünmüş yol kuralları, dönel kavşak, özel bölgeler, geçiş üstünlüğü dahil), **bölge bazında hız uyum tablosu**, kişisel profil karşılaştırması.
- Dışa aktarma: bağımsız HTML rapor, 10 Hz telemetri CSV, oturum JSON.
- Karne: EWMA ile güncellenen genel not ve 5 eksen, gelişim grafiği, rozetler, son oturumlar, kişisel sürüş profili; profiller JSON olarak dışa/içe aktarılabilir.

### Grafik
Gökyüzü + güneş/ay, gölgeler, PBR malzemeler, ortam yansımaları, bloom, FXAA/SMAA, zaman (sabah/öğle/gün batımı/gece) ve hava (açık/bulutlu/yağmur/sis). Gece aydınlatılmış pencereler, sokak lambası ışık havuzları ve gerçek far ışıkları.
**Kalite ön ayarları** (Düşük/Orta/Yüksek/Ultra) ilk açılışta GPU'ya göre otomatik önerilir.

## Kontroller (varsayılan — hepsi Ayarlar → Kontroller'den değiştirilebilir)

| Tuş | İşlev | Tuş | İşlev |
|---|---|---|---|
| W / ↑ | Gaz | Z / X / C | Sol ayna / iç dikiz / sağ ayna |
| S / ↓ | Fren (Kolay modda durunca basılı: geri) | Shift + Z / C | Omuz kontrolü |
| A / D, ← / → | Direksiyon | Q / E | Sol / sağ sinyal |
| Boşluk | El freni | G | Dörtlü flaşör |
| H | Korna | L / I | Farlar / silecek |
| F / R / N / P | Vites D / R / N / P (vites seçici) | K, = / − | Hız sabitleyici, ±5 km/h |
| 1–6, PgUp/PgDn ( ] / [ ) | Manuel vites | B | Debriyaj (manuel, yardım kapalı) |
| V | Kamera | M | Harita / hedef seç |
| J / Tab | Görev panosu | U | HUD modu |
| ⌫ Geri | Aracı şeride al | Esc | Duraklat |
| F1 | Yardım | O | Kafa takibini merkezle |

Gamepad: sol çubuk direksiyon, RT gaz, LT fren, B el freni, LB/RB sinyal, sağ çubuk ayna/omuz bakışı, Y kamera, X dörtlü, R3 hız sabitleyici; manuel modda D-pad ↑/↓ vites.

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
