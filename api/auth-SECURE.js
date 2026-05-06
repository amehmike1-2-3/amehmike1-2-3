// /api/auth.js — NeyoMarket Authentication API with MILITARY-GRADE SECURITY
// Features: JWT auth, role-based access control, rate limiting, token verification

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');
const jwt      = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRE = '7d';

/* ════════════════════════════════════════════════════════
   GMAIL SMTP CONFIGURATION
════════════════════════════════════════════════════════ */
const gmailTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  },
  logger: false,
  debug: false
});

/* ════════════════════════════════════════════════════════
   RATE LIMITER
════════════════════════════════════════════════════════ */
const loginAttempts = new Map();
const RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 30 * 60 * 1000,
};

function getRateLimitKey(req, email) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  return ip + '|' + (email || '').toLowerCase().trim();
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true };
  if (now - entry.firstAttempt > RATE_LIMIT.windowMs) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT.maxAttempts) {
    const waitMs = RATE_LIMIT.blockMs - (now - entry.firstAttempt);
    const waitMinutes = Math.ceil(waitMs / 60000);
    return { allowed: false, waitMinutes };
  }
  return { allowed: true };
}

function recordFailedAttempt(key) {
  const now = Date.now();
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
   SECURITY MIDDLEWARE
════════════════════════════════════════════════════════ */

// Generate JWT Token
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

// Verify JWT Token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Extract token from Authorization header
function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

// MIDDLEWARE: protect() — Verify user is authenticated
async function protect(req, res, token) {
  if (!token) {
    return res.status(401).json({ error: 'No token provided. Please login.' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
  
  // Verify user still exists in database
  const rows = await sql`SELECT * FROM users WHERE id = ${decoded.id} LIMIT 1`;
  if (!rows.length) {
    return res.status(401).json({ error: 'User not found. Token invalid.' });
  }
  
  return { user: rows[0], decoded };
}

// MIDDLEWARE: restrictTo(role) — Check if user has required role
function restrictTo(requiredRole) {
  return function(user) {
    if (user.role !== requiredRole) {
      return { allowed: false, error: '403 Forbidden: Admin access required.' };
    }
    return { allowed: true };
  };
}

/* ════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════ */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function toPublicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    role: row.role || 'buyer',
    affCode: row.aff_code || '',
    isVerified: row.is_verified || false,
    joined: row.joined ? new Date(row.joined).toLocaleDateString() : '',
    kycStatus: row.kyc_status || 'unverified',
    suspended: row.suspended || false,
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ════════════════════════════════════════════════════════
   EMAIL FUNCTIONS
════════════════════════════════════════════════════════ */
async function sendVerificationEmail(userEmail, userName, verificationToken) {
  const verificationLink = `https://neyomarket.com.ng/verify.html?token=${verificationToken}`;
  const emailContent = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:Segoe UI,sans-serif;background:#f5f5f5}
      .container{max-width:600px;margin:0 auto;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
      .header{background:linear-gradient(135deg,#1e3a8a 0%,#1e40af 100%);padding:50px 20px;text-align:center}
      .header h1{color:#fff;font-size:36px;font-weight:700;margin:0}
      .content{padding:40px 30px;color:#1f2937}
      .cta-button{display:inline-block;background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff;padding:16px 40px;border-radius:50px;text-decoration:none;font-weight:600;font-size:15px;text-align:center;margin:24px 0;box-shadow:0 4px 12px rgba(37,99,235,.3)}
      .footer{background:#f9fafb;padding:30px;text-align:center;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280}
    </style></head><body>
      <div class="container">
        <div class="header"><h1>🛍️ NEYO MARKET</h1><p>Engineering the Standard of E-commerce in Nigeria</p></div>
        <div class="content">
          <h2>Welcome, ${userName}! 👋</h2>
          <p>Verify your email to activate your account:</p>
          <a href="${verificationLink}" class="cta-button">✅ Verify Email Address</a>
          <p>Link expires in 24 hours.</p>
        </div>
        <div class="footer"><p>Neyo Market - Engineering the Standard of E-commerce in Nigeria</p></div>
      </div>
    </body></html>
  `;
  
  try {
    await gmailTransporter.sendMail({
      from: 'NeyoMarket <' + process.env.GMAIL_USER + '>',
      to: userEmail,
      subject: '✅ Verify Your Email - NeyoMarket',
      html: emailContent,
      replyTo: 'support@neyomarket.com.ng',
    });
    return { success: true };
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    return { success: false, error: err.message };
  }
}

async function sendPasswordResetEmail(userEmail, userName, resetLink) {
  const emailContent = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:Segoe UI,sans-serif;background:#f5f5f5}
      .container{max-width:600px;margin:0 auto;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
      .header{background:linear-gradient(135deg,#1e3a8a 0%,#1e40af 100%);padding:50px 20px;text-align:center}
      .header h1{color:#fff;font-size:36px;font-weight:700;margin:0}
      .content{padding:40px 30px;color:#1f2937}
      .cta-button{display:inline-block;background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff;padding:16px 40px;border-radius:50px;text-decoration:none;font-weight:600;font-size:15px;text-align:center;margin:24px 0;box-shadow:0 4px 12px rgba(37,99,235,.3)}
      .footer{background:#f9fafb;padding:30px;text-align:center;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280}
    </style></head><body>
      <div class="container">
        <div class="header"><h1>🛍️ NEYO MARKET</h1><p>Engineering the Standard of E-commerce in Nigeria</p></div>
        <div class="content">
          <h2>Password Reset Request 🔐</h2>
          <p>Hi ${userName},</p>
          <p>Click below to reset your password:</p>
          <a href="${resetLink}" class="cta-button">🔑 Reset Your Password</a>
          <p><strong>⚠️ Link expires in 1 hour.</strong> If you didn't request this, ignore this email.</p>
        </div>
        <div class="footer"><p>Neyo Market - Engineering the Standard of E-commerce in Nigeria</p></div>
      </div>
    </body></html>
  `;
  
  try {
    await gmailTransporter.sendMail({
      from: 'NeyoMarket <' + process.env.GMAIL_USER + '>',
      to: userEmail,
      subject: '🔐 Password Reset - NeyoMarket',
      html: emailContent,
      replyTo: 'support@neyomarket.com.ng',
    });
    return { success: true };
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    return { success: false, error: err.message };
  }
}

/* ════════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const token = getTokenFromRequest(req);

  try {

    /* ────────────────────────────────────────────────────
       LOGIN (NO AUTH NEEDED)
    ──────────────────────────────────────────────────── */
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: 'Email and password required.' });
      if (!validateEmail(email))
        return res.status(400).json({ error: 'Invalid email format.' });

      const rlKey = getRateLimitKey(req, email);
      const rlCheck = checkRateLimit(rlKey);
      if (!rlCheck.allowed) {
        return res.status(429).json({ error: `Too many attempts. Wait ${rlCheck.waitMinutes} minutes.` });
      }

      const rows = await sql`SELECT * FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
      const user = rows[0] || null;
      const dummyHash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
      const hashToTest = user ? user.password_hash : dummyHash;
      const match = await bcrypt.compare(password, hashToTest);

      if (!user || !match) {
        recordFailedAttempt(rlKey);
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      if (!user.is_verified) {
        return res.status(403).json({ error: 'Please verify your email first.', requiresVerification: true });
      }

      if (user.suspended) {
        return res.status(403).json({ error: 'Account suspended. Contact support.' });
      }

      clearAttempts(rlKey);
      const jwtToken = generateToken(user);
      return res.status(200).json({ token: jwtToken, user: toPublicUser(user) });
    }

    /* ────────────────────────────────────────────────────
       REGISTER (NO AUTH NEEDED)
    ──────────────────────────────────────────────────── */
    if (action === 'register') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { name, email, phone, role, password } = req.body || {};
      if (!name || !email || !password)
        return res.status(400).json({ error: 'Name, email, password required.' });
      if (!validateEmail(email))
        return res.status(400).json({ error: 'Invalid email.' });
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be 8+ characters.' });

      const existing = await sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
      if (existing.length)
        return res.status(409).json({ error: 'Email already registered.' });

      const hash = await bcrypt.hash(password, 10);
      const safeRole = ['buyer', 'seller', 'affiliate'].includes(role) ? role : 'buyer';
      const code = 'REF' + Math.random().toString(36).substr(2, 7).toUpperCase();
      const verificationToken = generateVerificationToken();
      const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const inserted = await sql`
        INSERT INTO users (name, email, phone, role, password_hash, aff_code, is_verified, verification_token, token_expiry, joined)
        VALUES (${name.trim()}, ${email.trim().toLowerCase()}, ${phone || ''}, ${safeRole}, ${hash}, ${code}, false, ${verificationToken}, ${tokenExpiry.toISOString()}, NOW())
        RETURNING *
      `;

      const emailResult = await sendVerificationEmail(inserted[0].email, inserted[0].name, verificationToken);
      if (!emailResult.success) {
        console.error('[REGISTER] Email failed');
        return res.status(201).json({ user: toPublicUser(inserted[0]), emailSent: false, message: 'Account created. Please contact support for verification.' });
      }

      return res.status(201).json({ user: toPublicUser(inserted[0]), emailSent: true, message: 'Account created! Check your email.' });
    }

    /* ────────────────────────────────────────────────────
       VERIFY EMAIL (NO AUTH NEEDED)
    ──────────────────────────────────────────────────── */
    if (action === 'verify-email') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { token: verifyToken } = req.body || {};
      if (!verifyToken)
        return res.status(400).json({ error: 'Token required.' });

      const rows = await sql`SELECT * FROM users WHERE verification_token = ${verifyToken} AND token_expiry > NOW() LIMIT 1`;
      if (!rows.length)
        return res.status(400).json({ error: 'Invalid or expired token.' });

      const user = rows[0];
      await sql`UPDATE users SET is_verified = true, verification_token = NULL, token_expiry = NULL WHERE id = ${user.id}`;

      const updated = await sql`SELECT * FROM users WHERE id = ${user.id} LIMIT 1`;
      return res.status(200).json({ ok: true, message: 'Email verified! You can now login.', user: toPublicUser(updated[0]) });
    }

    /* ────────────────────────────────────────────────────
       RESET PASSWORD (NO AUTH NEEDED)
    ──────────────────────────────────────────────────── */
    if (action === 'reset-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email } = req.body || {};
      if (!email)
        return res.status(400).json({ error: 'Email required.' });

      const rows = await sql`SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1`;
      if (!rows.length)
        return res.status(200).json({ ok: true, message: 'If email exists, reset link sent.' });

      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
      const resetLink = `https://neyomarket.com.ng/reset-password.html?token=${resetToken}`;

      await sql`UPDATE users SET reset_token = ${resetToken}, reset_token_expiry = ${tokenExpiry.toISOString()} WHERE id = ${user.id}`;

      const emailResult = await sendPasswordResetEmail(user.email, user.name, resetLink);
      if (!emailResult.success) {
        return res.status(500).json({ error: 'Failed to send reset email. Try again later.' });
      }

      return res.status(200).json({ ok: true, message: 'Reset link sent to your email.' });
    }

    /* ────────────────────────────────────────────────────
       CONFIRM PASSWORD RESET (NO AUTH NEEDED)
    ──────────────────────────────────────────────────── */
    if (action === 'confirm-password-reset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { token: resetToken, newPassword } = req.body || {};
      if (!resetToken || !newPassword)
        return res.status(400).json({ error: 'Token and password required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'Password must be 8+ characters.' });

      const rows = await sql`SELECT * FROM users WHERE reset_token = ${resetToken} AND reset_token_expiry > NOW() LIMIT 1`;
      if (!rows.length)
        return res.status(400).json({ error: 'Invalid or expired token.' });

      const user = rows[0];
      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash}, reset_token = NULL, reset_token_expiry = NULL WHERE id = ${user.id}`;

      return res.status(200).json({ ok: true, message: 'Password reset! Login with new password.' });
    }

    /* ────────────────────────────────────────────────────
       CHANGE PASSWORD (AUTH REQUIRED)
    ──────────────────────────────────────────────────── */
    if (action === 'change-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const protected = await protect(req, res, token);
      if (protected.error) return protected.error;

      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword)
        return res.status(400).json({ error: 'Current and new password required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'New password must be 8+ characters.' });

      const match = await bcrypt.compare(currentPassword, protected.user.password_hash);
      if (!match)
        return res.status(401).json({ error: 'Current password incorrect.' });

      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${protected.user.id}`;

      return res.status(200).json({ ok: true, message: 'Password changed successfully.' });
    }

    /* ────────────────────────────────────────────────────
       GET MY PROFILE (AUTH REQUIRED)
    ──────────────────────────────────────────────────── */
    if (action === 'get-profile') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

      const protected = await protect(req, res, token);
      if (protected.error) return protected.error;

      return res.status(200).json({ user: toPublicUser(protected.user) });
    }

    /* ────────────────────────────────────────────────────
       UPDATE PROFILE (AUTH REQUIRED)
    ──────────────────────────────────────────────────── */
    if (action === 'update-profile') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const protected = await protect(req, res, token);
      if (protected.error) return protected.error;

      const { name, phone, payoutBank, payoutAcct, payoutAname } = req.body || {};

      await sql`
        UPDATE users SET 
          name = COALESCE(${name ?? null}, name),
          phone = COALESCE(${phone ?? null}, phone),
          payout_bank = COALESCE(${payoutBank ?? null}, payout_bank),
          payout_acct = COALESCE(${payoutAcct ?? null}, payout_acct),
          payout_aname = COALESCE(${payoutAname ?? null}, payout_aname)
        WHERE id = ${protected.user.id}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${protected.user.id} LIMIT 1`;
      return res.status(200).json({ user: toPublicUser(rows[0]) });
    }

    /* ────────────────────────────────────────────────────
       KYC SUBMISSION (AUTH REQUIRED)
    ──────────────────────────────────────────────────── */
    if (action === 'kyc') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const protected = await protect(req, res, token);
      if (protected.error) return protected.error;

      const { kycType, kycNumber } = req.body || {};
      if (!kycType || !kycNumber)
        return res.status(400).json({ error: 'KYC type and number required.' });
      if (!['nin', 'bvn'].includes(kycType.toLowerCase()))
        return res.status(400).json({ error: 'Invalid KYC type.' });
      if (!/^\d{10,11}$/.test(kycNumber.trim()))
        return res.status(400).json({ error: 'Invalid KYC number.' });

      await sql`UPDATE users SET kyc_status = 'pending', kyc_type = ${kycType.toLowerCase()}, kyc_number = ${kycNumber.trim()} WHERE id = ${protected.user.id}`;

      const rows = await sql`SELECT * FROM users WHERE id = ${protected.user.id} LIMIT 1`;
      return res.status(200).json({ ok: true, message: 'KYC submitted for review.', user: toPublicUser(rows[0]) });
    }

    return res.status(400).json({ error: 'Unknown action.' });

  } catch (err) {
    console.error('[AUTH ERROR]', err.message);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
};

/* ════════════════════════════════════════════════════════
   EXPORT SECURITY MIDDLEWARE FOR OTHER FILES
════════════════════════════════════════════════════════ */
module.exports.protect = protect;
module.exports.restrictTo = restrictTo;
module.exports.getTokenFromRequest = getTokenFromRequest;
module.exports.verifyToken = verifyToken;
module.exports.generateToken = generateToken;
