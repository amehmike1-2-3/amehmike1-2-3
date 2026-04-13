// /api/orders.js — NeyoMarket Orders API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ── GET /api/orders?userId=xxx — fetch orders for a user ── */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      const rows = userId
        ? await sql`SELECT * FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC`
        : await sql`SELECT * FROM orders ORDER BY created_at DESC`;

      const orders = rows.map(function(r) {
        return {
          id:        r.id,
          userId:    r.user_id,
          customer:  r.customer  ? JSON.parse(r.customer)  : {},
          items:     r.items     ? JSON.parse(r.items)     : [],
          total:     parseFloat(r.total || 0),
          status:    r.status,
          collected: r.collected,
          date:      r.date,
          ref:       r.ref,
          shipping:  r.shipping  ? JSON.parse(r.shipping)  : null,
        };
      });
      return res.status(200).json({ orders: orders });
    }

    /* ── POST /api/orders — save a new order ── */
    if (req.method === 'POST') {
      const o = req.body || {};
      if (!o.id || !o.total)
        return res.status(400).json({ error: 'Order id and total are required.' });

      await sql`
        INSERT INTO orders (id, user_id, customer, items, total, status, collected, date, ref, shipping, created_at)
        VALUES (
          ${o.id},
          ${o.userId   || o.customer?.id || ''},
          ${JSON.stringify(o.customer  || {})},
          ${JSON.stringify(o.items     || [])},
          ${o.total},
          ${o.status    || 'escrow'},
          ${o.collected || false},
          ${o.date      || new Date().toLocaleDateString()},
          ${o.ref       || ''},
          ${JSON.stringify(o.shipping  || null)},
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
      return res.status(201).json({ ok: true });
    }

    /* ── PATCH /api/orders/:id — update order (mark collected etc) ── */
    if (req.method === 'PATCH') {
      // Get id from URL path: /api/orders/ORDER_ID
      const urlParts = req.url.split('/').filter(Boolean);
      const orderId  = urlParts[urlParts.length - 1].split('?')[0];
      const { collected, status } = req.body || {};

      if (!orderId) return res.status(400).json({ error: 'Order id is required.' });

      await sql`
        UPDATE orders
        SET
          collected = COALESCE(${collected ?? null}, collected),
          status    = COALESCE(${status    ?? null}, status)
        WHERE id = ${orderId}
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[orders.js error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

