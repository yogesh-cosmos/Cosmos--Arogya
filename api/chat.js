// /api/chat.js — Vercel serverless function
// Multi-provider AI proxy with automatic fallback.
// Keys live ONLY here (Vercel env vars) — never sent to the browser.
// Users never see any login, any provider's UI, or any API key.
//
// Fallback order: Groq -> Gemini -> OpenRouter -> no-key emergency fallback
// If one provider is rate-limited, down, or misconfigured, the next is tried.
// Add as many or as few keys as you have in Vercel's Environment Variables:
//   GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
// The app works with just ONE key set. More keys = more resilience under load.
//
// IMPORTANT: AI provider model names change/deprecate over time. If chat
// stops working after previously working, check console.groq.com/docs/deprecations
// (or the equivalent page for whichever provider) and update the model
// strings below — a decommissioned model ID is the most common silent-failure
// cause for this kind of proxy.

export const config = { runtime: 'edge' };

const SYSTEM_FALLBACK = 'You are Arogya AI, a compassionate multilingual medical assistant. Keep replies concise. Never diagnose — always recommend consulting a doctor for anything serious.';

async function tryGroq(messages, imageDataUrl) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('no-key');
  // Groq has no public (non-Enterprise) vision model as of this build —
  // qwen/qwen3-vl-32b-instruct exists but is Enterprise-tier only. For
  // image scans, skip Groq entirely and let Gemini/OpenRouter (which do
  // support vision) handle it instead of sending an image to a text-only
  // model, which would just error.
  if (imageDataUrl) throw new Error('groq-no-vision-support');
  // Verified against console.groq.com/docs/models — qwen/qwen3-32b is Groq's
  // current, real, publicly-available Qwen model. (Previous versions of this
  // file used invented model names like "qwen3.6-27b" that don't exist on
  // Groq at all — always cross-check against Groq's own docs before editing.)
  const model = 'qwen/qwen3-32b';
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 900 })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`groq-${resp.status}: ${t.slice(0,300)}`); }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('groq-empty-response: ' + JSON.stringify(data).slice(0,200));
  return text;
}

async function tryGemini(messages, imageDataUrl) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no-key');
  const sys = messages.find(m => m.role === 'system')?.content || SYSTEM_FALLBACK;
  const userMsgs = messages.filter(m => m.role !== 'system');
  const lastUser = userMsgs[userMsgs.length - 1]?.content || '';

  const parts = [{ text: lastUser }];
  if (imageDataUrl) {
    const match = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: sys }] },
        generationConfig: { temperature: 0.3, maxOutputTokens: 900 }
      })
    }
  );
  if (!resp.ok) { const t = await resp.text(); throw new Error(`gemini-${resp.status}: ${t.slice(0,300)}`); }
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('gemini-empty-response: ' + JSON.stringify(data).slice(0,200));
  return text;
}

async function tryOpenRouter(messages, imageDataUrl) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('no-key');
  const model = imageDataUrl ? 'google/gemini-flash-1.5:free' : 'meta-llama/llama-3.3-70b-instruct:free';
  const finalMessages = imageDataUrl
    ? patchLastUserMessageWithImage(messages, imageDataUrl)
    : messages;
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://cosmos-arogya.vercel.app',
      'X-Title': 'COSMOS Arogya'
    },
    body: JSON.stringify({ model, messages: finalMessages, temperature: 0.3, max_tokens: 900 })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`openrouter-${resp.status}: ${t.slice(0,300)}`); }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('openrouter-empty-response: ' + JSON.stringify(data).slice(0,200));
  return text;
}

// Last-resort, no-signup-required fallback — keeps chat alive even with
// zero keys configured. Low/unpredictable capacity; text-only. This is a
// safety net, not a substitute for configuring a real key above.
async function tryNoKeyFallback(messages, imageDataUrl) {
  if (imageDataUrl) throw new Error('no-vision-support');
  const sys = messages.find(m => m.role === 'system')?.content || SYSTEM_FALLBACK;
  const userMsgs = messages.filter(m => m.role !== 'system');
  const lastUser = userMsgs[userMsgs.length - 1]?.content || '';
  const resp = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: lastUser }],
    })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`fallback-${resp.status}: ${t.slice(0,300)}`); }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('fallback-empty-response');
  return text;
}

function patchLastUserMessageWithImage(messages, imageDataUrl) {
  const out = messages.map(m => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = {
        role: 'user',
        content: [
          { type: 'text', text: out[i].content },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      };
      break;
    }
  }
  return out;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 }); }

  const { messages, image } = body;
  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), { status: 400 });
  }

  const providers = [
    { name: 'groq', fn: tryGroq },
    { name: 'gemini', fn: tryGemini },
    { name: 'openrouter', fn: tryOpenRouter },
    { name: 'fallback', fn: tryNoKeyFallback },
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const text = await provider.fn(messages, image);
      return new Response(JSON.stringify({ text, provider: provider.name }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
      continue;
    }
  }

  // All providers failed — return full diagnostics so the real cause is
  // visible instead of a generic "unavailable" message. Check this in
  // Vercel's function logs (or the browser console, which now prints it too).
  return new Response(JSON.stringify({
    error: 'All AI providers are currently unavailable.',
    details: errors
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}
