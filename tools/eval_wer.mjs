// Türkçe WER karşılaştırması: uygulamadaki çözme ayarlarıyla aynı.
import * as T from '@huggingface/transformers';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { cleanText, repetitive } from '../js/engine.js';
const S = process.env.S, OLD = process.env.OLD;
T.env.cacheDir = OLD + '/hfcache';
T.env.localModelPath = S + '/conv/out/';
T.env.allowLocalModels = true;

// --- test seti (sabit tohumlu örnekleme) ---
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr, n) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const fleursRows = fs.readFileSync(OLD + '/fleurs/dev.tsv', 'utf8').trim().split('\n').map((l) => l.split('\t')).map((c) => ({ file: OLD + '/fleurs/dev/' + c[1], text: c[2], set: 'fleurs' }));
const parlRows = JSON.parse(fs.readFileSync(S + '/eval/parl.json', 'utf8')).map((r) => ({ file: S + '/eval/' + r.file, text: r.text, set: 'parl' }));
const N_F = +(process.env.NF || 100), N_P = +(process.env.NP || 120);
const items = [...pick(fleursRows, N_F), ...pick(parlRows, N_P)];
const load = (f) => { const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice(); };
const audios = items.map((it) => load(it.file));

// --- WER ---
const norm = (s) => s.normalize('NFC').toLocaleLowerCase('tr-TR').replace(/[’'`´]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function edits(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length]; }

const models = (process.env.MODELS || 'onnx-community/whisper-base,tr-arun100,tr-thealper2,tr-ysdede,onnx-community/whisper-small').split(',');
const out = {};
for (const m of models) {
  const asr = await T.pipeline('automatic-speech-recognition', m, { device: 'cpu', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  const t0 = Date.now(); const agg = { fleurs: [0, 0], parl: [0, 0] }; const hyps = [];
  for (let i = 0; i < items.length; i++) {
    const x = audios[i], dur = x.length / 16000;
    const r = await asr(x, { language: 'turkish', task: 'transcribe', max_new_tokens: Math.min(440, Math.ceil(dur * 18) + 16), no_repeat_ngram_size: 5 });
    let h = cleanText(r.text || ''); if (repetitive(h)) h = '';
    const ref = norm(items[i].text).split(' ').filter(Boolean), hyp = norm(h).split(' ').filter(Boolean);
    agg[items[i].set][0] += edits(ref, hyp); agg[items[i].set][1] += ref.length;
    hyps.push(h);
  }
  const wer = (k) => (100 * agg[k][0] / agg[k][1]).toFixed(1);
  const all = (100 * (agg.fleurs[0] + agg.parl[0]) / (agg.fleurs[1] + agg.parl[1])).toFixed(1);
  console.log(`${m.padEnd(32)} WER  FLEURS ${wer('fleurs')}%  Parlamento ${wer('parl')}%  Toplam ${all}%   (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);
  out[m] = hyps;
  await asr.dispose();
}
fs.writeFileSync(S + '/eval/hyps.json', JSON.stringify({ items: items.map((x) => ({ set: x.set, text: x.text })), out }, null, 1));
