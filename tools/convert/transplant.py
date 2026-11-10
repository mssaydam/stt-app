"""
Whisper (base) ince ayarlı ağırlıklarını onnx-community/whisper-base'in nicelenmiş (q8)
ONNX grafiklerine aktarır. PyTorch gerekmez.

1) fp32 ONNX initializer'larını orijinal openai/whisper-base parametrelerine birebir değer
   eşleşmesiyle bağlar (gerekirse transpoze).
2) Nicelenmiş grafikte her ağırlığı, yeni (ince ayarlı) değerlerle AYNI şemayla yeniden niceler:
   kodlayıcı: uint8 asimetrik; çözücü MatMul: int8 simetrik; gömme tablosu: uint8 simetrik (zp=127).
   (Bu formüllerin onnx-community dosyalarını bit bit ürettiği doğrulandı.)
Kullanım: transplant.py <src_dir_with_ocb> <hf_safetensors> <out_dir>
"""
import sys, os, hashlib, json, shutil, numpy as np, onnx
from onnx import numpy_helper
from safetensors.numpy import load_file
from common import inits, quant_u8, quant_i8

def h(a): return hashlib.blake2b(np.ascontiguousarray(a).tobytes(), digest_size=16).hexdigest()

def build_map(fp_inits, ref):
    idx = {}
    for name, a in ref.items():
        idx.setdefault((a.shape, h(a)), []).append((name, False))
        if a.ndim == 2:
            t = np.ascontiguousarray(a.T); idx.setdefault((t.shape, h(t)), []).append((name, True))
    mapping, missing, ambiguous = {}, [], []
    for name, tp in fp_inits.items():
        if tp.data_type != onnx.TensorProto.FLOAT: continue
        a = numpy_helper.to_array(tp)
        if a.size < 2: continue  # skaler sabitler
        c = idx.get((a.shape, h(a)))
        if not c: missing.append((name, a.shape)); continue
        if len({x[0] for x in c}) > 1: ambiguous.append((name, c))
        mapping[name] = c[0]
    return mapping, missing, ambiguous

def quant_embed(w):
    absmax = max(abs(float(w.min())), abs(float(w.max())))
    sc = np.float32(2 * absmax / 255)
    return np.clip(np.round(w / sc) + 127, 0, 255).astype(np.uint8), sc, np.uint8(127)

def transplant(src, kind, ref, new, out_path):
    fp = inits(onnx.load(f'{src}/onnx/{kind}.onnx'))
    mapping, missing, ambiguous = build_map(fp, ref)
    qm = onnx.load(f'{src}/onnx/{kind}_quantized.onnx')
    q = inits(qm)
    changed = 0
    for name, t in q.items():
        if name.endswith('_quantized'):
            base = name[:-len('_quantized')]
            if base not in mapping: raise SystemExit(f'eşlenemeyen nicelenmiş ağırlık: {base}')
            pname, tr = mapping[base]
            w = new[pname].astype(np.float32); w = np.ascontiguousarray(w.T) if tr else w
            old = numpy_helper.to_array(t)
            if 'embed_tokens' in base: qq, sc, zp = quant_embed(w)
            elif old.dtype == np.uint8: qq, sc, zp = quant_u8(w)
            else: qq, sc, zp = quant_i8(w)
            assert qq.shape == old.shape, (name, qq.shape, old.shape)
            t.CopyFrom(numpy_helper.from_array(qq, name))
            q[base + '_scale'].CopyFrom(numpy_helper.from_array(np.array(sc, dtype=np.float32), base + '_scale'))
            q[base + '_zero_point'].CopyFrom(numpy_helper.from_array(np.array(zp, dtype=qq.dtype), base + '_zero_point'))
            changed += 1
        elif t.data_type == onnx.TensorProto.FLOAT and name in mapping:
            pname, tr = mapping[name]
            w = new[pname].astype(np.float32); w = np.ascontiguousarray(w.T) if tr else w
            assert list(w.shape) == list(t.dims), (name, w.shape, t.dims)
            t.CopyFrom(numpy_helper.from_array(w, name))
            changed += 1
    onnx.save(qm, out_path)
    return changed, missing, ambiguous

if __name__ == '__main__':
    src, ref_path, new_path, out = sys.argv[1:5]
    ref = load_file(ref_path); new = load_file(new_path)
    # bazı ince ayarlı modellerde ad öneki farklı olabilir
    if set(ref) != set(new):
        print('UYARI: parametre adları farklı:', sorted(set(ref) ^ set(new))[:10])
    os.makedirs(f'{out}/onnx', exist_ok=True)
    for kind in ['encoder_model', 'decoder_model_merged']:
        n, missing, amb = transplant(src, kind, ref, new, f'{out}/onnx/{kind}_quantized.onnx')
        print(f'{kind}: {n} initializer güncellendi; eşlenemeyen fp32: {missing[:6]} ({len(missing)}); belirsiz: {len(amb)} {[(a, [x[0] for x in c]) for a, c in amb[:3]]}')
    for f in ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']:
        shutil.copy(f'{src}/{f}', f'{out}/{f}')
