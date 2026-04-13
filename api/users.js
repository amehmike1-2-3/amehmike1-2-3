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
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rows = await sql`SELECT * FROM users ORDER BY joined DESC`;
    return res.status(200).json({ users: rows.map(toPublicUser) });
  } catch (err) {
    console.error('[users.js error]', err);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
};

