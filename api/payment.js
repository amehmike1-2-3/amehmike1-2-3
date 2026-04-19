// /api/payment.js — NeyoMarket Payment Confirmation
// Atomic 90/5/5 wallet split + Paystack webhook verification

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const sql         = neon(process.env.DATABASE_URL);
const PSK         = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@neyomarket.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');
}

/* Verify payment reference directly with Paystack */
async function verifyPaystackPayment(reference) {
  try {
    const r    = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      headers: { 'Authorization': 'Bearer ' + PSK }
    });
    const text = await r.text();
    if (!text || text.trim() === '') return null;
    const data = JSON.parse(text);
    return (data.status === true && data.data) ? data.data : null;
  } catch (e) {
    console.error('[payment] Paystack verify error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ════════════════════════════════════════════════════════
     POST /api/payment?action=confirm
     Called from browser immediately after Paystack callback.
     Body: { reference, orderId, userId, items, total,
             customer, mode, sellerUserId, affCode, shipping }
  ════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'confirm') {
    const {
      reference, orderId, userId, items, total,
      customer, mode, sellerUserId, affCode, shipping
    } = req.body || {};

    if (!reference || !orderId || !total)
      return res.status(400).json({ error: 'reference, orderId and total are required.' });

    try {
      /* ── Idempotency: if order already confirmed, return it ── */
      const existing = await sql`
        SELECT id, status FROM orders WHERE id = ${String(orderId)} LIMIT 1
      `;
      if (existing.length && existing[0].status === 'paid') {
        return res.status(200).json({ ok: true, cached: true, orderId, status: 'paid' });
      }

      /* ── Verify with Paystack ── */
      let amount = parseFloat(total);
      if (PSK) {
        const txn = await verifyPaystackPayment(reference);
        if (!txn || txn.status !== 'success')
          return res.status(402).json({ error: 'Payment not confirmed by Paystack. Please contact support with ref: ' + reference });
        amount = txn.amount / 100; // Paystack stores in kobo
      }

      /* ── Calculate 90 / 5 / 5 split ── */
      const platformFee  = Math.round(amount * 0.05);
      const affiliateFee = (affCode && affCode !== 'GUEST') ? Math.round(amount * 0.05) : 0;
      const sellerAmount = Math.round(amount - platformFee - affiliateFee);

      /* ── Find affiliate user ID ── */
      let affUserId = null;
      if (affiliateFee > 0) {
        const affRows = await sql`SELECT id FROM users WHERE aff_code = ${affCode} LIMIT 1`;
        if (affRows.length) affUserId = String(affRows[0].id);
      }

      /* ════════════════════════════════════════════════════════
         ATOMIC TRANSACTION
         All 4 writes happen in one round-trip.
         If any fails the whole thing rolls back automatically.
      ════════════════════════════════════════════════════════ */
      await sql`
        WITH
          -- Insert or update the order
          upsert_order AS (
            INSERT INTO orders (
              id, user_id, customer, items, total, platform_fee,
              seller_payout, affiliate_fee, aff_code,
              status, collected, mode, ref, shipping, created_at
            ) VALUES (
              ${String(orderId)},
              ${String(userId   || '')},
              ${JSON.stringify(customer  || {})},
              ${JSON.stringify(items     || [])},
              ${amount},
              ${platformFee},
              ${sellerAmount},
              ${affiliateFee},
              ${affCode || null},
              ${'paid'},
              ${false},
              ${mode || 'standard'},
              ${reference},
              ${JSON.stringify(shipping || null)},
              NOW()
            )
            ON CONFLICT (id) DO UPDATE
              SET status = 'paid', ref = EXCLUDED.ref
          ),
          -- Credit seller wallet
          credit_seller AS (
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${sellerAmount}
            WHERE id = ${String(sellerUserId || '0')}
              AND ${!!sellerUserId}
          ),
          -- Credit platform (admin) wallet
          credit_admin AS (
            UPDATE users
            SET admin_balance = COALESCE(admin_balance, 0) + ${platformFee}
            WHERE LOWER(email) = LOWER(${ADMIN_EMAIL})
          ),
          -- Credit affiliate wallet (only if affiliate exists)
          credit_affiliate AS (
            UPDATE users
            SET affiliate_balance = COALESCE(affiliate_balance, 0) + ${affiliateFee}
            WHERE id = ${affUserId || '0'}
              AND ${affiliateFee > 0 && !!affUserId}
          )
        SELECT 1
      `;

      /* Record affiliate commission separately (not in main txn to avoid deadlock) */
      if (affiliateFee > 0 && affUserId) {
        await sql`
          INSERT INTO affiliate_commissions
            (aff_user_id, aff_code, order_id, order_amount, commission, status, created_at)
          VALUES
            (${affUserId}, ${affCode}, ${String(orderId)}, ${amount}, ${affiliateFee}, ${'pending'}, NOW())
          ON CONFLICT (order_id) DO NOTHING
        `;
      }

      return res.status(200).json({
        ok:           true,
        orderId,
        amount,
        sellerAmount,
        platformFee,
        affiliateFee,
        status:       'paid'
      });

    } catch (err) {
      console.error('[payment confirm]', err);
      return res.status(500).json({ error: 'Order save failed: ' + err.message });
    }
  }

  /* ════════════════════════════════════════════════════════
     GET /api/payment?action=order&orderId=xxx
     Checks DB for order status — drives download button
  ════════════════════════════════════════════════════════ */
  if (req.method === 'GET' && req.query.action === 'order') {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });

    try {
      const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
      const r = rows[0];
      return res.status(200).json({
        order: {
          id:        r.id,
          status:    r.status,
          collected: r.collected,
          total:     parseFloat(r.total || 0),
          items:     r.items ? (typeof r.items === 'object' ? r.items : JSON.parse(r.items)) : [],
          ref:       r.ref,
          date:      r.date || r.created_at
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  /* ════════════════════════════════════════════════════════
     POST /api/payment?action=webhook
     Paystack sends this after every charge.success event.
     Set URL in: Paystack Dashboard → Settings → Webhooks
     URL: https://neyo-market.vercel.app/api/payment?action=webhook
  ════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'webhook') {
    const signature = req.headers['x-paystack-signature'] || '';
    const secret    = PSK || '';

    /* Verify HMAC-SHA512 signature — rejects any forged events */
    const expected = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (expected !== signature) {
      console.warn('[webhook] Invalid signature — rejected');
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const ref    = event.data.reference;
      const amount = event.data.amount / 100;
      try {
        await sql`UPDATE orders SET status = 'paid' WHERE ref = ${ref} AND status != 'paid'`;
        console.log('[webhook] charge.success confirmed:', ref, '₦' + amount);
      } catch (e) {
        console.error('[webhook] DB error:', e.message);
      }
    }

    /* Always return 200 to Paystack or it will retry */
    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
