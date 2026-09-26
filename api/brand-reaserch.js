// /api/brand-research.js — Vercel serverless function
// Looks up information about a medicine brand and its manufacturer, plus
// alternative brands with the same active ingredient.
//
// Uses GROQ_API_KEY (the same key your main chat already uses) — no second
// key needed. This deliberately does NOT use Gemini's Google Search
// grounding: Gemini's free tier is only ~15 requests/minute and hits 503
// overload errors often at peak times, which would make this feature
// unreliable and could drag down your main chat if it shared a key/quota.
// Groq's free tier (30 RPM, 1,000/day per model) is meaningfully more
// headroom for a feature used this often.
//
// IMPORTANT — what this does and doesn't do:
// This draws on the model's training knowledge of manufacturers, brand
// reputations, and known recalls up to its training cutoff. It is NOT live
// search and can't see this week's news. It does NOT produce a numbered
// "top 20 brands" ranking — no such official, objective, universally-agreed
// ranking exists, and inventing one as fact would be misleading in a health
// context. The response is explicit that this is general knowledge, not a
// live lookup, and always points the user to verify anything important
// (especially recalls) with their pharmacist.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({
      error: 'Brand research requires GROQ_API_KEY to be set in Vercel.'
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 }); }

  const { medicineName, activeIngredient, lang } = body;
  if (!medicineName) {
    return new Response(JSON.stringify({ error: 'medicineName required' }), { status: 400 });
  }

  const langName = { en:'English', ta:'Tamil', hi:'Hindi', te:'Telugu', ml:'Malayalam' }[lang] || 'English';

  const prompt = `The user scanned a medicine branded "${medicineName}"${activeIngredient ? ` (active ingredient: ${activeIngredient})` : ''}.

Based on your general knowledge of pharmaceutical manufacturers and brands (not live search — be honest that this is general knowledge, not today's news):
1. Identify the likely manufacturer and their country, if you recognize this brand
2. General manufacturer reputation — established/well-regarded, or any WELL-KNOWN historical concerns (only mention concerns you're genuinely confident about — do not invent or guess at recalls)
3. 2-4 OTHER commonly available brands that contain the SAME active ingredient, which the user could ask their pharmacist about as alternatives
4. An honest standing assessment: "well_established", "typical", or "limited_information" (use limited_information if you don't confidently recognize this specific brand)

Respond with ONLY this JSON (no markdown fences):
{
  "brand": "${medicineName}",
  "manufacturer": "name or null if not confidently known",
  "manufacturerCountry": "country or null",
  "standing": "well_established|typical|limited_information",
  "standingReason": "1-2 sentences explaining the assessment, in ${langName}",
  "recallNotices": "only a WELL-KNOWN historical issue if you're confident, else null — never invent one",
  "alternativeBrands": [
    {"name": "brand name", "activeIngredient": "same ingredient name", "note": "brief note, in ${langName}"}
  ],
  "disclaimer": "a sentence noting this is general knowledge, not live search, and to verify with a pharmacist, in ${langName}"
}

Respond in ${langName} for all text fields. If you don't recognize this specific brand with confidence, say so honestly in standingReason rather than guessing.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          { role: 'system', content: 'You are a careful medical information assistant. You never invent specific facts (recalls, manufacturer names) you are not confident about — you say so honestly instead.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 900
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return new Response(JSON.stringify({ error: `Groq request failed (${resp.status})`, details: t.slice(0,300) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';

    let parsed;
    try { parsed = JSON.parse(text.replace(/```json/gi,'').replace(/```/g,'').trim()); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    if (!parsed) {
      return new Response(JSON.stringify({ error: 'Could not parse research results', raw: text.slice(0,500) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Brand research failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
