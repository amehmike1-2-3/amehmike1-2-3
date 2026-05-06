// /api/webhook.js — ADMIN ONLY
// Webhook management - Admin only access

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

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
  const protected = await protect(req, res, token);
  if (protected.statusCode) return protected;

  const adminCheck = restrictToAdmin(protected.user);
  if (!adminCheck.allowed) {
    return res.status(403).json({ error: '403 Forbidden: Admin access required.' });
  }

  try {

    /* ────────────────────────────────────────────────────
       GET WEBHOOK EVENTS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT 100`;
      return res.status(200).json({ events: rows, total: rows.length });
    }

    /* ────────────────────────────────────────────────────
       LOG WEBHOOK EVENT (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { eventType, payload, status } = req.body || {};
      if (!eventType) {
        return res.status(400).json({ error: 'eventType required.' });
      }

      const inserted = await sql`
        INSERT INTO webhook_events (event_type, payload, status, created_at)
        VALUES (${eventType}, ${JSON.stringify(payload || {})}, ${status || 'pending'}, NOW())
        RETURNING *
      `;

      return res.status(201).json({ event: inserted[0] });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
