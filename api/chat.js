// /api/chat.js — Neyo AI Backend (Vercel Serverless Function)
// Proxies chat messages to the Anthropic Claude API.
// The ANTHROPIC_API_KEY lives only in Vercel env vars — never exposed to the browser.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL             = 'claude-sonnet-4-20250514';
const MAX_TOKENS        = 600;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control',                'no-store');
}

module.exports = async function handler(req, res) {
  cors(res);

  /* Preflight */
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  /* ── API key guard — fail loudly so you know immediately ── */
  if (!ANTHROPIC_API_KEY) {
    console.error(
      '[chat.js] ANTHROPIC_API_KEY is missing from Vercel environment variables.\n' +
      '  Fix: Vercel Dashboard → Your Project → Settings → Environment Variables\n' +
      '  Add:  ANTHROPIC_API_KEY = sk-ant-...'
    );
    return res.status(500).json({
      error: 'AI service not configured. The ANTHROPIC_API_KEY environment variable is missing. ' +
             'Add it in Vercel → Project Settings → Environment Variables.'
    });
  }

  /* ── Parse request body ── */
  const { messages, systemPrompt } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  /* Sanitise messages — only role + content, max 20 turns to keep costs down */
  const cleanMessages = messages
    .slice(-20)
    .filter(function(m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
    })
    .map(function(m) {
      return { role: m.role, content: m.content.slice(0, 4000) }; // hard cap per message
    });

  if (!cleanMessages.length)
    return res.status(400).json({ error: 'No valid messages after sanitisation.' });

  /* ── Build the system prompt ── */
  const system = systemPrompt || buildDefaultSystemPrompt();

  /* ── Call Anthropic ── */
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     system,
        messages:   cleanMessages
      })
    });
  } catch (networkErr) {
    console.error('[chat.js] Network error reaching Anthropic:', networkErr.message);
    return res.status(502).json({
      error: 'Could not reach the AI service. Please try again in a moment.'
    });
  }

  /* ── Parse Anthropic response ── */
  let data;
  try {
    const text = await anthropicRes.text();
    if (!text || text.trim() === '') {
      console.error('[chat.js] Anthropic returned an empty response, status:', anthropicRes.status);
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }
    data = JSON.parse(text);
  } catch (parseErr) {
    console.error('[chat.js] Failed to parse Anthropic response:', parseErr.message);
    return res.status(502).json({ error: 'Unexpected response from AI. Please try again.' });
  }

  /* ── Forward Anthropic errors with clear messages ── */
  if (!anthropicRes.ok) {
    const apiErr = data.error || {};
    console.error('[chat.js] Anthropic API error:', anthropicRes.status, apiErr.type, apiErr.message);

    const userMsg =
      apiErr.type === 'authentication_error'
        ? 'Invalid API key. Check ANTHROPIC_API_KEY in Vercel environment variables.'
        : apiErr.type === 'rate_limit_error'
        ? 'AI is busy right now. Please wait a moment and try again.'
        : apiErr.type === 'overloaded_error'
        ? 'AI service is overloaded. Try again in a few seconds.'
        : (apiErr.message || 'AI service error. Please try again.');

    return res.status(anthropicRes.status).json({ error: userMsg });
  }

  /* ── Extract reply text ── */
  const reply =
    data.content &&
    data.content[0] &&
    data.content[0].type === 'text'
      ? data.content[0].text
      : null;

  if (!reply) {
    console.error('[chat.js] Unexpected Anthropic response shape:', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
  }

  /* ── Success ── */
  return res.status(200).json({
    ok:    true,
    reply: reply,
    usage: data.usage || null   // input_tokens + output_tokens for your own monitoring
  });
};

/* ═══════════════════════════════════════════════════════════════
   DEFAULT SYSTEM PROMPT
   Used when the frontend doesn't send one (graceful fallback).
   The full dynamic version is built in index.html and sent
   in the request body as systemPrompt.
═══════════════════════════════════════════════════════════════ */
function buildDefaultSystemPrompt() {
  return [
    "You are Neyo AI — a street-smart, professional, and genuinely helpful AI assistant",
    "built into NeyoMarket, Nigeria's premier digital marketplace.",
    "",
    "## YOUR PERSONALITY",
    "- Street-smart and direct: give real answers, not corporate fluff",
    "- Warm and encouraging: treat every user like a smart friend who deserves straight talk",
    "- Entrepreneurial mindset: see opportunity in everything, love helping people build income",
    "- Never open with a menu or list of options — answer the actual question first, every time",
    "- After answering, you may briefly connect it to business or earning if it's natural. Never force it.",
    "- Conversational, Nigerian-friendly tone. Light humour is welcome when appropriate.",
    "",
    "## ANSWER ANYTHING",
    "You are NOT restricted to marketplace topics. Answer questions on cooking, relationships,",
    "health, sports, tech, science, creativity, business, investing, coding, writing — anything.",
    "The only rule: answer the question first. Be genuinely useful.",
    "Then, only if natural, connect it to business in one sentence max.",
    "",
    "## NEYOMARKET FACTS (only use when relevant, never contradict)",
    "- Payment split: 90% seller · 5% affiliate · 5% platform",
    "- All payments via Paystack — 256-bit SSL, escrow-protected",
    "- Sellers must complete KYC (NIN or BVN) to list products",
    "- Minimum withdrawal: ₦2,000",
    "- Affiliate commission: 5% per referred sale via ?ref= link",
    "- Digital products: instant download after payment",
    "- Physical products: buyer confirms receipt to release escrow",
    "- Zero Scam Guarantee: escrow holds funds until delivery confirmed",
    "- Support: +2349072212496 (WhatsApp/call, 8am–8pm WAT)",
    "",
    "## FORMAT",
    "- Use **bold** for key terms and important figures",
    "- Match length to the question: quick question = quick answer, deep question = detailed answer",
    "- Never show a bullet-point menu when someone asks a specific question",
    "- Never say 'I can help you with X, Y, Z' — just answer what they actually asked"
  ].join("\n");
}

