// /api/auth.js — NeyoMarket Auth API (Neon Postgres)
const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function toPublicUser(row) {
  return {
    id:               String(row.id),
    name:             row.name,
    email:            row.email,
    phone:            row.phone             || '',
    role:             row.role              || 'buyer',
    affCode:          row.aff_code          || '',
    joined:           row.joined ? new Date(row.joined).toLocaleDateString() : '',
    payoutBank:       row.payout_bank       || '',
    payoutAcct:       row.payout_acct       || '',
    payoutAname:      row.payout_aname      || '',
    subaccountCode:   row.subaccount_code   || null,
    subaccountStatus: row.subaccount_status || 'pending',
  };
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* ── LOGIN ── */
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });

      const rows = await sql`
        SELECT * FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (!rows.length)
        return res.status(401).json({ error: 'Incorrect email or password.' });

      const user  = rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match)
        return res.status(401).json({ error: 'Incorrect email or password.' });

      return res.status(200).json({ user: toPublicUser(user) });
    }

    /* ── REGISTER ── */
    if (action === 'register') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { name, email, phone, role, password, affCode } = req.body || {};
      if (!name || !email || !password)
        return res.status(400).json({ error: 'Name, email and password are required.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const existing = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (existing.length)
        return res.status(409).json({ error: 'This email is already registered.' });

      const hash     = await bcrypt.hash(password, 10);
      const safeRole = ['buyer','seller','affiliate','admin'].includes(role) ? role : 'buyer';
      const code     = affCode || ('REF' + Math.random().toString(36).substr(2,7).toUpperCase());

      const inserted = await sql`
        INSERT INTO users (name, email, phone, role, password_hash, aff_code, joined)
        VALUES (
          ${name.trim()},
          ${email.trim().toLowerCase()},
          ${phone  || ''},
          ${safeRole},
          ${hash},
          ${code},
          NOW()
        )
        RETURNING *
      `;
      return res.status(201).json({ user: toPublicUser(inserted[0]) });
    }

    /* ── RESET PASSWORD ── */
    if (action === 'reset-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { email, tempPassword } = req.body || {};
      if (!email || !tempPassword)
        return res.status(400).json({ error: 'Email and temporary password are required.' });

      const rows = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (!rows.length)
        return res.status(404).json({ error: 'No account found for that email.' });

      const hash = await bcrypt.hash(tempPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].id}`;

      return res.status(200).json({ ok: true });
    }

    /* ── CHANGE PASSWORD ── */
    if (action === 'change-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { userId, email, newPassword } = req.body || {};
      if ((!userId && !email) || !newPassword)
        return res.status(400).json({ error: 'User identifier and new password are required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const hash = await bcrypt.hash(newPassword, 10);
      if (userId) {
        await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
      } else {
        await sql`UPDATE users SET password_hash = ${hash} WHERE LOWER(email) = LOWER(${email.trim()})`;
      }
      return res.status(200).json({ ok: true });
    }

    /* ── UPDATE PROFILE (payout / subaccount) ── */
    if (action === 'update-profile') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { userId, payoutBank, payoutAcct, payoutAname, subaccountCode, subaccountStatus } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId is required.' });

      await sql`
        UPDATE users SET
          payout_bank       = COALESCE(${payoutBank       ?? null}, payout_bank),
          payout_acct       = COALESCE(${payoutAcct       ?? null}, payout_acct),
          payout_aname      = COALESCE(${payoutAname      ?? null}, payout_aname),
          subaccount_code   = COALESCE(${subaccountCode   ?? null}, subaccount_code),
          subaccount_status = COALESCE(${subaccountStatus ?? null}, subaccount_status)
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      return res.status(200).json({ user: toPublicUser(rows[0]) });
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error('[auth.js error]', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
};
