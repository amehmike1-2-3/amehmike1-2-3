// api/chat.js — Neyo AI serverless function (Vercel)
// Model  : Google Gemini 2.0 Flash (free tier, latest stable)
// Env var: GEMINI_API_KEY
// Free key: https://aistudio.google.com/app/apikey

'use strict';

var GEMINI_KEY = process.env.GEMINI_API_KEY;

// Ordered list of models to try — if the first 404s, the next is attempted automatically
var GEMINI_MODELS = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent'
];

// ─── CORS ─────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystem(ctx) {
  var userName = (ctx && ctx.userName)       ? String(ctx.userName)       : 'there';
  var userRole = (ctx && ctx.userRole)       ? String(ctx.userRole)       : 'guest';
  var numProds = (ctx && ctx.activeProducts) ? ctx.activeProducts         : 0;
  var topCats  = (ctx && ctx.topCategories)  ? String(ctx.topCategories)  : 'none yet';
  var revenue  = (ctx && ctx.totalRevenue)   ? String(ctx.totalRevenue)   : '₦0';

  return [
    'You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant',
    'embedded in NeyoMarket, Nigeria\'s premier digital and physical marketplace.',
    '',
    '## PERSONALITY',
    '- Street-smart and direct: give real answers, not corporate fluff.',
    '- Warm and encouraging: treat every user like a smart friend who deserves straight talk.',
    '- Entrepreneurial mindset: see opportunity everywhere, help people build real income.',
    '- NEVER open with a menu of what you can do — answer the actual question first, every time.',
    '- After answering, briefly connect to business only if it feels natural (one sentence max).',
    '- Nigerian-friendly tone. Light humour welcome.',
    '- You are a knowledgeable mentor and partner, NOT a robot.',
    '',
    '## ANSWER ANYTHING',
    'You are NOT restricted to marketplace topics.',
    'Answer questions on cooking, relationships, health, sports, tech, science,',
    'creativity, business, investing, coding, writing — anything at all.',
    'One rule: answer the question first. Be genuinely useful.',
    '',
    '## LIVE MARKETPLACE CONTEXT',
    '- Current user: ' + userName + ' (' + userRole + ')',
    '- Active products: ' + numProds,
    '- Top categories: ' + topCats,
    '- Platform revenue: ' + revenue,
    '',
    '## NEYOMARKET FACTS  (cite only when directly relevant)',
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
    '## RESPONSE FORMAT',
    '- Use **bold** for key terms and figures.',
    '- Match length to question: short question = short answer.',
    '- Never show a bullet-point menu when someone asks a specific question.',
    '- Never say "I can help you with X, Y, Z" — just answer what was asked.',
    '- Stay under 200 words unless depth is genuinely needed.'
  ].join('\n');
}

// ─── CALL GEMINI — tries each model URL until one works ───────────────────────
async function callGemini(payload, key) {
  var lastError = null;

  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var url = GEMINI_MODELS[i] + '?key=' + key;

    var response;
    try {
      response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
    } catch (netErr) {
      lastError = 'Network error: ' + netErr.message;
      continue; // try next model
    }

    var rawText;
    try {
      rawText = await response.text();
    } catch (readErr) {
      lastError = 'Read error: ' + readErr.message;
      continue;
    }

    if (!rawText || rawText.trim() === '') {
      lastError = 'Empty response from ' + GEMINI_MODELS[i];
      continue;
    }

    var data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      lastError = 'Parse error for ' + GEMINI_MODELS[i] + ': ' + rawText.slice(0, 100);
      continue;
    }

    // 404 or 400 model-not-found → try next model
    if (response.status === 404 ||
        (response.status === 400 && rawText.includes('not found'))) {
      console.warn('[chat.js] Model not found, trying next:', GEMINI_MODELS[i]);
      lastError = 'Model not found: ' + GEMINI_MODELS[i];
      continue;
    }

    // Any other error (403, 429, 500) — return immediately, don't try more models
    if (!response.ok) {
      return { ok: false, status: response.status, data: data };
    }

    // Success
    console.log('[chat.js] Model responded OK:', GEMINI_MODELS[i]);
    return { ok: true, status: 200, data: data };
  }

  // All models failed
  return { ok: false, status: 503, data: { error: { message: lastError || 'All Gemini models unavailable.' } } };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // API key guard
  if (!GEMINI_KEY) {
    console.error(
      '[chat.js] GEMINI_API_KEY is missing.\n' +
      '  Fix: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Add: GEMINI_API_KEY = AIza...\n' +
      '  Get a free key at https://aistudio.google.com/app/apikey'
    );
    return res.status(500).json({
      error: 'AI service not configured. GEMINI_API_KEY is missing from Vercel environment variables.'
    });
  }

  // Parse body
  var body        = req.body         || {};
  var messages    = body.messages    || [];
  var contextData = body.contextData || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Build Gemini contents array
  // Spec: role must be "user" or "model"; text in parts[{text}]
  var contents = [];
  var recent   = messages.slice(-20);

  for (var i = 0; i < recent.length; i++) {
    var m = recent[i];
    if (!m || typeof m.content !== 'string' || m.content.trim() === '') { continue; }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'model') { continue; }

    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'No valid messages found.' });
  }

  // Gemini requires conversation to start with a user turn
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'First message must be from the user.' });
  }

  // Build payload — spec-compliant for both v1 and v1beta
  var payload = {
    system_instruction: {
      parts: [{ text: buildSystem(contextData) }]
    },
    contents: contents,
    generationConfig: {
      maxOutputTokens: 512,
      temperature:     0.8,
      topP:            0.9
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  // Call Gemini with automatic model fallback
  var result = await callGemini(payload, GEMINI_KEY);

  // Handle errors
  if (!result.ok) {
    var status  = result.status;
    var errMsg  = (result.data && result.data.error && result.data.error.message) || 'Unknown error';
    console.error('[chat.js] Gemini HTTP ' + status + ':', errMsg);

    var userMsg;
    if      (status === 400) userMsg = 'Bad request to AI. Please rephrase and try again.';
    else if (status === 403) userMsg = 'Invalid API key. Check GEMINI_API_KEY in Vercel.';
    else if (status === 429) userMsg = 'AI rate limit hit. Wait a moment and try again.';
    else if (status === 500) userMsg = 'Gemini server error. Try again in a few seconds.';
    else if (status === 503) userMsg = 'AI unavailable right now. Please try again shortly.';
    else                     userMsg = 'AI service error (' + status + '). Please try again.';

    return res.status(status > 299 ? status : 502).json({ error: userMsg });
  }

  var data = result.data;

  // Safety block
  var candidate    = data.candidates && data.candidates[0];
  var finishReason = candidate && candidate.finishReason;

  if (finishReason === 'SAFETY') {
    return res.status(200).json({
      ok:    true,
      reply: "I can't help with that specific request — ask me anything else! Business tips, marketplace help, or whatever's on your mind. 💡"
    });
  }

  // Extract reply text
  var replyText = candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts[0] &&
    candidate.content.parts[0].text;

  if (!replyText) {
    console.error('[chat.js] No reply text. Data:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
  }

  return res.status(200).json({
    ok:    true,
    reply: replyText.trim(),
    usage: data.usageMetadata || null
  });
};
