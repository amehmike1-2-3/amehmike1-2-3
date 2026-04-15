// /api/affiliate.js — NeyoMarket Affiliate Commission API
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* ══════════════════════════════════════════
       Record affiliate commission after sale
       POST /api/affiliate?action=record
       Body: { affCode, orderId, amount, commission, productId }
    ══════════════════════════════════════════ */
    if (action === 'record') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { affCode, orderId, amount, commission, productId } = req.body || {};
      if (!affCode || !orderId || !commission)
        return res.status(400).json({ error: 'affCode, orderId and commission required.' });

      /* Find affiliate user by affCode */
      const users = await sql`SELECT id FROM users WHERE aff_code = ${affCode} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'Affiliate not found.' });

      const affUserId = users[0].id;

      /* Save commission record */
      await sql`
        INSERT INTO affiliate_commissions (aff_user_id, aff_code, order_id, order_amount, commission, product_id, status, created_at)
        VALUES (${affUserId}, ${affCode}, ${String(orderId)}, ${amount || 0}, ${commission}, ${String(productId || '')}, ${'pending'}, NOW())
        ON CONFLICT (order_id) DO NOTHING
      `;

      return res.status(201).json({ ok: true });
    }

    /* ══════════════════════════════════════════
       Get affiliate stats + commission history
       GET /api/affiliate?action=stats&affCode=xxx
    ══════════════════════════════════════════ */
    if (action === 'stats') {
      const affCode = req.query.affCode;
      if (!affCode) return res.status(400).json({ error: 'affCode required.' });

      const rows = await sql`
        SELECT * FROM affiliate_commissions WHERE aff_code = ${affCode} ORDER BY created_at DESC
      `;

      const totalEarned = rows.filter(function(r){ return r.status === 'paid'; })
                              .reduce(function(s,r){ return s + parseFloat(r.commission); }, 0);
      const pendingComm = rows.filter(function(r){ return r.status === 'pending'; })
                              .reduce(function(s,r){ return s + parseFloat(r.commission); }, 0);
      const sales       = rows.length;
      const referrals   = new Set(rows.map(function(r){ return r.order_id; })).size;

      return res.status(200).json({
        totalEarned:  Math.round(totalEarned),
        pendingComm:  Math.round(pendingComm),
        sales:        sales,
        referrals:    referrals,
        commissions:  rows
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[affiliate.js]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};

