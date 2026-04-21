// /api/payment.js — NeyoMarket Payment Engine
// Handles: payment confirmation, 90/5/5 split, DVC escrow release, Paystack refund
// DATABASE_URL and PAYSTACK_SECRET_KEY must be set in Vercel environment variables.

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const sql          = neon(process.env.DATABASE_URL);
const PSK          = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL || 'admin@neyomarket.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');
}

async function verifyPaystackPayment(reference) {
  try {
    const r    = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      headers: { 'Authorization': 'Bearer ' + PSK }
    });
    const text = await r.text();
    if (!text) return null;
    const data = JSON.parse(text);
    return (data.status === true && data.data) ? data.data : null;
  } catch (e) {
    console.error('[payment] verify error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ════════════════════════════════════════════════════════════
     POST /api/payment?action=confirm
     Called immediately after Paystack callback fires.
     Verifies with Paystack, saves order, runs 90/5/5 split.
  ════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'confirm') {
    const {
      reference, orderId, userId, items, total,
      customer, mode, sellerUserId, affCode, shipping
    } = req.body || {};

    if (!reference || !orderId || !total)
      return res.status(400).json({ error: 'reference, orderId and total are required.' });

    try {
      /* Idempotency: if already confirmed, return cached result */
      const existing = await sql`SELECT id, status FROM orders WHERE id = ${String(orderId)} LIMIT 1`;
      if (existing.length && existing[0].status === 'paid') {
        return res.status(200).json({ ok: true, cached: true, orderId, status: 'paid' });
      }

      /* Verify with Paystack */
      let amount = parseFloat(total);
      if (PSK) {
        const txn = await verifyPaystackPayment(reference);
        if (!txn || txn.status !== 'success')
          return res.status(402).json({
            error: 'Payment not confirmed by Paystack. Contact support with ref: ' + reference
          });
        amount = txn.amount / 100;
      }

      /* ── 90 / 5 / 5 split ── */
      const platformFee  = Math.round(amount * 0.05);
      const affiliateFee = (affCode && affCode !== 'GUEST') ? Math.round(amount * 0.05) : 0;
      const sellerAmount = Math.round(amount - platformFee - affiliateFee);

      /* Find affiliate user */
      let affUserId = null;
      if (affiliateFee > 0) {
        const affRows = await sql`SELECT id FROM users WHERE aff_code = ${affCode} LIMIT 1`;
        if (affRows.length) affUserId = String(affRows[0].id);
      }

      /* Determine order status:
         - Digital products: mark 'paid' immediately (instant download)
         - Physical products: mark 'escrow_held' (awaits DVC confirmation) */
      const isDigital   = Array.isArray(items) && items.every(function(i) {
        return i.type === 'digital' || i.type === 'course';
      });
      const orderStatus = isDigital ? 'paid' : 'escrow_held';

      /* Atomic insert + balance updates */
      await sql`
        WITH
          ins AS (
            INSERT INTO orders (
              id, user_id, customer, items, total, platform_fee,
              seller_payout, affiliate_fee, aff_code,
              status, collected, mode, ref, shipping, created_at
            ) VALUES (
              ${String(orderId)},
              ${String(userId || '')},
              ${JSON.stringify(customer  || {})},
              ${JSON.stringify(items     || [])},
              ${amount},
              ${platformFee},
              ${sellerAmount},
              ${affiliateFee},
              ${affCode || null},
              ${orderStatus},
              ${false},
              ${mode || 'standard'},
              ${reference},
              ${JSON.stringify(shipping || null)},
              NOW()
            )
            ON CONFLICT (id) DO UPDATE
              SET status = EXCLUDED.status, ref = EXCLUDED.ref
          ),
          upd_seller AS (
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${isDigital ? sellerAmount : 0}
            WHERE id = ${String(sellerUserId || '0')}
              AND ${isDigital && !!sellerUserId}
          ),
          upd_admin AS (
            UPDATE users
            SET admin_balance = COALESCE(admin_balance, 0) + ${platformFee}
            WHERE LOWER(email) = LOWER(${ADMIN_EMAIL})
          ),
          upd_aff AS (
            UPDATE users
            SET affiliate_balance = COALESCE(affiliate_balance, 0) + ${affiliateFee}
            WHERE id = ${affUserId || '0'}
              AND ${affiliateFee > 0 && !!affUserId}
          )
        SELECT 1
      `;

      /* Record affiliate commission separately */
      if (affiliateFee > 0 && affUserId) {
        await sql`
          INSERT INTO affiliate_commissions
            (aff_user_id, aff_code, order_id, order_amount, commission, status, created_at)
          VALUES
            (${affUserId}, ${affCode}, ${String(orderId)}, ${amount}, ${affiliateFee}, ${'pending'}, NOW())
          ON CONFLICT (order_id) DO NOTHING
        `;
      }

      console.log('[payment] confirmed', orderId, '₦' + amount, '→ seller ₦' + sellerAmount, 'status:', orderStatus);

      return res.status(200).json({
        ok:           true,
        orderId,
        amount,
        sellerAmount,
        platformFee,
        affiliateFee,
        status:       orderStatus
      });

    } catch (err) {
      console.error('[payment confirm]', err);
      return res.status(500).json({ error: 'Order save failed: ' + err.message });
    }
  }

  /* ════════════════════════════════════════════════════════════
     POST /api/payment?action=dvc-release
     Seller enters the 6-digit Delivery Verification Code.
     Server validates it, marks order complete, credits seller.
     Body: { orderId, dvcCode, sellerUserId }
  ════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'dvc-release') {
    const { orderId, dvcCode, sellerUserId } = req.body || {};
    if (!orderId || !dvcCode)
      return res.status(400).json({ error: 'orderId and dvcCode are required.' });

    try {
      const rows = await sql`
        SELECT * FROM orders WHERE id = ${String(orderId)} LIMIT 1
      `;
      if (!rows.length)
        return res.status(404).json({ error: 'Order not found.' });

      const order = rows[0];

      if (order.status === 'completed')
        return res.status(200).json({ ok: true, cached: true, message: 'Order already completed.' });

      if (order.status !== 'escrow_held' && order.status !== 'paid')
        return res.status(400).json({ error: 'Order is not in escrow. Status: ' + order.status });

      /* Validate the DVC code — same deterministic algorithm as frontend */
      const expectedCode = generateDVC(String(orderId));
      if (String(dvcCode).trim() !== expectedCode)
        return res.status(400).json({ error: 'Incorrect delivery code. Ask the buyer for their code.' });

      const sellerPayout = parseFloat(order.seller_payout || 0);
      const sid          = sellerUserId || order.user_id;

      /* Mark complete + credit seller atomically */
      await sql`
        WITH
          upd_order AS (
            UPDATE orders
            SET status    = 'completed',
                collected = true
            WHERE id = ${String(orderId)}
          ),
          upd_seller AS (
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${sellerPayout}
            WHERE id = ${String(sid || '0')}
              AND ${!!sid}
          )
        SELECT 1
      `;

      console.log('[payment] DVC release for', orderId, '→ seller ₦' + sellerPayout);

      return res.status(200).json({
        ok:      true,
        orderId,
        released: sellerPayout,
        message: 'Delivery confirmed. ₦' + sellerPayout.toLocaleString() + ' released to seller.'
      });

    } catch (err) {
      console.error('[payment dvc-release]', err);
      return res.status(500).json({ error: err.message });
    }
  }

  /* ════════════════════════════════════════════════════════════
     POST /api/payment?action=refund
     Admin triggers a full Paystack refund for a disputed order.
     Body: { orderId, reference, amount }
  ════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'refund') {
    const { orderId, reference, amount } = req.body || {};
    if (!orderId || !reference)
      return res.status(400).json({ error: 'orderId and reference are required.' });
    if (!PSK)
      return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not configured.' });

    try {
      const body = { transaction: reference };
      if (amount) body.amount = Math.round(parseFloat(amount) * 100); // kobo

      const r    = await fetch('https://api.paystack.co/refund', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + PSK,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await r.json();

      if (!data.status)
        return res.status(400).json({ error: 'Paystack refund failed: ' + (data.message || 'Unknown') });

      await sql`
        UPDATE orders
        SET status    = 'refunded',
            collected = true
        WHERE id = ${String(orderId)}
      `;

      console.log('[payment] refund issued for', orderId, 'ref:', reference);
      return res.status(200).json({ ok: true, message: 'Refund initiated via Paystack.' });

    } catch (err) {
      console.error('[payment refund]', err);
      return res.status(500).json({ error: err.message });
    }
  }

  /* ════════════════════════════════════════════════════════════
     GET /api/payment?action=order&orderId=xxx
     Returns order status — drives download button on frontend.
  ════════════════════════════════════════════════════════════ */
  if (req.method === 'GET' && req.query.action === 'order') {
    const orderId = req.query.orderId;
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

  /* ════════════════════════════════════════════════════════════
     POST /api/payment?action=webhook
     Paystack sends this on every charge.success event.
     Set webhook URL in: Paystack Dashboard → Settings → Webhooks
     URL: https://neyo-market.vercel.app/api/payment?action=webhook
  ════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && req.query.action === 'webhook') {
    const secret   = PSK || '';
    const expected = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (expected !== req.headers['x-paystack-signature']) {
      console.warn('[webhook] invalid signature — rejected');
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const event = req.body;
    if (event.event === 'charge.success') {
      const ref    = event.data.reference;
      const amount = event.data.amount / 100;
      try {
        await sql`UPDATE orders SET status = 'paid' WHERE ref = ${ref} AND status != 'paid'`;
        console.log('[webhook] charge.success:', ref, '₦' + amount);
      } catch (e) {
        console.error('[webhook] db error:', e.message);
      }
    }

    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};

/* ────────────────────────────────────────────────────────────
   generateDVC — deterministic 6-digit code from orderId.
   MUST match the identical function in index.html exactly.
──────────────────────────────────────────────────────────── */
function generateDVC(orderId) {
  let hash = 0;
  const str = String(orderId);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(Math.abs(hash) % 900000 + 100000);
}
