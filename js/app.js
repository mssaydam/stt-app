// Konuşma Defteri — arayüz ve uygulama akışı.
import { db, uid } from './db.js';
import { ask, correctTranscript, explainError, hasKey, transcriptText, fmtTime, SUMMARY_PROMPT, CLAUDE_MODELS } from './claude.js';
import { modelFiles, asrModelFor } from './engine.js';

// ====================================================================
// Yardımcılar
// ====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const fmtDate = (ts) => new Date(ts).toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const words = (s) => (s.match(/\S+/g) || []).length;

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// ====================================================================
// Ayarlar (yalnızca bu cihazda, localStorage)
// ====================================================================
export const APP_VERSION = '1.2.0';
const DEFAULTS = {
  v: 2,
  asrModel: 'base',          // tiny | base | small
  device: 'wasm',            // wasm (CPU) | webgpu (deneysel)
  language: 'turkish',
  threshold: 0.45,           // konuşmacı ayırma: yüksek → daha çok kişi
  profileThreshold: 0.5,     // kayıtlı kişiyi tanıma eşiği
  keepAudio: true,
  apiKey: '',
  claudeModel: 'claude-opus-5-5',
  effort: 'medium',
};
let stored = {};
try { stored = JSON.parse(localStorage.getItem('kd-settings') || '{}') || {}; } catch { /* boş */ }
let settings = { ...DEFAULTS, ...stored };
const saveSettings = () => { try { localStorage.setItem('kd-settings', JSON.stringify(settings)); } catch { /* boş */ } };
// 1.0 → 1.1: "otomatik" işlemci iPhone'da deneysel WebGPU'yu seçip çökmeye yol açabiliyordu.
if (Object.keys(stored).length && (stored.v || 1) < 2) {
  settings.device = 'wasm';
  settings.v = 2;
  saveSettings();
}

// ====================================================================
// Tanılama: hata günlüğü ve "kapanma izi"
// iOS bir sayfayı bellek yetmediği için öldürdüğünde hiçbir hata yakalanamaz;
// bu yüzden işlemin hangi aşamada olduğunu her adımda kalıcı olarak yazıyoruz.
// ====================================================================
const LOG_KEY = 'kd-log', CRUMB_KEY = 'kd-crumb';
function logEvent(msg) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    log.push(`${new Date().toISOString().slice(5, 19).replace('T', ' ')} ${String(msg).slice(0, 400)}`);
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-40)));
  } catch { /* boş */ }
}
window.addEventListener('error', (e) => logEvent(`hata: ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => logEvent(`söz hatası: ${e.reason?.message || e.reason}`));
let lastCrumbWrite = 0;
function writeCrumb(c, force = false) {
  const now = Date.now();
  if (!force && now - lastCrumbWrite < 1500) return;
  lastCrumbWrite = now;
  try { localStorage.setItem(CRUMB_KEY, JSON.stringify({ ...c, t: now })); } catch { /* boş */ }
}
const readCrumb = () => { try { return JSON.parse(localStorage.getItem(CRUMB_KEY) || 'null'); } catch { return null; } };
const clearCrumb = () => { try { localStorage.removeItem(CRUMB_KEY); } catch { /* boş */ } };

// ====================================================================
// Durum
// ====================================================================
const state = {
  recs: [],           // kayıtlar (yeni → eski)
  profiles: [],
  job: null,          // { id, stage, value, detail }
  queue: [],
  selecting: false,
  selected: new Set(),
  search: '',
  audioUrl: null,
  busyClaude: null,   // AbortController
  device: null,
};

const findRec = (id) => state.recs.find((r) => r.id === id);
async function saveRec(rec) { rec.updatedAt = Date.now(); await db.put('recordings', rec); }
async function loadAll() {
  state.recs = (await db.all('recordings')).sort((a, b) => b.createdAt - a.createdAt);
  state.profiles = (await db.all('profiles')).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

// ====================================================================
// Konuşmacı yardımcıları
// ====================================================================
const COLORS = 8;
const spkColor = (i) => `var(--s${i % COLORS})`;
function speakerName(rec, i) {
  const s = rec.speakers?.[i];
  if (!s) return `Konuşmacı ${i + 1}`;
  if (s.profileId) {
    const p = state.profiles.find((x) => x.id === s.profileId);
    if (p) return p.name;
  }
  return s.name || `Konuşmacı ${i + 1}`;
}
function l2(v) { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }

// ====================================================================
// Küçük arayüz parçaları: bildirim, alt sayfa, onay, metin girişi
// ====================================================================
let toastTimer;
function toast(msg, ms = 2600) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function sheet(html, onMount) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
    const close = (v) => { bg.remove(); resolve(v); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
    document.body.append(bg);
    onMount?.(bg.firstElementChild, close);
  });
}

/** Seçenek menüsü. items: [{label, value, danger?}] */
function menu(title, items) {
  return sheet(`${title ? `<h3>${esc(title)}</h3>` : ''}<div class="menu">${items.map((it, i) =>
    `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('')}
    <button data-i="-1" class="muted">Vazgeç</button></div>`, (el, close) => {
    $$('button[data-i]', el).forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.i; close(i < 0 ? null : items[i].value);
    }));
  });
}

function confirmBox(title, text, okLabel = 'Tamam', danger = false) {
  return sheet(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
    <div class="btn-row"><button class="btn" data-a="no">Vazgeç</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`, (el, close) => {
    $('[data-a=no]', el).onclick = () => close(false);
    $('[data-a=ok]', el).onclick = () => close(true);
  });
}

function promptBox(title, value = '', { multiline = false, placeholder = '' } = {}) {
  return sheet(`<h3>${esc(title)}</h3>
    <div class="field">${multiline
      ? `<textarea rows="6" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" enterkeyhint="done">`}</div>
    <div class="btn-row"><button class="btn" data-a="no">Vazgeç</button><button class="btn primary" data-a="ok">Kaydet</button></div>`,
  (el, close) => {
    const inp = $('input,textarea', el);
    setTimeout(() => inp.focus(), 50);
    $('[data-a=no]', el).onclick = () => close(null);
    $('[data-a=ok]', el).onclick = () => close(inp.value.trim());
    if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value.trim()); });
  });
}

// Basit ve güvenli Markdown → HTML (önce kaçış, sonra biçim)
function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { endList(); out.push(`<h3>${inline(m[2])}</h3>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { endList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { endList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { endList(); }
    else { endList(); out.push(`<p>${inline(line)}</p>`); }
  }
  endList();
  return out.join('');
}

// ====================================================================
// Ekranı açık tutma (kayıt ve işleme sırasında)
// ====================================================================
let wakeLock = null, wakeWanted = 0;
async function wake(on) {
  wakeWanted = Math.max(0, wakeWanted + (on ? 1 : -1));
  try {
    if (wakeWanted && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!wakeWanted && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* desteklenmiyor */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeWanted) { wakeWanted--; wake(true); } });

// ====================================================================
// Ses çözme: her türlü dosya → 16 kHz mono Float32Array
// ====================================================================
async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 16000 }); } catch { ctx = new AC(); }
  let decoded;
  try {
    decoded = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } finally { ctx.close?.(); }
  if (decoded.sampleRate === 16000 && decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  const len = Math.ceil(decoded.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

// ====================================================================
// İşleme kuyruğu (Web Worker)
// ====================================================================
/**
 * Tek bir işi yeni bir işçide çalıştırır ve iş bitince işçiyi KAPATIR.
 * (WebAssembly belleği ancak işçi kapatılınca geri verilir.)
 * @param {object} msg  işçiye gönderilecek mesaj
 * @param {Transferable[]} transfer
 * @param {(m:object)=>void} onEvent  ara mesajlar (progress, turn …)
 * @param {string} doneType  işin bittiğini bildiren mesaj tipi
 */
function runInWorker(msg, transfer, onEvent, doneType) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const finish = (fn, v) => { try { w.terminate(); } catch { /* boş */ } fn(v); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === doneType) finish(resolve, m);
      else if (m.type === 'error') { logEvent(`işçi hatası [${m.stage}]: ${m.message}`); finish(reject, Object.assign(new Error(m.message), { stage: m.stage })); }
      else onEvent?.(m);
    };
    w.onerror = (e) => { logEvent(`işçi yüklenemedi: ${e.message || 'bilinmiyor'}`); finish(reject, new Error('İşlemci başlatılamadı: ' + (e.message || 'bilinmiyor'))); };
    w.postMessage(msg, transfer || []);
  });
}

const STAGES = {
  'decode': 'Ses çözülüyor',
  'load-diar': 'Konuşmacı modeli yükleniyor',
  'load-asr': 'Konuşma tanıma modeli yükleniyor',
  'diarize': 'Konuşmacılar ayrılıyor',
  'asr': 'Metne dönüştürülüyor',
};

function workerSettings(over = {}) {
  return {
    asrModel: settings.asrModel, device: settings.device, language: settings.language,
    threshold: settings.threshold, profileThreshold: settings.profileThreshold, ...over,
  };
}

function enqueue(id, over = {}) {
  if (state.job?.id === id || state.queue.some((q) => q.id === id)) return;
  state.queue.push({ id, over });
  const rec = findRec(id);
  if (rec) { rec.status = 'queued'; saveRec(rec); }
  refresh();
  pump();
}

async function pump() {
  if (state.job || !state.queue.length) return;
  const { id, over } = state.queue.shift();
  const rec = findRec(id);
  if (!rec) return pump();
  const ws = workerSettings(over);
  state.job = { id, stage: 'decode', value: 0, detail: '' };
  state.device = ws.device === 'webgpu' ? 'GPU' : 'CPU';
  rec.status = 'processing';
  rec.error = null;
  await saveRec(rec);
  refresh();
  await wake(true);
  const crumb = { id, stage: 'decode', model: ws.asrModel, device: ws.device, dur: rec.duration };
  writeCrumb(crumb, true);
  const onProgress = (m) => {
    if (m.type !== 'progress') return;
    const changed = m.stage !== state.job.stage;
    Object.assign(state.job, { stage: m.stage, value: m.value, detail: m.detail || '' });
    crumb.stage = m.stage; crumb.value = Math.round(m.value * 100);
    writeCrumb(crumb, changed);
    updateProgressUI();
  };
  try {
    const a = await db.get('audio', id);
    if (!a) throw new Error('Bu kaydın sesi silinmiş; yeniden işlenemez.');
    let audio = await decodeTo16k(a.blob);
    rec.duration = audio.length / 16000;
    crumb.dur = Math.round(rec.duration);

    // 1. aşama: konuşmacı ayırma (ayrı işçi, sonra kapatılır)
    const d = await runInWorker({ type: 'diarize', id, audio, settings: ws, profiles: state.profiles }, [audio.buffer], onProgress, 'diarized');
    audio = d.audio; // ses geri geldi
    const old = rec.speakers || [];
    rec.speakers = d.speakers.map((s, i) => ({
      ...s,
      // yeniden işlemede, profil eşleşmesi yoksa eski adı aynı sıradaki konuşmacıya koru
      name: s.profileId ? null : (over.keepNames ? old[i]?.name || null : null),
    }));
    rec.turns = [];
    await saveRec(rec);
    if (isViewing(id)) renderDetailParts(rec);

    // 2. aşama: metne çevirme (yeni işçi, sonra kapatılır)
    const result = await runInWorker({ type: 'transcribe', id, audio, segments: d.segments, settings: ws }, [audio.buffer], (m) => {
      if (m.type === 'turn') {
        rec.turns.push(m.turn);
        if (isViewing(id)) appendTurnLive(rec, m.turn);
      } else onProgress(m);
    }, 'done');
    rec.turns = result.turns;
    rec.status = 'done';
    rec.crashes = 0;
    rec.processedWith = { asrModel: result.model || ws.asrModel, device: result.device, at: Date.now(), version: APP_VERSION };
    await saveRec(rec);
    if (!settings.keepAudio) await db.del('audio', id);
    // Birleştirilmiş son metni ve Claude kartını (artık kullanılabilir) hemen göster
    if (isViewing(id)) { renderDetailParts(rec); renderClaude(rec); }
    toast(`“${rec.title}” hazır`);
  } catch (err) {
    console.error(err);
    logEvent(`işleme hatası [${state.job?.stage}]: ${err.message || err}`);
    rec.status = 'error';
    rec.error = `${STAGES[state.job?.stage] || state.job?.stage || ''} aşamasında hata: ${err.message || err}`;
    await saveRec(rec);
    toast('İşleme hatası: ' + (err.message || err), 5000);
  } finally {
    clearCrumb();
    state.job = null;
    await wake(false);
    refresh();
    pump();
  }
}

function jobLabel() {
  const j = state.job;
  if (!j) return '';
  return `${STAGES[j.stage] || j.stage}${j.detail ? ` · ${j.detail}` : ''} · %${Math.round(j.value * 100)}`;
}

// ====================================================================
// Kayıt
// ====================================================================
const rec = { mr: null, stream: null, chunks: [], startedAt: 0, elapsed: 0, lastTick: 0, paused: false, ac: null, raf: 0, timer: 0, draftId: null, numSpeakers: 0 };

function pickMime() {
  const c = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('Bu tarayıcı ses kaydını desteklemiyor.', 4000);
    return;
  }
  navigator.storage?.persist?.();
  // AudioContext'i dokunma anında oluştur: iOS, beklemeden sonra oluşturulanı askıya alır.
  let meterCtx = null;
  try { const AC = window.AudioContext || window.webkitAudioContext; meterCtx = new AC(); meterCtx.resume?.(); } catch { /* boş */ }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    meterCtx?.close?.();
    toast('Mikrofon izni verilmedi. iPhone: Ayarlar → Safari → Mikrofon.', 5000);
    return;
  }
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  Object.assign(rec, { mr, stream, chunks: [], startedAt: Date.now(), elapsed: 0, lastTick: performance.now(), paused: false, draftId: uid(), numSpeakers: 0 });
  mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  mr.start(1000);
  await wake(true);
  showRecorder();

  // Seviye göstergesi
  try {
    rec.ac = meterCtx;
    await rec.ac.resume?.();
    const srcNode = rec.ac.createMediaStreamSource(stream);
    const an = rec.ac.createAnalyser();
    an.fftSize = 512;
    srcNode.connect(an);
    const data = new Uint8Array(an.fftSize);
    const bars = $$('.meter i');
    const hist = new Array(bars.length).fill(0);
    const loop = () => {
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      hist.push(rec.paused ? 0 : peak / 128); hist.shift();
      bars.forEach((b, i) => { b.style.height = `${4 + Math.min(1, hist[i] * 2.2) * 76}px`; });
      rec.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* gösterge isteğe bağlı */ }

  // Saat ve çökmeye karşı ara kayıt
  let lastDraft = 0;
  rec.timer = setInterval(() => {
    const now = performance.now();
    if (!rec.paused) rec.elapsed += (now - rec.lastTick) / 1000;
    rec.lastTick = now;
    const c = $('.recorder .clock');
    if (c) c.textContent = fmtTime(rec.elapsed);
    if (now - lastDraft > 10000) {
      lastDraft = now;
      db.put('drafts', { id: rec.draftId, chunks: rec.chunks.slice(), mime: mr.mimeType, startedAt: rec.startedAt, elapsed: rec.elapsed }).catch(() => {});
    }
  }, 250);
}

function showRecorder() {
  const el = document.createElement('div');
  el.className = 'recorder';
  el.innerHTML = `
    <div class="state"><span style="color:var(--rec)">●</span> Kaydediliyor</div>
    <div class="clock">00:00</div>
    <div class="meter">${'<i></i>'.repeat(40)}</div>
    <label class="row small muted">Konuşmacı sayısı
      <select id="rec-nspk" class="chip">
        <option value="0">Otomatik</option>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join('')}
      </select>
    </label>
    <div class="ctrls">
      <button class="round sec" id="rec-cancel" aria-label="İptal">${ICON.x}</button>
      <button class="round stop" id="rec-stop" aria-label="Bitir"><i></i></button>
      <button class="round sec" id="rec-pause" aria-label="Duraklat">${ICON.pause}</button>
    </div>
    <p class="privacy">Ses yalnızca bu cihazda kaydedilir ve işlenir; internete gönderilmez. Kayıt boyunca ekranı açık tutun.</p>`;
  document.body.append(el);
  $('#rec-nspk', el).onchange = (e) => { rec.numSpeakers = +e.target.value; };
  $('#rec-stop', el).onclick = () => stopRecording(true);
  $('#rec-cancel', el).onclick = async () => {
    if (rec.elapsed > 5 && !(await confirmBox('Kayıt silinsin mi?', 'Bu kayıt kaydedilmeden silinecek.', 'Sil', true))) return;
    stopRecording(false);
  };
  $('#rec-pause', el).onclick = (e) => {
    const b = e.currentTarget;
    if (rec.paused) { rec.mr.resume(); rec.paused = false; b.innerHTML = ICON.pause; $('.recorder .state').innerHTML = '<span style="color:var(--rec)">●</span> Kaydediliyor'; }
    else { rec.mr.pause(); rec.paused = true; b.innerHTML = ICON.play; $('.recorder .state').textContent = 'Duraklatıldı'; }
  };
}

async function stopRecording(keep) {
  const { mr, stream } = rec;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ac?.close?.();
  const done = new Promise((r) => { mr.onstop = r; });
  try { mr.state !== 'inactive' && mr.stop(); } catch { /* boş */ }
  await Promise.race([done, sleep(3000)]);
  stream.getTracks().forEach((t) => t.stop());
  $('.recorder')?.remove();
  await wake(false);
  const draftId = rec.draftId;
  if (!keep) { await db.del('drafts', draftId); return; }
  const blob = new Blob(rec.chunks, { type: mr.mimeType || 'audio/mp4' });
  await db.del('drafts', draftId);
  await createRecording(blob, { title: `Kayıt – ${fmtDate(rec.startedAt)}`, createdAt: rec.startedAt, duration: rec.elapsed }, { numSpeakers: rec.numSpeakers });
}

async function createRecording(blob, meta, over = {}) {
  const id = uid();
  await db.put('audio', { id, blob, mime: blob.type });
  const r = {
    id, title: meta.title, createdAt: meta.createdAt || Date.now(), duration: meta.duration || 0,
    status: 'queued', speakers: [], turns: [], summaries: [], chat: [], source: meta.source || 'mic',
  };
  await saveRec(r);
  state.recs.unshift(r);
  location.hash = `#/r/${id}`;
  enqueue(id, over);
}

async function importFile(file) {
  if (!file) return;
  const title = file.name.replace(/\.[^.]+$/, '') || 'İçe aktarılan ses';
  const n = await menu('Kaç kişi konuşuyor?', [
    { label: 'Otomatik algıla', value: 0 },
    ...[1, 2, 3, 4, 5, 6].map((k) => ({ label: `${k} kişi`, value: k })),
  ]);
  if (n === null) return;
  await createRecording(file, { title, createdAt: file.lastModified || Date.now(), source: 'file' }, { numSpeakers: n });
}

async function recoverDrafts() {
  const drafts = await db.all('drafts');
  for (const d of drafts) {
    if (!d.chunks?.length) { await db.del('drafts', d.id); continue; }
    const ok = await confirmBox('Yarım kalmış kayıt bulundu',
      `${fmtDate(d.startedAt)} tarihinde başlayan ~${fmtTime(d.elapsed || 0)} uzunluğunda bir kayıt düzgün kapatılmamış. Kurtarılsın mı?`, 'Kurtar');
    if (ok) {
      await createRecording(new Blob(d.chunks, { type: d.mime || 'audio/mp4' }), { title: `Kurtarılan kayıt – ${fmtDate(d.startedAt)}`, createdAt: d.startedAt, duration: d.elapsed });
    }
    await db.del('drafts', d.id);
  }
}

// ====================================================================
// Dışa aktarma
// ====================================================================
function buildTxt(r) {
  const lines = [r.title, `${fmtDate(r.createdAt)} · ${fmtTime(r.duration)}`, ''];
  for (const t of r.turns || []) lines.push(`[${fmtTime(t.start)}] ${speakerName(r, t.spk)}: ${t.text}`);
  return lines.join('\n') + '\n';
}
function buildMd(r) {
  const out = [`# ${r.title}`, '', `*${fmtDate(r.createdAt)} · ${fmtTime(r.duration)} · Konuşmacılar: ${(r.speakers || []).map((_, i) => speakerName(r, i)).join(', ')}*`, ''];
  const s = r.summaries?.[r.summaries.length - 1];
  if (s) out.push('## Özet (Claude)', '', s.text, '');
  if (r.chat?.length) {
    out.push('## Soru – Cevap', '');
    for (const m of r.chat) out.push(m.role === 'user' ? `**Soru:** ${m.content}` : m.content, '');
  }
  out.push('## Metin', '');
  for (const t of r.turns || []) out.push(`**${speakerName(r, t.spk)}** \`${fmtTime(t.start)}\`  `, t.text, '');
  return out.join('\n');
}
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

async function shareText(filename, text, mime = 'text/plain') {
  const file = new File([text], filename, { type: `${mime};charset=utf-8` });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function exportMenu(r) {
  const v = await menu('Dışa aktar / paylaş', [
    { label: 'Metin dosyası (.txt)', value: 'txt' },
    { label: 'Özet + soru-cevap + metin (.md)', value: 'md' },
    { label: 'Ham veri (.json)', value: 'json' },
    { label: 'Metni panoya kopyala', value: 'copy' },
  ]);
  const base = safeName(r.title);
  if (v === 'txt') await shareText(`${base}.txt`, buildTxt(r));
  else if (v === 'md') await shareText(`${base}.md`, buildMd(r), 'text/markdown');
  else if (v === 'json') {
    const { speakers, ...rest } = r;
    await shareText(`${base}.json`, JSON.stringify({ ...rest, speakers: speakers.map(({ emb, ...s }, i) => ({ ...s, displayName: speakerName(r, i) })) }, null, 2), 'application/json');
  } else if (v === 'copy') {
    try { await navigator.clipboard.writeText(buildTxt(r)); toast('Panoya kopyalandı'); } catch { toast('Kopyalanamadı'); }
  }
}

// ====================================================================
// Yönlendirme ve ekranlar
// ====================================================================
const view = () => $('#view');
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/r/')) return { name: 'detail', id: h.slice(3) };
  if (h === '/people') return { name: 'people' };
  if (h === '/settings') return { name: 'settings' };
  if (h.startsWith('/ask')) return { name: 'ask' };
  return { name: 'list' };
}
const isViewing = (id) => { const r = route(); return r.name === 'detail' && r.id === id; };

function setChrome({ title, back = false, actions = '', fab = false, tab = null }) {
  $('#title').textContent = title;
  $('#back').classList.toggle('hidden', !back);
  $('#actions').innerHTML = actions;
  $('#fab').classList.toggle('hidden', !fab);
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}

function render() {
  if (state.audioUrl && route().name !== 'detail') { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  const r = route();
  if (r.name === 'detail') return renderDetail(r.id);
  if (r.name === 'people') return renderPeople();
  if (r.name === 'settings') return renderSettings();
  if (r.name === 'ask') return renderAsk();
  return renderList();
}
// Liste görünümündeyken yeniden çiz; ayrıntı görünümünde yalnızca durum kartını güncelle
function refresh() {
  const r = route();
  if (r.name === 'list') renderList();
  else if (r.name === 'detail') { const rc = findRec(r.id); if (rc) renderStatus(rc); }
}
function updateProgressUI() {
  const r = route();
  if (r.name === 'detail' && state.job?.id === r.id) renderStatus(findRec(r.id));
  const li = state.job && $(`[data-rec="${state.job.id}"] .pill`);
  if (li) li.textContent = `%${Math.round(state.job.value * 100)} ${STAGES[state.job.stage] || ''}`;
}

// ---------------- Kayıt listesi ----------------
function statusPill(r) {
  if (state.job?.id === r.id) return `<span class="pill busy">%${Math.round(state.job.value * 100)} ${esc(STAGES[state.job.stage] || '')}</span>`;
  if (r.status === 'queued') return '<span class="pill busy">Sırada</span>';
  if (r.status === 'processing') return '<span class="pill err">Yarıda kaldı</span>';
  if (r.status === 'error') return '<span class="pill err">Hata</span>';
  return '';
}

function renderList() {
  setChrome({
    title: 'Kayıtlar', tab: 'list', fab: !state.selecting,
    actions: state.recs.length ? `<button class="icon-btn" id="sel-toggle">${state.selecting ? 'Bitti' : 'Seç'}</button>
      <button class="icon-btn" id="import" aria-label="Ses dosyası içe aktar">${ICON.upload}</button>` : `<button class="icon-btn" id="import" aria-label="Ses dosyası içe aktar">${ICON.upload}</button>`,
  });
  const q = state.search.toLocaleLowerCase('tr');
  const recs = state.recs.filter((r) => !q || r.title.toLocaleLowerCase('tr').includes(q) ||
    (r.turns || []).some((t) => t.text.toLocaleLowerCase('tr').includes(q)) ||
    (r.speakers || []).some((_, i) => speakerName(r, i).toLocaleLowerCase('tr').includes(q)));

  let html = '';
  if (isIOS && !standalone) {
    html += `<div class="banner">📲 En iyi deneyim için: Safari'de <b>Paylaş → Ana Ekrana Ekle</b>. Böylece uygulama çevrimdışı açılır ve kayıtlarınız iOS tarafından silinmez.</div>`;
  }
  if (!state.recs.length) {
    html += `<div class="empty">${ICON.mic}<p><b>Henüz kayıt yok.</b><br>Aşağıdaki <b>Kaydet</b> düğmesiyle bir konuşma kaydedin ya da sağ üstten bir ses dosyası içe aktarın.</p>
      <p class="small">İlk işlemede konuşma tanıma modelleri bir kez indirilir (≈${settings.asrModel === 'small' ? 260 : settings.asrModel === 'tiny' ? 50 : 90} MB). Sonrasında her şey internetsiz çalışır.</p></div>`;
  } else {
    html += `<input class="search" type="search" placeholder="Kayıtlarda ara (metin, başlık, kişi)" value="${esc(state.search)}" id="search">`;
    if (state.selecting) {
      html += `<div class="banner">Claude'a birlikte soru sormak istediğiniz kayıtları seçin.</div>`;
    }
    html += '<ul class="list">' + recs.map((r) => {
      const spk = (r.speakers || []).map((_, i) => speakerName(r, i)).join(', ');
      const snip = (r.turns || []).slice(0, 3).map((t) => t.text).join(' ');
      return `<li><a class="rec-item ${state.selected.has(r.id) ? 'sel' : ''}" href="#/r/${r.id}" data-rec="${r.id}">
        <div class="row"><span class="t">${esc(r.title)}</span><span class="spacer"></span>${statusPill(r)}</div>
        <div class="meta">${fmtDate(r.createdAt)} · ${fmtTime(r.duration)}${spk ? ` · ${esc(spk)}` : ''}${r.summaries?.length ? ' · ✦ özet' : ''}</div>
        ${snip ? `<div class="snip">${esc(snip)}</div>` : ''}
      </a></li>`;
    }).join('') + '</ul>';
    if (!recs.length) html += '<p class="muted">Aramayla eşleşen kayıt yok.</p>';
    if (state.selecting) {
      html += `<button class="btn primary block" id="ask-selected" ${state.selected.size ? '' : 'disabled'}>${ICON.spark} Seçilen ${state.selected.size} kayıt hakkında Claude'a sor</button>`;
    }
  }
  view().innerHTML = html;
  $('#import')?.addEventListener('click', () => $('#file-input').click());
  $('#sel-toggle')?.addEventListener('click', () => { state.selecting = !state.selecting; state.selected.clear(); renderList(); });
  const s = $('#search');
  if (s) s.addEventListener('input', (e) => {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    renderList();
    const ns = $('#search'); ns.focus(); ns.setSelectionRange(pos, pos);
  });
  if (state.selecting) {
    $$('[data-rec]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.rec;
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderList();
    }));
    $('#ask-selected')?.addEventListener('click', () => {
      sessionStorage.setItem('kd-ask-ids', JSON.stringify([...state.selected]));
      state.selecting = false;
      location.hash = '#/ask';
    });
  }
}

// ---------------- Kayıt ayrıntısı ----------------
async function renderDetail(id) {
  const r = findRec(id);
  if (!r) { location.hash = '#/'; return; }
  setChrome({ title: r.title, back: true, actions: `<button class="icon-btn" id="share" aria-label="Paylaş">${ICON.share}</button><button class="icon-btn" id="more" aria-label="Diğer">${ICON.more}</button>` });
  view().innerHTML = `
    <div id="d-status"></div>
    <div class="card">
      <div class="row"><span class="muted small" id="d-meta">${fmtDate(r.createdAt)} · ${fmtTime(r.duration)}</span></div>
      <div id="d-audio"></div>
    </div>
    <div class="card"><h2>Konuşmacılar</h2><div id="d-speakers" class="chips"></div>
      <p class="small muted" style="margin:8px 0 0">Bir kişiye dokunarak adını verin. “Bu sesi tanı” derseniz sonraki kayıtlarda otomatik tanınır.</p></div>
    <div class="card" id="d-claude"></div>
    <div class="card"><div class="row"><h2 style="margin:0">Metin</h2><span class="spacer"></span><span class="small muted" id="d-wc"></span></div>
      <div id="d-transcript"></div></div>`;
  $('#share').onclick = () => exportMenu(r);
  $('#more').onclick = () => moreMenu(r);
  renderStatus(r);
  renderDetailParts(r);
  renderClaude(r);

  const a = await db.get('audio', id);
  if (a && isViewing(id)) {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(a.blob);
    $('#d-audio').innerHTML = `<audio controls preload="metadata" src="${state.audioUrl}"></audio>`;
    const au = $('#d-audio audio');
    au.addEventListener('timeupdate', () => {
      const t = au.currentTime;
      $$('.turn').forEach((el) => el.classList.toggle('playing', !au.paused && t >= +el.dataset.s && t < +el.dataset.e));
    });
  } else if (isViewing(id)) {
    $('#d-audio').innerHTML = '<p class="small muted" style="margin:6px 0 0">Ses dosyası silinmiş; yalnızca metin saklanıyor.</p>';
  }
}

function renderStatus(r) {
  const el = $('#d-status');
  if (!el) return;
  if (state.job?.id === r.id) {
    el.innerHTML = `<div class="card"><div class="row"><b>İşleniyor</b><span class="spacer"></span><span class="small muted">${esc(state.device || '')}</span></div>
      <p class="small muted" style="margin:6px 0">${esc(jobLabel())}</p>
      <div class="progress"><i style="width:${Math.round(state.job.value * 100)}%"></i></div>
      <p class="small muted" style="margin:8px 0 0">Tüm işlem bu telefonda yapılır. Uygulamayı açık ve ekranı açık tutun.</p></div>`;
  } else if (r.status === 'queued') {
    el.innerHTML = '<div class="card"><b>Sırada bekliyor…</b></div>';
  } else if (r.status === 'error' || r.status === 'processing') {
    const crashed = r.status === 'processing';
    const light = r.crash?.model === 'tiny' ? null : 'tiny';
    el.innerHTML = `<div class="card"><b style="color:var(--danger)">${crashed ? 'İşleme yarıda kaldı' : 'İşleme başarısız'}</b>
      <p class="small muted">${esc(r.error || 'Uygulama işlem sırasında kapanmış olabilir.')}</p>
      ${crashed ? `<p class="small muted">Telefonun bu sayfaya ayırdığı bellek yetmemiş olabilir. Diğer uygulamaları kapatıp tekrar deneyin${light ? ' ya da daha hafif modeli seçin' : ''}.</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" id="retry">Tekrar dene</button>
        ${light ? '<button class="btn" id="retry-light">Hafif modelle dene (tiny)</button>' : ''}
      </div>
      <p class="small muted" style="margin:8px 0 0">Sorun sürerse: Ayarlar → Tanılama → “Raporu kopyala” ve bana iletin.</p></div>`;
    $('#retry').onclick = () => enqueue(r.id, { keepNames: true });
    $('#retry-light')?.addEventListener('click', () => enqueue(r.id, { asrModel: 'tiny', keepNames: true }));
  } else el.innerHTML = '';
}

function renderDetailParts(r) {
  const meta = $('#d-meta');
  if (meta) meta.textContent = `${fmtDate(r.createdAt)} · ${fmtTime(r.duration)}`;
  const sp = $('#d-speakers');
  if (sp) {
    sp.innerHTML = (r.speakers || []).map((s, i) => `<button class="chip" data-spk="${i}"><span class="sw" style="background:${spkColor(i)}"></span>${esc(speakerName(r, i))}${s.profileId ? '<span class="badge" title="Tanınan kişi">✓</span>' : ''}<span class="small muted">${fmtTime(s.duration)}</span></button>`).join('')
      || '<span class="small muted">Henüz yok.</span>';
    $$('[data-spk]', sp).forEach((b) => b.addEventListener('click', () => speakerMenu(r, +b.dataset.spk)));
  }
  const tr = $('#d-transcript');
  if (tr) {
    tr.innerHTML = (r.turns || []).map((t, i) => turnHtml(r, t, i)).join('')
      || `<p class="muted small">${state.job?.id === r.id || r.status === 'queued' ? 'Metin hazırlanıyor…' : r.status === 'done' ? 'Bu kayıtta konuşma bulunamadı.' : 'Henüz metin yok.'}</p>`;
    $$('.turn', tr).forEach((el) => el.addEventListener('click', () => turnMenu(r, +el.dataset.i)));
    const wc = $('#d-wc');
    if (wc) wc.textContent = r.turns?.length ? `${words(r.turns.map((t) => t.text).join(' '))} kelime` : '';
  }
}
const turnHtml = (r, t, i) => `<div class="turn" data-i="${i}" data-s="${t.start}" data-e="${t.end}">
  <div class="who"><span style="color:${spkColor(t.spk)}">${esc(speakerName(r, t.spk))}</span><time>${fmtTime(t.start)}</time></div>
  <div class="txt">${esc(t.text)}</div></div>`;
function appendTurnLive(r, t) {
  const tr = $('#d-transcript');
  if (!tr) return;
  if (!tr.querySelector('.turn')) tr.innerHTML = '';
  tr.insertAdjacentHTML('beforeend', turnHtml(r, t, r.turns.length - 1));
}

async function moreMenu(r) {
  const hasAudio = !!(await db.get('audio', r.id));
  const items = [
    { label: 'Başlığı değiştir', value: 'title' },
    ...(hasAudio ? [{ label: 'Yeniden işle (farklı ayarlarla)', value: 'reprocess' }] : []),
    ...(hasAudio ? [{ label: 'Ses dosyasını paylaş/kaydet', value: 'audio' }] : []),
    ...(hasAudio ? [{ label: 'Sesi sil, yalnızca metni sakla', value: 'delaudio', danger: true }] : []),
    ...(r.originalTurns ? [{ label: 'Claude düzeltmelerini geri al', value: 'undofix' }] : []),
    { label: 'Kaydı tamamen sil', value: 'delete', danger: true },
  ];
  const v = await menu(r.title, items);
  if (v === 'undofix') {
    const ok = await confirmBox('Düzeltmeler geri alınsın mı?', 'Metin, Claude ile düzeltmeden önceki hâline döner (sonradan elle yaptığınız değişiklikler de geri alınır).', 'Geri al');
    if (ok) {
      r.turns = r.originalTurns;
      r.originalTurns = undefined;
      await saveRec(r);
      renderDetailParts(r); renderClaude(r);
      toast('Orijinal metne dönüldü');
    }
    return;
  }
  if (v === 'title') {
    const t = await promptBox('Başlık', r.title);
    if (t) { r.title = t; await saveRec(r); render(); }
  } else if (v === 'reprocess') {
    const n = await menu('Kaç kişi konuşuyor?', [{ label: 'Otomatik algıla', value: 0 }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ label: `${k} kişi`, value: k }))]);
    if (n === null) return;
    const m = await menu('Konuşma tanıma modeli', [
      { label: 'Hızlı (tiny, ~41 MB)', value: 'tiny' },
      { label: 'Dengeli (base, ~77 MB)', value: 'base' },
      { label: 'En doğru (small, ~250 MB) – telefonda belleğe sığmayabilir', value: 'small' },
    ]);
    if (!m) return;
    if (r.turns?.length && !(await confirmBox('Yeniden işlensin mi?', 'Mevcut metin ve metin üzerindeki düzeltmeleriniz yenisiyle değiştirilecek (özet ve sorular korunur).', 'Yeniden işle'))) return;
    enqueue(r.id, { numSpeakers: n, asrModel: m, keepNames: true });
  } else if (v === 'audio') {
    const a = await db.get('audio', r.id);
    const ext = (a.mime || '').includes('webm') ? 'webm' : (a.mime || '').includes('ogg') ? 'ogg' : (a.mime || '').includes('wav') ? 'wav' : 'm4a';
    const f = new File([a.blob], `${safeName(r.title)}.${ext}`, { type: a.mime || 'audio/mp4' });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch { /* iptal */ } }
    else { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); }
  } else if (v === 'delaudio') {
    if (await confirmBox('Ses silinsin mi?', 'Metin, özet ve sorular kalır; ama kayıt yeniden işlenemez ve dinlenemez.', 'Sesi sil', true)) {
      await db.del('audio', r.id); render();
    }
  } else if (v === 'delete') {
    if (await confirmBox('Kayıt silinsin mi?', 'Ses, metin, özet ve sorular kalıcı olarak silinecek.', 'Sil', true)) {
      await db.del('audio', r.id); await db.del('recordings', r.id);
      state.recs = state.recs.filter((x) => x.id !== r.id);
      state.queue = state.queue.filter((q) => q.id !== r.id);
      location.hash = '#/';
    }
  }
}

async function speakerMenu(r, i) {
  const s = r.speakers[i];
  const linked = s.profileId && state.profiles.find((p) => p.id === s.profileId);
  const items = [
    { label: 'Adını değiştir', value: 'rename' },
    linked ? { label: `Tanıma bağlantısını kaldır (${linked.name})`, value: 'unlink' } : { label: 'Bu sesi tanı (yeni kişi olarak kaydet)', value: 'save' },
    ...(!linked && state.profiles.length ? [{ label: 'Kayıtlı bir kişiyle eşleştir', value: 'link' }] : []),
    ...(r.speakers.length > 1 ? [{ label: 'Başka bir konuşmacıyla birleştir', value: 'merge' }] : []),
  ];
  const v = await menu(speakerName(r, i), items);
  if (v === 'rename') {
    const n = await promptBox('Konuşmacının adı', speakerName(r, i).startsWith('Konuşmacı ') ? '' : speakerName(r, i), { placeholder: 'ör. Ayşe' });
    if (!n) return;
    if (linked) { linked.name = n; linked.updatedAt = Date.now(); await db.put('profiles', linked); await loadAll(); }
    else s.name = n;
    await saveRec(r);
  } else if (v === 'save') {
    let n = s.name || '';
    if (!n) n = await promptBox('Bu kişinin adı', '', { placeholder: 'ör. Ayşe' });
    if (!n) return;
    const p = { id: uid(), name: n, emb: l2(s.emb), count: 1, updatedAt: Date.now() };
    await db.put('profiles', p);
    s.profileId = p.id; s.name = n;
    await saveRec(r); await loadAll();
    toast(`${n} artık otomatik tanınacak`);
  } else if (v === 'unlink') {
    s.name = linked.name; s.profileId = null; await saveRec(r);
  } else if (v === 'link') {
    const pid = await menu('Hangi kişi?', state.profiles.map((p) => ({ label: p.name, value: p.id })));
    if (!pid) return;
    const p = state.profiles.find((x) => x.id === pid);
    // Profilin ses izini bu örnekle güncelle (hareketli ortalama)
    p.emb = l2(p.emb.map((x, k) => x * p.count + s.emb[k]));
    p.count += 1; p.updatedAt = Date.now();
    await db.put('profiles', p);
    r.speakers.forEach((o) => { if (o.profileId === pid) o.profileId = null; });
    s.profileId = pid; s.name = p.name;
    await saveRec(r); await loadAll();
  } else if (v === 'merge') {
    const j = await menu(`${speakerName(r, i)} aslında kim?`, r.speakers.map((_, k) => k).filter((k) => k !== i).map((k) => ({ label: speakerName(r, k), value: k })));
    if (j === null) return;
    mergeSpeakers(r, i, j);
    await saveRec(r);
  }
  renderDetailParts(r);
}

function mergeSpeakers(r, from, to) {
  const a = r.speakers[from], b = r.speakers[to];
  b.emb = l2(b.emb.map((x, k) => x * b.duration + a.emb[k] * a.duration));
  b.duration += a.duration;
  if (!b.name && a.name) b.name = a.name;
  if (!b.profileId && a.profileId) b.profileId = a.profileId;
  r.speakers.splice(from, 1);
  const remap = (k) => (k === from ? (to > from ? to - 1 : to) : k > from ? k - 1 : k);
  const merged = [];
  for (const t of r.turns) {
    t.spk = remap(t.spk);
    const last = merged[merged.length - 1];
    if (last && last.spk === t.spk && t.start - last.end < 2) { last.text += ' ' + t.text; last.end = t.end; } else merged.push(t);
  }
  r.turns = merged;
}

async function turnMenu(r, i) {
  const t = r.turns[i];
  const au = $('#d-audio audio');
  const v = await menu(`${speakerName(r, t.spk)} · ${fmtTime(t.start)}`, [
    ...(au ? [{ label: '▶ Buradan dinle', value: 'play' }] : []),
    { label: 'Metni düzelt', value: 'edit' },
    ...(r.speakers.length > 1 ? [{ label: 'Konuşmacıyı değiştir', value: 'who' }] : []),
    { label: 'Bu bölümü sil', value: 'del', danger: true },
  ]);
  if (v === 'play') { au.currentTime = Math.max(0, t.start - 0.3); au.play(); return; }
  if (v === 'edit') {
    const s = await promptBox('Metni düzelt', t.text, { multiline: true });
    if (s === null) return;
    t.text = s;
  } else if (v === 'who') {
    const k = await menu('Bu bölümü kim söyledi?', r.speakers.map((_, k) => ({ label: speakerName(r, k), value: k })));
    if (k === null) return;
    t.spk = k;
  } else if (v === 'del') {
    r.turns.splice(i, 1);
  } else return;
  await saveRec(r);
  renderDetailParts(r);
}

// ---------------- Claude kartı (özet + soru-cevap) ----------------
function renderClaude(r) {
  const el = $('#d-claude');
  if (!el) return;
  const draft = $('#c-q')?.value || ''; // yazılmakta olan soruyu yeniden çizimde kaybetme
  queueMicrotask(() => { const q = $('#c-q'); if (q && draft && !q.value) q.value = draft; });
  const ready = r.status === 'done' && r.turns?.length;
  const sum = r.summaries?.[r.summaries.length - 1];
  const key = hasKey(settings);
  const modelLabel = (CLAUDE_MODELS.find((m) => m.id === settings.claudeModel) || CLAUDE_MODELS[0]).label.replace(/ \(.*/, '');
  el.innerHTML = `
    <div class="row"><h2 style="margin:0">${ICON.spark.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Claude</h2><span class="spacer"></span><span class="small muted">${esc(modelLabel)}</span></div>
    ${!key ? `<p class="notice">Özet ve soru-cevap için Ayarlar'a Anthropic API anahtarınızı girin. Bunlar yalnızca siz düğmeye bastığınızda çalışır ve <b>yalnızca metin</b> gönderilir — ses asla gönderilmez.</p>
      <a class="btn block" href="#/settings">Ayarlar'a git</a>` : ''}
    ${key && !ready ? '<p class="small muted">Metin hazır olduğunda özetleyebilir ve soru sorabilirsiniz.</p>' : ''}
    ${key && ready ? `
      <div id="c-summary">${sum ? `<div class="md">${md(sum.text)}</div><p class="small muted">${esc(sum.model)} · ${fmtDate(sum.createdAt)} · ${usageText(sum.usage)}</p>` : ''}</div>
      <div class="btn-row"><button class="btn ${sum ? '' : 'primary'}" id="c-sum">${sum ? 'Yeniden özetle' : 'Özetle'}</button>
        <button class="btn" id="c-fix">Metni düzelt</button></div>
      <p class="small muted" style="margin:8px 0 0"><b>Metni düzelt:</b> yanlış duyulan kelimeleri bağlamdan düzeltir (ör. “kutumu” → “kotumu”). Değişiklikleri uygulamadan önce tek tek görürsünüz.</p>
      <p class="small muted" style="margin:8px 0 0">Gönderilecek: yalnızca metin (~${words(r.turns.map((t) => t.text).join(' '))} kelime). Ses gönderilmez.</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div class="row"><b>Soru sor</b><span class="spacer"></span>${r.chat?.length ? '<button class="icon-btn small" id="c-clear">Temizle</button>' : ''}</div>
      <div id="c-chat">${(r.chat || []).map(bubble).join('')}</div>
      <div class="composer"><textarea id="c-q" rows="1" placeholder="Örn. Kim hangi işi üstlendi?"></textarea>
        <button class="btn primary" id="c-send" aria-label="Gönder">${ICON.send}</button></div>` : ''}`;
  if (!(key && ready)) return;
  $('#c-sum').onclick = () => summarize(r);
  $('#c-fix').onclick = () => fixTranscript(r);
  $('#c-send').onclick = () => sendQuestion(r);
  $('#c-clear')?.addEventListener('click', async () => {
    if (await confirmBox('Sohbet temizlensin mi?', 'Bu kayıttaki sorular ve yanıtlar silinecek.', 'Temizle', true)) { r.chat = []; await saveRec(r); renderClaude(r); }
  });
  autoGrow($('#c-q'));
}

const usageText = (u) => u ? `${u.input.toLocaleString('tr-TR')} girdi${u.cached ? ` (${u.cached.toLocaleString('tr-TR')} önbellekten)` : ''} + ${u.output.toLocaleString('tr-TR')} çıktı token · ~$${u.costUsd.toFixed(3)}` : '';
const bubble = (m) => m.role === 'user'
  ? `<div class="bubble user">${esc(m.content)}</div>`
  : `<div class="bubble assistant"><div class="md">${md(m.content)}</div>${m.usage ? `<div class="foot">${esc(m.model || '')} · ${usageText(m.usage)}</div>` : ''}</div>`;
function autoGrow(ta) {
  if (!ta) return;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
}

function claudeBusy(btn, label) {
  if (state.busyClaude) { state.busyClaude.abort(); return null; }
  const ac = new AbortController();
  state.busyClaude = ac;
  const old = btn.innerHTML;
  btn.innerHTML = label;
  return { ac, done: () => { state.busyClaude = null; btn.innerHTML = old; } };
}

/** Kelime düzeyinde fark: eski metinde silinenler kırmızı, yenide eklenenler yeşil. */
function wordDiff(a, b) {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean);
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(esc(x[i])); i++; j++; }
    // önce silinen (eski) kelime, sonra eklenen (yeni) kelime gösterilsin
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { out.push(`<del class="d-del">${esc(x[i])}</del>`); i++; }
    else { out.push(`<ins class="d-ins">${esc(y[j])}</ins>`); j++; }
  }
  return out.join(' ');
}

/** "Metni düzelt": Claude yalnızca metni görür; öneriler onaylanmadan uygulanmaz. */
async function fixTranscript(r) {
  if (!navigator.onLine) { toast('Düzeltme için internet bağlantısı gerekir.'); return; }
  const btn = $('#c-fix');
  const b = claudeBusy(btn, 'Durdur');
  if (!b) return;
  const t0 = Date.now();
  const tick = setInterval(() => { if (btn.isConnected) btn.textContent = `Düzeltiliyor… ${Math.round((Date.now() - t0) / 1000)} sn`; }, 1000);
  let res;
  try {
    res = await correctTranscript(settings, r, speakerName, { signal: b.ac.signal });
  } catch (err) {
    toast(explainError(err), 6000);
    return;
  } finally {
    clearInterval(tick);
    b.done();
  }
  if (!res.changes.length) { toast('Claude düzeltilecek bir şey bulmadı.'); return; }
  const picked = await sheet(`<h3>Önerilen düzeltmeler (${res.changes.length})</h3>
    <p class="small muted">${esc(res.model)} · ${usageText(res.usage)}</p>
    <div>${res.changes.map((c, k) => `<label class="fix-row">
      <input type="checkbox" data-k="${k}" checked>
      <span><span class="small muted">${esc(speakerName(r, r.turns[c.i].spk))} · ${fmtTime(r.turns[c.i].start)}</span><br>${wordDiff(c.old, c.text)}</span></label>`).join('')}</div>
    <div class="btn-row" style="margin-top:12px"><button class="btn" data-a="no">Vazgeç</button><button class="btn primary" data-a="ok">Seçilenleri uygula</button></div>`,
  (el, close) => {
    $('[data-a=no]', el).onclick = () => close(null);
    $('[data-a=ok]', el).onclick = () => close($$('input[data-k]', el).filter((c) => c.checked).map((c) => res.changes[+c.dataset.k]));
  });
  if (!picked?.length) return;
  if (!r.originalTurns) r.originalTurns = r.turns.map((t) => ({ ...t }));
  for (const c of picked) r.turns[c.i].text = c.text;
  r.corrections = [...(r.corrections || []), { at: Date.now(), model: res.model, count: picked.length, usage: res.usage }];
  await saveRec(r);
  if (isViewing(r.id)) { renderDetailParts(r); renderClaude(r); }
  toast(`${picked.length} satır düzeltildi. Geri almak için: ⋯ → “Claude düzeltmelerini geri al”`, 4500);
}

async function summarize(r) {
  if (!navigator.onLine) { toast('Özet için internet bağlantısı gerekir.'); return; }
  const btn = $('#c-sum');
  const b = claudeBusy(btn, 'Durdur');
  if (!b) return;
  const box = $('#c-summary');
  box.innerHTML = '<p class="small muted">Claude düşünüyor…</p>';
  try {
    const res = await ask(settings, transcriptText(r, speakerName), [{ role: 'user', content: SUMMARY_PROMPT }], {
      signal: b.ac.signal,
      onText: (t) => { box.innerHTML = `<div class="md">${md(t)}</div>`; },
    });
    r.summaries = [...(r.summaries || []).slice(-2), { text: res.text, model: res.model, createdAt: Date.now(), usage: res.usage }];
    await saveRec(r);
  } catch (err) {
    toast(explainError(err), 6000);
  } finally {
    b.done();
    if (isViewing(r.id)) renderClaude(r);
  }
}

async function sendQuestion(r) {
  const ta = $('#c-q');
  const q = ta.value.trim();
  if (!q) return;
  if (!navigator.onLine) { toast('Soru sormak için internet bağlantısı gerekir.'); return; }
  const btn = $('#c-send');
  const b = claudeBusy(btn, ICON.x);
  if (!b) return;
  r.chat = r.chat || [];
  r.chat.push({ role: 'user', content: q });
  ta.value = '';
  const chat = $('#c-chat');
  chat.insertAdjacentHTML('beforeend', bubble({ role: 'user', content: q }) + '<div class="bubble assistant" id="c-live"><span class="muted small">Claude düşünüyor…</span></div>');
  try {
    const res = await ask(settings, transcriptText(r, speakerName), r.chat.map(({ role, content }) => ({ role, content })), {
      signal: b.ac.signal,
      onText: (t) => { const el = $('#c-live'); if (el) el.innerHTML = `<div class="md">${md(t)}</div>`; },
    });
    r.chat.push({ role: 'assistant', content: res.text, model: res.model, usage: res.usage });
  } catch (err) {
    r.chat.pop(); // yanıtlanmayan soruyu geri al
    ta.value = q;
    toast(explainError(err), 6000);
  } finally {
    await saveRec(r);
    b.done();
    if (isViewing(r.id)) renderClaude(r);
  }
}

// ---------------- Birden çok kayıt hakkında soru ----------------
function renderAsk() {
  let ids = [];
  try { ids = JSON.parse(sessionStorage.getItem('kd-ask-ids') || '[]'); } catch { /* boş */ }
  const recs = ids.map(findRec).filter((r) => r && r.turns?.length);
  setChrome({ title: 'Kayıtlar hakkında sor', back: true });
  if (!recs.length) { view().innerHTML = '<p class="muted">Seçili, metni hazır kayıt yok.</p>'; return; }
  const key = `kd-ask-chat:${recs.map((r) => r.id).join(',')}`;
  let chat = [];
  try { chat = JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { /* boş */ }
  const context = recs.map((r) => transcriptText(r, speakerName)).join('\n\n---\n\n');
  view().innerHTML = `<div class="card"><b>${recs.length} kayıt</b><p class="small muted">${recs.map((r) => esc(r.title)).join(' · ')}</p>
    <p class="small muted">Gönderilecek: yalnızca metin (~${words(context)} kelime). Ses gönderilmez.</p>
    ${hasKey(settings) ? '' : '<p class="notice">Önce Ayarlar\'a API anahtarınızı girin.</p>'}</div>
    <div class="card"><div id="a-chat">${chat.map(bubble).join('')}</div>
    <div class="composer"><textarea id="a-q" rows="1" placeholder="Örn. Bu toplantılarda hangi kararlar tekrar ediyor?"></textarea>
    <button class="btn primary" id="a-send">${ICON.send}</button></div></div>`;
  autoGrow($('#a-q'));
  $('#a-send').onclick = async () => {
    const q = $('#a-q').value.trim();
    if (!q || !hasKey(settings)) return;
    const b = claudeBusy($('#a-send'), ICON.x);
    if (!b) return;
    chat.push({ role: 'user', content: q });
    $('#a-q').value = '';
    $('#a-chat').insertAdjacentHTML('beforeend', bubble({ role: 'user', content: q }) + '<div class="bubble assistant" id="a-live"><span class="muted small">Claude düşünüyor…</span></div>');
    try {
      const res = await ask(settings, context, chat.map(({ role, content }) => ({ role, content })), {
        signal: b.ac.signal,
        onText: (t) => { const el = $('#a-live'); if (el) el.innerHTML = `<div class="md">${md(t)}</div>`; },
      });
      chat.push({ role: 'assistant', content: res.text, model: res.model, usage: res.usage });
    } catch (err) { chat.pop(); toast(explainError(err), 6000); }
    sessionStorage.setItem(key, JSON.stringify(chat));
    b.done();
    if (route().name === 'ask') renderAsk();
  };
}

// ---------------- Konuşmacılar (tanınan kişiler) ----------------
function renderPeople() {
  setChrome({ title: 'Konuşmacılar', tab: 'people' });
  const counts = new Map();
  for (const r of state.recs) for (const s of r.speakers || []) if (s.profileId) counts.set(s.profileId, (counts.get(s.profileId) || 0) + 1);
  view().innerHTML = `
    <div class="card"><p class="small muted" style="margin:0">Bir kayıtta konuşmacıya dokunup <b>“Bu sesi tanı”</b> dediğinizde, o kişinin ses izi (256 sayılık bir vektör — ses kaydı değil) bu cihazda saklanır. Sonraki kayıtlarda bu kişi otomatik olarak adıyla gösterilir. Aynı kişiyi farklı kayıtlarda “Kayıtlı bir kişiyle eşleştir” ile işaretledikçe tanıma güçlenir.</p></div>
    ${state.profiles.length ? `<ul class="list">${state.profiles.map((p) => `<li class="card row" data-p="${p.id}">
      <div><b>${esc(p.name)}</b><div class="small muted">${counts.get(p.id) || 0} kayıtta · ${p.count} örnek</div></div>
      <span class="spacer"></span><button class="icon-btn" data-act="${p.id}">${ICON.more}</button></li>`).join('')}</ul>`
      : '<div class="empty"><p>Henüz tanınan kişi yok.</p></div>'}`;
  $$('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.profiles.find((x) => x.id === b.dataset.act);
    const v = await menu(p.name, [{ label: 'Adını değiştir', value: 'rename' }, { label: 'Sil (kayıtlardaki ad korunur)', value: 'del', danger: true }]);
    if (v === 'rename') {
      const n = await promptBox('Ad', p.name);
      if (n) { p.name = n; await db.put('profiles', p); }
    } else if (v === 'del') {
      if (!(await confirmBox(`${p.name} silinsin mi?`, 'Bu kişi artık otomatik tanınmayacak.', 'Sil', true))) return;
      for (const r of state.recs) {
        let ch = false;
        for (const s of r.speakers || []) if (s.profileId === p.id) { s.profileId = null; s.name = p.name; ch = true; }
        if (ch) await saveRec(r);
      }
      await db.del('profiles', p.id);
    }
    await loadAll();
    renderPeople();
  }));
}

// ---------------- Ayarlar ----------------
/** Seçili model kurulumunun tüm dosyaları önbellekte mi? → { ok, missing[] } */
const LOCAL_MODELS = new URL('../models/', import.meta.url).href;
async function modelCacheStatus(size = settings.asrModel) {
  try {
    const c = await caches.open('transformers-cache');
    const have = new Set((await c.keys()).map((k) => k.url));
    const missing = modelFiles(asrModelFor(size, settings.language), LOCAL_MODELS).filter((u) => !have.has(u));
    return { ok: missing.length === 0, missing };
  } catch (e) { return { ok: false, missing: [], error: String(e) }; }
}

/**
 * Model dosyalarını belleğe YÜKLEMEDEN, akış hâlinde doğrudan önbelleğe indirir.
 * (Eski sürüm indirirken modelleri de çalıştırıyordu; telefonda belleği zorluyordu.)
 */
async function downloadModels(size, onProgress) {
  const cache = await caches.open('transformers-cache');
  const { missing } = await modelCacheStatus(size);
  let i = 0;
  for (const url of missing) {
    i++;
    const name = url.split('/').pop();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name} indirilemedi (HTTP ${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    let loaded = 0;
    const report = () => onProgress({ file: i, files: missing.length, loaded, total, name });
    let body;
    if (res.body && typeof TransformStream !== 'undefined') {
      body = res.body.pipeThrough(new TransformStream({
        transform(chunk, ctl) { loaded += chunk.byteLength; report(); ctl.enqueue(chunk); },
      }));
    } else { body = await res.arrayBuffer(); loaded = body.byteLength; report(); }
    await cache.put(url, new Response(body, { status: 200, headers: res.headers }));
    logEvent(`indirildi: ${url.replace('https://huggingface.co/', '')} ${(total / 1e6).toFixed(1)} MB`);
  }
  return missing.length;
}

/** Tanılama raporu: kullanıcı kopyalayıp geliştiriciye iletebilir. Kişisel içerik yok. */
async function diagnosticsText() {
  const ua = navigator.userAgent;
  const ios = (ua.match(/OS (\d+)[._](\d+)(?:[._](\d+))? like Mac OS X/) || []).slice(1).filter(Boolean).join('.');
  const lines = [
    `Konuşma Defteri ${APP_VERSION}`,
    `Cihaz: ${/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : navigator.platform}${ios ? ` · iOS ${ios}` : ''} · ekran ${screen.width}x${screen.height}@${devicePixelRatio}`,
    `Tarayıcı: ${ua}`,
    `Ana ekran uygulaması: ${standalone ? 'evet' : 'hayır'} · WebGPU: ${navigator.gpu ? 'var' : 'yok'} · çekirdek: ${navigator.hardwareConcurrency || '?'} · bellek: ${navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'bilinmiyor'}`,
    `Ayarlar: model=${settings.asrModel} işlemci=${settings.device} dil=${settings.language} eşik=${settings.threshold}`,
  ];
  try {
    const est = await navigator.storage.estimate();
    lines.push(`Depolama: ${(est.usage / 1e6).toFixed(0)} MB kullanılıyor / ${(est.quota / 1e6).toFixed(0)} MB kota · kalıcı: ${await navigator.storage.persisted?.() ? 'evet' : 'hayır'}`);
  } catch { /* boş */ }
  const st = await modelCacheStatus();
  lines.push(`Modeller (${settings.asrModel}): ${st.ok ? 'tamam' : `${st.missing.length} dosya eksik`}`);
  const crashed = state.recs.filter((r) => r.crash).slice(0, 3);
  for (const r of crashed) lines.push(`Kapanma: ${r.crashes || 1}x · aşama=${r.crash.stage} %${r.crash.value || 0} · model=${r.crash.model} · işlemci=${r.crash.device} · ses=${r.crash.dur || '?'} sn`);
  let log = [];
  try { log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { /* boş */ }
  lines.push('— Günlük —', ...log.slice(-25));
  return lines.join('\n');
}

async function renderSettings() {
  setChrome({ title: 'Ayarlar', tab: 'settings' });
  const sel = (name, opts) => `<select data-k="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(settings[name]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  view().innerHTML = `
    <div class="card"><h2>Konuşma tanıma (cihazda)</h2>
      <label class="field"><span>Model</span>${sel('asrModel', [['tiny', 'Hızlı – tiny (~41 MB)'], ['base', 'Dengeli – base (~77 MB, önerilen)'], ['small', 'En doğru – small (~250 MB) – iPhone\'da sığmayabilir']])}
        <small>Büyük model Türkçe'de daha doğrudur ama daha yavaştır ve daha çok bellek ister. “small” işlem sırasında ~1,2 GB bellek kullanır; telefonlarda uygulamanın kapanmasına yol açabilir.</small></label>
      <label class="field"><span>Dil</span>${sel('language', [['turkish', 'Türkçe'], ['auto', 'Otomatik algıla'], ['english', 'İngilizce'], ['german', 'Almanca'], ['arabic', 'Arapça'], ['russian', 'Rusça'], ['french', 'Fransızca']])}</label>
      <label class="field"><span>İşlemci</span>${sel('device', [['wasm', 'CPU – en uyumlu (önerilen)'], ['webgpu', 'GPU (WebGPU) – deneysel']])}
        <small id="gpu-info"></small></label>
      <label class="field"><span>Konuşmacı ayırma hassasiyeti: <b id="thr-v">${settings.threshold.toFixed(2)}</b></span>
        <input type="range" min="0.25" max="0.7" step="0.05" data-k="threshold" value="${settings.threshold}">
        <small>Sola: benzer sesleri tek kişi say · Sağa: daha çok kişiye ayır. Kişi sayısını biliyorsanız kayıt ekranından seçmek daha güvenilirdir.</small></label>
      <label class="field"><span>Kayıtlı kişiyi tanıma eşiği: <b id="pthr-v">${settings.profileThreshold.toFixed(2)}</b></span>
        <input type="range" min="0.35" max="0.8" step="0.05" data-k="profileThreshold" value="${settings.profileThreshold}">
        <small>Yükseldikçe yalnızca çok emin olunan eşleşmeler kabul edilir.</small></label>
      <label class="switch"><span>İşlemeden sonra sesi sakla<br><small class="muted">Kapatırsanız yalnızca metin saklanır.</small></span><input type="checkbox" data-k="keepAudio" ${settings.keepAudio ? 'checked' : ''}></label>
    </div>

    <div class="card"><h2>Çevrimdışı kullanım</h2>
      <p class="small muted" id="cache-st">Kontrol ediliyor…</p>
      <button class="btn block" id="dl-models">Seçili modelleri şimdi indir</button>
      <div class="progress hidden" id="dl-prog" style="margin-top:10px"><i></i></div>
      <p class="small muted" id="storage-st"></p>
    </div>

    <div class="card"><h2>Claude API (isteğe bağlı)</h2>
      <p class="small muted">Özet ve soru-cevap için kendi Anthropic API anahtarınız kullanılır. Anahtar yalnızca bu cihazda saklanır. Claude'a yalnızca siz <b>Özetle</b> veya <b>Gönder</b>'e bastığınızda, yalnızca <b>metin</b> gönderilir.</p>
      <label class="field"><span>API anahtarı</span>
        <input type="password" data-k="apiKey" value="${esc(settings.apiKey)}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <small>Anahtar almak için: <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a> → API Keys. Harcama limitini oradan ayarlayabilirsiniz.</small></label>
      <label class="field"><span>Model</span>${sel('claudeModel', CLAUDE_MODELS.map((m) => [m.id, m.label]))}</label>
      <label class="field"><span>Düşünme düzeyi</span>${sel('effort', [['low', 'Düşük – hızlı, ucuz'], ['medium', 'Orta (önerilen)'], ['high', 'Yüksek – en dikkatli']])}</label>
      <button class="btn block" id="test-key">Bağlantıyı test et</button>
    </div>

    <div class="card"><h2>Veriler</h2>
      <div class="btn-row">
        <button class="btn" id="backup">Yedekle (.json)</button>
        <button class="btn" id="restore">Yedekten yükle</button>
      </div>
      <p class="small muted">Yedek; metinleri, özetleri, soruları ve tanınan kişileri içerir (ses dosyaları hariç).</p>
      <button class="btn danger block" id="wipe">Tüm verileri sil</button>
      <input type="file" id="restore-file" accept="application/json,.json" hidden>
    </div>

    <div class="card"><h2>Tanılama</h2>
      <p class="small muted">Bir sorun olursa bu raporu kopyalayıp geliştiriciye iletin. Raporda kayıtlarınızın içeriği yok; yalnızca cihaz bilgisi, ayarlar ve hata kayıtları var.</p>
      <pre id="diag" class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;background:var(--surface-2);padding:8px;border-radius:8px">…</pre>
      <div class="btn-row"><button class="btn" id="diag-copy">Raporu kopyala</button><button class="btn" id="diag-clear">Günlüğü temizle</button></div>
    </div>

    <div class="card small muted"><h2>Gizlilik</h2>
      <p>• Ses kaydı, konuşmacı ayırma ve metne dönüştürme tamamen bu telefonda yapılır. Ses dosyası hiçbir zaman internete gönderilmez.</p>
      <p>• İnternet yalnızca iki şey için kullanılır: (1) ilk kullanımda yapay zekâ modellerini Hugging Face'ten <i>indirmek</i>; (2) siz istediğinizde konuşma <i>metnini</i> Claude'a göndermek.</p>
      <p>• Sayfanın güvenlik politikası (CSP) başka hiçbir adrese bağlantıya izin vermez.</p>
      <p>Modeller: Whisper (OpenAI, MIT), pyannote segmentation 3.0 (MIT), WeSpeaker ResNet34 (Apache-2.0) · transformers.js, ONNX Runtime.</p>
    </div>`;

  $$('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    const handler = () => {
      settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
      if (k === 'threshold') $('#thr-v').textContent = (+el.value).toFixed(2);
      if (k === 'profileThreshold') $('#pthr-v').textContent = (+el.value).toFixed(2);
      saveSettings();
      if (k === 'asrModel') updateCacheStatus();
    };
    el.addEventListener(el.type === 'range' || el.type === 'password' ? 'input' : 'change', handler);
  });

  const gpu = !!navigator.gpu;
  $('#gpu-info').textContent = gpu
    ? 'Bu cihazda WebGPU var ama telefonda kapanmaya yol açabilir; sorun yaşarsanız CPU\'ya dönün.'
    : 'Bu tarayıcıda WebGPU yok; CPU kullanılır.';

  const updateCacheStatus = async () => {
    const st = await modelCacheStatus();
    const el = $('#cache-st');
    if (!el) return;
    el.innerHTML = st.ok
      ? '✅ Seçili modeller indirildi — uygulama internetsiz çalışır.'
      : `Seçili modellerin ${st.missing.length} dosyası henüz indirilmemiş. İlk kayıtta otomatik indirilir; isterseniz şimdi Wi-Fi'deyken indirin.`;
    $('#dl-models').classList.toggle('hidden', st.ok);
    try {
      const est = await navigator.storage.estimate();
      const persisted = await navigator.storage.persisted?.();
      $('#storage-st').textContent = `Kullanılan alan: ${(est.usage / 1e6).toFixed(0)} MB${persisted ? ' · kalıcı depolama açık' : ''}`;
    } catch { /* boş */ }
  };
  updateCacheStatus();

  $('#dl-models').onclick = async () => {
    navigator.storage?.persist?.();
    const prog = $('#dl-prog'); prog.classList.remove('hidden');
    const btn = $('#dl-models'); btn.disabled = true;
    try {
      await downloadModels(settings.asrModel, (p) => {
        const i = $('#dl-prog i');
        if (i) i.style.width = `${p.total ? Math.round(p.loaded / p.total * 100) : 0}%`;
        btn.textContent = `Dosya ${p.file}/${p.files} · ${(p.loaded / 1e6).toFixed(0)}${p.total ? ` / ${(p.total / 1e6).toFixed(0)}` : ''} MB`;
      });
      toast('Modeller indirildi');
    } catch (err) { logEvent('indirme hatası: ' + err.message); toast('İndirme hatası: ' + err.message, 5000); }
    if (route().name === 'settings') renderSettings();
  };

  diagnosticsText().then((t) => { const el = $('#diag'); if (el) el.textContent = t; });
  $('#diag-copy').onclick = async () => {
    const t = await diagnosticsText();
    try { await navigator.clipboard.writeText(t); toast('Rapor panoya kopyalandı'); }
    catch { await shareText('konusma-defteri-tanilama.txt', t); }
  };
  $('#diag-clear').onclick = () => { try { localStorage.removeItem(LOG_KEY); } catch { /* boş */ } renderSettings(); };

  $('#test-key').onclick = async () => {
    if (!hasKey(settings)) { toast('Önce API anahtarını girin.'); return; }
    const btn = $('#test-key'); btn.disabled = true; btn.textContent = 'Deneniyor…';
    try {
      const res = await ask({ ...settings, effort: 'low' }, 'Test kaydı. [00:00] Konuşmacı 1: Merhaba.', [{ role: 'user', content: 'Sadece "Bağlantı tamam" yaz.' }]);
      toast(`✓ ${res.model}: ${res.text.slice(0, 40)}`);
    } catch (err) { toast(explainError(err), 6000); }
    btn.disabled = false; btn.textContent = 'Bağlantıyı test et';
  };

  $('#backup').onclick = async () => {
    const data = { app: 'konusma-defteri', version: 1, exportedAt: new Date().toISOString(), recordings: state.recs, profiles: state.profiles };
    await shareText(`konusma-defteri-yedek-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  };
  $('#restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'konusma-defteri') throw new Error('Bu dosya bir Konuşma Defteri yedeği değil.');
      let n = 0;
      for (const r of data.recordings || []) { if (!findRec(r.id)) { if (r.status !== 'done') r.status = 'done'; await db.put('recordings', r); n++; } }
      for (const p of data.profiles || []) if (!state.profiles.some((x) => x.id === p.id)) await db.put('profiles', p);
      await loadAll();
      toast(`${n} kayıt geri yüklendi`);
    } catch (err) { toast('Yedek okunamadı: ' + err.message, 5000); }
  };
  $('#wipe').onclick = async () => {
    if (!(await confirmBox('Her şey silinsin mi?', 'Tüm kayıtlar, sesler, metinler, özetler ve tanınan kişiler bu cihazdan kalıcı olarak silinecek. İndirilen modeller ve ayarlar kalır.', 'Hepsini sil', true))) return;
    for (const s of ['recordings', 'audio', 'profiles', 'drafts']) await db.clear(s);
    await loadAll();
    toast('Silindi');
    location.hash = '#/';
  };
}

// ====================================================================
// Başlangıç
// ====================================================================
async function init() {
  await loadAll();
  // Uygulama işleme sırasında kapandıysa (iOS sayfayı bellek yüzünden öldürdüyse)
  // yarım kalanları işaretle ve kapanma anındaki aşamayı göster.
  const crumb = readCrumb();
  for (const r of state.recs) {
    if (r.status !== 'processing' && r.status !== 'queued') continue;
    r.status = 'processing';
    if (crumb && crumb.id === r.id) {
      r.crash = crumb;
      r.crashes = (r.crashes || 0) + 1;
      r.error = `Uygulama “${STAGES[crumb.stage] || crumb.stage}” aşamasında${crumb.value ? ` (%${crumb.value})` : ''} kapandı. Model: ${crumb.model}, işlemci: ${crumb.device === 'webgpu' ? 'GPU' : 'CPU'}.`;
      logEvent(`KAPANMA: ${r.error} süre=${crumb.dur}s`);
    } else r.error = 'Uygulama işlem sırasında kapandı.';
    await saveRec(r);
  }
  clearCrumb();

  $('#fab').addEventListener('click', startRecording);
  $('#back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/'; });
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importFile(f); });
  window.addEventListener('hashchange', render);
  render();
  recoverDrafts();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
