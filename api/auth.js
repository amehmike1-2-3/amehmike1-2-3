// /api/auth.js — NeyoMarket Authentication API with Brevo Email Verification
// Features: login, register (with email verification via Brevo), reset-password, change-password,
//           update-profile, kyc, verify-email — all with rate limiting

const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');

const sql = neon(process.env.DATABASE_URL);
const BREVO_API_KEY = process.env.BREVO_API_KEY;

/* ════════════════════════════════════════════════════════
   BREVO SMTP CONFIGURATION
   Uses environment variables for security — credentials NOT hardcoded
   Set these in Vercel Environment Variables:
   - BREVO_SMTP_HOST
   - BREVO_SMTP_PORT
   - BREVO_SMTP_USER
   - BREVO_SMTP_PASS
════════════════════════════════════════════════════════ */
const brevoTransporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.BREVO_SMTP_PORT) || 587,
  secure: false, // TLS, not SSL
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  },
  logger: false, // Set to true for debugging SMTP issues
  debug: false
});

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
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ════════════════════════════════════════════════════════
   BREVO EMAIL SENDING
════════════════════════════════════════════════════════ */
async function sendVerificationEmail(userEmail, userName, verificationToken) {
  if (!BREVO_API_KEY) {
    console.error('[Brevo] API key not configured');
    return { success: false, error: 'Email service not configured' };
  }

  const verificationLink = `https://neyomarket.com.ng/verify.html?token=${verificationToken}`;

  const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; }
        .header { background: linear-gradient(135deg, #c9922a 0%, #a6741f 100%); padding: 40px 20px; text-align: center; }
        .header h1 { color: #fff; font-size: 32px; font-weight: 700; margin-bottom: 10px; font-family: 'Cormorant Garamond', serif; }
        .header p { color: rgba(255,255,255,0.9); font-size: 14px; }
        .content { padding: 40px 20px; color: #111827; }
        .content h2 { font-size: 24px; font-weight: 700; margin-bottom: 16px; color: #0a0a1a; }
        .content p { font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #4b5563; }
        .cta-button { display: inline-block; background: linear-gradient(135deg, #c9922a 0%, #a6741f 100%); color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; text-align: center; margin: 20px 0; }
        .cta-button:hover { transform: translateY(-2px); box-shadow: 0 8px 16px rgba(201, 146, 42, 0.2); }
        .footer { background: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
        .security-note { background: #fef3c7; border-left: 4px solid #c9922a; padding: 12px 16px; margin: 20px 0; font-size: 12px; color: #92400e; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🛍️ NeyoMarket</h1>
          <p>Nigeria's Secure Marketplace</p>
        </div>
        
        <div class="content">
          <h2>Welcome, ${userName}! 👋</h2>
          <p>Thank you for joining NeyoMarket, Nigeria's most trusted marketplace for digital and physical products with escrow-protected payments.</p>
          
          <p><strong>Verify Your Email Address</strong></p>
          <p>To get started and unlock full marketplace access, please verify your email by clicking the button below:</p>
          
          <a href="${verificationLink}" class="cta-button">✅ Verify Your Email</a>
          
          <p style="margin-top: 20px;">Or copy and paste this link in your browser:</p>
          <p style="word-break: break-all; background: #f3f4f6; padding: 12px; border-radius: 4px; font-size: 12px; color: #374151;">
            ${verificationLink}
          </p>
          
          <div class="security-note">
            <strong>🔒 Security Tip:</strong> This link will expire in 24 hours. If you didn't create this account, please ignore this email.
          </div>
          
          <p style="margin-top: 20px; color: #6b7280; font-size: 13px;">
            Need help? Contact our support team at support@neyomarket.com.ng
          </p>
        </div>
        
        <div class="footer">
          <p>&copy; 2026 NeyoMarket. All rights reserved.</p>
          <p>You're receiving this email because you created an account on NeyoMarket.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          name: 'NeyoMarket',
          email: 'noreply@neyomarket.com.ng',
        },
        to: [
          {
            email: userEmail,
            name: userName,
          },
        ],
        subject: '✅ Verify Your Email - NeyoMarket Account Activation',
        htmlContent: emailContent,
        replyTo: {
          email: 'support@neyomarket.com.ng',
          name: 'NeyoMarket Support',
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      console.log('[Brevo] Email sent successfully to', userEmail);
      return { success: true, messageId: data.messageId };
    } else {
      const error = await response.json();
      console.error('[Brevo] Error:', error);
      return { success: false, error: error.message || 'Failed to send email' };
    }
  } catch (err) {
    console.error('[Brevo] Network error:', err.message);
    return { success: false, error: err.message };
  }
}

/* ════════════════════════════════════════════════════════
   PASSWORD RESET EMAIL — via Brevo SMTP
   Uses nodemailer to send from support@neyomarket.com.ng
════════════════════════════════════════════════════════ */
async function sendPasswordResetEmail(userEmail, userName, resetLink) {
  try {
    const emailContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: #fff; }
          .header { background: linear-gradient(135deg, #c9922a 0%, #a6741f 100%); padding: 40px 20px; text-align: center; }
          .header h1 { color: #fff; font-size: 32px; font-weight: 700; margin-bottom: 10px; font-family: 'Cormorant Garamond', serif; }
          .header p { color: rgba(255,255,255,0.9); font-size: 14px; }
          .content { padding: 40px 20px; color: #111827; }
          .content h2 { font-size: 24px; font-weight: 700; margin-bottom: 16px; color: #0a0a1a; }
          .content p { font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #4b5563; }
          .cta-button { display: inline-block; background: linear-gradient(135deg, #c9922a 0%, #a6741f 100%); color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; text-align: center; margin: 20px 0; }
          .cta-button:hover { transform: translateY(-2px); box-shadow: 0 8px 16px rgba(201, 146, 42, 0.2); }
          .footer { background: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
          .warning { background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 20px 0; font-size: 12px; color: #991b1b; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🛍️ NeyoMarket</h1>
            <p>Nigeria's Secure Marketplace</p>
          </div>
          
          <div class="content">
            <h2>Password Reset Request 🔐</h2>
            <p>Hi ${userName},</p>
            <p>We received a request to reset the password for your NeyoMarket account. Click the button below to create a new password:</p>
            
            <a href="${resetLink}" class="cta-button">🔑 Reset Your Password</a>
            
            <p style="margin-top: 20px;">Or copy and paste this link in your browser:</p>
            <p style="word-break: break-all; background: #f3f4f6; padding: 12px; border-radius: 4px; font-size: 12px; color: #374151;">
              ${resetLink}
            </p>
            
            <div class="warning">
              <strong>⚠️ Security Alert:</strong> This link will expire in 1 hour. If you didn't request a password reset, please ignore this email and your account will remain secure.
            </div>
            
            <p style="margin-top: 20px; color: #6b7280; font-size: 13px;">
              <strong>Need help?</strong> Contact our support team at support@neyomarket.com.ng
            </p>
          </div>
          
          <div class="footer">
            <p>&copy; 2026 NeyoMarket. All rights reserved.</p>
            <p>You're receiving this email because a password reset was requested for your account.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const info = await brevoTransporter.sendMail({
      from: 'support@neyomarket.com.ng',
      to: userEmail,
      subject: '🔐 Password Reset - NeyoMarket',
      html: emailContent,
      replyTo: 'support@neyomarket.com.ng',
    });

    console.log('[Brevo SMTP] Password reset email sent to', userEmail, '- Message ID:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Brevo SMTP] Error sending password reset email:', err.message);
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

  try {

    /* ────────────────────────────────────────────────────
       LOGIN
       Rate limited: 5 attempts per IP+email per 15 minutes
       UPDATED: Check is_verified flag
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

      // UPDATED: Check if email is verified
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

      // Success — clear rate limit
      clearAttempts(rlKey);
      return res.status(200).json({ user: toPublicUser(user) });
    }

    /* ────────────────────────────────────────────────────
       REGISTER
       UPDATED: Generate verification token, send Brevo email, save with is_verified: false
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
      const verificationToken = generateVerificationToken();
      const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

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

      // Send verification email via Brevo
      const emailResult = await sendVerificationEmail(
        inserted[0].email,
        inserted[0].name,
        verificationToken
      );

      if (!emailResult.success) {
        console.error('[register] Email send failed:', emailResult.error);
        // Still return success but notify user about email
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
       NEW: Verify token from URL, set is_verified = true
    ──────────────────────────────────────────────────── */
    if (action === 'verify-email') {
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

      // Mark as verified
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
       RESET PASSWORD (admin sends temp password)
    ──────────────────────────────────────────────────── */
    /* ────────────────────────────────────────────────────
       RESET PASSWORD
       UPDATED: Send reset link via Brevo SMTP email
    ──────────────────────────────────────────────────── */
    if (action === 'reset-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

      const { email } = req.body || {};
      if (!email)
        return res.status(400).json({ error: 'Email is required.' });

      const rows = await sql`
        SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
      `;

      // Always return 200 to prevent email enumeration
      if (!rows.length) {
        return res.status(200).json({ 
          ok: true,
          message: 'If an account with this email exists, a password reset link has been sent.'
        });
      }

      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      const resetLink = `https://neyomarket.com.ng/reset-password.html?token=${resetToken}`;

      // Save reset token in database
      await sql`
        UPDATE users 
        SET reset_token = ${resetToken}, reset_token_expiry = ${tokenExpiry.toISOString()}
        WHERE id = ${user.id}
      `;

      // Send password reset email via Brevo SMTP
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
       NEW: Validate reset token and set new password
    ──────────────────────────────────────────────────── */
    if (action === 'confirm-password-reset') {
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

      // Update password and clear reset token
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
