// Claude API bağlantısı — yalnızca kullanıcı düğmeye bastığında çağrılır.
// Gönderilen tek şey konuşmanın METNİDİR; ses dosyası asla gönderilmez.
// API anahtarı yalnızca bu cihazda (localStorage) tutulur ve doğrudan
// api.anthropic.com'a gider; arada başka bir sunucu yoktur.

import { Anthropic } from '../vendor/anthropic.min.mjs';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (önerilen)', inPrice: 4, outPrice: 20 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (daha hızlı/ucuz)', inPrice: 2, outPrice: 10 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (en ucuz)', inPrice: 0.1, outPrice: 0.5 },
];

const SYSTEM_BASE = `Sen kullanıcının kişisel konuşma asistanısın. Kullanıcı, telefonunda kaydettiği konuşmaların cihaz üzerinde otomatik olarak metne dökülmüş hâllerini sana veriyor.

Metin hakkında bilmen gerekenler:
- Konuşma → metin dönüşümü cihazda küçük bir Whisper modeliyle yapıldı; özellikle özel isimlerde, sayılarda ve yabancı kelimelerde hatalar olabilir. Bağlamdan anlamı çıkar; emin olmadığın yerlerde bunu belirt.
- Konuşmacı etiketleri ses izine göre otomatik atandı; nadiren yanlış kişiye atanmış cümleler olabilir.
- Her satır "[dakika:saniye] Konuşmacı: metin" biçimindedir.

Kurallar:
- Türkçe yanıt ver (kullanıcı başka bir dil kullanırsa o dilde).
- Yalnızca metinde gerçekten geçenlere dayan; metinde olmayan bilgiyi uydurma. Bir şey metinde yoksa açıkça "kayıtta geçmiyor" de.
- Bir bilgiyi aktarırken mümkünse kimin söylediğini ve yaklaşık zamanını [dk:sn] belirt.
- Yanıtlarını sade Markdown ile yaz (başlık, madde işareti, kalın). Tablo kullanma.`;

export const SUMMARY_PROMPT = `Bu konuşmanın özetini çıkar. Şu bölümleri kullan (boş kalacak bölümü atla):

## Kısa özet
2–4 cümle.

## Ana konular
Madde madde; her maddede kimin hangi görüşü savunduğunu belirt.

## Alınan kararlar

## Yapılacaklar
"Kim – ne – ne zaman" biçiminde (metinde geçtiği kadarıyla).

## Rakamlar, tarihler ve isimler
Konuşmada geçen önemli bilgiler (metin hatası şüphesi varsa belirt).

## Açık kalan konular ve takip soruları
Konuşmada yanıtsız kalan noktalar ve kullanıcının netleştirmek isteyebileceği 3–5 soru.`;

export function hasKey(settings) {
  return !!(settings.apiKey && settings.apiKey.trim().length > 20);
}

function client(settings) {
  return new Anthropic({
    apiKey: settings.apiKey.trim(),
    // Uygulamanın sunucusu yok; anahtar kullanıcının kendi cihazında kalır.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/** Konuşma(lar)ı Claude'a verilecek metin hâline getir. */
export function transcriptText(rec, speakerName) {
  const lines = [];
  lines.push(`# ${rec.title}`);
  lines.push(`Tarih: ${new Date(rec.createdAt).toLocaleString('tr-TR')} · Süre: ${fmtTime(rec.duration)}`);
  const names = (rec.speakers || []).map((s, i) => speakerName(rec, i));
  if (names.length) lines.push(`Konuşmacılar: ${names.join(', ')}`);
  lines.push('');
  for (const t of rec.turns || []) lines.push(`[${fmtTime(t.start)}] ${speakerName(rec, t.spk)}: ${t.text}`);
  return lines.join('\n');
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Akışlı (streaming) istek. Konuşma metni sistem isteminde önbelleğe alınır
 * (prompt caching) — aynı konuşmaya sorulan sonraki sorular çok daha ucuzdur.
 * @param {object} settings  { apiKey, claudeModel, effort }
 * @param {string} context   konuşma metni (bir veya birden çok kayıt)
 * @param {{role:'user'|'assistant', content:string}[]} messages
 * @param {{onText:(full:string)=>void, signal?:AbortSignal}} cb
 */
export async function ask(settings, context, messages, { onText, signal } = {}) {
  const model = settings.claudeModel || 'claude-opus-5-5';
  const params = {
    model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort || 'medium' },
    system: [
      { type: 'text', text: SYSTEM_BASE },
      { type: 'text', text: `<konusma_metni>\n${context}\n</konusma_metni>`, cache_control: { type: 'ephemeral' } },
    ],
    messages,
  };
  // Güvenlik sınıflandırıcısı bir isteği yanlışlıkla reddederse sunucu aynı isteği
  // uygun bir yedek modelle tekrar dener (server-side fallback). Haiku'da desteklenmez.
  const useFallback = model !== 'claude-haiku-5-5';
  const c = client(settings);
  const stream = useFallback
    ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
    : c.messages.stream(params, { signal });

  let text = '';
  stream.on('text', (delta) => { text += delta; onText?.(text); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('Claude bu isteği yanıtlamayı reddetti' + (msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : '.'));
  }
  const finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = CLAUDE_MODELS.find((x) => x.id === model) || CLAUDE_MODELS[0];
  const u = msg.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  const cost = (inTok * m.inPrice + (u.output_tokens || 0) * m.outPrice) / 1e6;
  return {
    text: finalText || text,
    model: msg.model || model,
    stopReason: msg.stop_reason,
    usage: {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
      costUsd: cost,
    },
  };
}

// ---------------------------------------------------------------------------
// Metin düzeltme: cihazdaki küçük modelin ses benzerliği hatalarını bağlamdan düzeltir.
// Yalnızca kullanıcı "Metni düzelt"e basınca çalışır ve yalnızca METİN gönderir.
// ---------------------------------------------------------------------------
const CORRECT_SYSTEM = `Sen Türkçe konuşma dökümlerini düzelten bir redaktörsün. Sana verilen metin, telefonda küçük bir Whisper modeliyle konuşmadan otomatik olarak çıkarıldı. Bu model sık sık sesçe benzeyen ama yanlış kelimeler yazar (ör. "kotumu" yerine "kutumu", "giyince" yerine "gidince"), ekleri yanlış duyar ("televizyonu açtım" yerine "televizyona açtım") ve kişi eklerini karıştırır ("neden yapmadın" yerine "neden yapmadım").

Görevin YALNIZCA bu tür tanıma hatalarını düzeltmek:
- Bağlama göre büyük olasılıkla yanlış duyulmuş kelimeleri ve ekleri düzelt; bariz yazım, büyük harf ve noktalama hatalarını düzelt.
- Konuşmanın kendisini KORU: üslup, kelime seçimi, konuşma dili, argo, tekrarlar, dolgu sözcükleri ("yani", "şey"), devrik cümleler ve dil bilgisi hataları — konuşan kişi gerçekten öyle söylemiş olabilir — olduğu gibi kalsın. Yeniden yazma, kısaltma, sansürleme, içerik ekleme.
- Emin olmadığın yerde dokunma. Özel isim ve sayıları yalnızca bağlam açıkça gösteriyorsa düzelt.
- Satırları birleştirme veya bölme; konuşmacıları değiştirme.

Yalnızca DEĞİŞTİRDİĞİN satırları döndür: satır numarası (i) ve o satırın düzeltilmiş TAM metni (konuşmacı adı olmadan). Değişiklik gerekmiyorsa boş liste döndür.`;

const CORRECT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, text: { type: 'string' } },
        required: ['i', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

/**
 * @returns {Promise<{changes:{i:number, old:string, text:string}[], model:string, usage:object}>}
 */
export async function correctTranscript(settings, rec, speakerName, { signal, onProgress } = {}) {
  const model = settings.claudeModel || 'claude-opus-5-5';
  const turns = rec.turns || [];
  const body = turns.map((t, i) => `[${i}] ${speakerName(rec, t.spk)}: ${t.text}`).join('\n');
  const params = {
    model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort || 'medium', format: { type: 'json_schema', schema: CORRECT_SCHEMA } },
    system: CORRECT_SYSTEM,
    messages: [{ role: 'user', content: `Konuşma: ${rec.title}\n\n<dokum>\n${body}\n</dokum>` }],
  };
  const useFallback = model !== 'claude-haiku-5-5';
  const c = client(settings);
  const stream = useFallback
    ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
    : c.messages.stream(params, { signal });
  let chars = 0;
  stream.on('text', (d) => { chars += d.length; onProgress?.(chars); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude bu isteği yanıtlamayı reddetti.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Metin çok uzun; düzeltme yarıda kaldı.');
  const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Claude\'un yanıtı okunamadı.'); }
  const seen = new Set();
  const changes = [];
  for (const l of parsed.lines || []) {
    const i = l.i;
    if (!Number.isInteger(i) || i < 0 || i >= turns.length || seen.has(i)) continue;
    const text = String(l.text || '').replace(/^\s*\[\d+\]\s*/, '').trim();
    if (!text || text === turns[i].text.trim()) continue;
    seen.add(i);
    changes.push({ i, old: turns[i].text, text });
  }
  changes.sort((a, b) => a.i - b.i);
  const m = CLAUDE_MODELS.find((x) => x.id === model) || CLAUDE_MODELS[0];
  const u = msg.usage || {};
  const cost = (((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * m.inPrice + (u.output_tokens || 0) * m.outPrice) / 1e6;
  return {
    changes,
    model: msg.model || model,
    usage: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, costUsd: cost },
  };
}

/** API hatalarını kullanıcıya anlaşılır Türkçe mesaja çevir. */
export function explainError(err) {
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return 'İstek iptal edildi.';
  if (err instanceof Anthropic.AuthenticationError) return 'API anahtarı geçersiz. Ayarlar\'dan kontrol edin.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Bu API anahtarının bu modele erişim izni yok.';
  if (err instanceof Anthropic.RateLimitError) return 'Hız sınırına takıldı; biraz bekleyip tekrar deneyin.';
  if (err instanceof Anthropic.BadRequestError) return `İstek reddedildi: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'Claude sunucusunda geçici bir sorun var; tekrar deneyin.';
  if (err instanceof Anthropic.APIConnectionError || !navigator.onLine) return 'İnternet bağlantısı yok. Özet ve soru-cevap için internet gerekir (ses işleme çevrimdışı çalışır).';
  return String(err?.message || err);
}
