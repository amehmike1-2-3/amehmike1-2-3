// /api/payment.js — NeyoMarket Payment Engine
// Compatible with: products.js, orders.js, transactions.js, paystack.js, webhook.js
//
// Routes:
//   POST ?action=confirm     — verify with Paystack, save order, compute split, write admin_transactions
//   POST ?action=dvc-release — seller enters 6-digit DVC to release physical escrow
//   POST ?action=refund      — admin triggers full Paystack refund for disputed order
//   GET  ?action=order       — fetch single order status (drives download/confirm button)
//   POST ?action=webhook     — Paystack charge.success webhook (fallback handler)
//
// Commission model (matches index.html markCol/markDL and transactions.js exactly):
//   With valid affiliate referral, digital  → Seller 80%, Platform 15%, Affiliate 5%
//   With valid affiliate referral, physical → Seller 88%, Platform  7%, Affiliate 5%
//   No referral, digital                    → Seller 90%, Platform 10%, Affiliate  0%
//   No referral, physical                   → Seller 95%, Platform  5%, Affiliate  0%
//
// Platform fee goes to admin_balance in users table + row written to admin_transactions.
// Affiliate commission goes to seller_balance of the aff_code owner.
// Seller payout goes to seller_balance only when order is COMPLETED (digital = on confirm,
// physical = on DVC release). Never credited on 'escrow_held'.
//
// No AI features. No CEO office. Pure payment + escrow logic.

'use strict';

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const sql         = neon(process.env.DATABASE_URL);
const PSK         = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@neyomarket.com';

/* ── CORS ── */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');
  res.setHeader('X-Content-Type-Options',       'nosniff');
}

/* ── JSON-only errors — never return HTML ── */
function jsonErr(res, status, msg, detail) {
  return res.status(status).json({ ok: false, error: msg, detail: detail || null });
}

/* ── Verify payment with Paystack API ── */
async function verifyPaystackPayment(reference) {
  try {
    const r    = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      headers: { 'Authorization': 'Bearer ' + PSK }
    });
    const text = await r.text();
    if (!text || !text.trim()) return null;
    const data = JSON.parse(text);
    return (data.status === true && data.data) ? data.data : null;
  } catch (e) {
    console.error('[payment] Paystack verify error:', e.message);
    return null;
  }
}

/* ── Commission split — matches index.html markCol/markDL and transactions.js exactly ──
   hasPhysical: true if ANY item in the order is type 'physical'
   hasValidAff: true if aff_code is non-empty, length > 2, and validated upstream
*/
function computeSplit(total, hasPhysical, hasValidAff) {
  let platformRate, affiliateRate;
  if (hasValidAff) {
    platformRate  = hasPhysical ? 0.07 : 0.15;
    affiliateRate = 0.05;
  } else {
    platformRate  = hasPhysical ? 0.05 : 0.10;
    affiliateRate = 0;
  }
  const sellerRate   = 1 - platformRate - affiliateRate;
  const platformFee  = Math.round(total * platformRate);
  const affiliateFee = Math.round(total * affiliateRate);
  const sellerPayout = Math.round(total * sellerRate);
  return { platformFee, affiliateFee, sellerPayout, platformRate, affiliateRate, sellerRate };
}

/* ── Deterministic 6-digit DVC — MUST match index.html generateDVC() exactly ── */
function generateDVC(orderId) {
  let hash = 0;
  const str = String(orderId);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(Math.abs(hash) % 900000 + 100000);
}

/* ── Write a row to admin_transactions for full admin visibility ──
   Non-fatal: if table doesn't exist yet, logs warning and continues. */
async function recordAdminTransaction(params) {
  const { orderId, total, platformFee, sellerPayout, affiliateFee,
          affCode, sellerId, type } = params;
  try {
    await sql`
      INSERT INTO admin_transactions (
        order_id, total, platform_fee, seller_payout,
        affiliate_fee, aff_code, seller_id,
        released_by, type, created_at
      ) VALUES (
        ${String(orderId)},
        ${parseFloat(total  || 0)},
        ${parseFloat(platformFee  || 0)},
        ${parseFloat(sellerPayout || 0)},
        ${parseFloat(affiliateFee || 0)},
        ${affCode  ? String(affCode)  : null},
        ${sellerId ? String(sellerId) : null},
        ${'payment'},
        ${type || 'payment'},
        NOW()
      )
      ON CONFLICT (order_id) DO NOTHING
    `;
  } catch (e) {
    if (e.message && e.message.includes('does not exist')) {
      console.warn('[payment] admin_transactions table not yet created — run migration.');
    } else {
      console.error('[payment] recordAdminTransaction error (non-fatal):', e.message);
    }
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  /* ══════════════════════════════════════════════════════════════
     POST ?action=confirm
     Called by frontend immediately after Paystack callback fires.
     1. Checks idempotency (already confirmed? return cached)
     2. Verifies payment with Paystack API
     3. Computes tiered commission split
     4. Inserts order into Neon with all split fields
     5. Credits admin_balance (platform fee) immediately
     6. Credits affiliate's seller_balance if valid aff_code
     7. Credits seller_balance ONLY for digital/course products
        (physical stays in escrow until DVC release)
     8. Writes row to admin_transactions
     9. Generates delivery_code for physical orders
  ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'confirm') {
    const {
      reference, orderId, userId, items, total,
      customer, mode, sellerUserId, affCode, shipping
    } = req.body || {};

    if (!reference || !orderId || !total)
      return jsonErr(res, 400, 'reference, orderId and total are required.');

    try {
      /* ── Idempotency: already confirmed → return cached ── */
      const existing = await sql`
        SELECT id, status FROM orders WHERE id = ${String(orderId)} LIMIT 1
      `;
      if (existing.length && (existing[0].status === 'paid' || existing[0].status === 'escrow_held' || existing[0].status === 'completed')) {
        return res.status(200).json({
          ok:      true,
          cached:  true,
          orderId,
          status:  existing[0].status
        });
      }

      /* ── Verify with Paystack (skip in test mode if no PSK) ── */
      let amount = parseFloat(total);
      if (PSK) {
        const txn = await verifyPaystackPayment(reference);
        if (!txn || txn.status !== 'success') {
          return jsonErr(res, 402,
            'Payment not confirmed by Paystack. Contact support with ref: ' + reference
          );
        }
        amount = txn.amount / 100; /* kobo → naira */
      }

      /* ── Parse items ── */
      const itemList = Array.isArray(items) ? items : [];

      /* ── Determine physical/digital ── */
      const hasPhysical = itemList.some(function(i) {
        return i.type === 'physical';
      });
      const isAllDigital = itemList.length > 0 && itemList.every(function(i) {
        return i.type === 'digital' || i.type === 'course';
      });

      /* ── Validate affiliate code ── */
      const rawAff    = (affCode && typeof affCode === 'string') ? affCode.trim() : '';
      const hasValidAff = rawAff.length > 2 && rawAff !== 'GUEST';

      /* ── Compute tiered split ── */
      const split = computeSplit(amount, hasPhysical, hasValidAff);

      /* ── Find affiliate user ID ── */
      let affUserId = null;
      if (hasValidAff && split.affiliateFee > 0) {
        const affRows = await sql`
          SELECT id FROM users WHERE aff_code = ${rawAff} LIMIT 1
        `;
        if (affRows.length) affUserId = String(affRows[0].id);
      }

      /* ── Find seller ID from items if not passed ── */
      const resolvedSellerId = sellerUserId
        ? String(sellerUserId)
        : (itemList[0] && (itemList[0].sellerId || itemList[0].seller_id))
          ? String(itemList[0].sellerId || itemList[0].seller_id)
          : null;

      /* ── Order status:
           digital/course → 'paid' (instant download, escrow released on markDL)
           physical       → 'escrow_held' (funds held until DVC confirmation)     ── */
      const orderStatus = isAllDigital ? 'paid' : 'escrow_held';

      /* ── Generate deterministic 6-digit delivery code ── */
      const deliveryCode = generateDVC(String(orderId));

      /* ── Fetch file_url from products for digital orders ── */
      let topFileUrl = null;
      if (isAllDigital && itemList.length > 0) {
        const productIds = itemList
          .map(function(i) { return Number(i.id); })
          .filter(function(id) { return !isNaN(id) && id > 0; });
        if (productIds.length) {
          const prods = await sql`
            SELECT id, file_url FROM products WHERE id = ANY(${productIds})
          `;
          const firstWithFile = prods.find(function(p) { return p.file_url; });
          if (firstWithFile) topFileUrl = firstWithFile.file_url;
          /* Merge file_url into each item */
          itemList.forEach(function(item) {
            const prod = prods.find(function(p) { return Number(p.id) === Number(item.id); });
            if (prod && prod.file_url) {
              item.fileUrl = prod.file_url;
            }
          });
        }
      }

      /* ── INSERT order ── */
      const cleanAff = hasValidAff ? rawAff : null;
      await sql`
        INSERT INTO orders (
          id, user_id, customer, items, total,
          platform_fee, seller_payout, affiliate_fee, aff_code,
          status, collected, mode, ref, shipping,
          delivery_code, file_url, date, created_at
        ) VALUES (
          ${String(orderId)},
          ${String(userId || '')},
          ${JSON.stringify(customer  || {})},
          ${JSON.stringify(itemList)},
          ${amount},
          ${split.platformFee},
          ${split.sellerPayout},
          ${split.affiliateFee},
          ${cleanAff},
          ${orderStatus},
          ${false},
          ${mode || 'standard'},
          ${reference},
          ${JSON.stringify(shipping || null)},
          ${deliveryCode},
          ${topFileUrl},
          ${new Date().toLocaleDateString()},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          status        = EXCLUDED.status,
          ref           = EXCLUDED.ref,
          delivery_code = EXCLUDED.delivery_code,
          file_url      = COALESCE(EXCLUDED.file_url, orders.file_url)
      `;

      /* ── Credit platform fee to admin_balance ── */
      if (split.platformFee > 0) {
        await sql`
          UPDATE users
          SET admin_balance = COALESCE(admin_balance, 0) + ${split.platformFee}
          WHERE LOWER(email) = LOWER(${ADMIN_EMAIL})
        `;
      }

      /* ── Credit affiliate seller_balance ── */
      if (affUserId && split.affiliateFee > 0) {
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) + ${split.affiliateFee}
          WHERE id = ${affUserId}
        `;
        /* Record affiliate commission for audit trail */
        try {
          await sql`
            INSERT INTO affiliate_commissions
              (aff_user_id, aff_code, order_id, order_amount, commission, status, created_at)
            VALUES
              (${affUserId}, ${rawAff}, ${String(orderId)}, ${amount}, ${split.affiliateFee}, ${'pending'}, NOW())
            ON CONFLICT (order_id) DO NOTHING
          `;
        } catch (affRecErr) {
          /* Non-fatal — table may not exist */
          console.warn('[payment] affiliate_commissions insert (non-fatal):', affRecErr.message);
        }
      }

      /* ── For digital products: credit seller_balance immediately ──
         Physical products: seller_balance is NOT credited here.
         It is credited only when DVC is validated (dvc-release action). ── */
      if (isAllDigital && resolvedSellerId && split.sellerPayout > 0) {
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) + ${split.sellerPayout}
          WHERE id = ${resolvedSellerId}
        `;
      }

      /* ── Write to admin_transactions for admin dashboard visibility ── */
      await recordAdminTransaction({
        orderId:      String(orderId),
        total:        amount,
        platformFee:  split.platformFee,
        sellerPayout: split.sellerPayout,
        affiliateFee: split.affiliateFee,
        affCode:      cleanAff,
        sellerId:     resolvedSellerId,
        type:         'payment'
      });

      console.log('[payment] confirmed', orderId,
        '₦' + amount,
        '| platform ₦' + split.platformFee,
        '| seller ₦' + split.sellerPayout,
        '| affiliate ₦' + split.affiliateFee,
        '| status:', orderStatus
      );

      return res.status(200).json({
        ok:            true,
        orderId,
        amount,
        platformFee:   split.platformFee,
        sellerPayout:  split.sellerPayout,
        affiliateFee:  split.affiliateFee,
        hasValidAff,
        status:        orderStatus,
        deliveryCode:  orderStatus === 'escrow_held' ? deliveryCode : null
      });

    } catch (err) {
      console.error('[payment confirm]', err.message);
      return jsonErr(res, 500, 'Order save failed.', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     POST ?action=dvc-release
     Seller enters the buyer's 6-digit Delivery Verification Code.
     1. Load order, check it's in escrow (not already completed)
     2. Validate DVC against deterministic hash OR stored delivery_code
     3. Compute split from stored order values (already set at confirm time)
     4. Credit seller_balance
     5. Credit affiliate if applicable
     6. Mark order completed + set collected_at
     7. Write completion row to admin_transactions
     Body: { orderId, dvcCode, sellerUserId }
  ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'dvc-release') {
    const { orderId, dvcCode, sellerUserId } = req.body || {};
    if (!orderId || !dvcCode)
      return jsonErr(res, 400, 'orderId and dvcCode are required.');

    try {
      const rows = await sql`
        SELECT * FROM orders WHERE id = ${String(orderId)} LIMIT 1
      `;
      if (!rows.length)
        return jsonErr(res, 404, 'Order not found: ' + orderId);

      const order = rows[0];

      /* Idempotency */
      if (order.status === 'completed' || order.collected) {
        return res.status(200).json({
          ok:       true,
          cached:   true,
          message:  'Order already completed.',
          released: parseFloat(order.seller_payout || 0)
        });
      }

      /* Only release from escrow or paid status */
      const releasable = ['escrow_held', 'paid', 'success'];
      if (!releasable.includes(order.status)) {
        return jsonErr(res, 400,
          'Order cannot be released. Current status: ' + order.status
        );
      }

      /* ── Validate DVC: check stored delivery_code first, then hash fallback ── */
      const storedCode  = order.delivery_code ? String(order.delivery_code).trim() : null;
      const hashedCode  = generateDVC(String(orderId));
      const expectedCode = storedCode || hashedCode;

      if (String(dvcCode).trim() !== expectedCode) {
        return jsonErr(res, 400,
          'Incorrect delivery code. Ask the buyer to open their Orders page and share the code.'
        );
      }

      /* ── Use stored split values (set at confirm time) ── */
      const sellerPayout  = parseFloat(order.seller_payout  || 0);
      const affiliateFee  = parseFloat(order.affiliate_fee  || 0);
      const collectedAt   = new Date().toISOString();

      /* Determine seller ID — prefer passed sellerUserId, fall back to items */
      let items = order.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }
      if (!Array.isArray(items)) items = [];

      const resolvedSellerId = sellerUserId
        ? String(sellerUserId)
        : (items[0] && (items[0].sellerId || items[0].seller_id))
          ? String(items[0].sellerId || items[0].seller_id)
          : null;

      /* ── Credit seller_balance ── */
      if (resolvedSellerId && sellerPayout > 0) {
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) + ${sellerPayout}
          WHERE id = ${resolvedSellerId}
        `;
      }

      /* ── Credit affiliate if applicable ── */
      const affCode = order.aff_code ? String(order.aff_code).trim() : '';
      if (affCode.length > 2 && affiliateFee > 0) {
        try {
          await sql`
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${affiliateFee}
            WHERE aff_code = ${affCode}
          `;
        } catch (affErr) {
          console.error('[payment dvc-release] Affiliate credit error (non-fatal):', affErr.message);
        }
      }

      /* ── Mark order completed ── */
      await sql`
        UPDATE orders SET
          status       = 'completed',
          collected    = true,
          collected_at = ${collectedAt}
        WHERE id = ${String(orderId)}
      `;

      /* ── Record completion in admin_transactions ── */
      await recordAdminTransaction({
        orderId:      String(orderId),
        total:        parseFloat(order.total || 0),
        platformFee:  parseFloat(order.platform_fee || 0),
        sellerPayout: sellerPayout,
        affiliateFee: affiliateFee,
        affCode:      affCode || null,
        sellerId:     resolvedSellerId,
        type:         'dvc_release'
      });

      console.log('[payment] DVC release — order', orderId,
        '| seller ₦' + sellerPayout,
        '| affiliate ₦' + affiliateFee
      );

      return res.status(200).json({
        ok:       true,
        orderId,
        released: sellerPayout,
        message:  '✅ Delivery confirmed. ₦' + sellerPayout.toLocaleString() + ' released to your wallet.'
      });

    } catch (err) {
      console.error('[payment dvc-release]', err.message);
      return jsonErr(res, 500, 'DVC release failed.', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     POST ?action=refund
     Admin triggers a full Paystack refund for a disputed order.
     Also marks the order 'refunded' in Neon.
     Body: { orderId, reference, amount }
  ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'refund') {
    const { orderId, reference, amount } = req.body || {};
    if (!orderId || !reference)
      return jsonErr(res, 400, 'orderId and reference are required.');
    if (!PSK)
      return jsonErr(res, 500, 'PAYSTACK_SECRET_KEY not configured. Cannot issue refund.');

    try {
      const body = { transaction: reference };
      if (amount) body.amount = Math.round(parseFloat(amount) * 100); /* naira → kobo */

      const r = await fetch('https://api.paystack.co/refund', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + PSK,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify(body)
      });

      let data;
      try {
        data = await r.json();
      } catch(parseErr) {
        return jsonErr(res, 502, 'Paystack returned non-JSON response. Check your dashboard.', parseErr.message);
      }

      if (!data.status)
        return jsonErr(res, 400, 'Paystack refund failed: ' + (data.message || 'Unknown error'));

      await sql`
        UPDATE orders
        SET status    = 'refunded',
            collected = false
        WHERE id = ${String(orderId)}
      `;

      console.log('[payment] refund issued for', orderId, 'ref:', reference);
      return res.status(200).json({
        ok:      true,
        orderId,
        message: 'Refund of ₦' + parseFloat(amount || 0).toLocaleString() + ' initiated via Paystack.'
      });

    } catch (err) {
      console.error('[payment refund]', err.message);
      return jsonErr(res, 500, 'Refund failed.', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     GET ?action=order&orderId=xxx
     Returns full order data — drives download/confirm/DVC buttons.
  ══════════════════════════════════════════════════════════════ */
  if (req.method === 'GET' && action === 'order') {
    const orderId = req.query.orderId;
    if (!orderId) return jsonErr(res, 400, 'orderId required.');

    try {
      const rows = await sql`
        SELECT * FROM orders WHERE id = ${String(orderId)} LIMIT 1
      `;
      if (!rows.length) return jsonErr(res, 404, 'Order not found: ' + orderId);

      const r = rows[0];
      let items = r.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }

      return res.status(200).json({
        ok: true,
        order: {
          id:            r.id,
          userId:        r.user_id,
          status:        r.status,
          collected:     r.collected,
          total:         parseFloat(r.total    || 0),
          platformFee:   parseFloat(r.platform_fee   || 0),
          sellerPayout:  parseFloat(r.seller_payout  || 0),
          affiliateFee:  parseFloat(r.affiliate_fee  || 0),
          affCode:       r.aff_code       || null,
          items:         items || [],
          ref:           r.ref            || '',
          deliveryCode:  r.delivery_code  || null,
          fileUrl:       r.file_url       || null,
          disputed:      r.disputed       || false,
          disputeReason: r.dispute_reason || null,
          date:          r.date           || (r.created_at ? new Date(r.created_at).toLocaleDateString() : ''),
          createdAt:     r.created_at     || null
        }
      });

    } catch (err) {
      console.error('[payment order]', err.message);
      return jsonErr(res, 500, 'Could not fetch order.', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     POST ?action=webhook
     Paystack charge.success fallback webhook.
     Primary webhook handler is /api/webhook.js (handles signature
     verification via raw body). This route handles the legacy
     ?action=webhook path that some Paystack dashboard configs use.
     Sets order to 'escrow_held' if not already updated.
     Webhook URL: https://neyo-market.vercel.app/api/payment?action=webhook
  ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'webhook') {
    if (!PSK) {
      console.warn('[payment webhook] PSK not set — signature check skipped');
    } else {
      const sig = req.headers['x-paystack-signature'] || '';
      const expected = crypto
        .createHmac('sha512', PSK)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (sig !== expected) {
        console.warn('[payment webhook] Invalid signature — rejected');
        return res.status(200).json({ received: false, reason: 'invalid_signature' });
      }
    }

    const event = req.body || {};
    if (event.event === 'charge.success' || event.event === 'dedicated_virtual_account.success') {
      const ref    = event.data && event.data.reference;
      const amount = event.data && event.data.amount ? event.data.amount / 100 : 0;
      if (ref) {
        try {
          await sql`
            UPDATE orders
            SET status = 'escrow_held'
            WHERE ref = ${ref}
              AND status NOT IN ('paid','escrow_held','completed','refunded')
          `;
          console.log('[payment webhook] charge.success:', ref, '₦' + amount);
        } catch (e) {
          console.error('[payment webhook] DB error:', e.message);
        }
      }
    }

    /* Always 200 — Paystack retries on non-2xx */
    return res.status(200).json({ received: true });
  }

  return jsonErr(res, 405, 'Method not allowed. Use: confirm | dvc-release | refund | order | webhook');
};
