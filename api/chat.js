// /api/chat.js — Neyo AI (Vercel Serverless)
// Model : Groq llama-3.1-8b-instant (free tier, very fast)
// Env   : GROQ_API_KEY
// UPGRADE: Consumes productEstate for live product recommendations

'use strict';

var GROQ_KEY = process.env.GROQ_API_KEY;
var GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
var MODEL    = 'llama-3.1-8b-instant';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function buildSystem(ctx) {
  var u  = (ctx && ctx.userName)       ? String(ctx.userName)      : 'there';
  var r  = (ctx && ctx.userRole)       ? String(ctx.userRole)      : 'guest';
  var p  = (ctx && ctx.activeProducts) ? ctx.activeProducts        : 0;
  var c  = (ctx && ctx.topCategories)  ? String(ctx.topCategories) : 'none yet';
  var v  = (ctx && ctx.totalRevenue)   ? String(ctx.totalRevenue)  : '₦0';

  /* ── Product Estate: array of live listing strings ── */
  var estate = (ctx && Array.isArray(ctx.productEstate) && ctx.productEstate.length)
    ? ctx.productEstate
    : null;

  var estateLine = estate
    ? [
        '',
        'LIVE PRODUCT ESTATE — recommend these specific products to buyers when relevant:',
        estate.map(function(l){ return '  ' + l; }).join('\n'),
        'When a buyer asks what to buy, mentions a need, or asks for recommendations,',
        'search this list and suggest matching products BY NAME with their price.',
        'Always say they can find it on the NeyoMarket marketplace.',
        ''
      ].join('\n')
    : '\nNo active listings yet — encourage the user to check back soon.\n';

  return [
    'You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant',
    'embedded in NeyoMarket, Nigeria\'s premier digital and physical marketplace.',
    '',
    'PERSONALITY:',
    '- Street-smart and direct. Give real answers, not corporate fluff.',
    '- Warm and encouraging. Treat every user like a smart friend.',
    '- Entrepreneurial mindset. Help people build real income.',
    '- NEVER open with a menu — answer the actual question first, every time.',
    '- After answering, connect to business only if natural (one sentence max).',
    '- Nigerian-friendly tone. Light humour welcome. Mentor, not robot.',
    '',
    'ANSWER ANYTHING — cooking, relationships, health, sports, tech, science,',
    'business, investing, coding, writing. Answer first. Be genuinely useful.',
    '',
    'LIVE CONTEXT:',
    '- User: ' + u + ' (' + r + ')',
    '- Active products on platform: ' + p,
    '- Top categories: ' + c,
    '- Platform revenue: ' + v,
    estateLine,
    'NEYOMARKET FACTS (cite only when directly relevant):',
    '- Revenue split: 85% seller · 5% affiliate · 10-15% platform',
    '- Paystack escrow, 256-bit SSL',
    '- KYC required: NIN or BVN',
    '- Trusted Seller badge: ₦2,000 one-time verification fee',
    '- Min withdrawal: ₦2,000 (₦100 flat processing fee)',
    '- Affiliate: 5% commission via ?ref= link',
    '- Digital products: instant download after payment',
    '- Physical: buyer confirms receipt to release escrow',
    '- Disputes resolved in 24 hours, full refund if seller at fault',
    '- Zero Scam Guarantee',
    '- Support: +2349072212496 (WhatsApp/call, 8am-8pm WAT)',
    '',
    'FORMAT: Bold **key terms**. Short answer for short question.',
    'No bullet menus for specific questions. Under 200 words unless needed.',
    'When recommending products, name them specifically and give the price.'
  ].join('\n');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Use POST.' });

  if (!GROQ_KEY) {
    console.error('[chat.js] GROQ_API_KEY missing');
    return res.status(500).json({
      error: 'AI not configured. Add GROQ_API_KEY to Vercel environment variables. Free at console.groq.com'
    });
  }

  var body     = req.body         || {};
  var messages = body.messages    || [];
  var ctx      = body.contextData || {};

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required.' });

  var groqMessages = [{ role: 'system', content: buildSystem(ctx) }];

  messages.slice(-20).forEach(function(m) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
    if (['user','assistant','model'].indexOf(m.role) === -1) return;
    groqMessages.push({
      role:    m.role === 'model' ? 'assistant' : m.role,
      content: m.content.slice(0, 4000)
    });
  });

  if (groqMessages[groqMessages.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Last message must be from user.' });

  var payload = {
    model:       MODEL,
    messages:    groqMessages,
    max_tokens:  600,
    temperature: 0.8,
    top_p:       0.9,
    stream:      false
  };

  var resp, raw, data;
  try {
    resp = await fetch(GROQ_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify(payload)
    });
    raw  = await resp.text();
    data = JSON.parse(raw);
  } catch (e) {
    console.error('[chat.js] Fetch/parse error:', e.message);
    return res.status(502).json({ error: 'Could not reach AI service. Please try again.' });
  }

  if (!resp.ok) {
    var status = resp.status;
    var errMsg = (data.error && data.error.message) || raw.slice(0, 200);
    console.error('[chat.js] Groq HTTP ' + status + ':', errMsg);
    var msg =
      status === 401 ? 'Invalid API key. Check GROQ_API_KEY in Vercel environment variables.' :
      status === 429 ? 'Rate limit reached. Please wait a moment and try again.' :
      status === 400 ? 'Request error: ' + errMsg :
      'AI error (' + status + '). Please try again.';
    return res.status(status).json({ error: msg });
  }

  var reply = data.choices &&
              data.choices[0] &&
              data.choices[0].message &&
              data.choices[0].message.content;

  if (!reply) {
    console.error('[chat.js] No reply in response:', JSON.stringify(data).slice(0, 200));
    return res.status(502).json({ error: 'Unexpected response from AI. Please try again.' });
  }

  console.log('[chat.js] OK — tokens:', data.usage && data.usage.total_tokens);
  return res.status(200).json({
    ok:    true,
    reply: reply.trim(),
    usage: data.usage || null
  });
};
