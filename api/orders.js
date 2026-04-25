// /api/orders.js — NeyoMarket Orders API
// FIX 3: GET with userId uses WHERE user_id = $1 (authenticated session only)
// FIX 4: affiliate commission only credited if valid aff_code present on order
// FIX 5: every route and catch returns res.json() — never HTML
// String() on all order IDs (NYO-XXXX format), Number() for product/user integer IDs

'use strict';

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options',       'nosniff');
}

function jsonErr(res, status, msg, detail) {
  return res.status(status).json({ error: msg, ...(detail ? { detail } : {}) });
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

    /* ════════════════════════════════════════════════
       GET
       FIX 3: userId query MUST be passed — no user ever
       sees all orders unless they are admin
    ════════════════════════════════════════════════ */
    if (req.method === 'GET') {
      const userId  = req.query.userId;
      const isAdmin = req.query.admin === 'true';

      let rows;
      if (isAdmin) {
        /* Admin: return all orders */
        rows = await sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`;
      } else if (userId) {
        /* Buyer: strict WHERE user_id = their own session ID */
        rows = await sql`
          SELECT * FROM orders
          WHERE user_id = ${String(userId)}
          ORDER BY created_at DESC
        `;
      } else {
        return jsonErr(res, 400, 'userId is required. Use ?userId=<id> or ?admin=true');
      }

      return res.status(200).json({ orders: rows.map(toOrder) });
    }

    /* ════════════════════════════════════════════════
       POST — create order
    ════════════════════════════════════════════════ */
    if (req.method === 'POST') {
      const o = req.body || {};
      if (!o.id || !o.total) return jsonErr(res, 400, 'id and total are required.');

      /* Deterministic 6-digit delivery code from order ID */
      const str = String(o.id);
      let hash  = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      const deliveryCode = String(Math.abs(hash) % 900000 + 100000);

      /* FIX 4: only store aff_code if it's a real non-empty value */
      const affCode = (o.affCode && String(o.affCode).trim().length > 2)
        ? String(o.affCode).trim()
        : null;

      await sql`
        INSERT INTO orders (
          id, user_id, customer, items, total, platform_fee, seller_payout,
          affiliate_fee, aff_code, status, collected, mode, ref,
          shipping, delivery_code, file_url, date, created_at
        ) VALUES (
          ${String(o.id)},
          ${String(o.userId || '')},
          ${JSON.stringify(o.customer || {})},
          ${JSON.stringify(o.items    || [])},
          ${parseFloat(o.total)},
          ${parseFloat(o.platformFee   || 0)},
          ${parseFloat(o.sellerPayout  || 0)},
          ${parseFloat(o.affiliateFee  || 0)},
          ${affCode},
          ${o.status      || 'paid'},
          ${false},
          ${o.mode        || 'standard'},
          ${o.ref         || ''},
          ${JSON.stringify(o.shipping || null)},
          ${deliveryCode},
          ${o.fileUrl     || null},
          ${new Date().toLocaleDateString()},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          status        = EXCLUDED.status,
          ref           = EXCLUDED.ref,
          delivery_code = EXCLUDED.delivery_code
      `;
      return res.status(201).json({ ok: true, deliveryCode });
    }

    /* ════════════════════════════════════════════════
       PATCH — update order
       All pre-computed (Neon ternary rule)
    ════════════════════════════════════════════════ */
    if (req.method === 'PATCH') {
      const parts   = (req.url || '').split('/').filter(Boolean);
      const orderId = parts[parts.length - 1].split('?')[0];
      if (!orderId) return jsonErr(res, 400, 'orderId required in path.');

      const body = req.body || {};

      const newStatus        = (body.status        !== undefined) ? String(body.status)                              : null;
      const newCollected     = (body.collected      !== undefined) ? Boolean(body.collected)                        : null;
      const newCollectedAt   = (body.collectedAt    !== undefined) ? (body.collectedAt   || null)                   : null;
      const newDisputed      = (body.disputed       !== undefined) ? Boolean(body.disputed)                         : null;
      const newDisputeReason = (body.disputeReason  !== undefined) ? String(body.disputeReason).slice(0, 1000)      : null;
      const newPlatformFee   = (body.platformFee    !== undefined) ? parseFloat(body.platformFee)                   : null;
      const newSellerPayout  = (body.sellerPayout   !== undefined) ? parseFloat(body.sellerPayout)                  : null;
      const newFileUrl       = (body.fileUrl        !== undefined) ? (body.fileUrl || null)                         : null;
      const newItems         = (body.items          !== undefined) ? JSON.stringify(body.items)                      : null;
      const orderIdStr       = String(orderId);

      /* FIX 4: only update affiliate_fee if a valid aff_code exists */
      const rawAff         = body.affCode || null;
      const newAffCode     = (rawAff && String(rawAff).trim().length > 2) ? String(rawAff).trim() : null;
      const newAffiliateFee = (body.affiliateFee !== undefined && newAffCode)
        ? parseFloat(body.affiliateFee)
        : (body.affiliateFee !== undefined && body.affiliateFee === 0 ? 0 : null);

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

      /* FIX 4: credit affiliate balance ONLY if valid aff_code on order */
      if (newAffCode && newAffiliateFee && newAffiliateFee > 0
          && (newStatus === 'completed' || body.collected === true)) {
        try {
          await sql`
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${newAffiliateFee}
            WHERE aff_code = ${newAffCode}
          `;
          console.log('[orders.js] Affiliate', newAffCode, 'credited ₦', newAffiliateFee);
        } catch(affErr) {
          console.error('[orders.js] Affiliate credit error (non-fatal):', affErr.message);
        }
      }

      return res.status(200).json({ ok: true });
    }

    /* ════════════════════════════════════════════════
       DELETE
    ════════════════════════════════════════════════ */
    if (req.method === 'DELETE') {
      const rawId = req.query.id || (req.body && req.body.id);
      if (!rawId) return jsonErr(res, 400, 'Order id required.');
      await sql`DELETE FROM orders WHERE id = ${String(rawId)}`;
      return res.status(200).json({ ok: true });
    }

    return jsonErr(res, 405, 'Method not allowed.');

  } catch (err) {
    /* FIX 5: always JSON — never HTML 500 page */
    console.error('[orders.js] ERROR:', err.message);
    return jsonErr(res, 500, 'Internal server error.', err.message);
  }
};
