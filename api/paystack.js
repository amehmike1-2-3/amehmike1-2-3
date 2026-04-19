// /api/paystack.js — NeyoMarket Paystack KYC + Withdrawal API
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const PSK = process.env.PAYSTACK_SECRET_KEY;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function paystackAPI(path, method, body) {
  try {
    const opts = {
      method: method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + PSK,
        'Content-Type': 'application/json'
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch('https://api.paystack.co' + path, opts);
    
    /* Zero-response fix — check if response has content */
    const text = await res.text();
    if (!text || text.trim() === '') {
      return { status: false, message: 'Empty response from Paystack' };
    }
    try {
      return JSON.parse(text);
    } catch(e) {
      return { status: false, message: 'Invalid response from Paystack: ' + text.substring(0, 100) };
    }
  } catch(err) {
    return { status: false, message: 'Paystack unreachable: ' + err.message };
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* KYC — Validate NIN/BVN */
    if (action === 'kyc') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, kycType, kycNumber } = req.body || {};

      if (!userId || !kycType || !kycNumber)
        return res.status(400).json({ error: 'userId, kycType and kycNumber are required.' });
      if (kycNumber.length < 10)
        return res.status(400).json({ error: 'Invalid ' + kycType.toUpperCase() + ' — must be at least 10 digits.' });
      if (!PSK)
        return res.status(500).json({ error: 'Paystack key not configured. Contact admin.' });

      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      /* Call Paystack */
      const paystackRes = await paystackAPI('/customer/validate', 'POST', {
        email:      user.email,
        first_name: user.name.split(' ')[0],
        last_name:  user.name.split(' ').slice(1).join(' ') || user.name,
        type:       kycType,
        value:      kycNumber,
        country:    'NG'
      });

      /* Check for warming up / empty response */
      if (!paystackRes || paystackRes.message === 'Empty response from Paystack') {
        return res.status(200).json({
          ok: true,
          kycStatus: 'pending',
          message: 'Verification service is warming up, please try again in a moment.'
        });
      }

      /* Determine status */
      let kycStatus = 'pending';
      if (paystackRes.status === true) {
        kycStatus = 'verified';
      } else if (paystackRes.data && paystackRes.data.identification) {
        kycStatus = paystackRes.data.identification.status === 'success' ? 'verified' : 'pending';
      } else if (paystackRes.message && paystackRes.message.toLowerCase().includes('success')) {
        kycStatus = 'verified';
      }

      await sql`
        UPDATE users
        SET kyc_status = ${kycStatus},
            kyc_type   = ${kycType},
            kyc_number = ${kycNumber}
        WHERE id = ${userId}
      `;

      return res.status(200).json({
        ok:        true,
        kycStatus: kycStatus,
        message:   kycStatus === 'verified'
          ? 'Identity verified! You can now list products.'
          : 'Submitted! Under review — usually takes a few minutes.'
      });
    }

    /* GET BALANCE */
    if (action === 'balance') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (!user.subaccount_code)
        return res.status(200).json({ balance: 0, message: 'No subaccount yet.' });

      const paystackRes = await paystackAPI('/subaccount/' + user.subaccount_code);
      const balance = (paystackRes.data && paystackRes.data.account_balance)
        ? paystackRes.data.account_balance / 100 : 0;

      return res.status(200).json({ balance: balance });
    }

    /* REQUEST WITHDRAWAL — saves to DB, admin processes later */
    if (action === 'request-withdraw') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required.' });

      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (user.kyc_status !== 'verified')
        return res.status(403).json({ error: 'KYC verification required.' });
      if (!user.payout_acct || !user.payout_bank)
        return res.status(400).json({ error: 'Add bank details in Payout Settings first.' });
      if (amount < 2000)
        return res.status(400).json({ error: 'Minimum withdrawal is ₦2,000.' });

      const bal = parseFloat(user.seller_balance || 0);
      if (amount > bal)
        return res.status(400).json({ error: 'Amount exceeds your available balance of ₦' + bal.toLocaleString() + '.' });

      /* Save withdrawal request — status 'pending' until admin approves */
      await sql`
        INSERT INTO withdrawals (user_id, amount, status, reference, created_at)
        VALUES (${userId}, ${amount}, ${'pending'}, ${''}, NOW())
      `;

      return res.status(201).json({ ok: true, message: 'Withdrawal request submitted! Admin will process it shortly.' });
    }

    /* ══════════════════════════════════════════════════════
       APPROVE PAYOUT — admin clicks 'Approve' on a pending request
       1. Creates Paystack transfer recipient
       2. Triggers Paystack Transfer API
       3. Deducts amount from seller_balance in Neon
       4. Marks withdrawal as 'success' in withdrawals table
    ══════════════════════════════════════════════════════ */
    if (action === 'approve-payout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { withdrawalId, userId, amount } = req.body || {};
      if (!withdrawalId || !userId || !amount)
        return res.status(400).json({ error: 'withdrawalId, userId and amount required.' });

      /* Load user */
      const users = await sql`SELECT * FROM users WHERE id = ${String(userId)} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (!user.payout_acct || !user.payout_bank)
        return res.status(400).json({ error: 'Seller has no bank details saved.' });

      const bal = parseFloat(user.seller_balance || 0);
      const amt = parseFloat(amount);
      if (amt > bal)
        return res.status(400).json({ error: `Seller balance (₦${bal.toLocaleString()}) is less than requested (₦${amt.toLocaleString()}).` });

      let transferRef = 'MAN-' + Date.now();
      let transferOk  = false;

      /* Attempt Paystack Transfer if key is available */
      if (PSK) {
        /* Step 1: Create recipient */
        const recipRes = await paystackAPI('/transferrecipient', 'POST', {
          type:           'nuban',
          name:           user.payout_aname || user.name,
          account_number: user.payout_acct,
          bank_code:      user.payout_bank,
          currency:       'NGN'
        });

        if (!recipRes.status)
          return res.status(400).json({ error: 'Could not create recipient: ' + (recipRes.message || 'Check bank details') });

        /* Step 2: Initiate transfer */
        const transferRes = await paystackAPI('/transfer', 'POST', {
          source:    'balance',
          amount:    Math.floor(amt * 100), /* kobo */
          recipient: recipRes.data.recipient_code,
          reason:    'NeyoMarket seller payout — ' + user.name
        });

        if (!transferRes.status)
          return res.status(400).json({ error: 'Transfer failed: ' + (transferRes.message || 'Try again') });

        transferRef = transferRes.data.reference || transferRef;
        transferOk  = true;
      } else {
        /* No PSK — mark as manually approved (admin handles bank transfer themselves) */
        transferOk = true;
      }

      if (transferOk) {
        /* Step 3: Deduct from seller_balance in Neon */
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) - ${amt}
          WHERE id = ${String(userId)}
        `;

        /* Step 4: Mark withdrawal as success */
        await sql`
          UPDATE withdrawals
          SET status    = 'success',
              reference = ${transferRef}
          WHERE id = ${String(withdrawalId)}
        `;
      }

      return res.status(200).json({
        ok:        true,
        reference: transferRef,
        message:   '₦' + amt.toLocaleString() + ' sent to ' + (user.payout_aname || user.name)
      });
    }

    /* REQUEST PAYOUT — admin-triggered, processes immediately */
    if (action === 'withdraw') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required.' });

      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (user.kyc_status !== 'verified')
        return res.status(403).json({ error: 'Complete KYC verification first.' });
      if (!user.payout_acct || !user.payout_bank)
        return res.status(400).json({ error: 'Add your bank details in Payout Settings first.' });
      if (amount < 2000)
        return res.status(400).json({ error: 'Minimum withdrawal is ₦2,000.' });

      /* Create recipient */
      const recipientRes = await paystackAPI('/transferrecipient', 'POST', {
        type:           'nuban',
        name:           user.payout_aname || user.name,
        account_number: user.payout_acct,
        bank_code:      user.payout_bank,
        currency:       'NGN'
      });

      if (!recipientRes.status)
        return res.status(400).json({ error: 'Could not create recipient: ' + (recipientRes.message || 'Try again') });

      const transferRes = await paystackAPI('/transfer', 'POST', {
        source:    'balance',
        amount:    Math.floor(amount * 100),
        recipient: recipientRes.data.recipient_code,
        reason:    'NeyoMarket seller payout'
      });

      if (!transferRes.status)
        return res.status(400).json({ error: 'Transfer failed: ' + (transferRes.message || 'Try again') });

      await sql`
        INSERT INTO withdrawals (user_id, amount, status, reference, created_at)
        VALUES (${userId}, ${amount}, ${'pending'}, ${transferRes.data.reference || ''}, NOW())
      `;

      return res.status(200).json({
        ok:        true,
        reference: transferRes.data.reference,
        message:   'Payout of ₦' + Number(amount).toLocaleString() + ' initiated!'
      });
    }

    /* WITHDRAWAL HISTORY — supports ?userId=all for admin */
    if (action === 'withdrawals') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });
      const rows = userId === 'all'
        ? await sql`SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 200`
        : await sql`SELECT * FROM withdrawals WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 50`;
      return res.status(200).json({ withdrawals: rows });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[paystack.js]', err);
    return res.status(500).json({ error: err.message || 'Server error. Please try again.' });
  }
};
