// api/chat.js — Neyo AI (Vercel Serverless)
// Tries every known Gemini model until one works with your key
'use strict';

var KEY = process.env.GEMINI_API_KEY;

// ALL known Gemini models across both endpoints, ordered by capability
// The function tries each until one responds — your key will work with at least one
var CANDIDATES = [
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',         sys: true  },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent',  sys: true  },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-001:generateContent',     sys: true  },
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent',             sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-001:generateContent',         sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',               sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent',                   sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent',           sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1/models/gemini-1.0-pro:generateContent',               sys: false },
  { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro-001:generateContent',       sys: false }
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function buildSystem(ctx) {
  var u = (ctx && ctx.userName)       ? String(ctx.userName)      : 'there';
  var r = (ctx && ctx.userRole)       ? String(ctx.userRole)      : 'guest';
  var p = (ctx && ctx.activeProducts) ? ctx.activeProducts        : 0;
  var c = (ctx && ctx.topCategories)  ? String(ctx.topCategories) : 'none yet';
  var v = (ctx && ctx.totalRevenue)   ? String(ctx.totalRevenue)  : '₦0';
  return [
    'You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant',
    'embedded in NeyoMarket, Nigeria\'s premier digital and physical marketplace.',
    '',
    'PERSONALITY: Street-smart and direct. Warm and encouraging. Entrepreneurial mindset.',
    'NEVER open with a menu — answer the actual question first, every single time.',
    'After answering, briefly connect to business only if natural (one sentence max).',
    'Nigerian-friendly tone. Light humour welcome. You are a mentor, not a robot.',
    '',
    'ANSWER ANYTHING — not just marketplace topics. Cooking, relationships, health,',
    'sports, tech, science, business, investing, coding, writing — answer it all.',
    'Rule: answer the question first. Be genuinely useful.',
    '',
    'LIVE CONTEXT: User=' + u + '(' + r + ') Products=' + p + ' Categories=' + c + ' Revenue=' + v,
    '',
    'NEYOMARKET FACTS (cite only when relevant):',
    'Split: 90% seller, 5% affiliate, 5% platform. Paystack escrow. KYC=NIN/BVN.',
    'Min withdrawal ₦2000. Affiliate 5% via ?ref= link. Digital=instant download.',
    'Physical=buyer confirms receipt. Support: +2349072212496 (8am-8pm WAT).',
    '',
    'FORMAT: Bold key terms. Short answer for short question. No bullet menus.',
    'Never say "I can help with X,Y,Z" — just answer. Under 200 words unless needed.'
  ].join('\n');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  if (!KEY) {
    console.error('[chat.js] GEMINI_API_KEY missing. Add it in Vercel → Settings → Environment Variables. Free key: https://aistudio.google.com/app/apikey');
    return res.status(500).json({ error: 'AI not configured. GEMINI_API_KEY missing from Vercel env vars.' });
  }

  var body     = req.body        || {};
  var messages = body.messages   || [];
  var ctx      = body.contextData || {};

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required.' });

  // Build clean contents array (Gemini format)
  var contents = [];
  messages.slice(-20).forEach(function(m) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
    if (!['user','assistant','model'].includes(m.role)) return;
    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  });
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length) return res.status(400).json({ error: 'No valid user messages.' });

  var sysText = buildSystem(ctx);

  // System prepended as conversation pair — works on ALL model versions
  var sysPair = [
    { role: 'user',  parts: [{ text: 'SYSTEM: ' + sysText }] },
    { role: 'model', parts: [{ text: 'Understood. I am Neyo AI — street-smart, direct, helpful. Ready.' }] }
  ];

  var safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
  ];

  var genConfig = { maxOutputTokens: 512, temperature: 0.8, topP: 0.9 };

  // Try every candidate until one works
  for (var i = 0; i < CANDIDATES.length; i++) {
    var cand = CANDIDATES[i];

    // Build payload — with or without system_instruction depending on endpoint support
    var payload;
    if (cand.sys) {
      payload = {
        system_instruction: { parts: [{ text: sysText }] },
        contents: contents,
        generationConfig: genConfig,
        safetySettings: safetySettings
      };
    } else {
      payload = {
        contents: sysPair.concat(contents),
        generationConfig: genConfig,
        safetySettings: safetySettings
      };
    }

    var resp, raw, data;
    try {
      resp = await fetch(cand.url + '?key=' + KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      raw  = await resp.text();
      data = JSON.parse(raw);
    } catch(e) {
      console.warn('[chat.js] Error on ' + cand.url + ':', e.message);
      continue;
    }

    // 404 or "not found" 400 → try next
    if (resp.status === 404 || (resp.status === 400 && raw.includes('not found'))) {
      console.warn('[chat.js] Skip 404:', cand.url.split('/models/')[1]);
      continue;
    }

    // system_instruction not supported → retry same model without it
    if (resp.status === 400 && raw.includes('system_instruction')) {
      console.warn('[chat.js] system_instruction rejected, retrying without it:', cand.url.split('/models/')[1]);
      try {
        resp = await fetch(cand.url + '?key=' + KEY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: sysPair.concat(contents),
            generationConfig: genConfig,
            safetySettings: safetySettings
          })
        });
        raw  = await resp.text();
        data = JSON.parse(raw);
      } catch(e2) { continue; }
    }

    // Rate limit or auth error — stop, don't try more models
    if (resp.status === 429) {
      console.error('[chat.js] Rate limit on:', cand.url.split('/models/')[1]);
      return res.status(429).json({ error: 'AI rate limit reached. Please wait a moment and try again.' });
    }
    if (resp.status === 403) {
      console.error('[chat.js] Auth error — check GEMINI_API_KEY in Vercel.');
      return res.status(403).json({ error: 'Invalid API key. Check GEMINI_API_KEY in Vercel environment variables.' });
    }

    // Other non-ok — try next model
    if (!resp.ok) {
      console.warn('[chat.js] HTTP ' + resp.status + ' on ' + cand.url.split('/models/')[1] + ':', raw.slice(0,120));
      continue;
    }

    // Extract reply
    var cand0  = data.candidates && data.candidates[0];
    var finish = cand0 && cand0.finishReason;
    if (finish === 'SAFETY') {
      return res.status(200).json({ ok: true, reply: "I can't help with that — ask me anything else! 💡" });
    }

    var reply = cand0 && cand0.content && cand0.content.parts && cand0.content.parts[0] && cand0.content.parts[0].text;
    if (!reply) {
      console.warn('[chat.js] No text in response from:', cand.url.split('/models/')[1]);
      continue;
    }

    console.log('[chat.js] Success with:', cand.url.split('/models/')[1]);
    return res.status(200).json({ ok: true, reply: reply.trim(), usage: data.usageMetadata || null });
  }

  console.error('[chat.js] All models failed for key region.');
  return res.status(503).json({ error: 'AI temporarily unavailable. Please try again shortly.' });
};
