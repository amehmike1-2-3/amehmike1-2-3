// /api/products.js — NeyoMarket Products API
// EMERGENCY FIX: Ternary expressions extracted from Neon template literals (caused SyntaxError)
// NEW: is_verified column, verification_fee payment flow, dispute flag column
// All ID lookups cast with Number() — Neon int/string safety rule

'use strict';

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function toProduct(r) {
  let imgs = r.imgs;
  if (typeof imgs === 'string') {
    try { imgs = JSON.parse(imgs); } catch(e) { imgs = []; }
  }
  if (!Array.isArray(imgs)) imgs = [];
  return {
    id:             r.id,
    name:           r.name             || '',
    type:           r.type             || 'digital',
    cat:            r.cat              || 'other',
    price:          parseFloat(r.price || 0),
    discountPrice:  r.discount_price   ? parseFloat(r.discount_price) : null,
    isOnSale:       r.is_on_sale       || false,
    saleEndsAt:     r.sale_ends_at     || null,
    shippingFee:    r.shipping_fee     ? parseFloat(r.shipping_fee) : 0,
    sellerVerified: r.seller_verified  || false,
    isVerified:     r.is_verified      || false,   /* NEW: Trust & Verification badge */
    commission:     parseFloat(r.commission || 0),
    description:    r.description      || r.desc || '',
    seller:         r.seller           || '',
    sellerId:       r.seller_id        || null,
    sellerEmail:    r.seller_email     || '',
    sellerWhatsapp: r.seller_whatsapp  || '',
    rating:         parseFloat(r.rating  || 0),
    reviews:        parseInt(r.reviews   || 0, 10),
    emoji:          r.emoji            || '📦',
    imgs:           imgs,
    status:         r.status           || 'pending',
    badge:          r.badge            || '',
    date:           r.date             || '',
    escrow:         r.escrow           !== false,
    fileExt:        r.file_ext         || null,
    fileName:       r.file_name        || null,
    fileUrl:        r.file_url         || null,
    disputed:       r.disputed         || false,   /* NEW: Dispute flag */
    createdAt:      r.created_at       || null,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── SAFETY: ensure every route returns JSON, never raw crashes ── */
  try {

    /* ════════════════════════════════════════════════════
       GET — fetch products
    ════════════════════════════════════════════════════ */
    if (req.method === 'GET') {
      const { admin, sellerId, status, id } = req.query;

      /* Single product by id */
      if (id) {
        const rows = await sql`
          SELECT * FROM products WHERE id = ${Number(id)} LIMIT 1
        `;
        if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
        return res.status(200).json({ product: toProduct(rows[0]) });
      }

      let rows;
      if (sellerId) {
        /* Seller's own listings */
        rows = await sql`
          SELECT * FROM products
          WHERE seller_id = ${Number(sellerId)}
          ORDER BY created_at DESC
        `;
      } else if (admin === 'true') {
        /* Admin: all products, optionally filtered by status */
        if (status && status !== 'all') {
          rows = await sql`
            SELECT * FROM products WHERE status = ${String(status)} ORDER BY created_at DESC
          `;
        } else {
          rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
        }
      } else {
        /* Public marketplace — only approved listings */
        rows = await sql`
          SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC
        `;
      }

      return res.status(200).json({ products: rows.map(toProduct) });
    }

    /* ════════════════════════════════════════════════════
       POST — create new product
    ════════════════════════════════════════════════════ */
    if (req.method === 'POST') {
      const p = req.body || {};
      if (!p.name || !p.price)
        return res.status(400).json({ error: 'Product name and price are required.' });

      const id = Number(p.id || Date.now());

      /* ── EMERGENCY FIX: Pre-compute all conditional values OUTSIDE the
         Neon template literal. Ternaries inside ${} in tagged templates
         cause the "missing ) after argument list" SyntaxError in Vercel. ── */
      const discountPrice  = p.discountPrice  ? parseFloat(p.discountPrice) : null;
      const isOnSale       = p.isOnSale       || false;
      const saleEndsAt     = p.saleEndsAt     || null;
      const shippingFee    = p.shippingFee    ? parseFloat(p.shippingFee)   : 0;
      const commission     = parseFloat(p.commission || 0);
      const sellerId       = p.sellerId       ? Number(p.sellerId)          : null;
      const sellerWhatsapp = p.sellerWhatsapp || '';
      const escrow         = p.escrow !== false;
      const fileExt        = p.fileExt        || null;
      const fileName       = p.fileName       || null;
      const fileUrl        = p.fileUrl        || null;
      const imgs           = JSON.stringify(p.imgs || []);
      const dateStr        = new Date().toLocaleDateString();

      const rows = await sql`
        INSERT INTO products (
          id, name, type, cat, price,
          discount_price, is_on_sale, sale_ends_at, shipping_fee,
          commission, description, seller, seller_id, seller_email, seller_whatsapp,
          rating, reviews, emoji, imgs, status, badge, date, escrow,
          file_ext, file_name, file_url, is_verified, disputed, created_at
        ) VALUES (
          ${id},
          ${p.name},
          ${p.type        || 'digital'},
          ${p.cat         || 'other'},
          ${parseFloat(p.price)},
          ${discountPrice},
          ${isOnSale},
          ${saleEndsAt},
          ${shippingFee},
          ${commission},
          ${p.description || ''},
          ${p.seller      || ''},
          ${sellerId},
          ${p.sellerEmail || ''},
          ${sellerWhatsapp},
          ${0},
          ${0},
          ${p.emoji       || '📦'},
          ${imgs},
          ${'pending'},
          ${p.badge       || ''},
          ${dateStr},
          ${escrow},
          ${fileExt},
          ${fileName},
          ${fileUrl},
          ${false},
          ${false},
          NOW()
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, product: toProduct(rows[0]) });
    }

    /* ════════════════════════════════════════════════════
       PATCH — update product fields
       EMERGENCY FIX: every conditional value extracted to a
       const BEFORE the template literal is constructed.
    ════════════════════════════════════════════════════ */
    if (req.method === 'PATCH') {
      const p = req.body || {};
      if (!p.id) return res.status(400).json({ error: 'Product id is required.' });

      /* Pre-compute — fixes the Vercel SyntaxError on conditional template params */
      const newStatus         = p.status          !== undefined ? String(p.status)                      : null;
      const newBadge          = p.badge            !== undefined ? String(p.badge)                       : null;
      const newDiscountPrice  = p.discountPrice    !== undefined ? (p.discountPrice !== null ? parseFloat(p.discountPrice) : null) : null;
      const newIsOnSale       = p.isOnSale         !== undefined ? Boolean(p.isOnSale)                  : null;
      const newSaleEndsAt     = p.saleEndsAt       !== undefined ? (p.saleEndsAt || null)                : null;
      const newShippingFee    = p.shippingFee      !== undefined ? (p.shippingFee !== null ? parseFloat(p.shippingFee) : null) : null;
      const newSellerVerified = p.sellerVerified   !== undefined ? Boolean(p.sellerVerified)            : null;
      const newSellerWhatsapp = p.sellerWhatsapp   !== undefined ? String(p.sellerWhatsapp)             : null;
      const newFileUrl        = p.fileUrl          !== undefined ? (p.fileUrl || null)                  : null;
      const newIsVerified     = p.isVerified       !== undefined ? Boolean(p.isVerified)                : null;
      const newDisputed       = p.disputed         !== undefined ? Boolean(p.disputed)                  : null;
      const productId         = Number(p.id);

      await sql`
        UPDATE products SET
          status          = COALESCE(${newStatus},         status),
          badge           = COALESCE(${newBadge},          badge),
          discount_price  = COALESCE(${newDiscountPrice},  discount_price),
          is_on_sale      = COALESCE(${newIsOnSale},       is_on_sale),
          sale_ends_at    = COALESCE(${newSaleEndsAt},     sale_ends_at),
          shipping_fee    = COALESCE(${newShippingFee},    shipping_fee),
          seller_verified = COALESCE(${newSellerVerified}, seller_verified),
          seller_whatsapp = COALESCE(${newSellerWhatsapp}, seller_whatsapp),
          file_url        = COALESCE(${newFileUrl},        file_url),
          is_verified     = COALESCE(${newIsVerified},     is_verified),
          disputed        = COALESCE(${newDisputed},       disputed)
        WHERE id = ${productId}
      `;
      return res.status(200).json({ ok: true });
    }

    /* ════════════════════════════════════════════════════
       DELETE — remove product
    ════════════════════════════════════════════════════ */
    if (req.method === 'DELETE') {
      const rawId = req.query.id || (req.body && req.body.id);
      if (!rawId) return res.status(400).json({ error: 'Product id is required.' });
      const productId = Number(rawId);
      await sql`DELETE FROM products WHERE id = ${productId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    /* ── GLOBAL CATCH: always return JSON, never crash the dashboard ── */
    console.error('[products.js] ERROR:', err.message, err.stack && err.stack.split('\n')[1]);
    return res.status(500).json({
      error:   'Internal server error.',
      detail:  err.message,
      _hint:   'Check Vercel function logs for stack trace.'
    });
  }
};
