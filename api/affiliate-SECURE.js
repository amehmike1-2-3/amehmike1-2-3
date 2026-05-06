// /api/affiliate.js — ADMIN ONLY
// Affiliate management - Admin only access

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

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
       GET AFFILIATE DATA (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, aff_code, affiliate_balance, created_at 
        FROM users 
        WHERE role = 'affiliate' 
        ORDER BY affiliate_balance DESC
      `;
      
      return res.status(200).json({ 
        affiliates: rows,
        total: rows.length 
      });
    }

    /* ────────────────────────────────────────────────────
       UPDATE AFFILIATE COMMISSION (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { userId, commission } = req.body || {};
      if (!userId || commission === undefined) {
        return res.status(400).json({ error: 'userId and commission required.' });
      }

      await sql`UPDATE users SET affiliate_balance = affiliate_balance + ${parseFloat(commission)} WHERE id = ${userId}`;
      
      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      return res.status(200).json({ 
        user: { id: rows[0].id, affCode: rows[0].aff_code, balance: rows[0].affiliate_balance },
        message: 'Commission updated.' 
      });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[AFFILIATE ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
