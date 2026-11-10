# İnce ayarlı Whisper modelini telefona (ONNX q8) dönüştürme

PyTorch gerektirmez. Aynı mimarideki (ör. whisper-base) herhangi bir ince ayarlı modelin
ağırlıkları, onnx-community'nin hazır nicelenmiş ONNX grafiklerine aktarılır.

```bash
pip install onnx onnxruntime safetensors numpy
# kaynaklar (src/ocb = onnx-community/whisper-base kopyası)
#   src/ocb/onnx/{encoder_model,decoder_model_merged}{,_quantized}.onnx
#   src/ocb/{config,generation_config,preprocessor_config,tokenizer,tokenizer_config}.json
#   src/openai-base/model.safetensors   (openai/whisper-base — eşleme için)
#   src/aday/model.safetensors          (ince ayarlı model)
PYTHONPATH=tools/convert python tools/convert/transplant.py src/ocb src/openai-base/model.safetensors src/aday/model.safetensors models/yeni-model
```

Doğrulama: aday yerine yine `openai-base/model.safetensors` verilirse çıkan dosyalardaki tüm
tensörler onnx-community'nin `_quantized` dosyalarıyla bit bit aynı olmalıdır.

Doğruluk karşılaştırması: `tools/eval_wer.mjs` (Node + transformers.js; FLEURS tr ve parlamento test seti).
