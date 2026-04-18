// /api/users.js — NeyoMarket Users API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function toPublicUser(row) {
  return {
    id:               String(row.id),
    name:             row.name,
    email:            row.email,
    phone:            row.phone             || '',
    role:             row.role              || 'buyer',
    affCode:          row.aff_code          || '',
    joined:           row.joined ? new Date(row.joined).toLocaleDateString() : '',
    payoutBank:       row.payout_bank       || '',
    payoutAcct:       row.payout_acct       || '',
    payoutAname:      row.payout_aname      || '',
    subaccountCode:   row.subaccount_code   || null,
    subaccountStatus: row.subaccount_status || 'pending',
    kycStatus:        row.kyc_status        || 'unverified',
    kycType:          row.kyc_type          || null,
    sellerBalance:    parseFloat(row.seller_balance    || 0),
    affiliateBalance: parseFloat(row.affiliate_balance || 0),
    adminBalance:     parseFloat(row.admin_balance     || 0),
    suspended:        row.suspended         || false,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* GET /api/users — fetch all users, or single user by ?userId= */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      if (userId) {
        const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        return res.status(200).json({ user: toPublicUser(rows[0]) });
      }
      const rows = await sql`SELECT * FROM users ORDER BY joined DESC`;
      return res.status(200).json({ users: rows.map(toPublicUser) });
    }

    /* DELETE /api/users?userId= — admin deletes account */
    if (req.method === 'DELETE') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[users.js error]', err);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
};
