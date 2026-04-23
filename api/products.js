// /api/products.js — NeyoMarket Products API
// Supports: discount_price, is_on_sale, sale_ends_at, shipping_fee, seller_verified
// PHASE 1 FIX: All ID lookups wrapped in Number() to prevent Neon int/string mismatch

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
  return {
    id:               r.id,
    name:             r.name,
    type:             r.type             || 'digital',
    cat:              r.cat              || 'other',
    price:            parseFloat(r.price || 0),
    discountPrice:    r.discount_price   ? parseFloat(r.discount_price) : null,
    isOnSale:         r.is_on_sale       || false,
    saleEndsAt:       r.sale_ends_at     || null,
    shippingFee:      r.shipping_fee     ? parseFloat(r.shipping_fee) : 0,
    sellerVerified:   r.seller_verified  || false,
    commission:       parseFloat(r.commission || 0),
    description:      r.description      || r.desc || '',
    seller:           r.seller           || '',
    sellerId:         r.seller_id        || null,
    sellerEmail:      r.seller_email     || '',
    sellerWhatsapp:   r.seller_whatsapp  || '',
    rating:           parseFloat(r.rating  || 0),
    reviews:          parseInt(r.reviews   || 0, 10),
    emoji:            r.emoji            || '📦',
    imgs:             Array.isArray(imgs) ? imgs : [],
    status:           r.status           || 'pending',
    badge:            r.badge            || '',
    date:             r.date             || '',
    escrow:           r.escrow           !== false,
    fileExt:          r.file_ext         || null,
    fileName:         r.file_name        || null,
    fileUrl:          r.file_url         || null,
    createdAt:        r.created_at       || null,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ── GET — fetch all products ── */
    if (req.method === 'GET') {
      const adminMode = req.query.admin === 'true';
      const sellerId  = req.query.sellerId;

      let rows;
      if (sellerId) {
        // FIX: seller_id is stored as bigint in Neon — cast to Number
        rows = await sql`
          SELECT * FROM products WHERE seller_id = ${Number(sellerId)}
          ORDER BY created_at DESC
        `;
      } else if (adminMode) {
        rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
      } else {
        rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
      }
      return res.status(200).json({ products: rows.map(toProduct) });
    }

    /* ── POST — create new product ── */
    if (req.method === 'POST') {
      const p = req.body || {};
      if (!p.name || !p.price)
        return res.status(400).json({ error: 'Product name and price are required.' });

      // FIX: cast id to Number so Neon receives a bigint, not a string
      const id = Number(p.id || Date.now());

      const rows = await sql`
        INSERT INTO products (
          id, name, type, cat, price,
          discount_price, is_on_sale, sale_ends_at, shipping_fee,
          commission, description, seller, seller_id, seller_email, seller_whatsapp,
          rating, reviews, emoji, imgs, status, badge, date, escrow,
          file_ext, file_name, file_url, created_at
        ) VALUES (
          ${id},
          ${p.name},
          ${p.type          || 'digital'},
          ${p.cat           || 'other'},
          ${parseFloat(p.price)},
          ${p.discountPrice ? parseFloat(p.discountPrice) : null},
          ${p.isOnSale      || false},
          ${p.saleEndsAt    || null},
          ${p.shippingFee   ? parseFloat(p.shippingFee) : 0},
          ${parseFloat(p.commission || 0)},
          ${p.description   || ''},
          ${p.seller        || ''},
          ${p.sellerId      ? Number(p.sellerId) : null},
          ${p.sellerEmail   || ''},
          ${p.sellerWhatsapp || ''},
          ${0},
          ${0},
          ${p.emoji         || '📦'},
          ${JSON.stringify(p.imgs || [])},
          ${'pending'},
          ${p.badge         || ''},
          ${new Date().toLocaleDateString()},
          ${p.escrow !== false},
          ${p.fileExt   || null},
          ${p.fileName  || null},
          ${p.fileUrl   || null},
          NOW()
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, product: toProduct(rows[0]) });
    }

    /* ── PATCH — update product (status, discount, sale fields, file_url) ── */
    if (req.method === 'PATCH') {
      const p = req.body || {};
      if (!p.id) return res.status(400).json({ error: 'Product id is required.' });

      // FIX: cast to Number so WHERE id = $n matches Neon bigint column
      await sql`
        UPDATE products SET
          status          = COALESCE(${p.status          ?? null}, status),
          badge           = COALESCE(${p.badge           ?? null}, badge),
          discount_price  = COALESCE(${p.discountPrice != null ? parseFloat(p.discountPrice) : null}, discount_price),
          is_on_sale      = COALESCE(${p.isOnSale        ?? null}, is_on_sale),
          sale_ends_at    = COALESCE(${p.saleEndsAt      ?? null}, sale_ends_at),
          shipping_fee    = COALESCE(${p.shippingFee != null ? parseFloat(p.shippingFee) : null}, shipping_fee),
          seller_verified = COALESCE(${p.sellerVerified  ?? null}, seller_verified),
          seller_whatsapp = COALESCE(${p.sellerWhatsapp  ?? null}, seller_whatsapp),
          file_url        = COALESCE(${p.fileUrl         ?? null}, file_url)
        WHERE id = ${Number(p.id)}
      `;
      return res.status(200).json({ ok: true });
    }

    /* ── DELETE — remove product ── */
    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Product id is required.' });
      // FIX: cast to Number for Neon bigint column
      await sql`DELETE FROM products WHERE id = ${Number(id)}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[products.js]', err.message);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};

          discount_price = COALESCE(${p.discountPrice != null ? parseFloat(p.discountPrice) : null}, discount_price),
          is_on_sale     = COALESCE(${p.isOnSale        ?? null}, is_on_sale),
          sale_ends_at   = COALESCE(${p.saleEndsAt      ?? null}, sale_ends_at),
          shipping_fee   = COALESCE(${p.shippingFee != null ? parseFloat(p.shippingFee) : null}, shipping_fee),
          seller_verified = COALESCE(${p.sellerVerified ?? null}, seller_verified),
          seller_whatsapp = COALESCE(${p.sellerWhatsapp ?? null}, seller_whatsapp)
        WHERE id = ${p.id}
      `;
      return res.status(200).json({ ok: true });
    }

    /* ── DELETE — remove product ── */
    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Product id is required.' });
      await sql`DELETE FROM products WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (err) {
    console.error('[products.js]', err.message);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};
