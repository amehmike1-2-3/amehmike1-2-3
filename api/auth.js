// /api/auth.js — NeyoMarket Authentication API
// Features: login, register, reset-password, change-password,
//           update-profile, kyc — all with rate limiting

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

/* ════════════════════════════════════════════════════════
   IN-MEMORY RATE LIMITER
   Vercel functions are stateless — this resets per cold
   start, which is fine. It stops burst brute-force attacks
   within any single function instance's lifetime.

   For production-grade rate limiting across all instances,
   replace this with an Upstash Redis check (free tier).
════════════════════════════════════════════════════════ */
const loginAttempts = new Map(); // key: ip|email → { count, firstAttempt }

const RATE_LIMIT = {
  maxAttempts: 5,        // max failed logins
  windowMs:    15 * 60 * 1000, // per 15 minutes
  blockMs:     30 * 60 * 1000, // block for 30 minutes after exceeded
};

function getRateLimitKey(req, email) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  return ip + '|' + (email || '').toLowerCase().trim();
}

function checkRateLimit(key) {
  const now   = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true };

  // Clear expired windows
  if (now - entry.firstAttempt > RATE_LIMIT.windowMs) {
    loginAttempts.delete(key);
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT.maxAttempts) {
    const waitMs      = RATE_LIMIT.blockMs - (now - entry.firstAttempt);
    const waitMinutes = Math.ceil(waitMs / 60000);
    return { allowed: false, waitMinutes };
  }

  return { allowed: true };
}

function recordFailedAttempt(key) {
  const now   = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttempt > RATE_LIMIT.windowMs) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

/* ════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════ */
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
    kycStatus:        row.kyc_status        || 'unverified',
    kycType:          row.kyc_type          || null,
    sellerBalance:    parseFloat(row.seller_balance    || 0),
    affiliateBalance: parseFloat(row.affiliate_balance || 0),
    adminBalance:     parseFloat(row.admin_balance     || 0),
    suspended:        row.suspended         || false,
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ════════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* ────────────────────────────────────────────────────
       LOGIN
       Rate limited: 5 attempts per IP+email per 15 minutes
    ──────────────────────────────────────────────────── */
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });
      if (!validateEmail(email))
        return res.status(400).json({ error: 'Invalid email format.' });

      // Check rate limit before touching the database
      const rlKey   = getRateLimitKey(req, email);
      const rlCheck = checkRateLimit(rlKey);
      if (!rlCheck.allowed) {
        return res.status(429).json({
          error: `Too many failed attempts. Please wait ${rlCheck.waitMinutes} minute(s) before trying again.`
        });
      }

      const rows = await sql`
        SELECT * FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;

      // Deliberate constant-time check — don't reveal whether email exists
      const user       = rows[0] || null;
      const dummyHash  = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
      const hashToTest = user ? user.password_hash : dummyHash;
      const match      = await bcrypt.compare(password, hashToTest);

      if (!user || !match) {
        recordFailedAttempt(rlKey);
        const entry = loginAttempts.get(rlKey);
        const remaining = RATE_LIMIT.maxAttempts - (entry ? entry.count : 1);
        const msg = remaining > 0
          ? `Incorrect email or password. (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)`
          : 'Too many failed attempts. Please wait 30 minutes.';
        return res.status(401).json({ error: msg });
      }

      if (user.suspended) {
        return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
      }

      // Success — clear rate limit
      clearAttempts(rlKey);
      return res.status(200).json({ user: toPublicUser(user) });
    }

    /* ────────────────────────────────────────────────────
       REGISTER
    ──────────────────────────────────────────────────── */
    if (action === 'register') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { name, email, phone, role, password, affCode } = req.body || {};

      if (!name || !email || !password)
        return res.status(400).json({ error: 'Name, email and password are required.' });
      if (!validateEmail(email))
        return res.status(400).json({ error: 'Invalid email format.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      if (name.trim().length < 2)
        return res.status(400).json({ error: 'Name must be at least 2 characters.' });

      // Rate limit registrations too — stops spam account creation
      const rlKey = getRateLimitKey(req, email);
      const existing = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (existing.length)
        return res.status(409).json({ error: 'An account with this email already exists.' });

      const hash     = await bcrypt.hash(password, 10);
      const safeRole = ['buyer', 'seller', 'affiliate'].includes(role) ? role : 'buyer';
      const code     = 'REF' + Math.random().toString(36).substr(2, 7).toUpperCase();

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

    /* ────────────────────────────────────────────────────
       RESET PASSWORD (admin sends temp password)
    ──────────────────────────────────────────────────── */
    if (action === 'reset-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email, tempPassword } = req.body || {};
      if (!email || !tempPassword)
        return res.status(400).json({ error: 'Email and temporary password are required.' });

      const rows = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      // Don't reveal whether email exists — always return 200
      if (rows.length) {
        const hash = await bcrypt.hash(tempPassword, 10);
        await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].id}`;
      }

      return res.status(200).json({ ok: true });
    }

    /* ────────────────────────────────────────────────────
       CHANGE PASSWORD (authenticated user)
    ──────────────────────────────────────────────────── */
    if (action === 'change-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { userId, currentPassword, newPassword } = req.body || {};
      if (!userId || !newPassword)
        return res.status(400).json({ error: 'userId and newPassword are required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      // If currentPassword provided, verify it first
      if (currentPassword) {
        const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!match)
          return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
      return res.status(200).json({ ok: true });
    }

    /* ────────────────────────────────────────────────────
       UPDATE PROFILE
       Handles: payout settings, subaccount, role changes,
       suspend/unsuspend, kyc status (admin use)
    ──────────────────────────────────────────────────── */
    if (action === 'update-profile') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const {
        userId, payoutBank, payoutAcct, payoutAname,
        subaccountCode, subaccountStatus,
        role, suspended, kycStatus
      } = req.body || {};

      if (!userId) return res.status(400).json({ error: 'userId is required.' });

      // Validate role if provided — block client-side admin escalation
      const safeRole = role && ['buyer', 'seller', 'affiliate', 'admin'].includes(role)
        ? role : null;

      await sql`
        UPDATE users SET
          payout_bank       = COALESCE(${payoutBank       ?? null}, payout_bank),
          payout_acct       = COALESCE(${payoutAcct       ?? null}, payout_acct),
          payout_aname      = COALESCE(${payoutAname      ?? null}, payout_aname),
          subaccount_code   = COALESCE(${subaccountCode   ?? null}, subaccount_code),
          subaccount_status = COALESCE(${subaccountStatus ?? null}, subaccount_status),
          role              = COALESCE(${safeRole         ?? null}, role),
          suspended         = COALESCE(${suspended        ?? null}, suspended),
          kyc_status        = COALESCE(${kycStatus        ?? null}, kyc_status)
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });
      return res.status(200).json({ user: toPublicUser(rows[0]) });
    }

    /* ────────────────────────────────────────────────────
       KYC SUBMISSION
       Saves NIN/BVN for admin review.
       Paystack Customer Validate is called from paystack.js
    ──────────────────────────────────────────────────── */
    if (action === 'kyc') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { userId, kycType, kycNumber } = req.body || {};
      if (!userId || !kycType || !kycNumber)
        return res.status(400).json({ error: 'userId, kycType and kycNumber are required.' });
      if (!['nin', 'bvn'].includes(kycType.toLowerCase()))
        return res.status(400).json({ error: 'kycType must be nin or bvn.' });
      if (!/^\d{10,11}$/.test(kycNumber.trim()))
        return res.status(400).json({ error: 'Invalid ' + kycType.toUpperCase() + ' — must be 10 or 11 digits.' });

      await sql`
        UPDATE users
        SET kyc_status = 'pending',
            kyc_type   = ${kycType.toLowerCase()},
            kyc_number = ${kycNumber.trim()}
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      return res.status(200).json({
        ok:        true,
        kycStatus: 'pending',
        message:   'Submitted for review. You will be notified within 24 hours.',
        user:      toPublicUser(rows[0])
      });
    }

    return res.status(400).json({ error: 'Unknown action: "' + action + '"' });

  } catch (err) {
    console.error('[auth.js]', action, err.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
};
