// Ses işleme Web Worker'ı. Arayüzü kilitlememek için model işleri burada çalışır.
// Bu worker yalnızca model dosyalarını (Hugging Face) indirir; ses hiçbir yere gönderilmez.
//
// Bellek: Her işçi TEK bir aşama yapar (konuşmacı ayırma VEYA metne çevirme) ve iş
// bitince ana sayfa tarafından tamamen kapatılır. WebAssembly belleği bir kez büyüyünce
// küçülmediği için, iki aşamayı aynı işçide yapmak telefonda belleği aşıyordu.

import * as T from '../vendor/transformers.min.js';
import { Engine, matchProfiles, asrModelFor } from './engine.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const LOCAL_MODELS = new URL('../models/', import.meta.url).href; // sitede barındırılan Türkçe model
T.env.allowLocalModels = false;
T.env.useBrowserCache = true; // modeller bir kez indirilir, sonra Cache Storage'dan okunur
T.env.backends.onnx.wasm.numThreads = 1; // iOS'ta crossOriginIsolated yok
T.env.backends.onnx.wasm.proxy = false;

/** CPU için WebGPU'suz küçük ONNX Runtime çekirdeği (11 MB); GPU için JSEP sürümü (22 MB). */
function useBackend(device) {
  T.env.backends.onnx.wasm.wasmPaths = device === 'webgpu'
    ? VENDOR
    : { mjs: VENDOR + 'ort-wasm-simd-threaded.mjs', wasm: VENDOR + 'ort-wasm-simd-threaded.wasm' };
}

const engine = new Engine(T, { diarDevice: 'wasm', lowMemory: true, localBase: LOCAL_MODELS });
const post = (type, data = {}, transfer) => self.postMessage({ type, ...data }, transfer || []);

// İndirme ilerlemesini dosya bazında topla
function progressTracker(stage) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) files.set(p.file, { loaded: p.loaded, total: p.total });
    else if (p.status === 'done' && files.has(p.file)) { const f = files.get(p.file); f.loaded = f.total; }
    else return;
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    post('progress', { stage, value: t ? l / t : 0, detail: `${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB` });
  };
}

let stage = 'init';
const setStage = (s, extra = {}) => { stage = s; post('progress', { stage: s, value: 0, ...extra }); };

self.onmessage = async (ev) => {
  const { type, id } = ev.data;
  try {
    if (type === 'diarize') {
      const { audio, settings, profiles } = ev.data;
      useBackend('wasm');
      setStage('load-diar');
      await engine.loadDiarization(progressTracker('load-diar'));
      setStage('diarize');
      const d = await engine.diarize(audio, {
        numSpeakers: settings.numSpeakers || 0,
        threshold: settings.threshold ?? 0.45,
        onProgress: (v) => post('progress', { stage: 'diarize', value: v }),
      });
      const matched = matchProfiles(d.centroids, profiles || [], settings.profileThreshold ?? 0.5);
      // Sesi ana sayfaya geri ver (kopyalamadan), bir sonraki işçi kullanacak.
      post('diarized', {
        id,
        segments: d.segments,
        speakers: d.centroids.map((c, i) => ({ emb: Array.from(c), duration: d.durations[i], profileId: matched[i] })),
        audio,
      }, [audio.buffer]);
    } else if (type === 'transcribe') {
      const { audio, segments, settings } = ev.data;
      const device = settings.device === 'webgpu' ? 'webgpu' : 'wasm';
      useBackend(device);
      setStage('load-asr', { device });
      const size = asrModelFor(settings.asrModel || 'base', settings.language || 'turkish');
      await engine.loadASR(size, device, progressTracker('load-asr'));
      setStage('asr', { device });
      const turns = await engine.transcribeTurns(audio, segments, {
        language: settings.language || 'turkish',
        onProgress: (v) => post('progress', { stage: 'asr', value: v }),
        onTurn: (t) => post('turn', { id, turn: t }),
      });
      post('done', { id, turns, device, model: size });
    } else if (type === 'info') {
      let webgpu = false;
      try { webgpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { /* yok */ }
      post('info', { id, webgpu });
    }
  } catch (err) {
    console.error(err);
    post('error', { id, stage, message: String(err?.message || err) });
  }
};
