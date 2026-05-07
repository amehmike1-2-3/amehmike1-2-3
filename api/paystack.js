// /api/paystack.js — NeyoMarket Paystack KYC + Withdrawal API
// FIX 4: dvc-release affiliate credit gated on valid aff_code
// FIX 5: all errors return res.json() — never HTML
'use strict';

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const PSK = process.env.PAYSTACK_SECRET_KEY;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options',       'nosniff'); /* FIX 5: prevent MIME sniff to HTML */
}

function jsonErr(res, status, msg, detail) {
  return res.status(status).json({ error: msg, ...(detail ? { detail } : {}) });
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

    /* RESOLVE ACCOUNT — looks up account name from bank code + account number */
    if (action === 'resolve-account') {
      const accountNumber = req.query.accountNumber;
      const bankCode      = req.query.bankCode;
      if (!accountNumber || !bankCode)
        return res.status(400).json({ error: 'accountNumber and bankCode required.' });
      if (!PSK)
        return res.status(200).json({ error: 'Paystack key not configured — enter name manually.' });

      const result = await paystackAPI('/bank/resolve?account_number=' + accountNumber + '&bank_code=' + bankCode);
      if (result.status && result.data) {
        return res.status(200).json({ accountName: result.data.account_name });
      }
      return res.status(200).json({ error: result.message || 'Account not found.' });
    }

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
      const { withdrawalId, userId, amount, flatFee, netAmount, masterKey } = req.body || {};
      if (!withdrawalId || !userId || !amount)
        return res.status(400).json({ error: 'withdrawalId, userId and amount required.' });

      /* ── PHASE 2: Master Key gate ─────────────────────────────────────
         The frontend sends the sessionStorage master key so server-side
         Paystack calls use the key the admin physically injected.
         Fall back to env PSK if masterKey not supplied (legacy calls).
      ────────────────────────────────────────────────────────────────── */
      const activeKey = (masterKey && (masterKey.startsWith('sk_live_') || masterKey.startsWith('sk_test_')))
        ? masterKey
        : PSK;

      if (!activeKey)
        return res.status(403).json({ error: 'Master Key required. Inject your Paystack secret key first.' });

      /* Load user */
      const users = await sql`SELECT * FROM users WHERE id = ${String(userId)} LIMIT 1`;
      if (!users.length) return res.status(404).json({ error: 'User not found.' });
      const user = users[0];

      if (!user.payout_acct || !user.payout_bank)
        return res.status(400).json({ error: 'Seller has no bank details saved.' });

      const bal       = parseFloat(user.seller_balance || 0);
      const grossAmt  = parseFloat(amount);
      const fee       = parseFloat(flatFee || 100);         /* ₦100 flat fee */
      const paidOut   = parseFloat(netAmount || (grossAmt - fee)); /* what seller actually receives */

      if (grossAmt > bal)
        return res.status(400).json({ error: `Seller balance (₦${bal.toLocaleString()}) is less than requested (₦${grossAmt.toLocaleString()}).` });

      let transferRef = 'MAN-' + Date.now();
      let transferOk  = false;

      /* Attempt Paystack Transfer using the active key */
      const paystackWithKey = async (path, method, body) => {
        const opts = {
          method: method || 'GET',
          headers: { 'Authorization': 'Bearer ' + activeKey, 'Content-Type': 'application/json' }
        };
        if (body) opts.body = JSON.stringify(body);
        const r    = await fetch('https://api.paystack.co' + path, opts);
        const text = await r.text();
        if (!text || text.trim() === '') return { status: false, message: 'Empty response from Paystack' };
        try { return JSON.parse(text); } catch(e) { return { status: false, message: 'Invalid JSON: ' + text.substring(0,100) }; }
      };

      /* Step 1: Create recipient */
      const recipRes = await paystackWithKey('/transferrecipient', 'POST', {
        type:           'nuban',
        name:           user.payout_aname || user.name,
        account_number: user.payout_acct,
        bank_code:      user.payout_bank,
        currency:       'NGN'
      });

      if (!recipRes.status)
        return res.status(400).json({ error: 'Could not create recipient: ' + (recipRes.message || 'Check bank details') });

      /* Step 2: Transfer NET amount (gross minus flat fee) */
      const transferRes = await paystackWithKey('/transfer', 'POST', {
        source:    'balance',
        amount:    Math.floor(paidOut * 100), /* kobo */
        recipient: recipRes.data.recipient_code,
        reason:    'NeyoMarket seller payout — ' + user.name
      });

      if (!transferRes.status)
        return res.status(400).json({ error: 'Transfer failed: ' + (transferRes.message || 'Try again') });

      transferRef = transferRes.data.reference || transferRef;
      transferOk  = true;

      if (transferOk) {
        /* Step 3: Deduct GROSS amount from seller_balance (fee stays on platform) */
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) - ${grossAmt}
          WHERE id = ${String(userId)}
        `;

        /* Step 4: Mark withdrawal success */
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
        grossAmt:  grossAmt,
        fee:       fee,
        netPaid:   paidOut,
        message:   '₦' + paidOut.toLocaleString() + ' sent to ' + (user.payout_aname || user.name) + ' (₦' + fee + ' platform fee retained)'
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

    /* ═══════════════════════════════════════════════════════════════════
       DVC-RELEASE — Seller enters the buyer's 6-digit delivery code.
       Validates code against delivery_code in orders table.
       On match: marks order completed, credits seller_balance in Neon.
       Tiered commission: 5% physical, 15% digital.
    ═══════════════════════════════════════════════════════════════════ */
    if (action === 'dvc-release') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
      const { orderId, dvcCode, sellerUserId } = req.body || {};
      if (!orderId || !dvcCode) return res.status(400).json({ error: 'orderId and dvcCode required.' });

      /* Load order from Neon */
      const orders = await sql`SELECT * FROM orders WHERE id = ${String(orderId)} LIMIT 1`;
      if (!orders.length) return res.status(404).json({ error: 'Order not found.' });
      const order = orders[0];

      /* Already completed — idempotent */
      if (order.status === 'completed' || order.collected) {
        return res.status(200).json({ ok: true, released: 0, message: 'Already completed.' });
      }

      /* Validate the delivery code */
      const expectedCode = String(order.delivery_code || '');
      if (!expectedCode) {
        /* Fallback: regenerate from orderId using same algo as frontend */
        const str = String(orderId);
        let hash  = 0;
        for (let i = 0; i < str.length; i++) {
          hash = ((hash << 5) - hash) + str.charCodeAt(i);
          hash |= 0;
        }
        const generated = String(Math.abs(hash) % 900000 + 100000);
        if (String(dvcCode).trim() !== generated) {
          return res.status(400).json({ error: 'Incorrect delivery code. Ask the buyer to re-share it.' });
        }
      } else {
        if (String(dvcCode).trim() !== expectedCode) {
          return res.status(400).json({ error: 'Incorrect delivery code. Ask the buyer to re-share it.' });
        }
      }

      /* ── Compute tiered revenue split ── */
      let items = order.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }
      if (!Array.isArray(items)) items = [];

      const hasPhysical   = items.some(function(i){ return i.type === 'physical'; });
      const platformRate  = hasPhysical ? 0.05 : 0.15;
      const affiliateRate = order.aff_code ? 0.05 : 0;
      const sellerRate    = 1 - platformRate - affiliateRate;
      const total         = parseFloat(order.total || 0);
      const platformFee   = Math.round(total * platformRate);
      const affiliateFee  = Math.round(total * affiliateRate);
      const sellerPayout  = Math.round(total * sellerRate);
      const collectedAt   = new Date().toISOString();

      /* ── Mark order completed ── */
      await sql`
        UPDATE orders SET
          status        = 'completed',
          collected     = true,
          collected_at  = ${collectedAt},
          platform_fee  = ${platformFee},
          seller_payout = ${sellerPayout},
          affiliate_fee = ${affiliateFee}
        WHERE id = ${String(orderId)}
      `;

      /* ── Credit seller balance ── */
      if (sellerUserId) {
        await sql`
          UPDATE users
          SET seller_balance = COALESCE(seller_balance, 0) + ${sellerPayout}
          WHERE id = ${String(sellerUserId)}
        `;
        console.log('[paystack.js] DVC release — seller', sellerUserId, 'credited ₦', sellerPayout);
      } else {
        /* Find seller from order items if no sellerUserId passed */
        const sellerIdFromItem = items[0] && (items[0].sellerId || items[0].seller_id);
        if (sellerIdFromItem) {
          await sql`
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${sellerPayout}
            WHERE id = ${String(sellerIdFromItem)}
          `;
        }
      }

      /* ── FIX 4: Credit affiliate ONLY if valid non-empty aff_code ── */
      const affCode = order.aff_code ? String(order.aff_code).trim() : '';
      if (affCode.length > 2 && affiliateFee > 0) {
        try {
          await sql`
            UPDATE users
            SET seller_balance = COALESCE(seller_balance, 0) + ${affiliateFee}
            WHERE aff_code = ${affCode}
          `;
          console.log('[paystack.js] Affiliate', affCode, 'credited ₦', affiliateFee);
        } catch(affErr) {
          console.error('[paystack.js] Affiliate credit error (non-fatal):', affErr.message);
        }
      }

      return res.status(200).json({
        ok:          true,
        released:    sellerPayout,
        platformFee: platformFee,
        message:     '✅ Delivery confirmed! ₦' + sellerPayout.toLocaleString() + ' released to your wallet.'
      });
    }

    /* ═══════════════════════════════════════════════════════════════════
       REFUND — Admin triggers Paystack refund for disputed order.
    ═══════════════════════════════════════════════════════════════════ */
    if (action === 'refund') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
      const { orderId, reference, amount } = req.body || {};
      if (!orderId || !reference) return res.status(400).json({ error: 'orderId and reference required.' });

      const refundAmount = Math.floor(parseFloat(amount || 0) * 100); /* naira to kobo */

      const refundRes = await fetch('https://api.paystack.co/refund', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + PSK, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          transaction:       reference,
          amount:            refundAmount,
          merchant_note:     'Buyer dispute resolved in buyer favour — NeyoMarket admin'
        })
      });
      const refundData = await refundRes.json();

      if (!refundData.status) {
        return res.status(400).json({ error: 'Refund failed: ' + (refundData.message || 'Check Paystack dashboard') });
      }

      /* Mark order as refunded in Neon */
      await sql`UPDATE orders SET status = 'refunded', collected = false WHERE id = ${String(orderId)}`;

      return res.status(200).json({ ok: true, message: 'Refund of ₦' + parseFloat(amount||0).toLocaleString() + ' initiated successfully.' });
    }

    return jsonErr(res, 400, 'Unknown action: ' + action);

  } catch (err) {
    /* FIX 5: always JSON — never HTML 500 page */
    console.error('[paystack.js]', err.message || err);
    return jsonErr(res, 500, 'Internal server error.', err.message);
  }
};
