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
| Konuşma → metin — Whisper tiny/base/small | Telefon | Hayır |
| Metni düzeltme, konuşmacı değiştirme/birleştirme, arama | Telefon | Hayır |
| Dışa aktarma (.txt / .md / .json, paylaş menüsü, panoya kopyala) | Telefon | Hayır |
| **Özetle** (karar, yapılacaklar, takip soruları) — Claude | Anthropic API | Evet, yalnızca metin |
| **Soru sor** (tek kayıt veya seçilen birden çok kayıt) — Claude | Anthropic API | Evet, yalnızca metin |

- İnternet yalnızca iki şey için kullanılır: (1) ilk kullanımda modellerin Hugging Face'ten
  **indirilmesi** (≈90 MB, "small" modelle ≈260 MB) ve (2) sizin bastığınız Claude düğmeleri.
- Sayfanın güvenlik politikası (CSP) yalnızca kendi dosyalarına, `huggingface.co` / `*.hf.co`
  ve `api.anthropic.com` adreslerine bağlantıya izin verir. Ses için yükleme kodu yoktur.
- Claude isteklerinde ses yok, yalnızca metin var; Claude hiçbir zaman otomatik çağrılmaz.
- API anahtarı yalnızca telefonda (tarayıcının yerel deposunda) tutulur ve doğrudan
  `api.anthropic.com`'a gider; arada sunucu yoktur.

## iPhone'a kurulum

Uygulama statik bir web sitesidir (sunucu kodu yok). HTTPS üzerinden yayınlanması yeterlidir;
veriler sitede değil, her kullanıcının kendi telefonunda saklanır.

### Seçenek A — Netlify Drop (ücretsiz, en kolay, Windows'tan 1 dakika)
1. <https://app.netlify.com/drop> adresini açın (ücretsiz hesap).
2. Bu depodaki **`konusma`** klasörünü sayfaya sürükleyip bırakın.
3. Verilen `https://….netlify.app` adresini iPhone'da **Safari** ile açın.

(Cloudflare Pages → "Upload assets" de aynı şekilde çalışır.)

### Seçenek B — GitHub Pages
Bu depo **özel (private)**; GitHub'ın ücretsiz planında özel depolardan Pages yayını yapılamaz
(GitHub Pro gerekir). Pro'nuz varsa:
1. Depo → Settings → Pages → Source: **GitHub Actions**.
2. Değişiklikleri `main` dalına birleştirin; `.github/workflows/konusma-pages.yml` otomatik yayınlar.
3. Adres: `https://<kullanıcı>.github.io/dresscode/`.

### Telefonda
1. Safari'de adresi açın → **Paylaş → Ana Ekrana Ekle**. (Önemli: Ana ekrana eklenen
   uygulamaların verilerini iOS kendiliğinden silmez ve uygulama internetsiz açılır.)
2. Ayarlar → **"Seçili modelleri şimdi indir"** (Wi-Fi'de, bir kerelik).
3. İsterseniz Ayarlar → **Claude API** bölümüne anahtarınızı girin
   (<https://platform.claude.com/settings/keys>; orada aylık harcama sınırı koyabilirsiniz).
4. Kayıt sırasında ekranı açık tutun (uygulama ekranı kendisi açık tutmaya çalışır).
   iOS, ekran kilitlenince veya başka uygulamaya geçince web uygulamalarının mikrofonunu durdurur.

## Model seçimi ve hız

| Model | İndirme | Türkçe doğruluk | Göreli hız |
|---|---|---|---|
| tiny | ~41 MB | zayıf | en hızlı |
| base (varsayılan) | ~77 MB | orta | orta |
| small | ~250 MB | iyi | base'in ~2–3 katı süre |

Ölçülen: masaüstü Chromium'da (WASM, tek iş parçacığı) 80 sn'lik 3 kişilik test sesi tiny ile
~40 sn'de işlendi. **iPhone'da hız henüz ölçülmedi**; telefonda daha yavaş olması beklenir.

- iOS 26 ve sonrası Safari'de WebGPU varsa "İşlemci: Otomatik" onu kullanır ve belirgin şekilde hızlanır.
- Kayıt ekranında **konuşmacı sayısını** seçmek, otomatik algılamadan daha güvenilir sonuç verir.
- Yanlış ayrılan kişiler için: konuşmacıya dokun → "Başka bir konuşmacıyla birleştir";
  tek bir cümle için: cümleye dokun → "Konuşmacıyı değiştir".
- Uzun kayıtlar (≈1 saat üzeri) iPhone tarayıcısının bellek sınırına takılabilir; toplantıları
  gerekirse parça parça kaydedin.

## Teknik yapı

```
konusma/
├── index.html              arayüz iskeleti + CSP
├── css/app.css
├── js/app.js               ekranlar, kayıt, işleme kuyruğu, dışa aktarma, Claude düğmeleri
├── js/engine.js            konuşmacı ayırma + kümeleme + tanıma + Whisper (Node'da da çalışır)
├── js/worker.js            modelleri Web Worker'da çalıştırır (arayüz donmaz)
├── js/claude.js            Anthropic SDK ile özet / soru-cevap (akışlı, prompt caching)
├── js/db.js                IndexedDB (kayıtlar, sesler, kişi profilleri, ara kayıtlar)
├── sw.js                   service worker (çevrimdışı açılış)
├── manifest.webmanifest, icons/
└── vendor/                 transformers.js 3.8.1, ONNX Runtime Web WASM, @anthropic-ai/sdk 1.1.0
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
