// api/chat.js — Neyo AI serverless function (Vercel)
// Model  : Google Gemini 1.5 Flash (free tier)
// Env var: GEMINI_API_KEY  ← add in Vercel → Project → Settings → Env Vars
// Free key: https://aistudio.google.com/app/apikey

'use strict';

var GEMINI_KEY = process.env.GEMINI_API_KEY;
var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// ─── CORS ────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
function buildSystem(ctx) {
  var userName = (ctx && ctx.userName)       ? ctx.userName       : 'there';
  var userRole = (ctx && ctx.userRole)       ? ctx.userRole       : 'guest';
  var numProds = (ctx && ctx.activeProducts) ? ctx.activeProducts : 0;
  var topCats  = (ctx && ctx.topCategories)  ? ctx.topCategories  : 'none yet';
  var revenue  = (ctx && ctx.totalRevenue)   ? ctx.totalRevenue   : '₦0';

  var lines = [
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
    '- Payment split: 90 % seller · 5 % affiliate · 5 % platform',
    '- All payments via Paystack — 256-bit SSL, escrow-protected',
    '- KYC required (NIN or BVN) before listing products',
    '- Minimum withdrawal: ₦2,000, paid directly to seller\'s bank',
    '- Affiliate commission: 5 % per referred sale via ?ref= link',
    '- Digital products: instant download after payment confirmed',
    '- Physical products: buyer confirms receipt before escrow releases',
    '- Zero Scam Guarantee: money held in escrow until buyer confirms',
    '- Support: +2349072212496 (WhatsApp / call, 8 am–8 pm WAT)',
    '',
    '## RESPONSE FORMAT',
    '- Use **bold** for key terms and figures.',
    '- Match length to question: short question = short answer.',
    '- Never show a bullet-point menu when someone asks a specific question.',
    '- Never say "I can help you with X, Y, Z" — just answer what was asked.',
    '- Stay under 200 words unless depth is genuinely needed.'
  ];

  return lines.join('\n');
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // API-key guard — loud error so you know exactly what to fix
  if (!GEMINI_KEY) {
    console.error(
      '[chat.js] GEMINI_API_KEY is missing.\n' +
      '  Go to: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Add  : GEMINI_API_KEY = AIza...\n' +
      '  Free key at https://aistudio.google.com/app/apikey'
    );
    return res.status(500).json({
      error: 'AI service not configured. GEMINI_API_KEY is missing from Vercel environment variables.'
    });
  }

  // Parse body
  var body        = req.body        || {};
  var messages    = body.messages   || [];
  var contextData = body.contextData || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Convert to Gemini format
  // Gemini uses role "user" / "model" (not "assistant")
  // Text must be in parts: [{ text: "..." }]
  var contents = [];
  var slice = messages.slice(-20); // max 20 turns to control cost

  for (var i = 0; i < slice.length; i++) {
    var m = slice[i];
    if (!m || typeof m.content !== 'string' || m.content.trim() === '') continue;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'model') continue;

    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'No valid messages found.' });
  }

  // Gemini requires the conversation to start with a user turn
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'First message must be from the user.' });
  }

  // Build Gemini payload
  var payload = {
    system_instruction: {
      parts: [{ text: buildSystem(contextData) }]
    },
    contents: contents,
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.8,
      topP: 0.9
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
    console.error('[chat.js] Network error reaching Gemini:', netErr.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }

  // Read body as text first (safe for any content)
  var rawText;
  try {
    rawText = await geminiRes.text();
  } catch (readErr) {
    console.error('[chat.js] Failed to read Gemini body:', readErr.message);
    return res.status(502).json({ error: 'Failed to read AI response. Please try again.' });
  }

  if (!rawText || rawText.trim() === '') {
    console.error('[chat.js] Gemini returned empty body. Status:', geminiRes.status);
    return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
  }

  // Parse JSON
  var data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('[chat.js] JSON parse failed. Raw:', rawText.slice(0, 300));
    return res.status(502).json({ error: 'Unexpected response format from AI. Please try again.' });
  }

  // Handle HTTP errors from Gemini
  if (!geminiRes.ok) {
    var status  = geminiRes.status;
    var errMsg  = (data.error && data.error.message) || 'Unknown error';
    console.error('[chat.js] Gemini HTTP ' + status + ':', errMsg);

    var userMsg;
    if      (status === 400) userMsg = 'Bad request to AI. Please rephrase and try again.';
    else if (status === 403) userMsg = 'Invalid API key. Check GEMINI_API_KEY in Vercel.';
    else if (status === 429) userMsg = 'AI rate limit hit. Wait a moment and try again.';
    else if (status === 500) userMsg = 'Gemini server error. Try again in a few seconds.';
    else                     userMsg = 'AI service error (' + status + '). Please try again.';

    return res.status(status).json({ error: userMsg });
  }

  // Extract reply text
  var candidate    = data.candidates && data.candidates[0];
  var finishReason = candidate && candidate.finishReason;

  // Safety block
  if (finishReason === 'SAFETY') {
    return res.status(200).json({
      ok:    true,
      reply: "I can't help with that specific request, but ask me anything else — business tips, marketplace help, or anything on your mind! 💡"
    });
  }

  var replyText = candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts[0] &&
    candidate.content.parts[0].text;

  if (!replyText) {
    console.error('[chat.js] No reply text found. Data:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
  }

  // Success
  return res.status(200).json({
    ok:    true,
    reply: replyText.trim(),
    usage: data.usageMetadata || null
  });
};
