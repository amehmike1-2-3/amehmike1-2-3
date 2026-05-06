// /api/paystack.js — ADMIN ONLY
// Paystack payment management - Admin only access

const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

async function protect(req, res, token) {
  if (!token) {
    return res.status(401).json({ error: '401 Unauthorized: No token provided.' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: '401 Unauthorized: Invalid token.' });
  }
  
  const rows = await sql`SELECT * FROM users WHERE id = ${decoded.id} LIMIT 1`;
  if (!rows.length) {
    return res.status(401).json({ error: '401 Unauthorized: User not found.' });
  }
  
  return { user: rows[0] };
}

function restrictToAdmin(user) {
  if (user.role !== 'admin') {
    return { allowed: false };
  }
  return { allowed: true };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getTokenFromRequest(req);
  const protected = await protect(req, res, token);
  if (protected.statusCode) return protected;

  const adminCheck = restrictToAdmin(protected.user);
  if (!adminCheck.allowed) {
    return res.status(403).json({ error: '403 Forbidden: Admin access required.' });
  }

  try {

    /* ────────────────────────────────────────────────────
       GET PAYSTACK TRANSACTIONS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM paystack_transactions ORDER BY created_at DESC`;
      return res.status(200).json({ transactions: rows });
    }

    /* ────────────────────────────────────────────────────
       CREATE SUBACCOUNT (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { action } = req.query;
      
      if (action === 'create-subaccount') {
        const { businessName, accountNumber, bankCode } = req.body || {};
        if (!businessName || !accountNumber || !bankCode) {
          return res.status(400).json({ error: 'Business name, account number, and bank code required.' });
        }

        // Call Paystack API
        const psRes = await fetch('https://api.paystack.co/subaccount', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${PAYSTACK_SECRET}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            business_name: businessName,
            settlement_bank: bankCode,
            account_number: accountNumber,
            percentage_charge: 10
          })
        });

        const data = await psRes.json();
        if (!psRes.ok) {
          return res.status(400).json({ error: data.message || 'Failed to create subaccount.' });
        }

        return res.status(201).json({ subaccount: data.data });
      }

      return res.status(400).json({ error: 'Unknown action.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[PAYSTACK ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
