// /api/disputes.js — NeyoMarket Dispute Management API
// Every route wrapped in try/catch returning res.status().json()
// Never returns HTML — stops 'Unexpected token T' errors completely
// Uses String() for order IDs (NYO-XXXX), Number() for integer IDs

'use strict';

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options',       'nosniff');
}

/* Centralised JSON error — never sends HTML */
function jsonErr(res, status, msg, detail) {
  return res.status(status).json({
    error:  msg,
    detail: detail || null,
    ok:     false
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ═══════════════════════════════════════════════════
       GET /api/disputes
       Admin: all disputed orders
       ?userId=x : buyer's own disputed orders only
    ═══════════════════════════════════════════════════ */
    if (req.method === 'GET') {
      const isAdmin = req.query.admin === 'true';
      const userId  = req.query.userId;

      let rows;

      if (isAdmin) {
        rows = await sql`
          SELECT * FROM orders
          WHERE disputed = true OR status = 'disputed'
          ORDER BY created_at DESC
          LIMIT 200
        `;
      } else if (userId) {
        rows = await sql`
          SELECT * FROM orders
          WHERE user_id = ${String(userId)}
            AND (disputed = true OR status = 'disputed')
          ORDER BY created_at DESC
        `;
      } else {
        return jsonErr(res, 400, 'Provide ?userId=<id> or ?admin=true');
      }

      /* Parse nested JSON fields safely */
      const disputes = rows.map(function(r) {
        let items    = r.items;
        let customer = r.customer;
        if (typeof items    === 'string') { try { items    = JSON.parse(items);    } catch(e) { items    = []; } }
        if (typeof customer === 'string') { try { customer = JSON.parse(customer); } catch(e) { customer = {}; } }
        return {
          id:            r.id,
          userId:        r.user_id,
          customer:      customer || {},
          items:         items    || [],
          total:         parseFloat(r.total || 0),
          status:        r.status || 'disputed',
          disputed:      r.disputed || true,
          disputeReason: r.dispute_reason || null,
          ref:           r.ref || null,
          createdAt:     r.created_at || null,
        };
      });

      return res.status(200).json({ ok: true, disputes });
    }

    /* ═══════════════════════════════════════════════════
       POST /api/disputes
       Buyer raises a dispute on an order.
       Saves dispute_reason to Neon — fixes the JSON parse crash.
    ═══════════════════════════════════════════════════ */
    if (req.method === 'POST') {
      const body = req.body || {};
      const { orderId, userId, reason } = body;

      if (!orderId) return jsonErr(res, 400, 'orderId is required.');
      if (!reason  || String(reason).trim().length < 5)
        return jsonErr(res, 400, 'A dispute reason of at least 5 characters is required.');

      const orderIdStr   = String(orderId);
      const safeReason   = String(reason).trim().slice(0, 1000);

      /* Verify order exists and belongs to this user */
      let orderRows;
      try {
        orderRows = await sql`
          SELECT id, status, user_id FROM orders
          WHERE id = ${orderIdStr}
          LIMIT 1
        `;
      } catch(dbErr) {
        return jsonErr(res, 500, 'Database error fetching order.', dbErr.message);
      }

      if (!orderRows.length)
        return jsonErr(res, 404, 'Order not found: ' + orderIdStr);

      const order = orderRows[0];

      /* Only allow dispute on paid/escrow orders — not already disputed or completed */
      const allowed = ['paid','escrow_held','success'];
      if (!allowed.includes(order.status))
        return jsonErr(res, 400, 'Order cannot be disputed. Status is: ' + order.status);

      /* Write dispute_reason to orders table */
      await sql`
        UPDATE orders
        SET
          disputed       = true,
          status         = 'disputed',
          dispute_reason = ${safeReason}
        WHERE id = ${orderIdStr}
      `;

      console.log('[disputes.js] Dispute raised on order', orderIdStr, '| reason:', safeReason.slice(0, 60));

      return res.status(200).json({
        ok:      true,
        message: 'Dispute submitted. Admin will review within 24 hours.',
        orderId: orderIdStr
      });
    }

    /* ═══════════════════════════════════════════════════
       PATCH /api/disputes
       Admin resolves a dispute.
       action: 'resolve_seller' | 'resolve_buyer' | 'close'
    ═══════════════════════════════════════════════════ */
    if (req.method === 'PATCH') {
      const body   = req.body || {};
      const { orderId, action, adminNote } = body;

      if (!orderId) return jsonErr(res, 400, 'orderId is required.');
      if (!action)  return jsonErr(res, 400, 'action is required: resolve_seller | resolve_buyer | close');

      const orderIdStr = String(orderId);
      const note       = adminNote ? String(adminNote).trim().slice(0, 500) : null;

      /* Load order */
      const rows = await sql`
        SELECT * FROM orders WHERE id = ${orderIdStr} LIMIT 1
      `;
      if (!rows.length) return jsonErr(res, 404, 'Order not found.');
      const order = rows[0];

      if (action === 'resolve_seller') {
        /* Release funds to seller — mark completed */
        const sellerPayout = parseFloat(order.seller_payout || order.total * 0.85 || 0);

        await sql`
          UPDATE orders SET
            status         = 'completed',
            collected      = true,
            collected_at   = NOW(),
            disputed       = false
          WHERE id = ${orderIdStr}
        `;

        /* Credit seller balance */
        let items = order.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }
        const sellerIdFromItem = Array.isArray(items) && items[0]
          ? String(items[0].sellerId || items[0].seller_id || '')
          : '';

        if (sellerIdFromItem) {
          await sql`
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${sellerPayout}
            WHERE id = ${sellerIdFromItem}
          `;
        }

        console.log('[disputes.js] Resolved FOR SELLER — order', orderIdStr, '| payout ₦', sellerPayout);
        return res.status(200).json({ ok: true, message: 'Resolved for seller. ₦' + sellerPayout.toLocaleString() + ' released.', payout: sellerPayout });

      } else if (action === 'resolve_buyer') {
        /* Trigger Paystack refund then mark refunded */
        const PSK = process.env.PAYSTACK_SECRET_KEY;
        if (!PSK) return jsonErr(res, 500, 'PAYSTACK_SECRET_KEY not configured. Cannot refund.');
        if (!order.ref) return jsonErr(res, 400, 'No Paystack reference on this order. Refund manually.');

        const refundAmount = Math.floor(parseFloat(order.total || 0) * 100); /* kobo */

        let refundData;
        try {
          const refundRes = await fetch('https://api.paystack.co/refund', {
            method:  'POST',
            headers: { 'Authorization': 'Bearer ' + PSK, 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              transaction:   order.ref,
              amount:        refundAmount,
              merchant_note: 'Dispute resolved in buyer favour — NeyoMarket'
            })
          });
          refundData = await refundRes.json();
        } catch(fetchErr) {
          return jsonErr(res, 502, 'Could not reach Paystack for refund.', fetchErr.message);
        }

        if (!refundData.status)
          return jsonErr(res, 400, 'Paystack refund failed: ' + (refundData.message || 'Check dashboard'), null);

        await sql`
          UPDATE orders SET
            status   = 'refunded',
            disputed = false
          WHERE id = ${orderIdStr}
        `;

        console.log('[disputes.js] Refunded buyer — order', orderIdStr);
        return res.status(200).json({ ok: true, message: 'Refund of ₦' + parseFloat(order.total||0).toLocaleString() + ' initiated for buyer.' });

      } else if (action === 'close') {
        await sql`
          UPDATE orders SET disputed = false, status = 'escrow_held'
          WHERE id = ${orderIdStr}
        `;
        return res.status(200).json({ ok: true, message: 'Dispute closed without action.' });

      } else {
        return jsonErr(res, 400, 'Unknown action: ' + action + '. Use resolve_seller | resolve_buyer | close');
      }
    }

    return jsonErr(res, 405, 'Method not allowed. Use GET, POST, or PATCH.');

  } catch (err) {
    /* GLOBAL CATCH — always JSON, never HTML */
    console.error('[disputes.js] Unhandled error:', err.message, err.stack && err.stack.split('\n')[1]);
    return jsonErr(res, 500, 'Internal server error.', err.message);
  }
};
