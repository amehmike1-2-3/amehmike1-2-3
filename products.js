// /api/products.js — NeyoMarket Products API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// IMPORTANT: Tell Vercel to increase body size limit
module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } }
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    rating:      parseFloat(r.rating  || 0),
    reviews:     parseInt(r.reviews   || 0),
    emoji:       r.emoji,
    imgs:        Array.isArray(r.imgs) ? r.imgs : (r.imgs ? JSON.parse(r.imgs) : []),
    status:      r.status,
    badge:       r.badge,
    date:        r.date,
    escrow:      r.escrow,
    fileExt:     r.file_ext  || null,
    fileName:    r.file_name || null,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* GET — fetch all products */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
      return res.status(200).json({ products: rows.map(toProduct) });
    }

    /* POST — save a new product */
    if (req.method === 'POST') {
      const p = req.body || {};
      if (!p.name || !p.price)
        return res.status(400).json({ error: 'Product name and price are required.' });

      /* Strip any base64 images */
      const imgs = (p.imgs || []).filter(function(img) {
        return img && typeof img === 'string' && !img.startsWith('data:');
      });

      await sql`
        INSERT INTO products (
          id, name, type, cat, price, commission, description,
          seller, seller_email, rating, reviews, emoji,
          imgs, status, badge, date, escrow,
          file_ext, file_name, created_at
        ) VALUES (
          ${p.id || Date.now()},
          ${p.name},
          ${p.type || 'physical'},
          ${p.cat  || 'other'},
          ${p.price},
          ${p.commission || 0},
          ${p.desc || ''},
          ${p.seller || ''},
          ${p.sellerEmail || ''},
          ${0},
          ${0},
          ${p.emoji || ''},
          ${JSON.stringify(imgs)},
          ${'pending'},
          ${'Pending Review'},
          ${p.date || new Date().toLocaleDateString()},
          ${true},
          ${p.fileExt  || null},
          ${p.fileName || null},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name   = EXCLUDED.name,
          status = EXCLUDED.status,
          badge  = EXCLUDED.badge
        RETURNING *
      `;
      return res.status(201).json({ ok: true });
    }

    /* PATCH — approve/reject */
    if (req.method === 'PATCH') {
      const { id, status, badge } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`UPDATE products SET status=${status||'active'}, badge=${badge||''} WHERE id=${id}`;
      return res.status(200).json({ ok: true });
    }

    /* DELETE */
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM products WHERE id=${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[products.js]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
