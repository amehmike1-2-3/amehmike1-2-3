// /api/orders.js — NeyoMarket Orders API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

function toOrder(r) {
  return {
    id:           r.id,
    userId:       r.user_id,
    customer:     safeJson(r.customer, {}),
    items:        safeJson(r.items, []),
    total:        parseFloat(r.total         || 0),
    platformFee:  parseFloat(r.platform_fee  || 0),
    sellerPayout: parseFloat(r.seller_payout || 0),
    affiliateFee: parseFloat(r.affiliate_fee || 0),
    affCode:      r.aff_code  || null,
    status:       r.status    || 'pending',
    collected:    r.collected || false,
    mode:         r.mode      || 'standard',
    date:         r.date      || (r.created_at ? new Date(r.created_at).toLocaleDateString() : ''),
    ref:          r.ref       || '',
    shipping:     safeJson(r.shipping, null),
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const userId = req.query.userId;
      const rows = userId
        ? await sql`SELECT * FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC`
        : await sql`SELECT * FROM orders ORDER BY created_at DESC`;
      return res.status(200).json({ orders: rows.map(toOrder) });
    }

    if (req.method === 'POST') {
      const o = req.body || {};
      if (!o.id || !o.total) return res.status(400).json({ error: 'id and total required.' });
      await sql`
        INSERT INTO orders (id, user_id, customer, items, total, platform_fee, seller_payout,
          affiliate_fee, aff_code, status, collected, mode, ref, shipping, created_at)
        VALUES (
          ${String(o.id)}, ${String(o.userId || '')},
          ${JSON.stringify(o.customer || {})}, ${JSON.stringify(o.items || [])},
          ${o.total}, ${o.platformFee || 0}, ${o.sellerPayout || 0},
          ${o.affiliateFee || 0}, ${o.affCode || null},
          ${o.status || 'paid'}, ${o.collected || false}, ${o.mode || 'standard'},
          ${o.ref || ''}, ${JSON.stringify(o.shipping || null)}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, ref = EXCLUDED.ref
      `;
      return res.status(201).json({ ok: true });
    }

    if (req.method === 'PATCH') {
      const parts   = req.url.split('/').filter(Boolean);
      const orderId = parts[parts.length - 1].split('?')[0];
      const { collected, status } = req.body || {};
      if (!orderId) return res.status(400).json({ error: 'orderId required.' });
      await sql`
        UPDATE orders
        SET collected = COALESCE(${collected ?? null}, collected),
            status    = COALESCE(${status    ?? null}, status)
        WHERE id = ${orderId}
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[orders.js]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
