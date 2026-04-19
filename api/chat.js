/*
 * NEYO MARKET AI - BACKEND ENGINE
 * Professional Edition (Vercel Serverless)
 * Switched to Google Gemini 1.5 Flash for $0 Cost
 */

export default async function handler(req, res) {
    // 1. CORS CONFIGURATION
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. LOGGING & VALIDATION
    console.log('[Neyo AI] Request received at:', new Date().toISOString());

    if (req.method !== 'POST') {
        return res.status(405).json({
            ok: false,
            error: 'Method not allowed. Use POST.',
            instructions: 'Send a JSON body with messages and systemPrompt.'
        });
    }

    // 3. API KEY AUTHENTICATION
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[Neyo AI] CRITICAL ERROR: GEMINI_API_KEY is missing in Vercel settings.');
        return res.status(500).json({
            ok: false,
            error: 'AI service not configured.',
            message: 'Add GEMINI_API_KEY to your Vercel Environment Variables.'
        });
    }

    // 4. REQUEST BODY PARSING
    const { messages, systemPrompt } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            ok: false,
            error: 'Invalid request body.',
            message: 'Messages array is required.'
        });
    }

    try {
        // 5. THE AI ENGINE (Switching from Claude to Free Gemini)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { role: "user", parts: [{ text: systemPrompt }] },
                    ...messages.map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }]
                    }))
                ],
                generationConfig: {
                    maxOutputTokens: 800,
                    temperature: 0.8,
                    topP: 0.95,
                }
            })
        });

        const data = await response.json();

        // 6. ERROR HANDLING (Specific to Gemini)
        if (data.error) {
            console.error('[Neyo AI] Gemini API Error:', data.error);
            return res.status(data.error.code || 500).json({
                ok: false,
                error: data.error.message,
                type: 'api_error'
            });
        }

        // 7. SUCCESS RESPONSE
        const aiReply = data.candidates[0].content.parts[0].text;

        console.log('[Neyo AI] Response generated successfully.');

        return res.status(200).json({
            ok: true,
            reply: aiReply,
            meta: {
                model: 'gemini-1.5-flash',
                timestamp: new Date().toISOString()
            }
        });

    } catch (err) {
        // 8. FAIL-SAFE FALLBACK
        console.error('[Neyo AI] System Level Error:', err);
        return res.status(500).json({
            ok: false,
            error: 'The AI is currently offline.',
            message: "I'm thinking through that one — my live connection is temporarily offline. Try me again! 💡"
        });
    }
}
