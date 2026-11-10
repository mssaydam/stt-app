// Ses işleme Web Worker'ı. Arayüzü kilitlememek için tüm model işleri burada çalışır.
// Bu worker yalnızca model dosyalarını (Hugging Face) indirir; ses hiçbir yere gönderilmez.

import * as T from '../vendor/transformers.min.js';
import { Engine, MODELS, matchProfiles } from './engine.js';

T.env.allowLocalModels = false;
T.env.useBrowserCache = true; // modeller bir kez indirilir, sonra Cache Storage'dan okunur
T.env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
T.env.backends.onnx.wasm.numThreads = 1; // iOS'ta crossOriginIsolated yok
T.env.backends.onnx.wasm.proxy = false;

const engine = new Engine(T, { diarDevice: 'wasm' });
const post = (type, data = {}) => self.postMessage({ type, ...data });

let gpuOk = null;
async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try {
    gpuOk = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter());
  } catch { gpuOk = false; }
  return gpuOk;
}

// İndirme ilerlemesini dosya bazında topla
function progressTracker(stage) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
    } else if (p.status === 'done' && files.has(p.file)) {
      const f = files.get(p.file); f.loaded = f.total;
    } else return;
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    post('progress', { stage, value: t ? l / t : 0, detail: `${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB` });
  };
}

async function loadAll(settings) {
  post('progress', { stage: 'load-diar', value: 0 });
  await engine.loadDiarization(progressTracker('load-diar'));
  let device = settings.device || 'auto';
  if (device === 'auto') device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  post('progress', { stage: 'load-asr', value: 0 });
  try {
    await engine.loadASR(settings.asrModel || 'base', device, progressTracker('load-asr'));
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // WebGPU başarısızsa WASM ile tekrar dene
    device = 'wasm';
    await engine.loadASR(settings.asrModel || 'base', device, progressTracker('load-asr'));
  }
  return device;
}

self.onmessage = async (ev) => {
  const { type, id } = ev.data;
  try {
    if (type === 'warmup') {
      const device = await loadAll(ev.data.settings);
      post('ready', { id, device });
    } else if (type === 'process') {
      const { audio, settings, profiles } = ev.data;
      const device = await loadAll(settings);
      post('progress', { stage: 'diarize', value: 0, device });
      const d = await engine.diarize(audio, {
        numSpeakers: settings.numSpeakers || 0,
        threshold: settings.threshold ?? 0.45,
        onProgress: (v) => post('progress', { stage: 'diarize', value: v }),
      });
      const matched = matchProfiles(d.centroids, profiles || [], settings.profileThreshold ?? 0.5);
      post('diarized', {
        id,
        segments: d.segments,
        speakers: d.centroids.map((c, i) => ({ emb: Array.from(c), duration: d.durations[i], profileId: matched[i] })),
      });
      post('progress', { stage: 'asr', value: 0 });
      const turns = await engine.transcribeTurns(audio, d.segments, {
        language: settings.language || 'turkish',
        onProgress: (v) => post('progress', { stage: 'asr', value: v }),
        onTurn: (t) => post('turn', { id, turn: t }),
      });
      post('done', { id, turns, device });
    } else if (type === 'info') {
      post('info', { id, webgpu: await hasWebGPU(), models: MODELS });
    }
  } catch (err) {
    console.error(err);
    post('error', { id, message: String(err?.message || err) });
  }
};
