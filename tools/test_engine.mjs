// Motoru Node.js ile dener (geliştirme için). Kullanım:
//   npm i @huggingface/transformers@3.8.1   (ve ffmpeg kurulu olmalı)
//   node konusma/tools/test_engine.mjs ses.m4a [tiny|base|small] [konuşmacı_sayısı=0] [eşik=0.45]
import * as T from '@huggingface/transformers';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { Engine, cosine } from '../js/engine.js';
T.env.cacheDir = process.env.HF_CACHE || '.hfcache';
const [,, wav, size='base', nspk='0', thr='0.45'] = process.argv;
const raw = execFileSync('ffmpeg', ['-loglevel','error','-i',wav,'-ac','1','-ar','16000','-f','f32le','-'], {maxBuffer: 1<<30});
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.length/4);
const e = new Engine(T, {diarDevice:'cpu'});
let t=Date.now(); await e.loadDiarization(); console.log('diar load', Date.now()-t);
t=Date.now(); const d = await e.diarize(audio, {numSpeakers: +nspk, threshold: +thr}); console.log('diarize ms', Date.now()-t);
console.log(d.segments.map(s=>`${s.start.toFixed(1)}-${s.end.toFixed(1)}:${s.spk}`).join(' '));
console.log('durations', d.durations.map(x=>x.toFixed(1)), 'centroid sims', d.centroids.map((a,i)=>d.centroids.map(b=>cosine(a,b).toFixed(2)).join(',')).join(' | '));
t=Date.now(); await e.loadASR(size, 'cpu'); console.log('asr load', Date.now()-t);
t=Date.now(); const turns = await e.transcribeTurns(audio, d.segments, {language:'turkish'}); console.log('asr ms', Date.now()-t);
for (const tr of turns) console.log(`[${tr.start.toFixed(1)}-${tr.end.toFixed(1)}] K${tr.spk+1}: ${tr.text}`);
