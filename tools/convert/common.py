import onnx, numpy as np
from onnx import numpy_helper

def walk(g):
    yield g
    for n in g.node:
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH: yield from walk(a.g)
            for sg in a.graphs: yield from walk(sg)

def inits(model):
    """Tüm (alt)graflardaki initializer'lar: ad -> TensorProto"""
    out = {}
    for g in walk(model.graph):
        for i in g.initializer: out[i.name] = i
    return out

def quant_u8(w):
    # ORT dinamik niceleme, QUInt8 asimetrik (reduce_range=False)
    rmin = min(float(w.min()), 0.0); rmax = max(float(w.max()), 0.0)
    scale = np.float32((rmax - rmin) / 255.0) if rmax > rmin else np.float32(1.0)
    zp = np.uint8(np.clip(np.round(-rmin / scale), 0, 255))
    q = np.clip(np.round(w / scale) + zp, 0, 255).astype(np.uint8)
    return q, scale, zp

def quant_i8(w):
    # ORT dinamik niceleme, QInt8 simetrik
    absmax = max(abs(float(w.min())), abs(float(w.max())))
    scale = np.float32(absmax / 127.0) if absmax > 0 else np.float32(1.0)
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
    return q, scale, np.int8(0)
