// /api/users.js — ADMIN ONLY
// User management - Admin access required via token in header

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
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
    membershipTier: row.membership_tier || 'free',
    tierRef: row.tier_ref || '',
    loyaltyPoints: parseInt(row.loyalty_points || 0),
    loyaltyHistory: row.loyalty_history || [],
  };
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
       GET USERS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      
      if (userId) {
        const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        return res.status(200).json({ user: toPublicUser(rows[0]) });
      }
      
      const rows = await sql`SELECT * FROM users ORDER BY joined DESC`;
      return res.status(200).json({ users: rows.map(toPublicUser), total: rows.length });
    }

    /* ────────────────────────────────────────────────────
       UPDATE USER (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { userId, role, suspended, kycStatus, membershipTier, tierRef, loyaltyPoints, loyaltyHistory } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const safeRole = ['buyer', 'seller', 'affiliate', 'admin'].includes(role) ? role : null;
      const safeTier = ['free', 'starter', 'pro', 'business'].includes(membershipTier) ? membershipTier : null;

      await sql`
        UPDATE users SET
          role             = COALESCE(${safeRole ?? null}, role),
          suspended        = COALESCE(${suspended ?? null}, suspended),
          kyc_status       = COALESCE(${kycStatus ?? null}, kyc_status),
          membership_tier  = COALESCE(${safeTier ?? null}, membership_tier),
          tier_ref         = COALESCE(${tierRef ?? null}, tier_ref),
          loyalty_points   = COALESCE(${loyaltyPoints ?? null}, loyalty_points),
          loyalty_history  = COALESCE(${loyaltyHistory ? JSON.stringify(loyaltyHistory) : null}::jsonb, loyalty_history)
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
