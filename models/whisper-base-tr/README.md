# whisper-base-tr (ONNX, q8)

Konuşma Defteri'nin varsayılan Türkçe konuşma tanıma modeli.

- **Kaynak ağırlıklar:** [ysdede/whisper-base-turkish-1.1](https://huggingface.co/ysdede/whisper-base-turkish-1.1)
  (openai/whisper-base'in Türkçe'ye ince ayarlı sürümü, Apache-2.0).
- **ONNX grafiği, tokenizer ve yapılandırma:** [onnx-community/whisper-base](https://huggingface.co/onnx-community/whisper-base).
- **Dönüştürme:** PyTorch olmadan; onnx-community/whisper-base'in nicelenmiş (q8) kodlayıcı/çözücü
  grafiklerindeki her ağırlık, orijinal openai/whisper-base parametreleriyle birebir değer eşleşmesiyle
  bulunup ince ayarlı değerlerle aynı niceleme şemasıyla (kodlayıcı uint8 asimetrik, çözücü int8 simetrik,
  gömme tablosu uint8 simetrik) yeniden yazıldı. Aynı işlem orijinal ağırlıklarla yapıldığında
  onnx-community dosyalarının tüm tensörleri bit bit aynı çıkıyor. Betikler: `tools/convert/`.

## Doğruluk (normalleştirilmiş WER, düşük daha iyi)

Uygulamadaki çözme ayarlarıyla, 100 FLEURS tr (dev) + 120 Türkiye Büyük Millet Meclisi konuşması
(alimetin/turkish-parliament-speech, test; 2026 kayıtları — model eğitiminden sonra):

| Model | FLEURS | Parlamento | Toplam |
|---|---|---|---|
| onnx-community/whisper-base (çok dilli) | 33,1 | 29,9 | 31,5 |
| **whisper-base-tr (bu model)** | **19,0** | **18,2** | **18,6** |
| onnx-community/whisper-small (çok dilli, 3x büyük) | 16,9 | 19,4 | 18,2 |
