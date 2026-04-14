// /api/paystack.js — NeyoMarket Paystack KYC + Withdrawal API
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const PSK = process.env.PAYSTACK_SECRET_KEY; // Add this to Vercel env vars

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function paystackAPI(path, method, body) {
  const opts = {
    method:  method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + PSK,
      'Content-Type':  'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('https://api.paystack.co' + path, opts);
  return res.json();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* ══════════════════════════════════════════════════
       KYC — Validate NIN/BVN via Paystack
       POST /api/paystack?action=kyc
       Body: { userId, kycType, kycNumber }
    ══════════════════════════════════════════════════ */
    if (action === 'kyc') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, kycType, kycNumber } = req.body || {};

      if (!userId || !kycType || !kycNumber)
        return res.status(400).json({ error: 'userId, kycType and kycNumber are required.' });
      if (kycNumber.length < 10)
        return res.status(400).json({ error: 'Invalid ' + kycType.toUpperCase() + ' number.' });

      /* Get user from DB */
      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      /* Call Paystack Validate Customer API */
      const paystackRes = await paystackAPI('/customer/validate', 'POST', {
        email:          user.email,
        first_name:     user.name.split(' ')[0],
        last_name:      user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0],
        type:           kycType,   // 'nin' or 'bvn'
        value:          kycNumber,
        country:        'NG',
        bvn:            kycType === 'bvn' ? kycNumber : undefined,
      });

      let kycStatus = 'pending';

      if (paystackRes.status === true) {
        kycStatus = 'verified';
      } else if (paystackRes.data && paystackRes.data.identification) {
        const idStatus = paystackRes.data.identification.status;
        kycStatus = idStatus === 'success' ? 'verified' : 'pending';
      }

      /* Save to DB */
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
          ? 'Identity verified successfully!'
          : 'Verification submitted — being reviewed.'
      });
    }

    /* ══════════════════════════════════════════════════
       GET BALANCE — fetch subaccount balance
       GET /api/paystack?action=balance&userId=xxx
    ══════════════════════════════════════════════════ */
    if (action === 'balance') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (!user.subaccount_code)
        return res.status(200).json({ balance: 0, message: 'No subaccount set up yet.' });

      /* Fetch subaccount details from Paystack */
      const paystackRes = await paystackAPI('/subaccount/' + user.subaccount_code);
      const balance = paystackRes.data ? (paystackRes.data.account_balance || 0) / 100 : 0;

      return res.status(200).json({ balance: balance, subaccountCode: user.subaccount_code });
    }

    /* ══════════════════════════════════════════════════
       REQUEST PAYOUT — trigger withdrawal
       POST /api/paystack?action=withdraw
       Body: { userId, amount }
    ══════════════════════════════════════════════════ */
    if (action === 'withdraw') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required.' });

      /* Get user */
      const users = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      /* Safety checks */
      if (user.kyc_status !== 'verified')
        return res.status(403).json({ error: 'KYC verification required before withdrawal.' });
      if (!user.subaccount_code)
        return res.status(400).json({ error: 'No subaccount set up. Add payout details first.' });
      if (amount < 2000)
        return res.status(400).json({ error: 'Minimum withdrawal is ₦2,000.' });

      /* Create transfer recipient if needed */
      const recipientRes = await paystackAPI('/transferrecipient', 'POST', {
        type:           'nuban',
        name:           user.payout_aname || user.name,
        account_number: user.payout_acct,
        bank_code:      user.payout_bank,
        currency:       'NGN'
      });

      if (!recipientRes.status)
        return res.status(400).json({ error: 'Could not create transfer recipient: ' + (recipientRes.message || 'Unknown error') });

      const recipientCode = recipientRes.data.recipient_code;
      const amountKobo    = Math.floor(amount * 100);

      /* Initiate transfer */
      const transferRes = await paystackAPI('/transfer', 'POST', {
        source:    'balance',
        amount:    amountKobo,
        recipient: recipientCode,
        reason:    'NeyoMarket seller payout'
      });

      if (!transferRes.status)
        return res.status(400).json({ error: 'Transfer failed: ' + (transferRes.message || 'Unknown error') });

      /* Save withdrawal record */
      await sql`
        INSERT INTO withdrawals (user_id, amount, status, reference, created_at)
        VALUES (
          ${userId},
          ${amount},
          ${'pending'},
          ${transferRes.data.reference || ''},
          NOW()
        )
      `;

      return res.status(200).json({
        ok:        true,
        reference: transferRes.data.reference,
        message:   'Payout of ₦' + amount.toLocaleString() + ' initiated successfully!'
      });
    }

    /* ══════════════════════════════════════════════════
       GET WITHDRAWAL HISTORY
       GET /api/paystack?action=withdrawals&userId=xxx
    ══════════════════════════════════════════════════ */
    if (action === 'withdrawals') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required.' });
      const rows = await sql`
        SELECT * FROM withdrawals WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20
      `;
      return res.status(200).json({ withdrawals: rows });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[paystack.js]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};

