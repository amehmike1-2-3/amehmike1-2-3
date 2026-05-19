// /api/users.js — ADMIN ONLY
// User management - Admin access required via token in header

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
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
    sellerBalance: parseFloat(row.seller_balance || 0),
    affiliateBalance: parseFloat(row.affiliate_balance || 0),
    membershipTier: row.membership_tier || 'free',
    tierRef: row.tier_ref || '',
    loyaltyPoints: parseInt(row.loyalty_points || 0),
    loyaltyHistory: row.loyalty_history || [],
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  /* ══════════════════════════════════════════════════════
     PUBLIC WALLET ENDPOINTS — no admin token needed
  ══════════════════════════════════════════════════════ */

  /* GET wallet transactions */
  if (action === 'wallet-transactions' && req.method === 'GET') {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required.' });
      const rows = await sql`
        SELECT type, amount, description, ref, created_at
        FROM wallet_transactions
        WHERE user_id = ${String(userId)}
        ORDER BY created_at DESC
        LIMIT 30
      `;
      return res.status(200).json({ ok: true, transactions: rows });
    } catch(err) {
      console.error('[users/wallet-transactions]', err.message);
      return res.status(500).json({ ok: false, error: 'Could not load transactions.' });
    }
  }

  /* POST wallet top-up */
  if (action === 'wallet-topup' && req.method === 'POST') {
    try {
      const { userId, amount, ref } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required.' });
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt < 500) return res.status(400).json({ error: 'Minimum top up is ₦500.' });

      await sql`UPDATE users SET buyer_wallet = COALESCE(buyer_wallet,0) + ${amt} WHERE id = ${String(userId)}`;
      await sql`INSERT INTO wallet_transactions (user_id, type, amount, description, ref, created_at) VALUES (${String(userId)}, 'credit', ${amt}, ${'Wallet top-up'}, ${ref||''}, NOW())`;
      return res.status(200).json({ ok: true });
    } catch(err) {
      console.error('[users/wallet-topup]', err.message);
      return res.status(500).json({ ok: false, error: 'Could not process top-up.' });
    }
  }

  /* POST referral bonus — award ₦500 to referrer and new buyer */
  if (action === 'referral-bonus' && req.method === 'POST') {
    try {
      const { refCode, newUserId } = req.body || {};
      if (!refCode) return res.status(400).json({ error: 'refCode required.' });

      /* STRICT GUARD 1: refCode must be a real non-guest code */
      const cleanRef = String(refCode).trim();
      if (!cleanRef || cleanRef.length < 3 || cleanRef === 'GUEST') {
        return res.status(200).json({ ok: true, skipped: 'No valid referral code.' });
      }

      /* STRICT GUARD 2: newUserId must be provided — we need it to check for duplicates */
      if (!newUserId) return res.status(400).json({ error: 'newUserId required.' });
      const cleanBuyerId = String(newUserId).trim();

      /* DEDUP GUARD: Check if this buyer has already received a referral bonus.
         We record this via a non-null referred_by column on the users table.
         If the buyer already has referred_by set, abort — bonus was already paid. */
      const buyerRows = await sql`SELECT id, referred_by FROM users WHERE id = ${cleanBuyerId} LIMIT 1`;
      if (!buyerRows.length) return res.status(200).json({ ok: true, skipped: 'Buyer not found.' });
      if (buyerRows[0].referred_by) {
        return res.status(200).json({ ok: true, skipped: 'Referral bonus already claimed for this buyer.' });
      }

      /* SELF-REFERRAL GUARD: referrer must not be the same person as the buyer */
      const referrers = await sql`SELECT id, buyer_ref_count FROM users WHERE (aff_code = ${cleanRef} OR buyer_ref_code = ${cleanRef}) AND id != ${cleanBuyerId} LIMIT 1`;
      if (!referrers.length) return res.status(200).json({ ok: true, skipped: 'Referrer not found or self-referral blocked.' });

      const referrerId   = String(referrers[0].id);
      const currentCount = parseInt(referrers[0].buyer_ref_count || 0);

      /* Mark buyer as referred FIRST — prevents race condition double-credit */
      await sql`UPDATE users SET referred_by = ${cleanRef} WHERE id = ${cleanBuyerId}`;

      /* Award ₦500 to referrer */
      await sql`UPDATE users SET buyer_wallet = COALESCE(buyer_wallet,0) + 500, buyer_ref_count = ${currentCount + 1} WHERE id = ${referrerId}`;
      await sql`INSERT INTO wallet_transactions (user_id, type, amount, description, ref, created_at) VALUES (${referrerId}, 'credit', ${500}, ${'Referral bonus — friend made first purchase'}, ${cleanBuyerId}, NOW())`;

      /* Award ₦500 welcome bonus to new buyer */
      await sql`UPDATE users SET buyer_wallet_bonus = COALESCE(buyer_wallet_bonus,0) + 500 WHERE id = ${cleanBuyerId}`;
      await sql`INSERT INTO wallet_transactions (user_id, type, amount, description, ref, created_at) VALUES (${cleanBuyerId}, 'credit', ${500}, ${'Welcome bonus — referred by a friend'}, ${cleanRef}, NOW())`;

      console.log('[users/referral-bonus] ₦500 awarded — referrer:', referrerId, '← buyer:', cleanBuyerId, 'via code:', cleanRef);
      return res.status(200).json({ ok: true });
    } catch(err) {
      console.error('[users/referral-bonus]', err.message);
      return res.status(500).json({ ok: false, error: 'Could not process referral bonus.' });
    }
  }

  /* ══════════════════════════════════════════════════════
     ADMIN ENDPOINTS — token required below
  ══════════════════════════════════════════════════════ */
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: '401 Unauthorized: Token required.' });
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: '403 Forbidden: Invalid token.' });

  try {
    /* ────────────────────────────────────────────────────
       GET USERS (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'GET') {
      const userId = req.query.userId;
      
      if (userId) {
        const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        return res.status(200).json({ user: toPublicUser(rows[0]) });
      }
      
      const rows = await sql`SELECT * FROM users ORDER BY joined DESC`;
      return res.status(200).json({ users: rows.map(toPublicUser), total: rows.length });
    }

    /* ────────────────────────────────────────────────────
       UPDATE USER (ADMIN ONLY)
    ──────────────────────────────────────────────────── */
    if (req.method === 'POST') {
      const { userId, role, suspended, kycStatus, membershipTier, tierRef, loyaltyPoints, loyaltyHistory } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const safeRole = ['buyer', 'seller', 'affiliate', 'admin'].includes(role) ? role : null;
      const safeTier = ['free', 'starter', 'pro', 'business'].includes(membershipTier) ? membershipTier : null;

      await sql`
        UPDATE users SET
          role             = COALESCE(${safeRole ?? null}, role),
          suspended        = COALESCE(${suspended ?? null}, suspended),
          kyc_status       = COALESCE(${kycStatus ?? null}, kyc_status),
          membership_tier  = COALESCE(${safeTier ?? null}, membership_tier),
          tier_ref         = COALESCE(${tierRef ?? null}, tier_ref),
          loyalty_points   = COALESCE(${loyaltyPoints ?? null}, loyalty_points),
          loyalty_history  = COALESCE(${loyaltyHistory ? JSON.stringify(loyaltyHistory) : null}::jsonb, loyalty_history)
        WHERE id = ${userId}
      `;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'User not found.' });

      return res.status(200).json({ user: toPublicUser(rows[0]), message: 'User updated.' });
    }

    if (req.method === 'DELETE') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ ok: true, message: 'User deleted.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('[USERS ERROR]', err.message);
    return res.status(500).json({ error: 'Server error.' });
  }
};
