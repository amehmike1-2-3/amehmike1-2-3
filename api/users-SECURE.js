// /api/users.js — ADMIN ONLY - User Management
// ALL routes require authentication AND admin role

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
  
  return { user: rows[0], decoded };
}

function restrictToAdmin(user) {
  if (user.role !== 'admin') {
    return { allowed: false, error: '403 Forbidden: Admin access required.' };
  }
  return { allowed: true };
}

function toPublicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    role: row.role || 'buyer',
    affCode: row.aff_code || '',
    isVerified: row.is_verified || false,
    joined: row.joined ? new Date(row.joined).toLocaleDateString() : '',
    kycStatus: row.kyc_status || 'unverified',
    suspended: row.suspended || false,
    sellerBalance: parseFloat(row.seller_balance || 0),
    affiliateBalance: parseFloat(row.affiliate_balance || 0),
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getTokenFromRequest(req);
  const protected = await protect(req, res, token);
  if (protected.statusCode) return protected; // Error response

  const adminCheck = restrictToAdmin(protected.user);
  if (!adminCheck.allowed) {
    return res.status(403).json({ error: adminCheck.error });
  }

  try {

    /* ────────────────────────────────────────────────────
       GET ALL USERS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      
      if (userId) {
        const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        return res.status(200).json({ user: toPublicUser(rows[0]) });
      }
      
      const rows = await sql`SELECT * FROM users ORDER BY joined DESC`;
      return res.status(200).json({ 
        users: rows.map(toPublicUser),
        total: rows.length 
      });
    }

    /* ────────────────────────────────────────────────────
       UPDATE USER (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { userId, role, suspended, kycStatus } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const safeRole = ['buyer', 'seller', 'affiliate', 'admin'].includes(role) ? role : null;

      await sql`
        UPDATE users SET
          role = COALESCE(${safeRole ?? null}, role),
          suspended = COALESCE(${suspended ?? null}, suspended),
          kyc_status = COALESCE(${kycStatus ?? null}, kyc_status)
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      return res.status(200).json({ user: toPublicUser(rows[0]), message: 'User updated.' });
    }

    /* ────────────────────────────────────────────────────
       DELETE USER (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'DELETE') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ ok: true, message: 'User deleted.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[USERS ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
