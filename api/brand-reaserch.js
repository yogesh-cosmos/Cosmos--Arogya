// /api/brand-research.js — Vercel serverless function
// Produces a RANKED comparison of the scanned medicine's brand against
// 3-5 alternative brands with the same active ingredient.
//
// Uses GROQ_API_KEY (the same key your main chat already uses) — no second
// key needed. Groq's free tier (30 RPM, 1,000/day per model) has more
// headroom than Gemini's free tier (~15 RPM, frequent 503s at peak times),
// which matters for a feature that fires on every scan.
//
// WHAT "RANKING" MEANS HERE — please read before changing this file:
// There is no official, objective, universally-agreed "top 20 pharma
// brands" list anywhere. A ranking claiming to cover the whole market
// would necessarily be the model inventing numbers that look authoritative
// but aren't — genuinely risky in a health context.
//
// What IS honestly buildable: a RELATIVE ranking among the small, specific
// set of brands actually relevant to this scan (the scanned brand + its
// alternatives), scored on criteria an AI can reasonably assess from
// general pharmaceutical knowledge:
//   - manufacturer scale/reputation (large multinational vs regional vs
//     unknown/unverifiable)
//   - how long the brand has been established, if known
//   - regulatory standing (any well-known, confident-only recall/warning
//     history — never invented)
//   - manufacturing transparency (is the manufacturer clearly identifiable)
//
// This produces a real #1-#5 ordering on screen, scoped honestly to "among
// these specific brands" rather than falsely implying market-wide coverage.
// The model is explicitly instructed to say when it doesn't have enough
// confident information to differentiate brands, rather than inventing
// small differences to force a clean ranking.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({
      error: 'Brand ranking requires GROQ_API_KEY to be set in Vercel.'
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

Task: produce a RANKED comparison of this brand against 3-5 OTHER real, commonly available brands containing the SAME active ingredient.

Scoring criteria (score each brand 1-10 on each, based on general pharmaceutical knowledge — be honest and conservative, do not invent precision you don't have):
- manufacturerScale: is the manufacturer a large, well-known multinational (score higher) vs regional/smaller (score lower) vs unknown/unverifiable (score lowest)
- trackRecord: how long-established and consistently available the brand is, if known
- regulatoryStanding: 10 if no known issues, lower ONLY if you are confident about a real, well-known historical recall or warning — never invent one to justify a lower score
- transparency: is the manufacturer clearly identifiable and disclosed

Compute overallScore as the average of the four, rounded to 1 decimal. Then RANK all brands (including "${medicineName}" itself) from highest overallScore to lowest. If you genuinely cannot differentiate two brands with confidence, give them the same score rather than inventing a tiebreaker.

Respond with ONLY this JSON (no markdown fences):
{
  "scannedBrand": "${medicineName}",
  "activeIngredient": "the active ingredient name",
  "ranking": [
    {
      "rank": 1,
      "brand": "brand name",
      "isScannedBrand": true or false,
      "manufacturer": "name or null if not confidently known",
      "manufacturerCountry": "country or null",
      "scores": {"manufacturerScale": 0, "trackRecord": 0, "regulatoryStanding": 0, "transparency": 0},
      "overallScore": 0.0,
      "note": "1 short sentence on why it's ranked here, in ${langName}"
    }
  ],
  "scannedBrandSummary": "1-2 sentences specifically about where the scanned brand landed and why, in ${langName}. If it's rank 1-2, say something like 'this is a strong choice'. If lower, briefly say why and that alternatives above it may be worth asking a pharmacist about — without being alarmist.",
  "confidenceNote": "1 sentence, in ${langName}, being honest about how confident this ranking is — e.g. if some brands are lesser-known ones you have limited information on, say so",
  "disclaimer": "1 sentence, in ${langName}, noting this is general knowledge (not live market data or an official ranking), scoped only to these specific brands, and to confirm with a pharmacist before switching anything"
}

List 4-6 brands total in the ranking array (the scanned brand plus 3-5 real alternatives). Respond in ${langName} for all text fields. If you don't recognize the scanned brand at all, still produce alternatives you do know, mark the scanned brand's manufacturer as null, and say so honestly in scannedBrandSummary.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'qwen/qwen3-32b',
        messages: [
          { role: 'system', content: 'You are a careful medical information assistant producing a relative comparison among a small set of specific brands. You never invent specific facts (recalls, manufacturer names, false precision) you are not confident about — you say so honestly and score conservatively instead. You never claim to represent the whole market, only the specific brands listed.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 1400
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

    if (!parsed || !Array.isArray(parsed.ranking)) {
      return new Response(JSON.stringify({ error: 'Could not parse ranking results', raw: text.slice(0,500) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Defensive sort — trust the model's rank field, but also guarantee
    // consistent ordering by overallScore in case rank numbers are off
    parsed.ranking.sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
    parsed.ranking.forEach((r, i) => { r.rank = i + 1; });

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Brand ranking failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
