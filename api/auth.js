// /api/auth.js  — NeyoMarket Auth API (Neon Postgres)
// Handles: login · register · reset-password · change-password · update-profile
// Deploy on Vercel. Uses the `@neondatabase/serverless` driver (no native pg needed).
//
// ── Setup ─────────────────────────────────────────────────────────────────────
// 1. npm install @neondatabase/serverless bcryptjs
// 2. In Vercel Dashboard → Settings → Environment Variables, add:
//      DATABASE_URL = postgresql://neondb_owner:npg_8OKdIsmhv7Ub@ep-little-wave-ambvqlg8-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
// 3. Make sure your Neon `users` table exists (DDL at the bottom of this file).
// ──────────────────────────────────────────────────────────────────────────────

import { neon } from '@neondatabase/serverless';
import bcrypt   from 'bcryptjs';

// ── DB connection (reused across warm invocations) ───────────────────────────
const sql = neon(process.env.DATABASE_URL);

// ── CORS helper ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Map a DB row → safe public user object ───────────────────────────────────
function toPublicUser(row) {
  return {
    id:               row.id,
    name:             row.name,
    email:            row.email,
    phone:            row.phone            || '',
    role:             row.role             || 'buyer',
    affCode:          row.aff_code         || '',
    joined:           row.joined           ? new Date(row.joined).toLocaleDateString() : '',
    payoutBank:       row.payout_bank      || '',
    payoutAcct:       row.payout_acct      || '',
    payoutAname:      row.payout_aname     || '',
    subaccountCode:   row.subaccount_code  || null,
    subaccountStatus: row.subaccount_status|| 'pending',
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {
    // ════════════════════════════════════════════════════════════════════════
    // POST /api/auth?action=login
    // Body: { email, password }
    // ════════════════════════════════════════════════════════════════════════
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

      const user = rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match)
        return res.status(401).json({ error: 'Incorrect email or password.' });

      return res.status(200).json({ user: toPublicUser(user) });
    }

    // ════════════════════════════════════════════════════════════════════════
    // POST /api/auth?action=register
    // Body: { name, email, phone, role, password, affCode }
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'register') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { name, email, phone, role, password, affCode } = req.body || {};
      if (!name || !email || !password)
        return res.status(400).json({ error: 'Name, email and password are required.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      // Check for duplicate email
      const existing = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (existing.length)
        return res.status(409).json({ error: 'This email is already registered.' });

      const hash     = await bcrypt.hash(password, 10);
      const safeRole = ['buyer','seller','affiliate','admin'].includes(role) ? role : 'buyer';
      const code     = affCode || ('REF' + Math.random().toString(36).substr(2, 7).toUpperCase());

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

    // ════════════════════════════════════════════════════════════════════════
    // POST /api/auth?action=reset-password
    // Body: { email, tempPassword }
    // ════════════════════════════════════════════════════════════════════════
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
      await sql`
        UPDATE users
        SET password_hash = ${hash}
        WHERE id = ${rows[0].id}
      `;

      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // POST /api/auth?action=change-password
    // Body: { userId, email, newPassword }
    // ════════════════════════════════════════════════════════════════════════
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
        await sql`
          UPDATE users
          SET password_hash = ${hash}
          WHERE LOWER(email) = LOWER(${email.trim()})
        `;
      }

      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // POST /api/auth?action=update-profile
    // Body: { userId, payoutBank?, payoutAcct?, payoutAname?,
    //         subaccountCode?, subaccountStatus? }
    // Used by both savePayout() and saveSellerPayout()
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'update-profile') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const {
        userId,
        payoutBank,
        payoutAcct,
        payoutAname,
        subaccountCode,
        subaccountStatus,
      } = req.body || {};

      if (!userId)
        return res.status(400).json({ error: 'userId is required.' });

      // Build a dynamic update only for fields that were actually sent
      const updates = [];
      const values  = [];

      if (payoutBank      !== undefined) { updates.push('payout_bank');       values.push(payoutBank); }
      if (payoutAcct      !== undefined) { updates.push('payout_acct');       values.push(payoutAcct); }
      if (payoutAname     !== undefined) { updates.push('payout_aname');      values.push(payoutAname); }
      if (subaccountCode  !== undefined) { updates.push('subaccount_code');   values.push(subaccountCode); }
      if (subaccountStatus !== undefined){ updates.push('subaccount_status'); values.push(subaccountStatus); }

      if (!updates.length)
        return res.status(400).json({ error: 'No fields to update.' });

      // Build parameterised query manually (neon tagged templates don't support
      // dynamic column lists natively, so we use sql.query with $N params)
      const setClauses = updates.map((col, i) => `${col} = $${i + 1}`).join(', ');
      values.push(userId); // last param = WHERE id
      await sql.query(
        `UPDATE users SET ${setClauses} WHERE id = $${values.length}`,
        values
      );

      // Return fresh user row so the client can update its local cache
      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      return res.status(200).json({ user: toPublicUser(rows[0]) });
    }

    // ── Unknown action ────────────────────────────────────────────────────
    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error('[auth.js]', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   NEON POSTGRES — required table DDL
   Run this ONCE in your Neon SQL Editor (console.neon.tech):
   ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL      PRIMARY KEY,
  name              TEXT           NOT NULL,
  email             TEXT           NOT NULL UNIQUE,
  phone             TEXT           DEFAULT '',
  role              TEXT           NOT NULL DEFAULT 'buyer',
  password_hash     TEXT           NOT NULL,
  aff_code          TEXT           DEFAULT '',
  joined            TIMESTAMPTZ    DEFAULT NOW(),
  payout_bank       TEXT           DEFAULT '',
  payout_acct       TEXT           DEFAULT '',
  payout_aname      TEXT           DEFAULT '',
  subaccount_code   TEXT           DEFAULT NULL,
  subaccount_status TEXT           DEFAULT 'pending'
);

-- Optional: speed up login lookups
CREATE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email));

   ════════════════════════════════════════════════════════════════════════════ */
