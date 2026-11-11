# Konuşma Defteri

iPhone'da (Safari) çalışan, **internete ses göndermeden** konuşmaları metne döken,
konuşmacıları ayıran ve tanıyan bir uygulama. İsteğe bağlı olarak, **siz düğmeye bastığınızda**,
konuşmanın *metnini* Claude'a (varsayılan: Claude Opus 5.5) gönderip özet çıkarır ve sorularınızı yanıtlar.

## Neler yapıyor?

| Özellik | Nerede çalışır | İnternet? |
|---|---|---|
| Ses kaydı (duraklat/devam, kesintiye karşı otomatik ara kayıt) | Telefon | Hayır |
| Ses dosyası içe aktarma (Sesli Notlar, WhatsApp sesi, m4a/mp3/wav…) | Telefon | Hayır |
| Konuşmacı ayırma ("kim ne zaman konuştu") — pyannote 3.0 | Telefon | Hayır |
| Konuşmacı tanıma (bir kez "Bu sesi tanı" deyin, sonraki kayıtlarda adıyla gelsin) — WeSpeaker | Telefon | Hayır |
| Konuşma → metin — Türkçe'ye ince ayarlı Whisper (varsayılan) veya çok dilli tiny/base/small | Telefon | Hayır |
| Metni elle düzeltme, konuşmacı değiştirme/birleştirme, arama | Telefon | Hayır |
| Dışa aktarma (.txt / .md / .json, paylaş menüsü, panoya kopyala) | Telefon | Hayır |
| **Metni düzelt** (yanlış duyulan kelimeleri bağlamdan düzeltir; öneriler tek tek onaylanır, geri alınabilir) — Claude | Anthropic API | Evet, yalnızca metin |
| **Özetle** (karar, yapılacaklar, takip soruları) — Claude | Anthropic API | Evet, yalnızca metin |
| **Soru sor** (tek kayıt veya seçilen birden çok kayıt) — Claude | Anthropic API | Evet, yalnızca metin |

- İnternet yalnızca iki şey için kullanılır: (1) ilk kullanımda modellerin **indirilmesi**
  (≈110 MB: Türkçe model bu sitenin kendisinden, konuşmacı modelleri Hugging Face'ten) ve
  (2) sizin bastığınız Claude düğmeleri.
- Sayfanın güvenlik politikası (CSP) yalnızca kendi dosyalarına, `huggingface.co` / `*.hf.co`
  ve `api.anthropic.com` adreslerine bağlantıya izin verir. Ses için yükleme kodu yoktur.
- Claude isteklerinde ses yok, yalnızca metin var; Claude hiçbir zaman otomatik çağrılmaz.
- API anahtarı yalnızca telefonda (tarayıcının yerel deposunda) tutulur ve doğrudan
  `api.anthropic.com`'a gider; arada sunucu yoktur.

## iPhone'a kurulum

Uygulama statik bir web sitesidir (sunucu kodu yok); bu depo GitHub Pages ile yayınlanır:
**<https://mssaydam.github.io/stt-app/>**. Veriler sitede değil, her kullanıcının kendi telefonunda saklanır.
`main` dalına yapılan her gönderim `.github/workflows/pages.yml` ile otomatik yayınlanır.

### Telefonda
1. Safari'de adresi açın → **Paylaş → Ana Ekrana Ekle** → uygulamayı ana ekrandaki simgeden açın. (Önemli: Ana ekrana eklenen
   uygulamaların verilerini iOS kendiliğinden silmez ve uygulama internetsiz açılır.)
2. Ana ekran uygulamasının içinde Ayarlar → **"Seçili modelleri şimdi indir"** (Wi-Fi'de, bir kerelik).
   iOS ana ekran uygulamasının depolamasını Safari'den ayrı tutar; Safari sekmesinde indirilenler orada görünmez.
3. İsterseniz Ayarlar → **Claude API** bölümüne anahtarınızı girin
   (<https://platform.claude.com/settings/keys>; orada aylık harcama sınırı koyabilirsiniz).
4. Kayıt sırasında ekranı açık tutun (uygulama ekranı kendisi açık tutar).

### Kayıt ve ekran kilidi

iOS, ekran kilitlendiğinde ya da başka uygulamaya geçildiğinde **web uygulamalarının** mikrofonunu kapatır;
bu bir iOS kuralıdır ve web uygulaması tarafından aşılamaz (yerel uygulamalar "arka plan ses" izniyle aşar).
Bu yüzden (1.3 sürümü):

- **Yanlışlıkla durdurmaya karşı:** kayıt ekranındaki Bitir / Duraklat / İptal düğmeleri yalnızca
  **basılı tutunca** çalışır (çevrelerinde dolan halka); kısa dokunuşlar kaydı etkilemez.
- **Ekranı açık tutma:** Screen Wake Lock API; çalışmazsa sessiz, görünmez küçük bir video yedeği.
- **Kesintiye karşı:** uygulama arka plana geçtiği anda o ana kadarki kayıt saklanır. Dönüşte mikrofon
  hâlâ açıksa kayıt sürer ve kaydedilemeyen süre için uyarı gösterilir; mikrofon kapanmışsa kaydedilen
  kısım işlenir ve bu açıkça söylenir. Uygulama tamamen kapanmışsa açılışta "yarım kalmış kayıt" kurtarılır.
- Kayıt göstergesi her zaman görünürdür; iOS da mikrofon kullanılırken turuncu göstergeyi yakar.
- **Ekran kapalıyken kayıt için:** iPhone'un **Ses Notları** uygulamasıyla kaydedin (kilitli ekranda çalışır)
  → kayıt → ••• → **Dosyalar'a Kaydet** → bu uygulamada **↑ İçe aktar**. (Ses Notları'nın iCloud eşitlemesi
  açıksa kayıt iCloud'a yüklenir; istemiyorsanız Ayarlar → [adınız] → iCloud → Ses Notları'nı kapatın.)
- **Dokunmatiği tamamen kilitlemek için:** Ayarlar → Erişilebilirlik → **Yönlendirmeli Erişim**; kayıt
  ekranında yan tuşa üç kez basıp "Dokunma"yı kapatın.

## Model seçimi, hız ve bellek

| Model | İndirme | Türkçe kelime hatası (WER)† | İşlem sırasında tepe bellek* | Süre* |
|---|---|---|---|---|
| **Türkçe – base-tr (varsayılan)** | ~77 MB | **%18,6** | ~700 MB | ~73 sn |
| tiny (çok dilli) | ~41 MB | (~%65‡) | ~560 MB | 47 sn |
| base (çok dilli) | ~77 MB | %31,5 | ~700 MB | ~95 sn |
| small (çok dilli) | ~250 MB | %18,2 | ~1,2 GB — **iPhone'da sığmayabilir** | 142 sn |

† 100 FLEURS tr + 120 TBMM konuşması (2026), normalleştirilmiş; ayrıntı: `models/whisper-base-tr/README.md`.
‡ Ölçmedim; turkmedstt/turkish-asr-benchmark tablosundaki değer (farklı test seti).

“Türkçe” model, [ysdede/whisper-base-turkish-1.1](https://huggingface.co/ysdede/whisper-base-turkish-1.1)
ağırlıklarının telefona dönüştürülmüş hâlidir (`tools/convert/`); boyutu, hızı ve belleği çok dilli
`base` ile aynıdır. Türkçe dışı bir dil seçilirse otomatik olarak çok dilli model kullanılır.

\* Masaüstü Chromium (CPU/WASM, tek iş parçacığı), 80 sn'lik 3 kişilik test sesi. **iPhone'da ölçülmedi**;
iOS bir web sayfasına sınırlı bellek verir ve aşılırsa sayfayı kapatıp yeniden yükler
("Bu web sayfasında bir sorun oluştu" mesajı).

Belleği düşük tutmak için (1.1 sürümü):
- Konuşmacı ayırma ve metne çevirme **ayrı işçilerde** çalışır; biri bitince kapatılır ve belleği geri verilir.
- WebGPU'suz küçük ONNX Runtime çekirdeği (11 MB) kullanılır ve graf optimizasyonu kapalıdır
  (tepe bellek ~150–190 MB düşük; karşılığında metne çevirme ~%50 daha yavaş).
- "Modelleri indir" düğmesi dosyaları belleğe yüklemeden doğrudan önbelleğe indirir.
- İşlemci varsayılanı **CPU**'dur. GPU (WebGPU) seçeneği deneyseldir; iPhone'da kapanmaya yol açabilir.

Uygulama işlem sırasında kapanırsa, tekrar açıldığında hangi aşamada kapandığını gösterir ve
"Hafif modelle dene (tiny)" önerir. Ayarlar → **Tanılama → Raporu kopyala** ile cihaz/hata bilgisi
(kayıt içeriği olmadan) paylaşılabilir.

- Kayıt ekranında **konuşmacı sayısını** seçmek, otomatik algılamadan daha güvenilir sonuç verir.
- Yanlış ayrılan kişiler için: konuşmacıya dokun → "Başka bir konuşmacıyla birleştir";
  tek bir cümle için: cümleye dokun → "Konuşmacıyı değiştir".
- Uzun kayıtlar (≈1 saat üzeri) iPhone tarayıcısının bellek sınırına takılabilir; toplantıları
  gerekirse parça parça kaydedin.

## Teknik yapı

```
./
├── index.html              arayüz iskeleti + CSP
├── css/app.css
├── js/app.js               ekranlar, kayıt, işleme kuyruğu, dışa aktarma, Claude düğmeleri
├── js/engine.js            konuşmacı ayırma + kümeleme + tanıma + Whisper (Node'da da çalışır)
├── js/worker.js            modelleri Web Worker'da çalıştırır (her aşama ayrı işçi; arayüz donmaz)
├── js/claude.js            Anthropic SDK ile özet / soru-cevap (akışlı, prompt caching)
├── js/db.js                IndexedDB (kayıtlar, sesler, kişi profilleri, ara kayıtlar)
├── sw.js                   service worker (çevrimdışı açılış)
├── manifest.webmanifest, icons/
└── vendor/                 transformers.js 3.8.1, ONNX Runtime Web 1.22 WASM (CPU + WebGPU çekirdekleri), @anthropic-ai/sdk 1.1.0
```

İşleme hattı (tamamen cihazda):
1. Ses 16 kHz mono'ya çevrilir.
2. **pyannote-segmentation-3.0** 10 sn'lik pencerelerde konuşma bölgelerini ve yerel konuşmacıları bulur.
3. Her yerel konuşmacının sesinden **WeSpeaker ResNet34** ile 256 boyutlu ses izi çıkarılır;
   kosinüs benzerliğiyle birleştirici kümeleme yapılarak tüm kayıt boyunca kim kimdir bulunur.
4. Kümeler, kaydedilmiş kişi profilleriyle eşleştirilir (tanıma).
5. Aynı kişinin kesintisiz konuşması (≤28 sn) **Whisper**'a ayrı ayrı verilir; uzun sessizlikler
   kısaltılır, tekrar döngüleri ayıklanır. (Karışık 30 sn pencerelere göre Türkçe'de belirgin
   şekilde daha az atlama/tekrar.)

Claude çağrısı: `claude-opus-5-5`, uyarlamalı düşünme (`thinking: {type: "adaptive"}`),
ayarlanabilir `effort`, akışlı yanıt; konuşma metni sistem isteminde önbelleğe alınır (aynı
kayda sorulan sonraki sorular ucuzlar). Güvenlik sınıflandırıcısı bir isteği yanlışlıkla
reddederse sunucu tarafı yedek model (`fallbacks: "default"`) devreye girer.

## Geliştirme / test

Yerelde çalıştırmak için (mikrofon için `localhost` güvenli sayılır):
```
cd konusma
python -m http.server 8000
# http://localhost:8000
```

Lisanslar: Whisper (MIT), pyannote segmentation 3.0 (MIT), WeSpeaker (Apache-2.0),
transformers.js (Apache-2.0), ONNX Runtime (MIT), Anthropic TypeScript SDK (lisans dosyası `vendor/` içinde).
