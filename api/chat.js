// api/chat.js — Neyo AI (Vercel Serverless)
// Auto-discovers which Gemini model your API key supports, then uses it.
'use strict';

var KEY = process.env.GEMINI_API_KEY;

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
    'You are Neyo AI — a street-smart, professional, genuinely helpful AI assistant',
    'in NeyoMarket, Nigeria\'s premier digital marketplace.',
    'PERSONALITY: Direct, warm, entrepreneurial. NEVER open with a menu.',
    'Answer the question first. Connect to business only if natural (1 sentence max).',
    'Nigerian-friendly tone. Mentor, not robot. Answer ANYTHING — not just marketplace.',
    'LIVE: User=' + u + '(' + r + ') Products=' + p + ' Cats=' + c + ' Rev=' + v,
    'NEYOMARKET: 90/5/5 split. Paystack escrow. KYC=NIN/BVN. Min withdrawal ₦2000.',
    'Affiliate 5% via ?ref=. Digital=instant download. Support: +2349072212496.',
    'FORMAT: Bold key terms. Short=short. No bullet menus. Under 200 words.'
  ].join('\n');
}

// Cache the working model URL after first discovery
var cachedModelUrl = null;

async function discoverModel(key) {
  // Call ListModels to get exactly what this key supports
  var listUrl = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + key;
  try {
    var r   = await fetch(listUrl);
    var txt = await r.text();
    var d   = JSON.parse(txt);
    var models = d.models || [];

    // Find first model that supports generateContent
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var methods = m.supportedGenerationMethods || [];
      if (methods.indexOf('generateContent') !== -1) {
        // m.name is like "models/gemini-1.5-flash"
        var modelId = m.name; // keep the full path as Gemini returns it
        console.log('[chat.js] Discovered model:', modelId);
        return 'https://generativelanguage.googleapis.com/v1beta/' + modelId + ':generateContent';
      }
    }
    console.error('[chat.js] ListModels returned no generateContent models. Models:', models.map(function(x){ return x.name; }).join(', '));
    return null;
  } catch(e) {
    console.error('[chat.js] ListModels failed:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Use POST.' });

  if (!KEY) {
    console.error('[chat.js] GEMINI_API_KEY missing. Add it in Vercel → Settings → Environment Variables.');
    return res.status(500).json({ error: 'AI not configured. Add GEMINI_API_KEY to Vercel environment variables.' });
  }

  // Special action: list available models (call GET /api/chat?action=list to debug)
  if (req.method === 'POST' && req.body && req.body.action === 'list') {
    var listUrl = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + KEY;
    try {
      var lr   = await fetch(listUrl);
      var ltxt = await lr.text();
      return res.status(200).json({ raw: ltxt });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  var body     = req.body         || {};
  var messages = body.messages    || [];
  var ctx      = body.contextData || {};

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required.' });

  // Build contents
  var contents = [];
  messages.slice(-20).forEach(function(m) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
    if (['user','assistant','model'].indexOf(m.role) === -1) return;
    contents.push({
      role:  (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 4000) }]
    });
  });
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length) return res.status(400).json({ error: 'No valid user messages.' });

  var sysText = buildSystem(ctx);
  var sysPair = [
    { role: 'user',  parts: [{ text: 'SYSTEM INSTRUCTIONS:\n' + sysText }] },
    { role: 'model', parts: [{ text: 'Understood. Neyo AI ready — direct, street-smart, helpful.' }] }
  ];
  var fullContents = sysPair.concat(contents);

  var payload = {
    contents: fullContents,
    generationConfig: { maxOutputTokens: 512, temperature: 0.8, topP: 0.9 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  // Discover model if not cached
  if (!cachedModelUrl) {
    cachedModelUrl = await discoverModel(KEY);
  }

  if (!cachedModelUrl) {
    return res.status(503).json({
      error: 'Could not find a compatible AI model for your API key. Check Vercel logs for details.'
    });
  }

  // Call Gemini
  var resp, raw, data;
  try {
    resp = await fetch(cachedModelUrl + '?key=' + KEY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    raw  = await resp.text();
    data = JSON.parse(raw);
  } catch(e) {
    console.error('[chat.js] Fetch error:', e.message);
    // Reset cache so next request re-discovers
    cachedModelUrl = null;
    return res.status(502).json({ error: 'Could not reach AI service. Please try again.' });
  }

  if (!resp.ok) {
    var status = resp.status;
    var errMsg = (data.error && data.error.message) || raw.slice(0, 200);
    console.error('[chat.js] Gemini error ' + status + ':', errMsg);
    // Reset cache on 404 so next call re-discovers
    if (status === 404) cachedModelUrl = null;
    var msg =
      status === 403 ? 'Invalid API key.' :
      status === 429 ? 'Rate limit reached. Please wait a moment and try again.' :
      status === 404 ? 'Model not found. Retrying...' :
      'AI error (' + status + '). Please try again.';
    return res.status(status).json({ error: msg });
  }

  var cand0  = data.candidates && data.candidates[0];
  if (cand0 && cand0.finishReason === 'SAFETY')
    return res.status(200).json({ ok: true, reply: "I can't help with that — ask me anything else! 💡" });

  var reply = cand0 && cand0.content && cand0.content.parts &&
              cand0.content.parts[0] && cand0.content.parts[0].text;

  if (!reply) {
    console.error('[chat.js] No reply text. Data:', JSON.stringify(data).slice(0, 200));
    return res.status(502).json({ error: 'Unexpected AI response format. Please try again.' });
  }

  console.log('[chat.js] OK via', cachedModelUrl.split('/models/')[1]);
  return res.status(200).json({ ok: true, reply: reply.trim(), usage: data.usageMetadata || null
