// api/chat.js — Neyo AI serverless function (Vercel)
// Model: gemini-1.5-flash on stable v1 endpoint
// Env var: GEMINI_API_KEY
// Free key: https://aistudio.google.com/app/apikey

'use strict';

var GEMINI_KEY = process.env.GEMINI_API_KEY;

// v1 is the stable endpoint, available in all regions including Nigeria
// v1beta has restricted model access depending on key region
var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent';

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
      '  Fix: Vercel Dashboard → Project → Settings → Environment Variables\n' +
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

  // Build contents array — Gemini uses role "user"/"model", text in parts[{text}]
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

  // Must start with user turn
  while (contents.length > 0 && contents[0].role !== 'user') { contents.shift(); }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'No valid user messages found.' });
  }

  // On v1, system_instruction is NOT supported — inject as first user/model pair instead
  var systemText = buildSystem(contextData);
  var fullContents = [
    {
      role:  'user',
      parts: [{ text: 'SYSTEM INSTRUCTIONS — follow these for the entire conversation:\n\n' + systemText }]
    },
    {
      role:  'model',
      parts: [{ text: 'Understood. I am Neyo AI — street-smart, direct, and helpful. I will answer every question fully before mentioning NeyoMarket. Ready.' }]
    }
  ].concat(contents);

  var payload = {
    contents: fullContents,
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

  // Call Gemini
  var geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL + '?key=' + GEMINI_KEY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
  } catch (netErr) {
    console.error('[chat.js] Network error:', netErr.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }

  // Read response
  var rawText;
  try {
    rawText = await geminiRes.text();
  } catch (readErr) {
    console.error('[chat.js] Read error:', readErr.message);
    return res.status(502).json({ error: 'Failed to read AI response. Please try again.' });
  }

  if (!rawText || rawText.trim() === '') {
    console.error('[chat.js] Empty response. Status:', geminiRes.status);
    return res.status(502).json({ error: 'AI returned empty response. Please try again.' });
  }

  var data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('[chat.js] Parse error. Raw:', rawText.slice(0, 200));
    return res.status(502).json({ error: 'Unexpected response from AI. Please try again.' });
  }

  // Handle Gemini errors
  if (!geminiRes.ok) {
    var status = geminiRes.status;
    var errMsg = (data.error && data.error.message) || 'Unknown error';
    console.error('[chat.js] Gemini HTTP ' + status + ':', errMsg);

    var userMsg;
    if      (status === 400) userMsg = 'Request error. Please rephrase and try again.';
    else if (status === 403) userMsg = 'Invalid API key. Check GEMINI_API_KEY in Vercel.';
    else if (status === 404) userMsg = 'AI model not found. Contact support.';
    else if (status === 429) userMsg = 'AI rate limit reached. Please wait a moment and try again.';
    else if (status === 500) userMsg = 'Gemini server error. Try again in a few seconds.';
    else                     userMsg = 'AI error (' + status + '). Please try again.';

    return res.status(status).json({ error: userMsg });
  }

  // Extract reply
  var candidate    = data.candidates && data.candidates[0];
  var finishReason = candidate && candidate.finishReason;

  if (finishReason === 'SAFETY') {
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
    console.error('[chat.js] No reply text. Response:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned unexpected format. Please try again.' });
  }

  return res.status(200).json({
    ok:    true,
    reply: replyText.trim(),
    usage: data.usageMetadata || null
  });
};
