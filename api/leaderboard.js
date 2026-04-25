// /api/leaderboard.js — NeyoMarket Affiliate Leaderboard
// GET: returns top users ranked by affiliate_earnings (sum of credited affiliate fees)
// All ID and numeric casts use Number() per Neon safety rule

'use strict';

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only.' });

  try {
    /* ── Strategy 1: sum affiliate_fee from completed orders by aff_code ──
       This is the most accurate — it reflects real earnings from real sales.
       We join on aff_code stored in users table.
    ── */
    const rows = await sql`
      SELECT
        u.id,
        u.name,
        u.aff_code,
        COALESCE(SUM(o.affiliate_fee), 0)::numeric AS affiliate_earnings,
        COUNT(o.id)::int                            AS total_referrals
      FROM users u
      LEFT JOIN orders o
        ON o.aff_code = u.aff_code
        AND o.status IN ('completed', 'escrow_held', 'paid')
        AND o.affiliate_fee > 0
      WHERE u.aff_code IS NOT NULL
        AND u.aff_code != ''
      GROUP BY u.id, u.name, u.aff_code
      ORDER BY affiliate_earnings DESC
      LIMIT 20
    `;

    /* ── Strategy 2 fallback: use seller_balance if orders join returns nothing ──
       Some early deployments credited balance directly without tracking aff_code.
    ── */
    const leaderboard = rows.length > 0 ? rows : await sql`
      SELECT
        id,
        name,
        aff_code,
        COALESCE(seller_balance, 0)::numeric AS affiliate_earnings,
        0::int                               AS total_referrals
      FROM users
      WHERE role = 'affiliate'
        OR aff_code IS NOT NULL
      ORDER BY seller_balance DESC
      LIMIT 20
    `;

    return res.status(200).json({
      ok:          true,
      leaderboard: leaderboard.map(function(u) {
        return {
          id:                 u.id,
          name:               u.name || 'Affiliate',
          affCode:            u.aff_code,
          affiliate_earnings: parseFloat(u.affiliate_earnings || 0),
          total_referrals:    parseInt(u.total_referrals   || 0, 10)
        };
      }),
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[leaderboard.js] ERROR:', err.message);
    return res.status(500).json({ error: 'Could not load leaderboard.', detail: err.message });
  }
};

