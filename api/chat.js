// api/chat.js — Neyo AI serverless function (Vercel)
// Uses Google Gemini 1.5 Flash — free tier, no billing needed.
// Required env var: GEMINI_API_KEY
// Get a free key at: https://aistudio.google.com/app/apikey

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

// ---------------------------------------------------------------------------
// System prompt — Street-Smart Mentor personality
// ---------------------------------------------------------------------------
function systemPrompt(ctx) {
  var user    = (ctx && ctx.userName)       || 'there';
  var role    = (ctx && ctx.userRole)       || 'guest';
  var prods   = (ctx && ctx.activeProducts) || 0;
  var cats    = (ctx && ctx.topCategories)  || 'none yet';
  var rev     = (ctx && ctx.totalRevenue)   || '₦0';

  return [
    'You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant',
    'embedded in NeyoMarket, Nigeria\'s premier digital and physical marketplace.',
    '',
    '## PERSONALITY',
    '- Street-smart and direct: give real answers, not corporate fluff.',
    '- Warm and encouraging: treat every user like a smart friend who deserves straight talk.',
    '- Entrepreneurial mindset: see opportunity everywhere, love helping people build income.',
    '- NEVER open with a menu or a list of what you can do — answer the actual question first.',
    '- After answering, you may briefly connect it to business if it feels natural (one sentence max). Never force it.',
    '- Nigerian-friendly tone. Light humour is welcome.',
    '- You are a knowledgeable partner and mentor, NOT a robot.',
    '',
    '## ANSWER ANYTHING',
    'You are NOT restricted to marketplace topics.',
    'Answer questions on cooking, relationships, health, sports, tech, science,',
    'creativity, business, investing, coding, writing — anything at all.',
    'Rule: answer the question first, be genuinely useful.',
    '',
    '## LIVE CONTEXT',
    '- Current user: ' + user + ' (' + role + ')',
    '- Active products on platform: ' + prods,
    '- Top categories: ' + cats,
    '- Total platform revenue: ' + rev,
    '',
    '## NEYOMARKET FACTS (cite only when relevant)',
    '- Payment split: 90% seller · 5% affiliate · 5% platform',
    '- All payments via Paystack — 256-bit SSL, escrow-protected',
    '- KYC required (NIN or BVN) before listing products',
    '- Minimum withdrawal: ₦2,000, paid direct to seller\'s bank',
    '- Affiliate commission: 5% per referred sale via ?ref= link',
    '- Digital products: instant download after payment',
    '- Physical products: buyer confirms receipt to release escrow',
    '- Zero Scam Guarantee: money held until buyer confirms delivery',
    '- Support: +2349072212496 (WhatsApp/call, 8am–8pm WAT)',
    '',
    '## FORMAT',
    '- Use **bold** for key terms and figures.',
    '- Match length to the question: short question = short answer.',
    '- Never show a bullet-point menu when someone asks a specific question.',
    '- Never say "I can help you with X, Y, Z" — just answer what was asked.',
    '- Keep responses under 200 words unless depth is truly needed.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  setCors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Guard: API key must be set
  if (!GEMINI_KEY) {
    console.error(
      '[chat.js] GEMINI_API_KEY is not set in Vercel environment variables.\n' +
      '  Fix: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Key name : GEMINI_API_KEY\n' +
      '  Free key : https://aistudio.google.com/app/apikey'
    );
    return res.status(500).json({
      error: 'AI service not configured. Add GEMINI_API_KEY to your Vercel environment variables.'
    });
  }

  // Parse body
  var body        = req.body || {};
  var messages    = body.messages;
  var contextData = body.contextData || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Build Gemini contents array
  // Gemini uses role "user" / "model" and wraps text in parts[{text}]
  var contents = messages
    .slice(-20)
    .filter(function (m) {
      return (m.role === 'user' || m.role === 'assistant' || m.role === 'model') &&
             typeof m.content === 'string' &&
             m.content.trim().length > 0;
    })
    .map(function (m) {
      return {
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content.slice(0, 4000) }]
      };
    });

  if (contents.length === 0) {
    return res.status(400).json({ error: 'No valid messages after sanitisation.' });
  }

  // Gemini requires conversation to start with a user turn
  if (contents[0].role !== 'user') {
    contents = contents.slice(1);
  }
  if (contents.length === 0) {
    return res.status(400).json({ error: 'First message must be from the user.' });
  }

  // Build request payload
  var payload = {
    system_instruction: {
      parts: [{ text: systemPrompt(contextData) }]
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

  // Call Gemini
  var geminiResponse;
  try {
    geminiResponse = await fetch(GEMINI_URL + '?key=' + GEMINI_KEY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
  } catch (networkError) {
    console.error('[chat.js] Network error contacting Gemini:', networkError.message);
    return res.status(502).json({
      error: 'Could not reach the AI service. Please try again.'
    });
  }

  // Parse response text safely
  var responseText;
  try {
    responseText = await geminiResponse.text();
  } catch (readError) {
    console.error('[chat.js] Failed to read Gemini response body:', readError.message);
    return res.status(502).json({ error: 'Failed to read AI response. Please try again.' });
  }

  if (!responseText || responseText.trim() === '') {
    console.error('[chat.js] Gemini returned empty body. HTTP status:', geminiResponse.status);
    return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
  }

  var data;
  try {
    data = JSON.parse(responseText);
  } catch (parseError) {
    console.error('[chat.js] JSON parse failed. Raw response:', responseText.slice(0, 300));
    return res.status(502).json({ error: 'Unexpected response format from AI. Please try again.' });
  }

  // Handle non-OK HTTP status from Gemini
  if (!geminiResponse.ok) {
    var httpStatus = geminiResponse.status;
    var apiError   = (data.error && data.error.message) || 'Unknown error';
    console.error('[chat.js] Gemini API error ' + httpStatus + ':', apiError);

    var userMessage;
    if (httpStatus === 400) userMessage = 'Invalid request. Please rephrase and try again.';
    else if (httpStatus === 403) userMessage = 'Invalid API key. Check GEMINI_API_KEY in Vercel environment variables.';
    else if (httpStatus === 429) userMessage = 'AI rate limit reached. Please wait a moment and try again.';
    else if (httpStatus === 500) userMessage = 'Gemini service error. Please try again in a few seconds.';
    else userMessage = 'AI error (' + httpStatus + '). Please try again.';

    return res.status(httpStatus).json({ error: userMessage });
  }

  // Extract reply text from Gemini structure
  var candidate  = data.candidates && data.candidates[0];
  var finishReason = candidate && candidate.finishReason;

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
    console.error('[chat.js] Could not find reply text. Response shape:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
  }

  return res.status(200).json({
    ok:    true,
    reply: replyText.trim(),
    usage: data.usageMetadata || null
  });
};
