// /api/chat.js — Neyo AI Backend (Vercel Serverless Function)
// Uses Google Gemini 1.5 Flash — free tier, no Anthropic credits needed.
// Add GEMINI_API_KEY to Vercel → Project → Settings → Environment Variables.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT — Street-Smart Mentor personality
═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(contextData) {
  var ctx = contextData || {};
  return [
    "You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant",
    "built into NeyoMarket, Nigeria's premier digital and physical marketplace.",
    "",
    "## YOUR PERSONALITY",
    "- Street-smart and direct: give real answers, not corporate fluff",
    "- Warm and encouraging: treat every user like a smart friend who deserves straight talk",
    "- Entrepreneurial mindset: see opportunity in everything, love helping people build income",
    "- You NEVER open with a menu or list of options — answer the actual question first, every time",
    "- After answering, you may briefly connect it to business or earning if it feels natural. One sentence max. Never force it.",
    "- Conversational, Nigerian-friendly tone. Light humour is welcome when appropriate.",
    "- You are NOT a robot. You are a knowledgeable partner and mentor.",
    "",
    "## ANSWER ANYTHING",
    "You are NOT restricted to marketplace topics. Answer questions on cooking, relationships,",
    "health, sports, tech, science, creativity, business, investing, coding, writing — anything.",
    "The only rule: answer the question first and be genuinely useful.",
    "",
    "## LIVE MARKETPLACE CONTEXT" + (ctx.userName ? " (user: " + ctx.userName + ")" : ""),
    "- Active products on platform: " + (ctx.activeProducts || 0),
    "- Top categories: " + (ctx.topCategories || "none yet"),
    "- Total platform revenue: ₦" + (ctx.totalRevenue || "0"),
    "",
    "## NEYOMARKET FACTS (only cite when directly relevant)",
    "- Payment split: 90% seller · 5% affiliate · 5% platform",
    "- All payments via Paystack — 256-bit SSL, escrow-protected",
    "- Sellers must complete KYC (NIN or BVN) before listing products",
    "- Minimum withdrawal: ₦2,000 — paid direct to seller's bank",
    "- Affiliate commission: 5% per referred sale via ?ref= link",
    "- Digital products: instant download delivered after payment",
    "- Physical products: buyer confirms receipt before escrow releases",
    "- Zero Scam Guarantee: money never goes to seller until buyer confirms",
    "- Support: +2349072212496 (WhatsApp/call, 8am–8pm WAT)",
    "",
    "## RESPONSE FORMAT",
    "- Use **bold** for key terms and important figures",
    "- Match length to the question: quick question = quick answer, deep question = detailed answer",
    "- Never show a bullet-point menu when someone asks a specific question",
    "- Never say 'I can help you with X, Y, Z' — just answer what they actually asked",
    "- Keep responses under 200 words unless depth is genuinely needed"
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
═══════════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  /* ── Guard: API key must exist ── */
  if (!GEMINI_API_KEY) {
    console.error(
      '[chat.js] GEMINI_API_KEY is missing from environment variables.\n' +
      '  Fix: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Key name: GEMINI_API_KEY\n' +
      '  Value: Get a free key at https://aistudio.google.com/app/apikey'
    );
    return res.status(500).json({
      error:
        'AI service not configured. Add GEMINI_API_KEY to Vercel environment variables. ' +
        'Get a free key at aistudio.google.com.'
    });
  }

  /* ── Parse body ── */
  const body = req.body || {};
  const { messages, contextData } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  /* ── Build Gemini contents array from chat history ──
     Gemini uses 'user' / 'model' roles (not 'user' / 'assistant')
     and wraps text in parts[].text                               */
  const contents = messages
    .slice(-20)                   // max 20 turns to keep costs low
    .filter(function(m) {
      return (m.role === 'user' || m.role === 'assistant' || m.role === 'model') &&
             typeof m.content === 'string' && m.content.trim().length > 0;
    })
    .map(function(m) {
      return {
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content.slice(0, 4000) }]   // hard cap per message
      };
    });

  if (!contents.length)
    return res.status(400).json({ error: 'No valid messages after sanitisation.' });

  /* Gemini requires the conversation to start with a user turn */
  if (contents[0].role !== 'user') {
    return res.status(400).json({ error: 'First message must be from the user.' });
  }

  const system = buildSystemPrompt(contextData);

  /* ── Call Gemini ── */
  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL + '?key=' + GEMINI_API_KEY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        system_instruction: {
          parts: [{ text: system }]
        },
        contents: contents,
        generationConfig: {
          maxOutputTokens: 512,
          temperature:     0.8,   // street-smart tone — slightly creative
          topP:            0.9
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });
  } catch (networkErr) {
    console.error('[chat.js] Network error reaching Gemini:', networkErr.message);
    return res.status(502).json({
      error: 'Could not reach the AI service. Please try again in a moment.'
    });
  }

  /* ── Parse Gemini response ── */
  let data;
  try {
    const text = await geminiRes.text();
    if (!text || text.trim() === '') {
      console.error('[chat.js] Gemini returned empty response, status:', geminiRes.status);
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }
    data = JSON.parse(text);
  } catch (parseErr) {
    console.error('[chat.js] Failed to parse Gemini response:', parseErr.message);
    return res.status(502).json({ error: 'Unexpected response from AI. Please try again.' });
  }

  /* ── Handle Gemini errors ── */
  if (!geminiRes.ok) {
    const status = geminiRes.status;
    console.error('[chat.js] Gemini API error:', status, JSON.stringify(data).slice(0, 300));
    const userMsg =
      status === 400 ? 'Invalid request sent to AI. Please try again.' :
      status === 403 ? 'Invalid API key. Check GEMINI_API_KEY in Vercel environment variables.' :
      status === 429 ? 'AI is busy right now. Please wait a moment and try again.' :
      status === 500 ? 'Gemini service error. Please try again in a few seconds.' :
      'AI service error (' + status + '). Please try again.';
    return res.status(status).json({ error: userMsg });
  }

  /* ── Extract reply ── */
  const candidate = data.candidates && data.candidates[0];
  const reply     = candidate &&
                    candidate.content &&
                    candidate.content.parts &&
                    candidate.content.parts[0] &&
                    candidate.content.parts[0].text;

  if (!reply) {
    /* Could be a safety block */
    const blockReason = candidate && candidate.finishReason;
    if (blockReason === 'SAFETY') {
      return res.status(200).json({
        ok:    true,
        reply: "I can't help with that specific request, but ask me anything else about business, NeyoMarket, or whatever's on your mind! 💡"
      });
    }
    console.error('[chat.js] Unexpected Gemini shape:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
  }

  /* ── Success ── */
  return res.status(200).json({
    ok:    true,
    reply: reply.trim(),
    usage: data.usageMetadata || null
  });
};
