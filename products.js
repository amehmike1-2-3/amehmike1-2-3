// /api/products.js — NeyoMarket Products API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Strip base64 image data — only keep URLs
function cleanImgs(imgs) {
  if (!Array.isArray(imgs)) return [];
  return imgs.map(function(img) {
    if (!img) return null;
    // If it's a base64 data URL, replace with placeholder
    if (typeof img === 'string' && img.startsWith('data:')) return null;
    return img;
  }).filter(Boolean);
}

function toProduct(r) {
  return {
    id:          Number(r.id),
    name:        r.name,
    type:        r.type,
    cat:         r.cat,
    price:       parseFloat(r.price),
    commission:  parseFloat(r.commission || 0),
    desc:        r.description || '',
    description: r.description || '',
    seller:      r.seller,
    sellerEmail: r.seller_email,
    rating:      parseFloat(r.rating || 0),
    reviews:     parseInt(r.reviews   || 0),
    emoji:       r.emoji,
    imgs:        Array.isArray(r.imgs) ? r.imgs : (r.imgs ? JSON.parse(r.imgs) : []),
    status:      r.status,
    badge:       r.badge,
    date:        r.date,
    escrow:      r.escrow,
    fileDataUrl: r.file_data_url || null,
    fileExt:     r.file_ext      || null,
    fileName:    r.file_name     || null,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ── GET — fetch all products ── */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
      return res.status(200).json({ products: rows.map(toProduct) });
    }

    /* ── POST — save a new product ── */
    if (req.method === 'POST') {
      const p = req.body || {};
      if (!p.name || !p.price)
        return res.status(400).json({ error: 'Product name and price are required.' });

      // Clean images — remove base64 data to avoid DB size limits
      const cleanedImgs = cleanImgs(p.imgs);

      const inserted = await sql`
        INSERT INTO products (
          id, name, type, cat, price, commission, description,
          seller, seller_email, rating, reviews, emoji,
          imgs, status, badge, date, escrow,
          file_data_url, file_ext, file_name, created_at
        ) VALUES (
          ${p.id          || Date.now()},
          ${p.name},
          ${p.type        || 'digital'},
          ${p.cat         || 'other'},
          ${p.price},
          ${p.commission  || 0},
          ${p.desc        || p.description || ''},
          ${p.seller      || ''},
          ${p.sellerEmail || ''},
          ${0},
          ${0},
          ${p.emoji       || ''},
          ${JSON.stringify(cleanedImgs)},
          ${'pending'},
          ${'Pending Review'},
          ${p.date        || new Date().toLocaleDateString()},
          ${true},
          ${p.fileDataUrl || null},
          ${p.fileExt     || null},
          ${p.fileName    || null},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name        = EXCLUDED.name,
          status      = EXCLUDED.status,
          badge       = EXCLUDED.badge
        RETURNING *
      `;
      return res.status(201).json({ product: toProduct(inserted[0]) });
    }

    /* ── PATCH — approve / reject product ── */
    if (req.method === 'PATCH') {
      const { id, status, badge } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Product id is required.' });
      await sql`
        UPDATE products
        SET status = ${status || 'active'}, badge = ${badge || ''}
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }

    /* ── DELETE — remove product ── */
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Product id is required.' });
      await sql`DELETE FROM products WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[products.js error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
};
