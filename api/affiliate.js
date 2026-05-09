// /api/affiliate.js — NeyoMarket Affiliate + Analytics API (combined)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    /* ══════════════════════════════════════════════════
       AFFILIATE — record commission after a sale
    ══════════════════════════════════════════════════ */
    if (action === 'record') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { affCode, orderId, amount, commission, productId } = req.body || {};

      if (!affCode || !orderId || !commission)
        return res.status(400).json({ error: 'affCode, orderId and commission required.' });

      const users = await sql`SELECT id FROM users WHERE aff_code = ${affCode} LIMIT 1`;
      if (!users.length) return res.status(200).json({ ok: true, skipped: 'Affiliate not found' });

      await sql`
        INSERT INTO affiliate_commissions
          (aff_user_id, aff_code, order_id, order_amount, commission, product_id, status, created_at)
        VALUES
          (${String(users[0].id)}, ${affCode}, ${String(orderId)}, ${amount || 0}, ${commission}, ${String(productId || '')}, ${'pending'}, NOW())
        ON CONFLICT (order_id) DO NOTHING
      `;

      return res.status(201).json({ ok: true });
    }

    /* ══════════════════════════════════════════════════
       AFFILIATE — get stats + commission history
    ══════════════════════════════════════════════════ */
    if (action === 'stats') {
      const affCode = req.query.affCode;
      if (!affCode) return res.status(200).json({ totalEarned: 0, pendingComm: 0, sales: 0, referrals: 0, commissions: [] });

      const rows = await sql`
        SELECT * FROM affiliate_commissions
        WHERE aff_code = ${affCode}
        ORDER BY created_at DESC
      `;

      const totalEarned = rows
        .filter(r => r.status === 'paid')
        .reduce((s, r) => s + parseFloat(r.commission || 0), 0);

      const pendingComm = rows
        .filter(r => r.status === 'pending')
        .reduce((s, r) => s + parseFloat(r.commission || 0), 0);

      return res.status(200).json({
        totalEarned:  Math.round(totalEarned),
        pendingComm:  Math.round(pendingComm),
        sales:        rows.length,
        referrals:    rows.length,
        commissions:  rows
      });
    }

    /* ══════════════════════════════════════════════════
       ANALYTICS — ADMIN (full platform stats)
    ══════════════════════════════════════════════════ */
    if (action === 'analytics-admin') {
      const role = req.query.role || '';
      if (role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

      // Totals
      const [usersRow]    = await sql`SELECT COUNT(*) AS count FROM users`;
      const [prodsRow]    = await sql`SELECT COUNT(*) AS count FROM products WHERE status = 'active'`;
      const [ordersRow]   = await sql`SELECT COUNT(*) AS count FROM orders`;
      const [revenueRow]  = await sql`
        SELECT COALESCE(SUM(amount),0) AS total FROM orders
        WHERE status IN ('completed','delivered','released')
      `;
      const [newUsersRow] = await sql`
        SELECT COUNT(*) AS count FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `;
      const [affPaidRow]  = await sql`
        SELECT COALESCE(SUM(commission),0) AS total FROM affiliate_commissions WHERE status = 'paid'
      `;
      const [affPendRow]  = await sql`
        SELECT COALESCE(SUM(commission),0) AS total FROM affiliate_commissions WHERE status = 'pending'
      `;

      // Orders by status
      const ordersByStatus = await sql`
        SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC
      `;

      // Top 5 products by sales
      const topProducts = await sql`
        SELECT p.name, p.price, COUNT(o.id) AS sales,
               COALESCE(SUM(o.amount),0) AS revenue
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE o.status IN ('completed','delivered','released')
        GROUP BY p.id, p.name, p.price
        ORDER BY sales DESC LIMIT 5
      `;

      // Daily orders + revenue last 30 days
      const dailyOrders = await sql`
        SELECT TO_CHAR(DATE(created_at),'Mon DD') AS day,
               COUNT(*) AS orders,
               COALESCE(SUM(amount),0) AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at), day
        ORDER BY DATE(created_at) ASC
      `;

      // Top 5 affiliates
      const topAffiliates = await sql`
        SELECT aff_code, COUNT(*) AS referrals,
               COALESCE(SUM(commission),0) AS earned
        FROM affiliate_commissions
        GROUP BY aff_code
        ORDER BY earned DESC LIMIT 5
      `;

      const totalRevenue = parseFloat(revenueRow.total || 0);

      return res.status(200).json({
        totalUsers:       parseInt(usersRow.count || 0),
        totalProducts:    parseInt(prodsRow.count || 0),
        totalOrders:      parseInt(ordersRow.count || 0),
        totalRevenue:     Math.round(totalRevenue),
        platformRevenue:  Math.round(totalRevenue * 0.10),
        totalAffPaid:     Math.round(parseFloat(affPaidRow.total || 0)),
        totalAffPending:  Math.round(parseFloat(affPendRow.total || 0)),
        newUsersMonth:    parseInt(newUsersRow.count || 0),
        ordersByStatus,
        topProducts,
        dailyOrders,
        topAffiliates
      });
    }

    /* ══════════════════════════════════════════════════
       ANALYTICS — SELLER (own stats only)
    ══════════════════════════════════════════════════ */
    if (action === 'analytics-seller') {
      const userId = req.query.userId || '';
      if (!userId) return res.status(400).json({ error: 'userId required.' });

      const [myProds]   = await sql`
        SELECT COUNT(*) AS count FROM products WHERE seller_id = ${userId} AND status = 'active'
      `;
      const [myOrders]  = await sql`
        SELECT COUNT(*) AS count FROM orders WHERE seller_id = ${userId}
      `;
      const [myPending] = await sql`
        SELECT COUNT(*) AS count FROM orders WHERE seller_id = ${userId} AND status = 'pending'
      `;
      const [myRevenue] = await sql`
        SELECT COALESCE(SUM(amount * 0.9),0) AS total FROM orders
        WHERE seller_id = ${userId}
        AND status IN ('completed','delivered','released')
      `;

      // Top 5 products
      const myTopProds = await sql`
        SELECT p.name, p.price, COUNT(o.id) AS sales,
               COALESCE(SUM(o.amount * 0.9),0) AS revenue
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE p.seller_id = ${userId}
        AND o.status IN ('completed','delivered','released')
        GROUP BY p.id, p.name, p.price
        ORDER BY sales DESC LIMIT 5
      `;

      // Daily last 30 days
      const myDailyOrders = await sql`
        SELECT TO_CHAR(DATE(created_at),'Mon DD') AS day,
               COUNT(*) AS orders,
               COALESCE(SUM(amount * 0.9),0) AS revenue
        FROM orders
        WHERE seller_id = ${userId}
        AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at), day
        ORDER BY DATE(created_at) ASC
      `;

      // Affiliate stats for this seller
      const affRows = await sql`
        SELECT * FROM affiliate_commissions
        WHERE aff_user_id = ${userId}
        ORDER BY created_at DESC
      `;
      const affEarned  = affRows.filter(r => r.status === 'paid').reduce((s,r) => s + parseFloat(r.commission||0), 0);
      const affPending = affRows.filter(r => r.status === 'pending').reduce((s,r) => s + parseFloat(r.commission||0), 0);

      return res.status(200).json({
        totalProducts:  parseInt(myProds.count || 0),
        totalOrders:    parseInt(myOrders.count || 0),
        pendingOrders:  parseInt(myPending.count || 0),
        totalRevenue:   Math.round(parseFloat(myRevenue.total || 0)),
        affEarned:      Math.round(affEarned),
        affPending:     Math.round(affPending),
        affReferrals:   affRows.length,
        topProducts:    myTopProds,
        dailyOrders:    myDailyOrders
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[affiliate.js]', err);
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
};
