// Konuşma Defteri — cihaz üzerinde çalışan ses işleme motoru.
//
// Üç model kullanır (hepsi tarayıcıda, WASM/WebGPU ile; ses cihazdan çıkmaz):
//   1. pyannote-segmentation-3.0   → 10 sn'lik pencerelerde "kim ne zaman konuşuyor"
//   2. wespeaker-voxceleb-resnet34 → her konuşmacı parçası için 256 boyutlu ses izi
//   3. Whisper                     → her konuşma sırası ayrı ayrı metne
//
// Ses izleri kümelenerek pencereler arası konuşmacılar birleştirilir ve kayıtlı
// konuşmacı profilleriyle eşleştirilir. Ardından her konuşma sırası (aynı kişinin
// kesintisiz konuşması) Whisper'a ayrı verilir.
//
// Bu dosya hem Web Worker'da hem de Node test betiğinde çalışır; transformers.js
// modülü dışarıdan verilir.

export const SR = 16000;

export const MODELS = {
  segmentation: 'onnx-community/pyannote-segmentation-3.0',
  embedding: 'onnx-community/wespeaker-voxceleb-resnet34-LM',
  asr: {
    tiny: { id: 'onnx-community/whisper-tiny', mb: 41 },
    base: { id: 'onnx-community/whisper-base', mb: 77 },
    small: { id: 'onnx-community/whisper-small', mb: 249 },
  },
};

// pyannote powerset sınıfları: 0 = sessizlik, 1-3 tek konuşmacı, 4-6 iki kişi aynı anda.
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

const WIN_S = 10;
const WIN = WIN_S * SR;

const l2norm = (v) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
};

export const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
};

export class Engine {
  /**
   * @param {any} T transformers.js modülü
   * @param {{diarDevice?: string}} opt  tarayıcıda 'wasm', Node'da 'cpu'
   */
  constructor(T, { diarDevice = 'wasm' } = {}) {
    this.T = T;
    this.diarDevice = diarDevice;
    this.seg = null;
    this.emb = null;
    this.asr = null;
    this.asrKey = null;
  }

  // ---------- model yükleme ----------

  async loadDiarization(progress_callback) {
    const T = this.T;
    const opts = { dtype: 'fp32', device: this.diarDevice, progress_callback };
    if (!this.seg) {
      const [processor, model] = await Promise.all([
        T.AutoProcessor.from_pretrained(MODELS.segmentation, { progress_callback }),
        T.AutoModelForAudioFrameClassification.from_pretrained(MODELS.segmentation, opts),
      ]);
      this.seg = { processor, model };
    }
    if (!this.emb) {
      const [processor, model] = await Promise.all([
        T.AutoProcessor.from_pretrained(MODELS.embedding, { progress_callback }),
        T.AutoModel.from_pretrained(MODELS.embedding, opts),
      ]);
      this.emb = { processor, model };
    }
  }

  async loadASR(size, device, progress_callback) {
    const key = `${size}/${device}`;
    if (this.asr && this.asrKey === key) return;
    if (this.asr) { try { await this.asr.dispose(); } catch { /* yoksay */ } this.asr = null; }
    const m = MODELS.asr[size] || MODELS.asr.base;
    const dtype = device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' };
    this.asr = await this.T.pipeline('automatic-speech-recognition', m.id, { device, dtype, progress_callback });
    this.asrKey = key;
  }

  // ---------- konuşmacı ayırma ----------

  /** Bir ses parçasının L2-normalize ses izi (256 boyut). */
  async embed(samples) {
    // Model en az ~0.5 sn ister; kısa parçaları kendini tekrarlayarak uzat.
    let x = samples;
    const minLen = Math.floor(0.6 * SR);
    if (x.length < minLen) {
      const y = new Float32Array(minLen);
      for (let i = 0; i < minLen; i++) y[i] = x[i % x.length];
      x = y;
    }
    const inputs = await this.emb.processor(x);
    const out = await this.emb.model(inputs);
    const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
    return l2norm(t.data);
  }

  /**
   * @param {Float32Array} audio 16 kHz mono
   * @param {{numSpeakers?: number, threshold?: number, onProgress?: (f:number)=>void}} opt
   * @returns {Promise<{segments: {start:number,end:number,spk:number}[], centroids: Float32Array[], durations: number[]}>}
   */
  async diarize(audio, opt = {}) {
    const threshold = opt.threshold ?? 0.45;
    const numSpeakers = opt.numSpeakers || 0;
    const onProgress = opt.onProgress || (() => {});
    const nWin = Math.max(1, Math.ceil(audio.length / WIN));

    const windows = []; // {w, t0, dt, sets: number[][]}
    const items = [];   // pencere içindeki yerel konuşmacılar

    for (let w = 0; w < nWin; w++) {
      const off = w * WIN;
      const real = Math.min(WIN, audio.length - off);
      const chunk = new Float32Array(WIN);
      chunk.set(audio.subarray(off, off + real));
      const inputs = await this.seg.processor(chunk);
      const { logits } = await this.seg.model(inputs);
      const [, nF, nC] = logits.dims;
      const data = logits.data;
      const dt = WIN_S / nF;
      const lastF = Math.min(nF, Math.ceil(real / SR / dt));
      const sets = new Array(lastF);
      for (let f = 0; f < lastF; f++) {
        let best = 0, bv = -Infinity;
        for (let c = 0; c < nC; c++) { const v = data[f * nC + c]; if (v > bv) { bv = v; best = c; } }
        sets[f] = POWERSET[best] || [];
      }
      windows.push({ w, t0: off / SR, dt, sets });

      for (let k = 0; k < 3; k++) {
        const clean = runs(sets, (s) => s.length === 1 && s[0] === k);
        const active = runs(sets, (s) => s.includes(k));
        if (!active.length) continue;
        const cleanDur = clean.reduce((a, [s, e]) => a + (e - s), 0) * dt;
        const activeDur = active.reduce((a, [s, e]) => a + (e - s), 0) * dt;
        if (activeDur < 0.15) continue;
        items.push({ w, k, clean, active, dur: cleanDur, emb: null, spk: -1 });
      }
      onProgress((w + 1) / nWin * 0.5);
      await yieldToLoop();
    }

    // Ses izleri
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const win = windows[it.w];
      const src = it.dur >= 0.3 ? it.clean : it.active;
      const pieces = [];
      let total = 0;
      for (const [s, e] of src) {
        const a = Math.floor((win.t0 + s * win.dt) * SR);
        const b = Math.min(audio.length, Math.floor((win.t0 + e * win.dt) * SR));
        if (b > a) { pieces.push(audio.subarray(a, b)); total += b - a; }
      }
      if (total >= 0.25 * SR) {
        const buf = new Float32Array(total);
        let p = 0;
        for (const pc of pieces) { buf.set(pc, p); p += pc.length; }
        it.emb = await this.embed(buf);
      }
      onProgress(0.5 + (i + 1) / items.length * 0.5);
    }

    // Kümeleme: güçlü (≥1 sn) ses izleriyle başla, zayıfları sonra en yakın kümeye ata.
    let strong = items.filter((it) => it.emb && it.dur >= 1.0);
    if (!strong.length) strong = items.filter((it) => it.emb);
    const clusters = agglomerate(strong, threshold, numSpeakers);
    strong.forEach((it, i) => { it.spk = clusters.labels[i]; });
    const centroids = clusters.centroids;

    for (const it of items) {
      if (it.spk >= 0 || !it.emb || !centroids.length) continue;
      let best = 0, bv = -Infinity;
      centroids.forEach((c, j) => { const v = cosine(it.emb, c); if (v > bv) { bv = v; best = j; } });
      it.spk = best;
    }

    // Kare bazlı genel konuşmacı zaman çizelgesi
    const raw = [];
    for (const win of windows) {
      const map = new Map();
      for (const it of items) if (it.w === win.w) map.set(it.k, it.spk);
      let cur = -1, start = 0;
      const flush = (fEnd) => {
        if (cur >= 0) raw.push({ start: win.t0 + start * win.dt, end: win.t0 + fEnd * win.dt, spk: cur });
      };
      for (let f = 0; f < win.sets.length; f++) {
        const s = win.sets[f];
        let g = -1;
        if (s.length) {
          // Örtüşmede: önceki konuşmacı hâlâ konuşuyorsa onda kal.
          const cands = s.map((k) => map.get(k) ?? -1).filter((x) => x >= 0);
          g = cands.includes(cur) ? cur : (cands[0] ?? -1);
        }
        if (g !== cur) { flush(f); cur = g; start = f; }
      }
      flush(win.sets.length);
    }
    let segments = mergeSegments(raw, 0.5).filter((s) => s.end - s.start >= 0.2);
    segments = mergeSegments(segments, 0.5);

    // Toplam süresi çok kısa kümeleri en yakın kümeye kat (konuşmacı sayısı verilmediyse).
    const durations = new Array(centroids.length).fill(0);
    for (const s of segments) durations[s.spk] += s.end - s.start;
    if (!numSpeakers && centroids.length > 1) {
      const remap = centroids.map((_, i) => i);
      const tiny = durations.map((d, i) => [d, i]).filter(([d]) => d < 1.5).map(([, i]) => i);
      for (const i of tiny) {
        let best = -1, bv = -Infinity;
        centroids.forEach((c, j) => {
          if (j === i || tiny.includes(j)) return;
          const v = cosine(centroids[i], c); if (v > bv) { bv = v; best = j; }
        });
        if (best >= 0) remap[i] = best;
      }
      for (const s of segments) s.spk = remap[s.spk];
      segments = mergeSegments(segments, 0.5);
    }

    // Konuşmacıları ilk görünme sırasına göre 0,1,2… olarak yeniden numarala.
    const order = [];
    for (const s of segments) if (!order.includes(s.spk)) order.push(s.spk);
    const newIdx = new Map(order.map((old, i) => [old, i]));
    for (const s of segments) s.spk = newIdx.get(s.spk);
    const outCentroids = order.map((old) => centroids[old]);
    const outDur = order.map(() => 0);
    for (const s of segments) outDur[s.spk] += s.end - s.start;

    return { segments, centroids: outCentroids, durations: outDur };
  }

  // ---------- konuşma → metin ----------

  /**
   * Her konuşma sırasını (aynı kişinin kesintisiz konuşması) ayrı ayrı yazıya döker.
   * Whisper'a tek kişilik, tutarlı parçalar vermek Türkçe'de tekrar döngülerini ve
   * atlanan bölümleri belirgin biçimde azaltır.
   * @param {Float32Array} audio
   * @param {{start:number,end:number,spk:number}[]} segments  diarize() çıktısı
   * @returns {Promise<{start:number,end:number,spk:number,text:string}[]>}
   */
  async transcribeTurns(audio, segments, { language = 'turkish', onProgress = () => {}, onTurn = () => {} } = {}) {
    const turns = planTurns(audio, segments);
    const totalDur = turns.reduce((s, t) => s + (t.end - t.start), 0) || 1;
    let done = 0;
    const out = [];
    const run = async (x) => {
      const dur = x.length / SR;
      const res = await this.asr(x, {
        language: language === 'auto' ? null : language,
        task: 'transcribe',
        // Whisper Türkçe'de saniyede ~12-15 token üretir; döngüye girerse burada kesilir.
        max_new_tokens: Math.min(440, Math.ceil(dur * 18) + 16),
        no_repeat_ngram_size: 5,
      });
      const t = cleanText(res.text || '');
      return repetitive(t) ? '' : t;
    };
    for (const t of turns) {
      const x = turnAudio(audio, t.parts);
      const dur = x.length / SR;
      let text = '';
      if (dur >= 0.35) {
        text = await run(x);
        // Whisper bazen ilk kelimeden sonra erken durur. Çıktı süreye göre çok kısaysa
        // parçaları tek tek dene ve birleşimi daha uzunsa onu al.
        if (dur > 2.5 && text.length < dur * 9 && t.parts.length > 1 || dur > 2.5 && text.length < dur * 4) {
          const pieces = [];
          const parts = t.parts.length > 1 ? t.parts : splitHalf(t.parts[0]);
          for (const p of parts) {
            if (p[1] - p[0] < 0.35) continue;
            const s = await run(turnAudio(audio, [p]));
            if (s) pieces.push(s);
          }
          const alt = pieces.join(' ');
          if (alt.length > text.length * 1.3) text = alt;
        }
      }
      done += t.end - t.start;
      if (text) {
        const turn = { start: t.start, end: t.end, spk: t.spk, text };
        out.push(turn);
        onTurn(turn);
      }
      onProgress(done / totalDur);
    }
    return mergeTurns(out);
  }
}

const splitHalf = ([s, e]) => { const m = (s + e) / 2; return [[s, m + 0.3], [m - 0.3, e]]; };

/** Bir konuşma sırasının parçalarını birleştir; aradaki uzun sessizlikleri 0.3 sn'ye kısalt. */
function turnAudio(audio, parts) {
  const PAD = 0.12, GAP = Math.floor(0.3 * SR);
  const chunks = [];
  let prevEnd = -1;
  for (const [s, e] of parts) {
    let a = Math.max(0, Math.floor((s - PAD) * SR));
    const b = Math.min(audio.length, Math.ceil((e + PAD) * SR));
    if (prevEnd >= 0) {
      if (a - prevEnd > GAP * 2) chunks.push(new Float32Array(GAP));
      else a = prevEnd; // kısa boşluğu olduğu gibi bırak
    }
    if (b > a) chunks.push(audio.subarray(a, b));
    prevEnd = b;
  }
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const x = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { x.set(c, o); o += c.length; }
  return x;
}

// ---------- yardımcılar ----------

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

function runs(arr, pred) {
  const out = [];
  let s = -1;
  for (let i = 0; i < arr.length; i++) {
    if (pred(arr[i])) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i]); s = -1; }
  }
  if (s >= 0) out.push([s, arr.length]);
  return out;
}

function mergeSegments(segs, gap) {
  const out = [];
  for (const s of segs) {
    if (s.spk < 0) continue;
    const last = out[out.length - 1];
    if (last && last.spk === s.spk && s.start - last.end <= gap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Ağırlıklı merkez bağlantılı birleştirici kümeleme (kosinüs benzerliği). */
export function agglomerate(items, threshold, numSpeakers) {
  const n = items.length;
  if (!n) return { labels: [], centroids: [] };
  const dim = items[0].emb.length;
  const cl = items.map((it, i) => {
    const w = Math.max(0.3, Math.min(it.dur, 10));
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = it.emb[d] * w;
    return { v, members: [i] };
  });
  while (cl.length > 1) {
    let bi = -1, bj = -1, bv = -Infinity;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      const v = cosine(cl[i].v, cl[j].v);
      if (v > bv) { bv = v; bi = i; bj = j; }
    }
    const stop = numSpeakers ? cl.length <= numSpeakers : bv < threshold;
    if (stop) break;
    const a = cl[bi], b = cl[bj];
    for (let d = 0; d < dim; d++) a.v[d] += b.v[d];
    a.members.push(...b.members);
    cl.splice(bj, 1);
  }
  const labels = new Array(n);
  cl.forEach((c, ci) => c.members.forEach((m) => { labels[m] = ci; }));
  return { labels, centroids: cl.map((c) => l2norm(c.v)) };
}

/**
 * Konuşmacı bölümlerini Whisper'a uygun (≤28 sn konuşma) sıralara çevir.
 * Her sıra, aynı konuşmacının ardışık bölümlerinden (`parts`) oluşur.
 */
export function planTurns(audio, segments, maxLen = 28) {
  // Komşusundan kopuk, 0.3 sn'den kısa kırıntılar çoğunlukla sınır hatasıdır.
  const segs = segments.filter((s, i) => {
    if (s.end - s.start >= 0.3) return true;
    const near = (o) => o && o.spk === s.spk && Math.min(Math.abs(o.start - s.end), Math.abs(s.start - o.end)) < 0.2;
    return near(segments[i - 1]) || near(segments[i + 1]);
  });
  const speech = (t) => t.parts.reduce((x, [s, e]) => x + (e - s), 0);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.spk === s.spk && s.start - last.end < 3 && speech(last) + (s.end - s.start) <= maxLen) {
      last.end = s.end;
      last.parts.push([s.start, s.end]);
    } else merged.push({ start: s.start, end: s.end, spk: s.spk, parts: [[s.start, s.end]] });
  }
  const out = [];
  for (const t of merged) {
    for (const [ps, pe] of t.parts) {
      // tek bölüm çok uzunsa en sessiz noktalardan böl
      if (pe - ps <= maxLen) continue;
      t.parts = t.parts.flatMap(([a, b]) => {
        if (b - a <= maxLen) return [[a, b]];
        const res = [];
        let s = a;
        while (b - s > maxLen) { const c = quietestPoint(audio, s + 18, s + maxLen); res.push([s, c]); s = c; }
        res.push([s, b]);
        return res;
      });
      break;
    }
    // parçaları ≤maxLen konuşma içeren sıralara grupla
    let cur = null;
    for (const p of t.parts) {
      if (!cur || speech(cur) + (p[1] - p[0]) > maxLen) {
        cur = { start: p[0], end: p[1], spk: t.spk, parts: [] };
        out.push(cur);
      }
      cur.parts.push(p);
      cur.end = p[1];
    }
  }
  return out;
}

function quietestPoint(audio, from, to) {
  const hop = Math.floor(0.05 * SR);
  let best = to, bv = Infinity;
  for (let t = from; t < to; t += 0.05) {
    const i = Math.floor(t * SR);
    let e = 0;
    for (let k = i; k < Math.min(audio.length, i + hop); k++) e += audio[k] * audio[k];
    if (e < bv) { bv = e; best = t; }
  }
  return best;
}

function mergeTurns(turns) {
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.spk === t.spk && t.start - last.end < 1.5) {
      last.text = `${last.text} ${t.text}`;
      last.end = t.end;
    } else out.push({ ...t });
  }
  return out;
}

/** Metin bir tekrar döngüsü mü? (aynı 2'li kelime öbekleri baskınsa) */
export function repetitive(text) {
  const w = text.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  // aynı 1-3 kelimelik öbeğin art arda 3+ kez tekrarı
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + 3 * n <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ');
      if (w.slice(i + n, i + 2 * n).join(' ') === g && w.slice(i + 2 * n, i + 3 * n).join(' ') === g) return true;
    }
  }
  if (w.length < 12) return false;
  const grams = [];
  for (let i = 0; i + 1 < w.length; i++) grams.push(w[i] + ' ' + w[i + 1]);
  return new Set(grams).size / grams.length < 0.45;
}

/** Whisper'ın uydurduğu tekrarları ve bilinen kalıp cümleleri temizle. */
export function cleanText(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  // aynı kelimenin art arda 3'ten fazla tekrarı → 1'e indir
  t = t.replace(/(\S+?)([\s,.;!?]+\1(?=[\s,.;!?]|$)){2,}/giu, '$1');
  const junk = [
    /altyaz[ıi]\s*m\.?k\.?/i,
    /abone olmay[ıi] unutmay[ıi]n/i,
    /izledi[ğg]iniz i[çc]in te[şs]ekk[üu]r/i,
    /^\[?\(?m[üu]zik\)?\]?$/i,
    /^[\s\p{P}]*$/u,
  ];
  if (junk.some((r) => r.test(t))) return '';
  return t;
}

/**
 * Kümeleri kayıtlı konuşmacı profilleriyle eşleştir (her profil en fazla bir kümeye).
 * @param {Float32Array[]} centroids
 * @param {{id:string,emb:number[]}[]} profiles
 * @returns {(string|null)[]} her küme için eşleşen profil id'si
 */
export function matchProfiles(centroids, profiles, minSim = 0.5) {
  const pairs = [];
  centroids.forEach((c, i) => profiles.forEach((p) => {
    pairs.push({ i, id: p.id, v: cosine(c, Float32Array.from(p.emb)) });
  }));
  pairs.sort((a, b) => b.v - a.v);
  const res = centroids.map(() => null);
  const used = new Set();
  for (const p of pairs) {
    if (p.v < minSim) break;
    if (res[p.i] !== null || used.has(p.id)) continue;
    res[p.i] = p.id;
    used.add(p.id);
  }
  return res;
}
