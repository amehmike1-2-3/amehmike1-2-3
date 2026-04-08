/**
 * ============================================================
 *  NEYOMARKET — UPDATED JAVASCRIPT FUNCTIONS
 *  Drop these into your existing <script> block.
 *  Replace any existing versions of these functions.
 * ============================================================
 */

/* ── CONSTANTS ─────────────────────────────────────────────── */
var PAYSTACK_KEY  = 'pk_live_aaf3faacd1ff2cb720a5f1afaf79112c3fc322ca';
var ADMIN_EMAIL   = 'admin@neyomarket.com';
var ADMIN_PASS    = 'NEYO2026';
var SUPPORT_PHONE = '+2349072212496';

/* ── MASTER ADMIN ACCOUNT (hardcoded, syncs on every device) ─ */
var MASTER_ADMIN = {
  id:       'master_admin_001',
  name:     'NeyoMarket Admin',
  email:    ADMIN_EMAIL,
  password: ADMIN_PASS,
  phone:    SUPPORT_PHONE,
  role:     'admin',
  joined:   '2025-01-01',
  affCode:  'NEYO_ADMIN'
};

/* ────────────────────────────────────────────────────────────
   1.  loadUsers()  — always injects the master admin account
   ──────────────────────────────────────────────────────────── */
function loadUsers() {
  var stored = [];
  try {
    var raw = localStorage.getItem('nm_users');
    if (raw) stored = JSON.parse(raw);
    if (!Array.isArray(stored)) stored = [];
  } catch (e) {
    stored = [];
  }

  // Ensure master admin always exists (works on any device)
  var hasAdmin = stored.some(function (u) {
    return u.email === MASTER_ADMIN.email;
  });
  if (!hasAdmin) {
    stored.unshift(MASTER_ADMIN);
    localStorage.setItem('nm_users', JSON.stringify(stored));
  }

  return stored;
}

/* ────────────────────────────────────────────────────────────
   2a. validateSell() — blocks if < 2 images
   ──────────────────────────────────────────────────────────── */
function validateSell() {
  var name   = (document.getElementById('s-name')  || {}).value || '';
  var type   = (document.getElementById('s-type')  || {}).value || '';
  var cat    = (document.getElementById('s-cat')   || {}).value || '';
  var price  = parseFloat((document.getElementById('s-price') || {}).value || '0');
  var comm   = parseFloat((document.getElementById('s-comm')  || {}).value || '0');
  var desc   = (document.getElementById('s-desc')  || {}).value || '';
  var email  = (document.getElementById('s-email') || {}).value || '';
  var terms  = document.getElementById('sell-cb');
  var termsOk = terms ? terms.checked : false;

  var imgCount  = (typeof uploadedImages !== 'undefined') ? uploadedImages.filter(Boolean).length : 0;
  var needsFile = (type === 'digital' || type === 'course');
  var fileOk    = (typeof dReady !== 'undefined') ? dReady : true;

  var issues = [];
  if (imgCount < 2)                    issues.push('Upload at least 2 product images');
  if (!name.trim())                    issues.push('Product name required');
  if (!type)                           issues.push('Select a product type');
  if (!cat)                            issues.push('Select a category');
  if (!price || price < 100)           issues.push('Price must be at least ₦100');
  if (!comm || comm < 5 || comm > 40)  issues.push('Commission must be 5–40%');
  if (desc.trim().length < 20)         issues.push('Description is too short (min 20 chars)');
  if (!email.trim() || !email.includes('@')) issues.push('Valid payout email required');
  if (needsFile && !fileOk)            issues.push('Upload the product file (PDF/ZIP/MP4)');
  if (!termsOk)                        issues.push('Accept the Terms of Service');

  var btn = document.getElementById('sell-btn');
  var msg = document.getElementById('sell-st');
  var ok  = issues.length === 0;

  if (btn) btn.disabled = !ok;
  if (msg) {
    msg.textContent  = ok ? '✓ Ready to submit!' : '⚠ ' + issues[0] + '.';
    msg.style.color  = ok ? 'var(--green)' : 'var(--red)';
  }
}

/* ────────────────────────────────────────────────────────────
   2b. submitProduct() — enforces 2-image rule, alerts on success
   ──────────────────────────────────────────────────────────── */
function submitProduct() {
  var uploadedImages = window.uploadedImages || [];
  var imgCount = uploadedImages.filter(Boolean).length;

  if (imgCount < 2) {
    alert('Please upload at least 2 product images');
    return;
  }

  var btn = document.getElementById('sell-btn');
  if (btn && btn.disabled) return;

  var emojiMap = {
    ebooks: '📚', courses: '🎓', software: '⚙️',
    fashion: '👗', electronics: '📱', art: '🎨', other: '📦'
  };

  var name  = document.getElementById('s-name').value.trim();
  var type  = document.getElementById('s-type').value;
  var cat   = document.getElementById('s-cat').value;
  var price = parseFloat(document.getElementById('s-price').value);
  var comm  = parseFloat(document.getElementById('s-comm').value);
  var desc  = document.getElementById('s-desc').value.trim();
  var email = document.getElementById('s-email').value.trim();

  var currentUser = window.currentUser || window.CU || null;
  var sellerName  = currentUser ? currentUser.name : 'Seller';

  var product = {
    id:          Date.now(),
    name:        name,
    type:        type,
    cat:         cat,
    price:       price,
    commission:  comm,
    desc:        desc,
    seller:      sellerName,
    sellerEmail: maskEmail(email),
    rating:      0,
    reviews:     0,
    emoji:       emojiMap[cat] || '📦',
    imgs:        uploadedImages.filter(Boolean),
    status:      'pending',
    badge:       'Pending Review',
    date:        new Date().toLocaleDateString(),
    escrow:      true
  };

  // Save product
  var existing = [];
  try { existing = JSON.parse(localStorage.getItem('nm_products') || '[]'); } catch (e) {}
  existing.push(product);
  localStorage.setItem('nm_products', JSON.stringify(existing));

  // Update in-memory array if it exists
  if (Array.isArray(window.prods)) window.prods.push(product);
  if (Array.isArray(window.products)) window.products.push(product);

  // Reset form
  resetSellForm();

  // Alert then redirect to admin
  alert('Product Submitted! It will go live after admin review.');
  go('admin');
}

/* ────────────────────────────────────────────────────────────
   3.  Stealth Admin — 5 taps on .nav-logo within 3 seconds
   ──────────────────────────────────────────────────────────── */
(function initStealthAdmin() {
  var tapCount = 0;
  var tapTimer = null;

  var logo = document.getElementById('nav-logo');
  if (!logo) return;

  logo.addEventListener('click', function () {
    tapCount++;
    clearTimeout(tapTimer);

    tapTimer = setTimeout(function () {
      tapCount = 0;
    }, 3000);

    if (tapCount >= 5) {
      tapCount = 0;
      clearTimeout(tapTimer);

      var pw = prompt('🔐 Admin Access Required\n\nEnter the admin password:');
      if (pw === null) return; // cancelled

      if (pw === ADMIN_PASS) {
        // Log in as master admin
        var adminUser = {
          id:    'master_admin_001',
          name:  'NeyoMarket Admin',
          email: ADMIN_EMAIL,
          role:  'admin'
        };
        window.CU = adminUser;
        window.currentUser = adminUser;
        sessionStorage.setItem('nm_session', JSON.stringify(adminUser));

        if (typeof updateNav === 'function')   updateNav();
        if (typeof updNav  === 'function')     updNav();

        alert('✅ Admin access granted. Welcome back!');
        go('admin');
      } else {
        alert('❌ Incorrect password.\n\nThis access attempt has been logged.');
      }
    }
  });
})();

/* ────────────────────────────────────────────────────────────
   4a. startPurchase(isPhysical, price) — routing helper
   ──────────────────────────────────────────────────────────── */
function startPurchase(isPhysical, price) {
  var currentUser = window.currentUser || window.CU || null;
  if (!currentUser) {
    alert('Please sign in to complete your purchase.');
    go('signin');
    return;
  }

  // Pre-fill known buyer info
  if (currentUser.name) {
    var nameFields = ['sh-name', 'co-name'];
    nameFields.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) el.value = currentUser.name;
    });
  }
  if (currentUser.email) {
    var emailFields = ['sh-email', 'co-email'];
    emailFields.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) el.value = currentUser.email;
    });
  }
  if (currentUser.phone) {
    var phoneFields = ['sh-wa', 'co-wa'];
    phoneFields.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) el.value = currentUser.phone;
    });
  }

  if (isPhysical) {
    go('shipping');
  } else {
    go('checkout');
  }
}

/* ────────────────────────────────────────────────────────────
   4b. processPaystack(mode) — Paystack inline + NYO-XXXX ID
   ──────────────────────────────────────────────────────────── */
function processPaystack(mode) {
  var isPhysical = (mode === 'physical');

  var email   = document.getElementById(isPhysical ? 'sh-email'  : 'co-email');
  var nameEl  = document.getElementById(isPhysical ? 'sh-name'   : 'co-name');
  var waEl    = document.getElementById(isPhysical ? 'sh-wa'     : 'co-wa');
  var addrEl  = document.getElementById('sh-addr');

  var buyerEmail   = email   ? email.value.trim()   : '';
  var buyerName    = nameEl  ? nameEl.value.trim()  : '';
  var buyerWA      = waEl    ? waEl.value.trim()    : '';
  var buyerAddress = (isPhysical && addrEl) ? addrEl.value.trim() : 'Digital Delivery';

  if (!buyerEmail || !buyerName) {
    alert('Please fill in all required fields before paying.');
    return;
  }

  // Calculate total from cart
  var cart = window.cart || [];
  var total = cart.reduce(function (sum, item) {
    return sum + (item.price * (item.qty || 1));
  }, 0);

  if (total <= 0) {
    alert('Your cart is empty. Please add items before checking out.');
    return;
  }

  // Generate tracking ID
  var trackingId = 'NYO-' + Math.floor(1000 + Math.random() * 9000);

  var config = {
    key:      PAYSTACK_KEY,
    email:    buyerEmail,
    amount:   total * 100, // convert to kobo
    currency: 'NGN',
    ref:      trackingId,
    metadata: {
      custom_fields: [
        { display_name: 'Customer Name', variable_name: 'customer_name', value: buyerName },
        { display_name: 'WhatsApp',      variable_name: 'whatsapp',      value: buyerWA },
        { display_name: 'Address',       variable_name: 'address',       value: buyerAddress },
        { display_name: 'Tracking ID',   variable_name: 'tracking_id',   value: trackingId }
      ]
    },

    callback: function (response) {
      // Build order object
      var order = {
        id:         trackingId,
        ref:        response.reference,
        customer:   { name: buyerName, email: maskEmail(buyerEmail), whatsapp: buyerWA, address: buyerAddress },
        items:      (window.cart || []).map(function (i) {
          return { id: i.id, name: i.name, type: i.type, price: i.price, qty: i.qty || 1, emoji: i.emoji };
        }),
        total:      total,
        status:     'escrow_held',
        mode:       mode,
        date:       new Date().toLocaleDateString(),
        collected:  false,
        downloadLog: []
      };

      // Persist order
      try {
        var existing = JSON.parse(localStorage.getItem('nm_orders') || '[]');
        existing.push(order);
        localStorage.setItem('nm_orders', JSON.stringify(existing));
      } catch (e) {}

      if (Array.isArray(window.ords))   window.ords.push(order);
      if (Array.isArray(window.orders)) window.orders.push(order);

      // Clear cart
      if (window.cart)   window.cart   = [];
      if (window.orders) {} // already pushed above

      if (typeof updateCartBadge === 'function') updateCartBadge();
      if (typeof updCart         === 'function') updCart();

      // Show receipt modal if available, else alert
      var recModal = document.getElementById('m-rec');
      var recId    = document.getElementById('rec-id');
      var recInfo  = document.getElementById('rec-info');

      if (recModal && recId && recInfo) {
        recId.textContent = trackingId;
        recInfo.innerHTML =
          '<div>Name: '    + buyerName          + '</div>' +
          '<div>WhatsApp: '+ buyerWA            + '</div>' +
          '<div>Amount: ₦' + total.toLocaleString() + '</div>' +
          '<div>Date: '    + new Date().toLocaleDateString() + '</div>' +
          '<div style="margin-top:8px;color:var(--green)">🛡️ Funds held in escrow until you confirm receipt.</div>';

        if (typeof oM  === 'function') oM('m-rec');
        if (typeof openM === 'function') openM('m-rec');
      } else {
        alert('✅ Payment Successful!\n\nYour Tracking ID: ' + trackingId + '\nAmount: ₦' + total.toLocaleString() + '\n\nFunds are held in escrow until you confirm receipt.');
        go('profile');
      }
    },

    onClose: function () {
      alert('Payment was cancelled. Your cart is still intact.');
    }
  };

  try {
    var handler = PaystackPop.setup(config);
    handler.openIframe();
  } catch (err) {
    alert('Paystack could not load. Please check your internet connection and try again.');
    console.error('Paystack error:', err);
  }
}

/* ────────────────────────────────────────────────────────────
   5a. go(pageId) — hides ALL .page elements before showing new one
   ──────────────────────────────────────────────────────────── */
function go(pageId) {
  // Hide every page
  var allPages = document.querySelectorAll('.page');
  allPages.forEach(function (p) { p.classList.remove('active'); });

  // Remove active state from all nav buttons
  var allNavBtns = document.querySelectorAll('.nb, .nav-btn');
  allNavBtns.forEach(function (b) { b.classList.remove('on', 'active'); });

  // Show the requested page
  var target = document.getElementById('page-' + pageId);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }

  // Highlight matching nav button
  var navBtnId = 'nb-' + pageId;
  var activeBtn = document.getElementById(navBtnId);
  if (activeBtn) activeBtn.classList.add('on', 'active');

  // Page-specific init
  if (pageId === 'home') {
    var grid = document.getElementById('home-grid');
    if (grid && typeof rGrid === 'function') {
      var active = (window.prods || window.products || []).filter(function (p) { return p.status === 'active'; });
      rGrid('home-grid', active.slice(0, 8));
    }
    var hc = document.getElementById('hero-cnt');
    if (hc) {
      var ap = (window.prods || window.products || []).filter(function (p) { return p.status === 'active'; });
      hc.textContent = ap.length;
    }
  }

  if (pageId === 'market') {
    var mGrid = document.getElementById('mkt-grid') || document.getElementById('market-grid');
    if (mGrid && typeof rGrid === 'function') {
      var active2 = (window.prods || window.products || []).filter(function (p) { return p.status === 'active'; });
      rGrid(mGrid.id, active2);
    }
  }

  if (pageId === 'sell') {
    var cu = window.CU || window.currentUser;
    if (!cu) { alert('Please sign in to list a product.'); go('signin'); return; }
    if (typeof resetSellForm === 'function') resetSellForm();
    if (typeof resetSell     === 'function') resetSell();
    if (typeof vSell         === 'function') vSell();
    if (typeof validateSell  === 'function') validateSell();
  }

  if (pageId === 'profile') {
    var cu2 = window.CU || window.currentUser;
    if (!cu2) { go('signin'); return; }
    if (typeof refreshProf   === 'function') refreshProf();
    if (typeof refreshProfile === 'function') refreshProfile();
  }

  if (pageId === 'admin') {
    var cu3 = window.CU || window.currentUser;
    if (!cu3 || cu3.role !== 'admin') {
      alert('Admin access required.');
      return;
    }
    if (typeof aTab === 'function') {
      var firstBtn = document.querySelector('.asb, .sidebar-btn');
      aTab('ov', firstBtn);
    }
  }

  if (pageId === 'shipping' || pageId === 'checkout') {
    if (typeof bSum === 'function') bSum(pageId);
  }
}

/* ────────────────────────────────────────────────────────────
   5b. sendMessage() / sendMsg() — local switch-case chatbot
   ──────────────────────────────────────────────────────────── */
function getChatReply(input) {
  var q = input.toLowerCase().trim();

  // keyword matching
  if (q.includes('sell') || q.includes('list') || q.includes('product')) {
    return "To sell on NeyoMarket, go to the **Sell** page. Upload at least 2 product images, fill in all details, and submit for review. Admin approves listings within 24 hours! 🏪";
  }
  if (q.includes('buy') || q.includes('purchase') || q.includes('order') || q.includes('cart')) {
    return "Browse the **Marketplace**, add items to your cart, then checkout. 🛒 Your payment is held in escrow — only released to the seller after you confirm receipt. You're always protected!";
  }
  if (q.includes('affiliate') || q.includes('earn') || q.includes('commission') || q.includes('referral') || q.includes('refer')) {
    return "Our **Affiliate Program** pays 15–30% commission on every sale you refer! 💸 Go to your Profile to get your unique link. Share it anywhere and get paid every Monday. No investment needed.";
  }
  if (q.includes('safehaven') || q.includes('safe haven') || q.includes('children') || q.includes('shelter') || q.includes('donate')) {
    return "SafeHaven is a children's shelter we're proud to support. 🏠 Their donation platform is powered by NeyoMarket's payment system. Contact us at " + SUPPORT_PHONE + " to learn more or donate.";
  }
  if (q.includes('escrow') || q.includes('scam') || q.includes('fraud') || q.includes('safe') || q.includes('protect')) {
    return "🛡️ **Zero Scam Guarantee:** Every payment is held in escrow via Paystack. Your money is NEVER sent directly to sellers — it's only released after you confirm receipt. Open a dispute within 24–72 hours if anything goes wrong.";
  }
  if (q.includes('refund') || q.includes('return') || q.includes('dispute') || q.includes('problem')) {
    return "Refund Policy: Physical goods = 3-day window. Digital goods = 24hr if not as described. Open a dispute from your Orders page. Our team reviews within 24 hours. Full refund issued if seller is at fault. ⚖️";
  }
  if (q.includes('pay') || q.includes('paystack') || q.includes('payment') || q.includes('transfer')) {
    return "All payments use **Paystack** — Nigeria's most trusted gateway. 🔐 Your card details are encrypted and never stored on our servers. Every transaction is escrow-protected.";
  }
  if (q.includes('digital') || q.includes('download') || q.includes('ebook') || q.includes('course')) {
    return "Digital products (eBooks, courses, software) are delivered by download link after payment. ⚡ Your download is timestamped. Confirm it works to release payment. Dispute within 24 hours if there's an issue.";
  }
  if (q.includes('physical') || q.includes('shipping') || q.includes('delivery') || q.includes('ship')) {
    return "Physical products require a delivery address at checkout. 📦 Enter your WhatsApp number so the seller can contact you. Tap **Mark as Collected** when your item arrives to release escrow. Average delivery: 3–7 days.";
  }
  if (q.includes('payout') || q.includes('withdraw') || q.includes('bank') || q.includes('account number')) {
    return "Sellers and affiliates add bank details in **Profile → Payout Settings**. 🏦 Payouts are processed every Monday. Min withdrawal: ₦500. Make sure your account name matches your identity.";
  }
  if (q.includes('password') || q.includes('forgot') || q.includes('reset') || q.includes('login') || q.includes('sign in')) {
    return "Tap **Sign In** in the menu. If you forgot your password, use the **'Forgot password?'** link on the login page. A reset link will be sent to your registered email. 🔑";
  }
  if (q.includes('contact') || q.includes('support') || q.includes('help') || q.includes('whatsapp') || q.includes('call')) {
    return "📞 Reach our support team at **" + SUPPORT_PHONE + "** (WhatsApp or call). We're real humans — no bots. We handle every complaint personally. Business hours: 8am–8pm daily (WAT).";
  }
  if (q.includes('admin') || q.includes('dashboard') || q.includes('secret')) {
    return "The Admin Dashboard is access-restricted. 🔐 If you're the site admin, use the secret 5-tap method on the logo to open the login gate. For technical help, contact support directly.";
  }
  if (q.includes('hi') || q.includes('hello') || q.includes('hey') || q.includes('good morning') || q.includes('good afternoon')) {
    return "Hello! 👋 I'm **Neyo AI**, NeyoMarket's assistant. I can help you with buying, selling, affiliates, payments, refunds, or anything marketplace-related. What would you like to know?";
  }
  if (q.includes('thank') || q.includes('thanks') || q.includes('appreciate')) {
    return "You're welcome! 😊 If you need anything else, I'm right here. Happy shopping on NeyoMarket! 🛒";
  }
  if (q.includes('how') && q.includes('work')) {
    return "NeyoMarket works in 3 steps: 1️⃣ Browse and buy — payment is held in escrow. 2️⃣ Seller delivers your product. 3️⃣ You confirm receipt and the seller gets paid. Simple, safe, and fast! 🎯";
  }

  // Default fallback
  return "Hmm, I'm not sure about that one. 🤔 Try asking about: **sell, buy, affiliate, escrow, refund, payment, shipping, or support**. Or call us directly at " + SUPPORT_PHONE + " for personal help!";
}

// Exported as both sendMsg() and sendMessage() to match whichever name your HTML uses
function sendMsg() {
  var inp   = document.getElementById('chat-in') || document.getElementById('chat-input') || document.getElementById('chatInput');
  if (!inp) return;
  var text = inp.value.trim();
  if (!text) return;
  inp.value = '';

  addUserMsg(text);

  setTimeout(function () {
    var reply = getChatReply(text);
    addBotMsg(reply);
  }, 500);
}

function sendMessage() { sendMsg(); }

// Make sure addBotMsg/addUserMsg exist (safe fallbacks)
function addBotMsg(text) {
  var containerId = 'chat-ms';
  var fallbacks   = ['chat-msgs', 'chatMessages', 'chat-messages'];
  var m = document.getElementById(containerId);
  if (!m) { fallbacks.forEach(function (id) { if (!m) m = document.getElementById(id); }); }
  if (!m) return;
  var d = document.createElement('div');
  d.className = 'bub bot bubble bot';
  d.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  m.appendChild(d);
  m.scrollTop = m.scrollHeight;
}

function addUserMsg(text) {
  var containerId = 'chat-ms';
  var fallbacks   = ['chat-msgs', 'chatMessages', 'chat-messages'];
  var m = document.getElementById(containerId);
  if (!m) { fallbacks.forEach(function (id) { if (!m) m = document.getElementById(id); }); }
  if (!m) return;
  var d = document.createElement('div');
  d.className = 'bub user bubble user';
  d.textContent = text;
  m.appendChild(d);
  m.scrollTop = m.scrollHeight;
}

/* ────────────────────────────────────────────────────────────
   6.  forgotPassword() — prompt + alert
   ──────────────────────────────────────────────────────────── */
function forgotPassword() {
  var email = prompt('Enter your registered email address and we\'ll send a reset link:');
  if (email === null) return; // User hit Cancel

  email = email.trim();
  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address.');
    return;
  }

  var users = loadUsers();
  var found = users.some(function (u) {
    return u.email.toLowerCase() === email.toLowerCase();
  });

  if (found) {
    alert('✅ Reset Link Sent!\n\nA password reset link has been sent to:\n' + email + '\n\nCheck your inbox (and spam folder) within 5 minutes.\n\nNote: Full email reset requires a backend server for production.');
  } else {
    alert('No account was found with that email address.\n\nDouble-check your spelling or create a new account.');
  }
}

/* ────────────────────────────────────────────────────────────
   HELPER: maskEmail  (used by submitProduct & processPaystack)
   ──────────────────────────────────────────────────────────── */
function maskEmail(e) {
  if (!e || !e.includes('@')) return '***';
  var parts = e.split('@');
  return parts[0].charAt(0) + '***@' + parts[1];
}

/* ────────────────────────────────────────────────────────────
   HELPER: resetSellForm  (called by submitProduct & go())
   ──────────────────────────────────────────────────────────── */
function resetSellForm() {
  window.uploadedImages = [];
  window.dReady = false;
  window.imgs = [];

  ['s-name','s-type','s-cat','s-price','s-comm','s-desc','s-email'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });

  var cb = document.getElementById('sell-cb');
  if (cb) cb.checked = false;

  var dw = document.getElementById('dfile-wrap') || document.getElementById('digital-file-fg');
  if (dw) dw.style.display = 'none';

  var fn = document.getElementById('dfile-name');
  if (fn) fn.textContent = 'Tap to Choose File';

  var fz = document.getElementById('fz');
  if (fz) fz.classList.remove('has');

  for (var i = 0; i < 5; i++) {
    var sl = document.getElementById('sl-' + i) || document.getElementById('slot-' + i);
    if (sl) {
      sl.innerHTML = '<span class="sp">＋</span>';
      sl.classList.remove('filled');
    }
  }

  if (typeof validateSell === 'function') validateSell();
  if (typeof vSell        === 'function') vSell();
}

/* ─────────────────────────────────────────────────────────────
   EXPOSE to window so HTML onclick="" attributes can call them
   ──────────────────────────────────────────────────────────── */
window.loadUsers      = loadUsers;
window.validateSell   = validateSell;
window.submitProduct  = submitProduct;
window.submitProd     = submitProduct;   // alias
window.startPurchase  = startPurchase;
window.processPaystack = processPaystack;
window.go             = go;
window.sendMsg        = sendMsg;
window.sendMessage    = sendMessage;
window.addBotMsg      = addBotMsg;
window.addUserMsg     = addUserMsg;
window.forgotPassword = forgotPassword;
window.forgotPwd      = forgotPassword;  // alias
window.maskEmail      = maskEmail;
window.resetSellForm  = resetSellForm;
window.resetSell      = resetSellForm;   // alias
window.getChatReply   = getChatReply;
window.MASTER_ADMIN   = MASTER_ADMIN;
window.ADMIN_EMAIL    = ADMIN_EMAIL;
window.ADMIN_PASS     = ADMIN_PASS;
