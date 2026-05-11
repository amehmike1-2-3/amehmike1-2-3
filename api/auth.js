// /api/auth.js — NeyoMarket Authentication API with Gmail SMTP Email Service
// Features: login, register (with email verification), reset-password, change-password,
//           update-profile, kyc, verify-email — all with rate limiting

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');

const sql = neon(process.env.DATABASE_URL);

/* ════════════════════════════════════════════════════════
   GMAIL SMTP CONFIGURATION
   Uses environment variables for security — credentials NOT hardcoded
   Set these in Vercel Environment Variables:
   - GMAIL_USER (your Gmail address)
   - GMAIL_PASS (your Google App Password)
════════════════════════════════════════════════════════ */
const gmailTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // SSL/TLS
  auth: {
    user: process.env.GMAIL_USER || 'amehmichael2336@gmail.com',
    pass: process.env.GMAIL_PASS || 'iewd drzi pdbj zxux'
  },
  logger: false,
  debug: false
});

/* ════════════════════════════════════════════════════════
   IN-MEMORY RATE LIMITER
════════════════════════════════════════════════════════ */
const loginAttempts = new Map();

const RATE_LIMIT = {
  maxAttempts: 5,
  windowMs:    15 * 60 * 1000,
  blockMs:     30 * 60 * 1000,
};

function getRateLimitKey(req, email) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  return ip + '|' + (email || '').toLowerCase().trim();
}

function checkRateLimit(key) {
  const now   = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true };

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
    isVerified:       row.is_verified       || false,
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
    membershipTier:   row.membership_tier   || 'free',
    tierRef:          row.tier_ref          || '',
    loyaltyPoints:    parseInt(row.loyalty_points || 0),
    loyaltyHistory:   row.loyalty_history   || [],
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ════════════════════════════════════════════════════════
   EMAIL VERIFICATION — via Gmail SMTP
   Professional Navy Blue Header, Beautiful Design
════════════════════════════════════════════════════════ */
async function sendVerificationEmail(userEmail, userName, verificationToken) {
  const verificationLink = `https://neyomarket.com.ng/verify.html?token=${verificationToken}`;

  const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); padding: 50px 20px; text-align: center; }
        .header h1 { color: #fff; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: 1px; }
        .header p { color: rgba(255,255,255,0.9); font-size: 12px; margin-top: 8px; }
        .content { padding: 40px 30px; color: #1f2937; }
        .content h2 { font-size: 22px; font-weight: 600; margin-bottom: 16px; color: #1e3a8a; }
        .content p { font-size: 14px; line-height: 1.8; margin-bottom: 20px; color: #4b5563; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #fff; padding: 16px 40px; border-radius: 50px; text-decoration: none; font-weight: 600; font-size: 15px; text-align: center; margin: 24px 0; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); transition: transform 0.3s ease; }
        .cta-button:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4); }
        .link-text { background: #f3f4f6; padding: 12px; border-radius: 6px; font-size: 12px; color: #374151; word-break: break-all; margin: 20px 0; }
        .footer { background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb; }
        .footer p { font-size: 12px; color: #6b7280; margin: 8px 0; }
        .security-badge { background: #eff6ff; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 20px 0; font-size: 12px; color: #1e40af; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🛍️ NEYO MARKET</h1>
          <p>Engineering the Standard of E-commerce in Nigeria</p>
        </div>
        
        <div class="content">
          <h2>Welcome, ${userName}! 👋</h2>
          
          <p>Thank you for joining NeyoMarket, Nigeria's most trusted marketplace for digital and physical products with escrow-protected payments.</p>
          
          <p><strong>Verify Your Email Address</strong></p>
          <p>To complete your registration and unlock full marketplace access, please verify your email by clicking the button below:</p>
          
          <a href="${verificationLink}" class="cta-button">✅ Verify Email Address</a>
          
          <p style="margin-top: 30px; font-size: 13px;">Or copy and paste this link in your browser:</p>
          <div class="link-text">${verificationLink}</div>
          
          <div class="security-badge">
            <strong>🔒 Security:</strong> This link will expire in 24 hours. If you didn't create this account, please ignore this email.
          </div>
          
          <p style="margin-top: 20px; font-size: 13px; color: #6b7280;">
            <strong>Questions?</strong> Our support team is here to help: support@neyomarket.com.ng
          </p>
        </div>
        
        <div class="footer">
          <p><strong>Neyo Market</strong> - Engineering the Standard of E-commerce in Nigeria</p>
          <p>&copy; 2026 NeyoMarket. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const info = await gmailTransporter.sendMail({
      from: 'NeyoMarket <amehmichael2336@gmail.com>',
      to: userEmail,
      subject: '✅ Verify Your Email - NeyoMarket Account Activation',
      html: emailContent,
      replyTo: 'support@neyomarket.com.ng',
    });

    console.log('[Gmail SMTP] Verification email sent to', userEmail, '- Message ID:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Gmail SMTP] Error sending verification email:', err.message);
    return { success: false, error: err.message };
  }
}

/* ════════════════════════════════════════════════════════
   PASSWORD RESET EMAIL — via Gmail SMTP
   Navy Blue Header, Beautiful Design
════════════════════════════════════════════════════════ */
async function sendPasswordResetEmail(userEmail, userName, resetLink) {
  const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); padding: 50px 20px; text-align: center; }
        .header h1 { color: #fff; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: 1px; }
        .header p { color: rgba(255,255,255,0.9); font-size: 12px; margin-top: 8px; }
        .content { padding: 40px 30px; color: #1f2937; }
        .content h2 { font-size: 22px; font-weight: 600; margin-bottom: 16px; color: #1e3a8a; }
        .content p { font-size: 14px; line-height: 1.8; margin-bottom: 20px; color: #4b5563; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #fff; padding: 16px 40px; border-radius: 50px; text-decoration: none; font-weight: 600; font-size: 15px; text-align: center; margin: 24px 0; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); transition: transform 0.3s ease; }
        .cta-button:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4); }
        .link-text { background: #f3f4f6; padding: 12px; border-radius: 6px; font-size: 12px; color: #374151; word-break: break-all; margin: 20px 0; }
        .footer { background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb; }
        .footer p { font-size: 12px; color: #6b7280; margin: 8px 0; }
        .warning { background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 20px 0; font-size: 12px; color: #991b1b; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🛍️ NEYO MARKET</h1>
          <p>Engineering the Standard of E-commerce in Nigeria</p>
        </div>
        
        <div class="content">
          <h2>Password Reset Request 🔐</h2>
          
          <p>Hi ${userName},</p>
          <p>We received a request to reset the password for your NeyoMarket account. Click the button below to create a new password:</p>
          
          <a href="${resetLink}" class="cta-button">🔑 Reset Your Password</a>
          
          <p style="margin-top: 30px; font-size: 13px;">Or copy and paste this link in your browser:</p>
          <div class="link-text">${resetLink}</div>
          
          <div class="warning">
            <strong>⚠️ Important:</strong> This link will expire in 1 hour. If you didn't request a password reset, please ignore this email and your account will remain secure.
          </div>
          
          <p style="margin-top: 20px; font-size: 13px; color: #6b7280;">
            <strong>Questions?</strong> Contact our support team: support@neyomarket.com.ng
          </p>
        </div>
        
        <div class="footer">
          <p><strong>Neyo Market</strong> - Engineering the Standard of E-commerce in Nigeria</p>
          <p>&copy; 2026 NeyoMarket. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const info = await gmailTransporter.sendMail({
      from: 'NeyoMarket <amehmichael2336@gmail.com>',
      to: userEmail,
      subject: '🔐 Password Reset - NeyoMarket',
      html: emailContent,
      replyTo: 'support@neyomarket.com.ng',
    });

    console.log('[Gmail SMTP] Password reset email sent to', userEmail, '- Message ID:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Gmail SMTP] Error sending password reset email:', err.message);
    return { success: false, error: err.message };
  }
}

/* ════════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    /* ────────────────────────────────────────────────────
       LOGIN
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });
      if (!validateEmail(email))
        return res.status(400).json({ error: 'Invalid email format.' });

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

      if (!user.is_verified) {
        return res.status(403).json({ 
          error: 'Please verify your account via email to continue.',
          requiresVerification: true,
          email: user.email
        });
      }

      if (user.suspended) {
        return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
      }

      clearAttempts(rlKey);
      return res.status(200).json({ user: toPublicUser(user) });
    }

    /* ────────────────────────────────────────────────────
       REGISTER
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'register') {
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

      const existing = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;
      if (existing.length)
        return res.status(409).json({ error: 'An account with this email already exists.' });

      const hash     = await bcrypt.hash(password, 10);
      const safeRole = ['buyer', 'seller', 'affiliate'].includes(role) ? role : 'buyer';
      const code     = 'REF' + Math.random().toString(36).substr(2, 7).toUpperCase();
      const verificationToken = generateVerificationToken();
      const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const inserted = await sql`
        INSERT INTO users (name, email, phone, role, password_hash, aff_code, is_verified, verification_token, token_expiry, joined)
        VALUES (
          ${name.trim()},
          ${email.trim().toLowerCase()},
          ${phone  || ''},
          ${safeRole},
          ${hash},
          ${code},
          false,
          ${verificationToken},
          ${tokenExpiry.toISOString()},
          NOW()
        )
        RETURNING *
      `;

      const emailResult = await sendVerificationEmail(
        inserted[0].email,
        inserted[0].name,
        verificationToken
      );

      if (!emailResult.success) {
        console.error('[register] Email send failed:', emailResult.error);
        return res.status(201).json({
          user: toPublicUser(inserted[0]),
          requiresVerification: true,
          emailSent: false,
          message: 'Account created but verification email could not be sent. Please contact support.'
        });
      }

      return res.status(201).json({
        user: toPublicUser(inserted[0]),
        requiresVerification: true,
        emailSent: true,
        message: 'Account created! Verification email sent to ' + inserted[0].email
      });
    }

    /* ────────────────────────────────────────────────────
       VERIFY EMAIL
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'verify-email') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { token } = req.body || {};
      if (!token)
        return res.status(400).json({ error: 'Verification token is required.' });

      const rows = await sql`
        SELECT * FROM users 
        WHERE verification_token = ${token}
        AND token_expiry > NOW()
        LIMIT 1
      `;

      if (!rows.length) {
        return res.status(400).json({ 
          error: 'Invalid or expired verification token. Please request a new one.'
        });
      }

      const user = rows[0];

      await sql`
        UPDATE users 
        SET is_verified = true, verification_token = NULL, token_expiry = NULL
        WHERE id = ${user.id}
      `;

      const updated = await sql`SELECT * FROM users WHERE id = ${user.id} LIMIT 1`;
      return res.status(200).json({
        ok: true,
        message: 'Email verified successfully! You can now log in.',
        user: toPublicUser(updated[0])
      });
    }

    /* ────────────────────────────────────────────────────
       RESET PASSWORD
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'reset-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email } = req.body || {};
      if (!email)
        return res.status(400).json({ error: 'Email is required.' });

      const rows = await sql`
        SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;

      if (!rows.length) {
        return res.status(200).json({ 
          ok: true,
          message: 'If an account with this email exists, a password reset link has been sent.'
        });
      }

      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
      const resetLink = `https://neyomarket.com.ng/reset-password.html?token=${resetToken}`;

      await sql`
        UPDATE users 
        SET reset_token = ${resetToken}, reset_token_expiry = ${tokenExpiry.toISOString()}
        WHERE id = ${user.id}
      `;

      const emailResult = await sendPasswordResetEmail(user.email, user.name, resetLink);

      if (!emailResult.success) {
        console.error('[reset-password] Email send failed:', emailResult.error);
        return res.status(500).json({ 
          error: 'Failed to send reset email. Please try again later.'
        });
      }

      return res.status(200).json({ 
        ok: true,
        message: 'Password reset link has been sent to your email. Link expires in 1 hour.'
      });
    }

    /* ────────────────────────────────────────────────────
       CONFIRM PASSWORD RESET
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'confirm-password-reset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { token, newPassword } = req.body || {};
      if (!token || !newPassword)
        return res.status(400).json({ error: 'Token and new password are required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const rows = await sql`
        SELECT * FROM users 
        WHERE reset_token = ${token}
        AND reset_token_expiry > NOW()
        LIMIT 1
      `;

      if (!rows.length) {
        return res.status(400).json({ 
          error: 'Invalid or expired password reset token. Please request a new reset link.'
        });
      }

      const user = rows[0];
      const hash = await bcrypt.hash(newPassword, 10);

      await sql`
        UPDATE users 
        SET password_hash = ${hash}, reset_token = NULL, reset_token_expiry = NULL
        WHERE id = ${user.id}
      `;

      return res.status(200).json({
        ok: true,
        message: 'Password reset successfully! You can now log in with your new password.'
      });
    }

    /* ────────────────────────────────────────────────────
       CHANGE PASSWORD
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'change-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { userId, currentPassword, newPassword } = req.body || {};
      if (!userId || !newPassword)
        return res.status(400).json({ error: 'userId and newPassword are required.' });
      if (newPassword.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

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
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'update-profile') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const {
        userId, payoutBank, payoutAcct, payoutAname,
        subaccountCode, subaccountStatus,
        role, suspended, kycStatus,
        membershipTier, tierRef,
        loyaltyPoints, loyaltyHistory
      } = req.body || {};

      if (!userId) return res.status(400).json({ error: 'userId is required.' });

      const safeRole = role && ['buyer', 'seller', 'affiliate', 'admin'].includes(role)
        ? role : null;
      const safeTier = membershipTier && ['free', 'starter', 'pro', 'business'].includes(membershipTier)
        ? membershipTier : null;
      const safeLoyaltyPts  = (loyaltyPoints !== undefined && loyaltyPoints !== null)
        ? parseInt(loyaltyPoints) : null;
      const safeLoyaltyHist = loyaltyHistory
        ? JSON.stringify(loyaltyHistory) : null;

      await sql`
        UPDATE users SET
          payout_bank       = COALESCE(${payoutBank       ?? null}, payout_bank),
          payout_acct       = COALESCE(${payoutAcct       ?? null}, payout_acct),
          payout_aname      = COALESCE(${payoutAname      ?? null}, payout_aname),
          subaccount_code   = COALESCE(${subaccountCode   ?? null}, subaccount_code),
          subaccount_status = COALESCE(${subaccountStatus ?? null}, subaccount_status),
          role              = COALESCE(${safeRole         ?? null}, role),
          suspended         = COALESCE(${suspended        ?? null}, suspended),
          kyc_status        = COALESCE(${kycStatus        ?? null}, kyc_status),
          membership_tier   = COALESCE(${safeTier         ?? null}, membership_tier),
          tier_ref          = COALESCE(${tierRef          ?? null}, tier_ref),
          loyalty_points    = COALESCE(${safeLoyaltyPts   ?? null}, loyalty_points),
          loyalty_history   = COALESCE(${safeLoyaltyHist  ?? null}::jsonb, loyalty_history)
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });
      return res.status(200).json({ ok: true, user: toPublicUser(rows[0]) });
    }

    /* ────────────────────────────────────────────────────
       KYC SUBMISSION
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'kyc') {
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

    /* ────────────────────────────────────────────────────
       VERIFY SELLER (requires ₦2,000 payment)
    ──────────────────────────────────────────────────── */
    if (req.query.action === 'verify-seller' && req.method === 'POST') {
      const { userId, ref } = req.body || {};
      if (!userId || !ref) return res.status(400).json({ error: 'userId and ref required' });

      try {
        /* Verify payment with Paystack */
        const paystackRes = await fetch('https://api.paystack.co/transaction/verify/' + String(ref), {
          headers: { Authorization: 'Bearer ' + (process.env.PAYSTACK_SECRET_KEY || '') }
        });
        const paystackData = await paystackRes.json();

        if (!paystackData.status || paystackData.data.status !== 'success') {
          return res.status(403).json({ error: 'Payment not verified' });
        }

        /* Set badge_verified only after payment confirmed */
        await sql`
          UPDATE users 
          SET badge_verified = true
          WHERE id = ${String(userId)}
        `;

        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[verify-seller]', err.message);
        return res.status(500).json({ error: 'Verification failed' });
      }
    }

    return res.status(400).json({ error: 'Unknown action.' });

  } catch (err) {
    console.error('[auth.js] ERROR:', err.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
};
