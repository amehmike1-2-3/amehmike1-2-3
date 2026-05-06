// /api/leaderboard.js — ADMIN ONLY
// Leaderboard management - Admin only access

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
       GET LEADERBOARD (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const { type } = req.query; // 'sellers', 'affiliates', 'buyers'
      
      let query = '';
      if (type === 'sellers') {
        query = 'SELECT id, name, seller_balance as balance, created_at FROM users WHERE role = $1 ORDER BY balance DESC LIMIT 100';
      } else if (type === 'affiliates') {
        query = 'SELECT id, name, affiliate_balance as balance, aff_code, created_at FROM users WHERE role = $1 ORDER BY balance DESC LIMIT 100';
      } else {
        query = 'SELECT id, name, created_at FROM users WHERE role = $1 ORDER BY created_at DESC LIMIT 100';
      }

      const rows = await sql.query(query, [type || 'seller']);
      return res.status(200).json({ leaderboard: rows });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[LEADERBOARD ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
