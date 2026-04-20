// api/chat.js — Neyo AI serverless function (Vercel)
// Uses Google Gemini API — free tier
// Env var: GEMINI_API_KEY
// Free key: https://aistudio.google.com/app/apikey

'use strict';

var GEMINI_KEY = process.env.GEMINI_API_KEY;

// Models that support system_instruction (v1beta only feature)
// Tried in order — first one that works wins
var MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

var BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ─── CORS ─────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystem(ctx) {
  var userName = (ctx && ctx.userName)       ? String(ctx.userName)      : 'there';
  var userRole = (ctx && ctx.userRole)       ? String(ctx.userRole)      : 'guest';
  var numProds = (ctx && ctx.activeProducts) ? ctx.activeProducts        : 0;
  var topCats  = (ctx && ctx.topCategories)  ? String(ctx.topCategories) : 'none yet';
  var revenue  = (ctx && ctx.totalRevenue)   ? String(ctx.totalRevenue)  : '₦0';

  return [
    'You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant',
    'embedded in NeyoMarket, Nigeria\'s premier digital and physical marketplace.',
    '',
    '## PERSONALITY',
    '- Street-smart and direct: give real answers, not corporate fluff.',
    '- Warm and encouraging: treat every user like a smart friend who deserves straight talk.',
    '- Entrepreneurial mindset: see opportunity everywhere, help people build real income.',
    '- NEVER open with a menu — answer the actual question first, every single time.',
    '- After answering, briefly connect to business only if it feels natural (one sentence max).',
    '- Nigerian-friendly tone. Light humour welcome. You are a mentor, not a robot.',
    '',
    '## ANSWER ANYTHING',
    'You are NOT restricted to marketplace topics. Answer questions on cooking, relationships,',
    'health, sports, tech, science, creativity, business, investing, coding, writing — anything.',
    'One rule: answer the question first. Be genuinely useful.',
    '',
    '## LIVE CONTEXT',
    '- Current user: ' + userName + ' (' + userRole + ')',
    '- Active products: ' + numProds,
    '- Top categories: ' + topCats,
    '- Platform revenue: ' + revenue,
    '',
    '## NEYOMARKET FACTS  (only cite when directly relevant)',
    '- Payment split: 90% seller · 5% affiliate · 5% platform',
    '- All payments via Paystack — 256-bit SSL, escrow-protected',
    '- KYC required (NIN or BVN) before listing products',
    '- Minimum withdrawal: ₦2,000, paid directly to seller\'s bank',
    '- Affiliate commission: 5% per referred sale via ?ref= link',
    '- Digital products: instant download after payment confirmed',
    '- Physical products: buyer confirms receipt before escrow releases',
    '- Zero Scam Guarantee: money held in escrow until buyer confirms',
    '- Support: +2349072212496 (WhatsApp/call, 8am–8pm WAT)',
    '',
    '## FORMAT',
    '- Use **bold** for key terms and figures.',
    '- Match length to question — short question = short answer.',
    '- Never show a bullet menu when someone asks a specific question.',
    '- Never say "I can help with X, Y, Z" — just answer what was asked.',
    '- Stay under 200 words unless depth is genuinely needed.'
  ].join('\n');
}

// ─── INJECT SYSTEM PROMPT AS FIRST USER/MODEL EXCHANGE ────────────────────────
// For models that don't accept system_instruction, we prepend the system
// prompt as a user message + brief model acknowledgement at the start.
function buildContentsWithSystem(messages, systemText) {
  var contents = [];

  // Build from message history
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m || typeof m.content !== 'string' || !m.content.trim()) { continue; }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'model') { continue; }
    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  }

  // Must start with user turn
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  // Prepend system as a user→model pair at the very start
  // This works universally across all Gemini model versions
  var systemPair = [
    {
      role:  'user',
      parts: [{ text: 'SYSTEM INSTRUCTIONS (follow these for the entire conversation):\n\n' + systemText }]
    },
    {
      role:  'model',
      parts: [{ text: 'Understood. I am Neyo AI — street-smart, helpful, and ready. I\'ll answer questions directly without showing menus. What would you like to know?' }]
    }
  ];

  return systemPair.concat(contents);
}

// ─── CALL ONE MODEL ───────────────────────────────────────────────────────────
async function tryModel(modelName, contents, systemText, key) {
  // Build payload — try with system_instruction first (v1beta feature)
  // If we get a 400 "Cannot find field", we fall back to prepended-system approach
  var url     = BASE + modelName + ':generateContent?key=' + key;
  var payload = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: contents,
    generationConfig: { maxOutputTokens: 512, temperature: 0.8, topP: 0.9 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  var resp, raw, data;

  try {
    resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    raw  = await resp.text();
    data = JSON.parse(raw);
  } catch (e) {
    return { skip: true, reason: 'network/parse: ' + e.message };
  }

  // 404 — model not available on this key/region
  if (resp.status === 404) {
    return { skip: true, reason: '404 model not found: ' + modelName };
  }

  // 400 with "Cannot find field" → model doesn't support system_instruction
  // Retry the same model without it, using prepended-system contents instead
  if (resp.status === 400 &&
      raw && raw.includes('Cannot find field')) {
    console.warn('[chat.js] system_instruction not supported by ' + modelName + ', retrying with prepended system');

    var contentsWithSys = buildContentsWithSystem(
      contents.map(function(c) {
        return { role: c.role === 'model' ? 'assistant' : 'user', content: c.parts[0].text };
      }),
      systemText
    );

    var payload2 = {
      contents: contentsWithSys,
      generationConfig: { maxOutputTokens: 512, temperature: 0.8, topP: 0.9 },
      safetySettings: payload.safetySettings
    };

    try {
      resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload2)
      });
      raw  = await resp.text();
      data = JSON.parse(raw);
    } catch (e2) {
      return { skip: true, reason: 'retry network/parse: ' + e2.message };
    }

    if (!resp.ok) {
      return { skip: false, status: resp.status, data: data };
    }
  }

  // 429 or 500 — hard error, stop trying
  if (!resp.ok) {
    return { skip: false, status: resp.status, data: data };
  }

  // Success
  return { skip: false, status: 200, data: data };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // API key guard
  if (!GEMINI_KEY) {
    console.error(
      '[chat.js] GEMINI_API_KEY is missing.\n' +
      '  Fix: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Add: GEMINI_API_KEY = AIza...\n' +
      '  Free key: https://aistudio.google.com/app/apikey'
    );
    return res.status(500).json({
      error: 'AI not configured. GEMINI_API_KEY is missing from Vercel environment variables.'
    });
  }

  // Parse request
  var body        = req.body         || {};
  var messages    = body.messages    || [];
  var contextData = body.contextData || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Build clean contents array
  var contents = [];
  var recent   = messages.slice(-20);

  for (var i = 0; i < recent.length; i++) {
    var m = recent[i];
    if (!m || typeof m.content !== 'string' || !m.content.trim()) { continue; }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'model') { continue; }
    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  }

  // Must start with user
  while (contents.length > 0 && contents[0].role !== 'user') { contents.shift(); }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'No valid user messages found.' });
  }

  var systemText = buildSystem(contextData);
  var lastResult = null;

  // Try each model in order
  for (var mi = 0; mi < MODELS.length; mi++) {
    console.log('[chat.js] Trying model:', MODELS[mi]);
    var result = await tryModel(MODELS[mi], contents, systemText, GEMINI_KEY);

    if (result.skip) {
      console.warn('[chat.js] Skipping:', result.reason);
      continue;
    }

    lastResult = result;

    if (result.status !== 200) {
      // Hard error — report it, don't try more models
      var status  = result.status;
      var errMsg  = (result.data && result.data.error && result.data.error.message) || 'Unknown error';
      console.error('[chat.js] Gemini HTTP ' + status + ':', errMsg);

      var userMsg;
      if      (status === 400) userMsg = 'Request error. Please rephrase and try again.';
      else if (status === 403) userMsg = 'Invalid API key. Check GEMINI_API_KEY in Vercel.';
      else if (status === 429) userMsg = 'AI rate limit reached. Please wait a moment and try again.';
      else if (status === 500) userMsg = 'Gemini server error. Try again in a few seconds.';
      else                     userMsg = 'AI service error (' + status + '). Please try again.';

      return res.status(status).json({ error: userMsg });
    }

    // Extract reply
    var data      = result.data;
    var candidate = data.candidates && data.candidates[0];

    if (candidate && candidate.finishReason === 'SAFETY') {
      return res.status(200).json({
        ok:    true,
        reply: "I can't help with that specific request — ask me anything else! 💡"
      });
    }

    var replyText = candidate &&
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts[0] &&
      candidate.content.parts[0].text;

    if (!replyText) {
      console.warn('[chat.js] No text in response, trying next model. Data:', JSON.stringify(data).slice(0, 200));
      continue;
    }

    // Success
    console.log('[chat.js] Got reply from:', MODELS[mi]);
    return res.status(200).json({
      ok:    true,
      reply: replyText.trim(),
      model: MODELS[mi],
      usage: data.usageMetadata || null
    });
  }

  // All models failed
  console.error('[chat.js] All models exhausted. Last result:', JSON.stringify(lastResult).slice(0, 200));
  return res.status(503).json({
    error: 'AI is temporarily unavailable. Please try again in a moment.'
  });
};
