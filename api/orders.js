// /api/orders.js — NeyoMarket Orders API (Neon Postgres)
// FIX: PATCH now accepts disputed, disputeReason, delivery_code, collectedAt, platformFee, sellerPayout
// FIX: dispute JSON parse error resolved — all fields pre-computed before sql template

'use strict';

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

function toOrder(r) {
  return {
    id:            r.id,
    userId:        r.user_id,
    customer:      safeJson(r.customer, {}),
    items:         safeJson(r.items, []),
    total:         parseFloat(r.total          || 0),
    platformFee:   parseFloat(r.platform_fee   || 0),
    sellerPayout:  parseFloat(r.seller_payout  || 0),
    affiliateFee:  parseFloat(r.affiliate_fee  || 0),
    affCode:       r.aff_code       || null,
    status:        r.status         || 'pending',
    collected:     r.collected      || false,
    collectedAt:   r.collected_at   || null,
    disputed:      r.disputed       || false,
    disputeReason: r.dispute_reason || null,
    deliveryCode:  r.delivery_code  || null,
    fileUrl:       r.file_url       || null,
    mode:          r.mode           || 'standard',
    date:          r.date           || (r.created_at ? new Date(r.created_at).toLocaleDateString() : ''),
    ref:           r.ref            || '',
    shipping:      safeJson(r.shipping, null),
    createdAt:     r.created_at     || null,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ── GET ── */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      const rows = userId
        ? await sql`SELECT * FROM orders WHERE user_id = ${String(userId)} ORDER BY created_at DESC`
        : await sql`SELECT * FROM orders ORDER BY created_at DESC`;
      return res.status(200).json({ orders: rows.map(toOrder) });
    }

    /* ── POST — create order ── */
    if (req.method === 'POST') {
      const o = req.body || {};
      if (!o.id || !o.total) return res.status(400).json({ error: 'id and total required.' });

      /* Generate delivery code from order id — same algo as frontend generateDVC() */
      const str  = String(o.id);
      let hash   = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      const deliveryCode = String(Math.abs(hash) % 900000 + 100000);

      await sql`
        INSERT INTO orders (
          id, user_id, customer, items, total, platform_fee, seller_payout,
          affiliate_fee, aff_code, status, collected, mode, ref,
          shipping, delivery_code, file_url, created_at
        ) VALUES (
          ${String(o.id)},
          ${String(o.userId || '')},
          ${JSON.stringify(o.customer || {})},
          ${JSON.stringify(o.items    || [])},
          ${o.total},
          ${o.platformFee   || 0},
          ${o.sellerPayout  || 0},
          ${o.affiliateFee  || 0},
          ${o.affCode       || null},
          ${o.status        || 'paid'},
          ${o.collected     || false},
          ${o.mode          || 'standard'},
          ${o.ref           || ''},
          ${JSON.stringify(o.shipping || null)},
          ${deliveryCode},
          ${o.fileUrl || null},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          status        = EXCLUDED.status,
          ref           = EXCLUDED.ref,
          delivery_code = EXCLUDED.delivery_code
      `;
      return res.status(201).json({ ok: true, deliveryCode: deliveryCode });
    }

    /* ── PATCH — update order fields ──────────────────────────────────
       FIX: All conditional values pre-computed BEFORE sql template.
       This stops the JSON 'Unexpected token A' / parse errors.
       Fields supported: status, collected, collectedAt, disputed,
       disputeReason, platformFee, sellerPayout, fileUrl, items.
    ─────────────────────────────────────────────────────────────────── */
    if (req.method === 'PATCH') {
      const parts   = req.url.split('/').filter(Boolean);
      const orderId = parts[parts.length - 1].split('?')[0];
      if (!orderId) return res.status(400).json({ error: 'orderId required.' });

      const body = req.body || {};

      /* Pre-compute every field — NEVER put ternaries inside sql`` */
      const newStatus        = (body.status        !== undefined) ? String(body.status)        : null;
      const newCollected     = (body.collected      !== undefined) ? Boolean(body.collected)   : null;
      const newCollectedAt   = (body.collectedAt    !== undefined) ? (body.collectedAt || null) : null;
      const newDisputed      = (body.disputed       !== undefined) ? Boolean(body.disputed)    : null;
      const newDisputeReason = (body.disputeReason  !== undefined) ? String(body.disputeReason).slice(0, 1000) : null;
      const newPlatformFee   = (body.platformFee    !== undefined) ? parseFloat(body.platformFee)   : null;
      const newSellerPayout  = (body.sellerPayout   !== undefined) ? parseFloat(body.sellerPayout)  : null;
      const newAffiliateFee  = (body.affiliateFee   !== undefined) ? parseFloat(body.affiliateFee)  : null;
      const newFileUrl       = (body.fileUrl        !== undefined) ? (body.fileUrl || null)         : null;
      const newItems         = (body.items          !== undefined) ? JSON.stringify(body.items)      : null;
      const orderIdStr       = String(orderId);

      await sql`
        UPDATE orders SET
          status         = COALESCE(${newStatus},        status),
          collected      = COALESCE(${newCollected},     collected),
          collected_at   = COALESCE(${newCollectedAt},   collected_at),
          disputed       = COALESCE(${newDisputed},      disputed),
          dispute_reason = COALESCE(${newDisputeReason}, dispute_reason),
          platform_fee   = COALESCE(${newPlatformFee},   platform_fee),
          seller_payout  = COALESCE(${newSellerPayout},  seller_payout),
          affiliate_fee  = COALESCE(${newAffiliateFee},  affiliate_fee),
          file_url       = COALESCE(${newFileUrl},       file_url),
          items          = COALESCE(${newItems},         items::text)
        WHERE id = ${orderIdStr}
      `;
      return res.status(200).json({ ok: true });
    }

    /* ── DELETE ── */
    if (req.method === 'DELETE') {
      const rawId = req.query.id || (req.body && req.body.id);
      if (!rawId) return res.status(400).json({ error: 'Order id required.' });
      await sql`DELETE FROM orders WHERE id = ${String(rawId)}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[orders.js] ERROR:', err.message);
    return res.status(500).json({
      error:  'Internal server error.',
      detail: err.message
    });
  }
};
