// /api/leaderboard.js — ADMIN ONLY
// Leaderboard - Admin access required via token in header

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getAuthToken(req);

  // Admin token required
  if (!token) {
    return res.status(401).json({ error: '401 Unauthorized: Token required.' });
  }

  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: '403 Forbidden: Invalid token.' });
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
      return res.status(200).json({ leaderboard: rows, total: rows.length });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[LEADERBOARD ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
