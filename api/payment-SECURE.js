// /api/payment.js — ADMIN ONLY
// Payment management and Paystack webhook handling - Admin only access

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

async function protect(req, res, token) {
  if (!token) {
    return res.status(401).json({ error: '401 Unauthorized: No token provided.' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: '401 Unauthorized: Invalid token.' });
  }
  
  const rows = await sql`SELECT * FROM users WHERE id = ${decoded.id} LIMIT 1`;
  if (!rows.length) {
    return res.status(401).json({ error: '401 Unauthorized: User not found.' });
  }
  
  return { user: rows[0] };
}

function restrictToAdmin(user) {
  if (user.role !== 'admin') {
    return { allowed: false };
  }
  return { allowed: true };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getTokenFromRequest(req);
  const { action } = req.query;

  // WEBHOOK: No auth required (Paystack calls this)
  if (action === 'webhook') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

    // Verify webhook signature
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(403).json({ error: 'Invalid signature.' });
    }

    // Process webhook
    const { event, data } = req.body;
    if (event === 'charge.success') {
      console.log('[WEBHOOK] Payment successful:', data.reference);
      // Update transaction status
      await sql`UPDATE paystack_transactions SET status = 'success' WHERE reference = ${data.reference}`;
    }

    return res.status(200).json({ ok: true });
  }

  // ALL OTHER ROUTES: Admin only
  const adminProtected = await protect(req, res, token);
  if (adminProtected.statusCode) return adminProtected;

  const adminCheck = restrictToAdmin(adminProtected.user);
  if (!adminCheck.allowed) {
    return res.status(403).json({ error: '403 Forbidden: Admin access required.' });
  }

  try {

    /* ────────────────────────────────────────────────────
       GET PAYMENTS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM payments ORDER BY created_at DESC`;
      return res.status(200).json({ payments: rows });
    }

    /* ────────────────────────────────────────────────────
       CREATE PAYMENT RECORD (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { userId, amount, orderId, reference } = req.body || {};
      if (!userId || !amount || !reference) {
        return res.status(400).json({ error: 'userId, amount, reference required.' });
      }

      const inserted = await sql`
        INSERT INTO payments (user_id, amount, order_id, reference, status, created_at)
        VALUES (${userId}, ${parseFloat(amount)}, ${orderId || null}, ${reference}, 'pending', NOW())
        RETURNING *
      `;

      return res.status(201).json({ payment: inserted[0] });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[PAYMENT ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
