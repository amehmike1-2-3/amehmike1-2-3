// /api/products.js — SECURITY-HARDENED
// GET: PUBLIC (anyone can view)
// POST: AUTH REQUIRED (must be logged in to create)
// DELETE: AUTH + OWNER/ADMIN ONLY

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

async function protect(token) {
  if (!token) return null;
  
  const decoded = verifyToken(token);
  if (!decoded) return null;
  
  const rows = await sql`SELECT * FROM users WHERE id = ${decoded.id} LIMIT 1`;
  return rows.length ? rows[0] : null;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getTokenFromRequest(req);

  try {

    /* ────────────────────────────────────────────────────
       GET PRODUCTS (PUBLIC - ANYONE CAN VIEW)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const { productId, sellerId, category, condition } = req.query;
      let query = 'SELECT * FROM products WHERE 1=1';
      const params = [];

      if (productId) {
        query += ` AND id = $${params.length + 1}`;
        params.push(productId);
      }
      if (sellerId) {
        query += ` AND seller_id = $${params.length + 1}`;
        params.push(String(sellerId));
      }
      if (category) {
        query += ` AND category = $${params.length + 1}`;
        params.push(category);
      }
      if (condition) {
        query += ` AND condition = $${params.length + 1}`;
        params.push(condition);
      }

      query += ' ORDER BY created_at DESC LIMIT 1000';
      
      const rows = await sql.query(query, params);
      return res.status(200).json({ products: rows });
    }

    /* ────────────────────────────────────────────────────
       CREATE PRODUCT (AUTH REQUIRED)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      if (!token) {
        return res.status(401).json({ error: '401 Unauthorized: Login required to create products.' });
      }

      const user = await protect(token);
      if (!user) {
        return res.status(401).json({ error: '401 Unauthorized: Invalid token.' });
      }

      const { name, description, price, category, condition, emoji, imageUrl, type } = req.body || {};
      
      if (!name || !price || !category) {
        return res.status(400).json({ error: 'Name, price, and category required.' });
      }

      const inserted = await sql`
        INSERT INTO products (name, description, price, category, condition, emoji, image_url, seller_id, type, created_at)
        VALUES (${name}, ${description || ''}, ${parseFloat(price)}, ${category}, ${condition || 'new'}, ${emoji || '📦'}, ${imageUrl || ''}, ${user.id}, ${type || 'physical'}, NOW())
        RETURNING *
      `;

      return res.status(201).json({ product: inserted[0], message: 'Product created.' });
    }

    /* ────────────────────────────────────────────────────
       UPDATE PRODUCT (AUTH + OWNER/ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'PATCH') {
      if (!token) {
        return res.status(401).json({ error: '401 Unauthorized: Login required.' });
      }

      const user = await protect(token);
      if (!user) {
        return res.status(401).json({ error: '401 Unauthorized: Invalid token.' });
      }

      const { productId, name, description, price, category, condition } = req.body || {};
      if (!productId) return res.status(400).json({ error: 'productId required.' });

      const rows = await sql`SELECT * FROM products WHERE id = ${productId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Product not found.' });

      const product = rows[0];
      if (String(product.seller_id) !== String(user.id) && user.role !== 'admin') {
        return res.status(403).json({ error: '403 Forbidden: Can only edit your own products.' });
      }

      await sql`
        UPDATE products SET
          name = COALESCE(${name ?? null}, name),
          description = COALESCE(${description ?? null}, description),
          price = COALESCE(${price ?? null}, price),
          category = COALESCE(${category ?? null}, category),
          condition = COALESCE(${condition ?? null}, condition)
        WHERE id = ${productId}
      `;

      const updated = await sql`SELECT * FROM products WHERE id = ${productId} LIMIT 1`;
      return res.status(200).json({ product: updated[0], message: 'Product updated.' });
    }

    /* ────────────────────────────────────────────────────
       DELETE PRODUCT (AUTH + OWNER/ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'DELETE') {
      if (!token) {
        return res.status(401).json({ error: '401 Unauthorized: Login required.' });
      }

      const user = await protect(token);
      if (!user) {
        return res.status(401).json({ error: '401 Unauthorized: Invalid token.' });
      }

      const productId = req.query.productId;
      if (!productId) return res.status(400).json({ error: 'productId required.' });

      const rows = await sql`SELECT * FROM products WHERE id = ${productId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Product not found.' });

      const product = rows[0];
      if (String(product.seller_id) !== String(user.id) && user.role !== 'admin') {
        return res.status(403).json({ error: '403 Forbidden: Can only delete your own products.' });
      }

      await sql`DELETE FROM products WHERE id = ${productId}`;
      return res.status(200).json({ ok: true, message: 'Product deleted.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[PRODUCTS ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
