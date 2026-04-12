// /api/reviews.js — NeyoMarket Reviews API (Neon Postgres)
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

    /* ── GET /api/reviews?productId=xxx ── */
    if (req.method === 'GET') {
      const productId = req.query.productId;
      if (!productId) return res.status(400).json({ error: 'productId is required.' });

      const rows = await sql`
        SELECT * FROM reviews WHERE product_id = ${productId} ORDER BY created_at DESC
      `;
      return res.status(200).json({ reviews: rows });
    }

    /* ── POST /api/reviews — submit a review ── */
    if (req.method === 'POST') {
      const { productId, userId, userName, rating, comment } = req.body || {};
      if (!productId || !userId || !rating)
        return res.status(400).json({ error: 'productId, userId and rating are required.' });
      if (rating < 1 || rating > 5)
        return res.status(400).json({ error: 'Rating must be between 1 and 5.' });

      /* One review per user per product */
      const existing = await sql`
        SELECT id FROM reviews WHERE product_id = ${productId} AND user_id = ${userId} LIMIT 1
      `;
      if (existing.length)
        return res.status(409).json({ error: 'You have already reviewed this product.' });

      await sql`
        INSERT INTO reviews (product_id, user_id, user_name, rating, comment, created_at)
        VALUES (${productId}, ${userId}, ${userName || 'Anonymous'}, ${rating}, ${comment || ''}, NOW())
      `;

      /* Update product average rating */
      const stats = await sql`
        SELECT COUNT(*) as cnt, AVG(rating) as avg FROM reviews WHERE product_id = ${productId}
      `;
      const cnt = parseInt(stats[0].cnt);
      const avg = parseFloat(stats[0].avg).toFixed(1);

      await sql`
        UPDATE products SET rating = ${avg}, reviews = ${cnt} WHERE id = ${productId}
      `;

      return res.status(201).json({ ok: true, rating: avg, reviews: cnt });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[reviews.js error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
