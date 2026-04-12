// /api/products.js — NeyoMarket Products API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ── GET /api/products — fetch all products ── */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
      const products = rows.map(function(r) {
        return {
          id:          r.id,
          name:        r.name,
          type:        r.type,
          cat:         r.cat,
          price:       parseFloat(r.price),
          commission:  parseFloat(r.commission || 0),
          desc:        r.desc,
          seller:      r.seller,
          sellerEmail: r.seller_email,
          rating:      parseFloat(r.rating || 0),
          reviews:     parseInt(r.reviews || 0),
          emoji:       r.emoji,
          imgs:        r.imgs || [],
          status:      r.status,
          badge:       r.badge,
          date:        r.date,
          escrow:      r.escrow,
          fileDataUrl: r.file_data_url || null,
          fileExt:     r.file_ext     || null,
          fileName:    r.file_name    || null,
        };
      });
      return res.status(200).json({ products: products });
    }

    /* ── POST /api/products — save a new product ── */
    if (req.method === 'POST') {
      const p = req.body || {};
      if (!p.name || !p.price)
        return res.status(400).json({ error: 'Product name and price are required.' });

      const inserted = await sql`
        INSERT INTO products (
          id, name, type, cat, price, commission, desc,
          seller, seller_email, rating, reviews, emoji,
          imgs, status, badge, date, escrow,
          file_data_url, file_ext, file_name, created_at
        ) VALUES (
          ${p.id || Date.now()},
          ${p.name},
          ${p.type        || 'digital'},
          ${p.cat         || 'other'},
          ${p.price},
          ${p.commission  || 0},
          ${p.desc        || ''},
          ${p.seller      || ''},
          ${p.sellerEmail || ''},
          ${p.rating      || 0},
          ${p.reviews     || 0},
          ${p.emoji       || '📦'},
          ${JSON.stringify(p.imgs || [])},
          ${p.status      || 'pending'},
          ${p.badge       || 'Pending Review'},
          ${p.date        || new Date().toLocaleDateString()},
          ${p.escrow      !== false},
          ${p.fileDataUrl || null},
          ${p.fileExt     || null},
          ${p.fileName    || null},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          badge  = EXCLUDED.badge
        RETURNING *
      `;
      return res.status(201).json({ product: inserted[0] });
    }

    /* ── PATCH /api/products — update status (approve/reject) ── */
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

    /* ── DELETE /api/products ── */
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Product id is required.' });
      await sql`DELETE FROM products WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[products.js error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
