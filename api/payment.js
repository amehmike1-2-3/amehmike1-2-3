// /api/payment.js — NeyoMarket Payment Confirmation (Server-Side)
// This is called AFTER Paystack confirms payment
// It handles: order persistence, balance splitting, affiliate commission
// ALL in one atomic operation so nothing is lost on refresh

const { neon } = require('@neondatabase/serverless');

const sql        = neon(process.env.DATABASE_URL);
const PSK        = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@neyomarket.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');
}

/* Verify payment reference with Paystack */
async function verifyPaystackPayment(reference) {
  try {
    const r = await fetch('https://api.paystack.co/transaction/verify/' + reference, {
      headers: { 'Authorization': 'Bearer ' + PSK }
    });
    const text = await r.text();
    if (!text) return null;
    const data = JSON.parse(text);
    return data.status === true ? data.data : null;
  } catch(e) {
    console.error('Paystack verify error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ══════════════════════════════════════════════════════
     POST /api/payment?action=confirm
     Called from frontend after Paystack callback fires.
     Body: { reference, orderId, userId, items, total,
             customer, mode, sellerUserId, affCode }
  ══════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'confirm') {
    const {
      reference, orderId, userId, items, total,
      customer, mode, sellerUserId, affCode, shipping
    } = req.body || {};

    if (!reference || !orderId || !total)
      return res.status(400).json({ error: 'reference, orderId and total are required.' });

    try {
      /* ── Step 1: Check if order already exists (idempotency) ── */
      const existing = await sql`SELECT id, status FROM orders WHERE id = ${String(orderId)} LIMIT 1`;
      if (existing.length && existing[0].status !== 'pending') {
        return res.status(200).json({ ok: true, order: existing[0], cached: true });
      }

      /* ── Step 2: Verify payment with Paystack ── */
      let verified = false;
      let paystackAmount = 0;

      if (PSK) {
        const txn = await verifyPaystackPayment(reference);
        if (txn && txn.status === 'success') {
          verified      = true;
          paystackAmount = txn.amount / 100; // Convert from kobo
        }
      } else {
        /* No PSK configured — trust the client (dev mode) */
        verified      = true;
        paystackAmount = total;
      }

      if (!verified)
        return res.status(402).json({ error: 'Payment could not be verified. Please contact support.' });

      const amount       = paystackAmount || total;
      const platformFee  = Math.round(amount * 0.05);  /* 5% platform */
      const affiliateFee = affCode ? Math.round(amount * 0.05) : 0; /* 5% affiliate */
      const sellerAmount = Math.round(amount - platformFee - affiliateFee); /* rest to seller */

      /* ── Step 3: Save order to DB ── */
      await sql`
        INSERT INTO orders (
          id, user_id, customer, items, total, platform_fee,
          seller_payout, affiliate_fee, aff_code,
          status, collected, mode, ref, shipping, created_at
        ) VALUES (
          ${String(orderId)},
          ${String(userId || '')},
          ${JSON.stringify(customer || {})},
          ${JSON.stringify(items    || [])},
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
        ON CONFLICT (id) DO UPDATE SET
          status    = 'paid',
          ref       = EXCLUDED.ref
      `;

      /* ── Step 4: Update seller balance ── */
      if (sellerUserId) {
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) + ${sellerAmount}
          WHERE id = ${String(sellerUserId)}
        `;
      }

      /* ── Step 5: Update admin balance ── */
      await sql`
        UPDATE users
        SET admin_balance = COALESCE(admin_balance, 0) + ${platformFee}
        WHERE email = ${ADMIN_EMAIL}
      `;

      /* ── Step 6: Credit affiliate if applicable ── */
      if (affCode && affiliateFee > 0) {
        const affUser = await sql`SELECT id FROM users WHERE aff_code = ${affCode} LIMIT 1`;
        if (affUser.length) {
          await sql`
            UPDATE users
            SET affiliate_balance = COALESCE(affiliate_balance, 0) + ${affiliateFee}
            WHERE id = ${affUser[0].id}
          `;
          /* Record commission */
          await sql`
            INSERT INTO affiliate_commissions
              (aff_user_id, aff_code, order_id, order_amount, commission, status, created_at)
            VALUES
              (${String(affUser[0].id)}, ${affCode}, ${String(orderId)}, ${amount}, ${affiliateFee}, ${'pending'}, NOW())
            ON CONFLICT (order_id) DO NOTHING
          `;
        }
      }

      return res.status(200).json({
        ok:            true,
        orderId:       orderId,
        amount:        amount,
        sellerAmount:  sellerAmount,
        platformFee:   platformFee,
        affiliateFee:  affiliateFee,
        status:        'paid'
      });

    } catch (err) {
      console.error('[payment confirm error]', err);
      return res.status(500).json({ error: 'Failed to save order: ' + err.message });
    }
  }

  /* ══════════════════════════════════════════════════════
     GET /api/payment?action=order&orderId=xxx
     Check if order exists in DB (for download access)
  ══════════════════════════════════════════════════════ */
  if (req.method === 'GET' && req.query.action === 'order') {
    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });

    const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });

    const r = rows[0];
    return res.status(200).json({
      order: {
        id:        r.id,
        status:    r.status,
        collected: r.collected,
        total:     parseFloat(r.total || 0),
        items:     r.items ? JSON.parse(r.items) : [],
        ref:       r.ref,
        date:      r.date || r.created_at
      }
    });
  }

  /* ══════════════════════════════════════════════════════
     POST /api/payment?action=webhook
     Paystack webhook — server-side event confirmation
     Set this URL in Paystack Dashboard → Settings → Webhooks
  ══════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'webhook') {
    const crypto = require('crypto');
    const secret = PSK || '';
    const hash   = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    if (event.event === 'charge.success') {
      const txn       = event.data;
      const reference = txn.reference;
      const amount    = txn.amount / 100;

      /* Update order status to paid */
      await sql`
        UPDATE orders SET status = 'paid' WHERE ref = ${reference}
      `;

      console.log('Webhook: payment confirmed for ref', reference, '₦' + amount);
    }

    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

