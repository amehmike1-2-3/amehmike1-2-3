// api/staff-gate.js — NeyoMarket Staff Portal Backend
// Handles: pending-products, review-product, pending-kyc, review-kyc
// Access: product reviewers + KYC reviewers only

'use strict';
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

/* ── Authorised staff emails ── */
const STAFF = {
  'product1@neyomarket.com': 'product_reviewer',
  'product2@neyomarket.com': 'product_reviewer',
  'kyc1@neyomarket.com':     'kyc_reviewer',
};

function jsonErr(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://neyomarket.com.ng');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  /* ══════════════════════════════════════════════════════
     GET pending-products — product reviewers only
  ══════════════════════════════════════════════════════ */
  if (action === 'pending-products' && req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT
          id, name, type, cat, price, discount_price, currency,
          description, seller, seller_id, seller_email,
          imgs, emoji, badge, location, created_at, commission
        FROM products
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `;
      return res.status(200).json({ ok: true, products: rows });
    } catch (err) {
      console.error('[staff-gate/pending-products]', err.message);
      return jsonErr(res, 500, 'Could not load pending products.');
    }
  }

  /* ══════════════════════════════════════════════════════
     POST review-product — approve or reject a product
  ══════════════════════════════════════════════════════ */
  if (action === 'review-product' && req.method === 'POST') {
    const { productId, status, reviewerEmail } = req.body || {};

    if (!productId || !status || !reviewerEmail)
      return jsonErr(res, 400, 'productId, status and reviewerEmail are required.');

    /* Verify reviewer is authorised */
    const role = STAFF[(reviewerEmail || '').toLowerCase()];
    if (!role || role !== 'product_reviewer')
      return jsonErr(res, 403, 'Not authorised to review products.');

    const allowedStatuses = ['active', 'rejected'];
    if (!allowedStatuses.includes(status))
      return jsonErr(res, 400, 'Status must be active or rejected.');

    try {
      await sql`
        UPDATE products
        SET
          status      = ${status},
          reviewed_by = ${reviewerEmail},
          reviewed_at = NOW()
        WHERE id = ${Number(productId)}
      `;
      console.log('[staff-gate/review-product]', productId, '->', status, 'by', reviewerEmail);
      return res.status(200).json({ ok: true, productId, status });
    } catch (err) {
      console.error('[staff-gate/review-product]', err.message);
      return jsonErr(res, 500, 'Could not update product status.');
    }
  }

  /* ══════════════════════════════════════════════════════
     GET pending-kyc — kyc reviewer only
  ══════════════════════════════════════════════════════ */
  if (action === 'pending-kyc' && req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT
          id, name, email, phone, role,
          kyc_status, kyc_type, nin_number,
          joined, created_at
        FROM users
        WHERE kyc_status = 'pending'
          AND nin_number IS NOT NULL
        ORDER BY created_at ASC
      `;
      return res.status(200).json({ ok: true, users: rows });
    } catch (err) {
      console.error('[staff-gate/pending-kyc]', err.message);
      return jsonErr(res, 500, 'Could not load pending KYC submissions.');
    }
  }

  /* ══════════════════════════════════════════════════════
     POST review-kyc — verify or reject a user's KYC
  ══════════════════════════════════════════════════════ */
  if (action === 'review-kyc' && req.method === 'POST') {
    const { userId, status, reviewerEmail } = req.body || {};

    if (!userId || !status || !reviewerEmail)
      return jsonErr(res, 400, 'userId, status and reviewerEmail are required.');

    /* Verify reviewer is authorised */
    const role = STAFF[(reviewerEmail || '').toLowerCase()];
    if (!role || role !== 'kyc_reviewer')
      return jsonErr(res, 403, 'Not authorised to review KYC.');

    const allowedStatuses = ['verified', 'rejected'];
    if (!allowedStatuses.includes(status))
      return jsonErr(res, 400, 'Status must be verified or rejected.');

    try {
      /* Update kyc_status and is_verified flag */
      await sql`
        UPDATE users
        SET
          kyc_status  = ${status},
          is_verified = ${status === 'verified'},
          kyc_reviewed_by = ${reviewerEmail},
          kyc_reviewed_at = NOW()
        WHERE id = ${String(userId)}
      `;
      console.log('[staff-gate/review-kyc]', userId, '->', status, 'by', reviewerEmail);
      return res.status(200).json({ ok: true, userId, status });
    } catch (err) {
      console.error('[staff-gate/review-kyc]', err.message);
      return jsonErr(res, 500, 'Could not update KYC status.');
    }
  }

  return jsonErr(res, 400, 'Unknown action.');
};
