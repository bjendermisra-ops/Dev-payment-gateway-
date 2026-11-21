require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { ImapFlow } = require('imapflow');

const store = require('./services/store');
const qrHelper = require('./services/qrHelper');
const watcherManager = require('./services/concurrencyWatcher');
const { hashPassword, validPassword, setCookie, clearCookie, requireMerchant } = require('./services/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer Storage Configuration for QR uploads
const uploadDir = process.env.VERCEL
  ? path.join(require('os').tmpdir(), 'aurapay-uploads')
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use((req,res,next) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  next();
});
// Merchant routes are protected by the signed HttpOnly session cookie.
// Caller-controlled merchant IDs must never grant access to another merchant.
const merchantSession = requireMerchant(store);
// Load durable state before authentication, and persist every changed record
// before replying to a mutating API request.
app.use('/api', async (req,res,next) => {
  try {
    await store.ready;
    if (process.env.MONGODB_URI && !store.mongoReady) return res.status(503).json({error:'Database unavailable'});
    if (store.mongoReady) await store.loadFromMongo();
    if (req.method !== 'GET') {
      const sendJson = res.json.bind(res);
      res.json = data => {
        store.flushWrites().then(() => sendJson(data)).catch(err => {
          console.error('[Database] Could not persist request:', err.message);
          if (!res.headersSent) { res.statusCode = 503; sendJson({error:'Database write failed'}); }
        });
        return res;
      };
    }
    next();
  } catch(err) { console.error('[Database]',err.message); return res.status(503).json({error:'Database unavailable'}); }
});
app.use('/api/merchant', merchantSession, (req,res,next) => {
  req.headers['x-merchant-id'] = req.merchant.id;
  next();
});
app.use('/api/auth/me', merchantSession);
app.use('/api/v1/simulate-payment', merchantSession, (req,res,next) => {
  if (process.env.ENABLE_SIMULATIONS !== 'true') return res.status(403).json({error:'Payment simulation is disabled'});
  req.body.merchantId = req.merchant.id;
  next();
});


// Temporary uploaded QR assets remain accessible on the same function instance.
// Use durable object storage before accepting production uploads.
app.get('/api/merchant/qr/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'QR image not found or upload expired' });
  return res.sendFile(filePath);
});

app.get('/api/health', (req, res) => res.json({
  status: 'online',
  service: 'AuraPay Express Gateway',
  storage: store.mongoReady ? 'mongodb' : (process.env.VERCEL ? 'temporary-demo' : 'local'),
  paymentReady: !process.env.VERCEL && store.mongoReady && process.env.PAYMENT_VERIFICATION_ENABLED === 'true',
  timestamp: new Date().toISOString()
}));

function publicMerchant(merchant) {
  if (!merchant) return null;
  const { password, gmailAppPass, ...safe } = merchant;
  return safe;
}

// Initialize Watcher for default merchant on start
const defaultMerchant = null;
if (defaultMerchant && defaultMerchant.gmailUser && defaultMerchant.gmailAppPass) {
  watcherManager.getOrCreate(defaultMerchant);
}

// ==============================================================
// 1. AUTHENTICATION ENDPOINTS
// ==============================================================

// Register new merchant
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, businessName } = req.body;
  if (!email || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Valid email and a password of 12-128 characters are required' });
  }
  if (process.env.VERCEL && !process.env.MONGODB_URI) {
    return res.status(503).json({error: 'Merchant registration requires permanent database storage. Configure MONGODB_URI.'});
  }

  const existing = store.getMerchantByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  const merchant = store.createMerchant({
    name,
    email,
    password: hashPassword(password),
    businessName
  });
  setCookie(res, merchant.id);

  res.json({
    success: true,
    merchant: publicMerchant(merchant)
  });
});

// Login merchant
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const merchant = store.getMerchantByEmail(email);
  if (!merchant || !validPassword(password, merchant.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Ensure watcher is active if onboarded
  if (merchant.isOnboarded && merchant.gmailUser && merchant.gmailAppPass) {
    watcherManager.getOrCreate(merchant);
  }

  setCookie(res, merchant.id);
  res.json({
    success: true,
    merchant: publicMerchant(merchant)
  });
});
app.post('/api/auth/logout', (req,res) => { clearCookie(res); res.json({success:true}); });

// Get current merchant profile
app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, merchant: publicMerchant(req.merchant) });
});

// ==============================================================
// 2. ONBOARDING WIZARD ENDPOINTS
// ==============================================================

// Upload and Auto-Decode FamPay / UPI QR Image
app.post('/api/merchant/upload-qr', upload.single('qrImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const filePath = req.file.path;
  const webPath = process.env.VERCEL
    ? `/api/merchant/qr/${path.basename(filePath)}`
    : `/uploads/${path.basename(filePath)}`;

  // Automatically decode QR code to extract UPI ID
  const decoded = await qrHelper.decodeQrImage(filePath);

  res.json({
    success: true,
    qrImagePath: webPath,
    detectedUpiId: decoded.upiId || '',
    detectedPayeeName: decoded.payeeName || '',
    rawQrData: decoded.raw || ''
  });
});

// Test Gmail IMAP Connection Live
app.post('/api/merchant/test-email', async (req, res) => {
  if (process.env.VERCEL) return res.status(503).json({error:'Gmail verification requires a secure persistent worker'});
  const { gmailUser, gmailAppPass } = req.body;
  if (!gmailUser || !gmailAppPass) {
    return res.status(400).json({ error: 'Gmail address and App Password required' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: gmailUser.trim(),
      pass: gmailAppPass.replace(/\s+/g, '')
    },
    logger: false
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    await client.logout();

    res.json({
      success: true,
      message: 'Connected successfully to Gmail IMAP!',
      inboxCount: total
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'Gmail authentication failed. Please verify 2-Step Verification is enabled and use a 16-character App Password.'
    });
  }
});

// Complete Onboarding
app.post('/api/merchant/complete-onboarding', async (req, res) => {
  const { merchantId, businessName, upiId, qrImagePath, gmailUser, gmailAppPass } = req.body;
  
  const merchant = req.merchant;
  // Reject a forged merchantId even for an authenticated user.
  if (merchantId !== merchant.id) return res.status(403).json({ error: 'Merchant mismatch' });

  if (process.env.VERCEL && gmailAppPass) return res.status(503).json({error:'Do not submit Gmail App Passwords to serverless. Configure a persistent verifier first.'});
  const updated = store.updateMerchant(merchant.id, {
    businessName: businessName || merchant.businessName,
    upiId: upiId || merchant.upiId,
    qrImagePath: qrImagePath || merchant.qrImagePath,
    gmailUser: gmailUser || merchant.gmailUser,
    gmailAppPass: gmailAppPass ? gmailAppPass.replace(/\s+/g, '') : merchant.gmailAppPass,
    isOnboarded: true
  });

  // Start or update active watcher
  if (!process.env.VERCEL && process.env.PAYMENT_VERIFICATION_ENABLED === 'true') watcherManager.getOrCreate(updated);

  res.json({
    success: true,
    merchant: publicMerchant(updated)
  });
});

// ==============================================================
// 3. MERCHANT DASHBOARD ENDPOINTS
// ==============================================================

app.get('/api/merchant/dashboard', (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const orders = store.getOrdersByMerchant(merchantId);
  const paidOrders = orders.filter(o => o.status === 'PAID');
  const totalVolume = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const pendingOrders = orders.filter(o => o.status === 'PENDING');

  const watcher = watcherManager.get(merchantId);
  const watcherStatus = watcher ? watcher.getStatus() : { connected: false };

  res.json({
    success: true,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      businessName: merchant.businessName,
      email: merchant.email,
      upiId: merchant.upiId,
      apiKey: merchant.apiKey,
      qrImagePath: merchant.qrImagePath,
      isOnboarded: merchant.isOnboarded
    },
    metrics: {
      totalVolume,
      paidCount: paidOrders.length,
      pendingCount: pendingOrders.length,
      totalOrders: orders.length,
      avgSpeed: '1.4s'
    },
    watcherStatus,
    recentOrders: orders.slice(0, 10)
  });
});

// Create Hosted Paywall Link
app.post('/api/merchant/create-paywall-link', async (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const { amount, customerName, customerEmail, note } = req.body;

  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  if (!merchant.upiId || !merchant.isOnboarded || !process.env.MONGODB_URI || process.env.VERCEL || process.env.PAYMENT_VERIFICATION_ENABLED !== 'true') return res.status(503).json({error:'Live payments disabled until persistent storage and trusted verification are configured.'});
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Valid payment amount required' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = store.getPendingOrdersByMerchant(merchantId);
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  // Pre-generate dynamic QR data with isolated exact amount and order ID
  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    orderId,
    merchantId,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Payment #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });

  res.json({
    success: true,
    order,
    paywallUrl: `/pay/${order.orderId}`
  });
});

// Regenerate API Key
app.post('/api/merchant/regenerate-api-key', (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const crypto = require('crypto');
  const newKey = `aura_live_${crypto.randomBytes(16).toString('hex')}`;
  
  const updated = store.updateMerchant(merchantId, { apiKey: newKey });
  res.json({ success: true, apiKey: updated.apiKey });
});

// SSE Stream for Merchant Dashboard
app.get('/api/merchant/events', (req, res) => {
  const merchantId = req.query.merchantId || 'merch_default';
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const watcher = watcherManager.getOrCreate(merchant);
  if (watcher) {
    watcher.subscribeMerchant(res);
  }
});

// ==============================================================
// 4. PUBLIC DEVELOPER API & PAYWALL ENDPOINTS
// ==============================================================

// Create checkout order via API Key
app.post('/api/v1/checkout/create', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const merchant = store.getMerchantByApiKey(apiKey);
  if (!merchant) {
    return res.status(403).json({ error: 'Invalid API Key' });
  }

  const { amount, customerName, customerEmail, note } = req.body;
  if (!merchant.upiId || !merchant.isOnboarded || !process.env.MONGODB_URI || process.env.VERCEL || process.env.PAYMENT_VERIFICATION_ENABLED !== 'true') return res.status(503).json({error:'Live payments disabled until persistent storage and trusted verification are configured.'});
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = store.getPendingOrdersByMerchant(merchant.id);
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    orderId,
    merchantId: merchant.id,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Order #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });

  // Ensure watcher is active
  if (!process.env.VERCEL && process.env.PAYMENT_VERIFICATION_ENABLED === 'true') watcherManager.getOrCreate(merchant);

  res.json({
    success: true,
    orderId: order.orderId,
    amount: order.amount,
    currency: 'INR',
    status: order.status,
    checkoutUrl: `${req.protocol}://${req.get('host')}/pay/${order.orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
});

// Get Public Checkout Details
app.get('/api/v1/checkout/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const merchant = store.getMerchantById(order.merchantId);

  // If dynamic QR wasn't pre-generated, generate it now
  if (!order.dynamicQrDataUrl && merchant) {
    const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
      upiId: merchant.upiId,
      payeeName: merchant.businessName,
      amount: order.amount,
      note: order.note,
      orderId: order.orderId
    });
    order.dynamicUpiUrl = upiUri;
    order.dynamicQrDataUrl = qrDataUrl;
    store.updateOrder(orderId, { dynamicUpiUrl: upiUri, dynamicQrDataUrl: qrDataUrl });
  }

  res.json({
    success: true,
    order: {
      orderId: order.orderId,
      amount: order.amount,
      customerName: order.customerName,
      note: order.note,
      status: order.status,
      dynamicUpiUrl: order.dynamicUpiUrl,
      dynamicQrDataUrl: order.dynamicQrDataUrl,
      verifiedAt: order.verifiedAt,
      paymentDetails: order.paymentDetails
    },
    merchant: {
      businessName: merchant ? merchant.businessName : 'Merchant Payee',
      upiId: merchant ? merchant.upiId : '8789601387@fam',
      qrImagePath: merchant ? merchant.qrImagePath : '/uploads/default-qr.jpeg'
    }
  });
});

// Check payment verification status for an order
app.get('/api/v1/checkout/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'PAID') {
    return res.json({
      success: true,
      verified: true,
      order
    });
  }

  // Force quick check via watcher
  const merchant = store.getMerchantById(order.merchantId);
  if (merchant && !process.env.VERCEL && process.env.PAYMENT_VERIFICATION_ENABLED === 'true') {
    const watcher = watcherManager.getOrCreate(merchant);
    if (watcher) await watcher.syncAndProcess(15);
  }

  const refreshed = store.getOrder(orderId);
  return res.json({
    success: true,
    verified: refreshed.status === 'PAID',
    order: refreshed
  });
});

// Secure Digital Delivery Endpoint (Requires Verified Payment)
app.get('/api/v1/checkout/delivery/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status !== 'PAID') {
    return res.status(403).json({
      error: 'Access Denied',
      message: 'Payment has not been completed or verified yet. Please complete payment first.'
    });
  }

  const DRIVE_VIEW_URL = process.env.DIGITAL_DELIVERY_URL;
  const DRIVE_DOWNLOAD_URL = process.env.DIGITAL_DOWNLOAD_URL || DRIVE_VIEW_URL;
  if (!DRIVE_VIEW_URL) return res.status(503).json({error:'Digital delivery is not configured'});
  const targetUrl = req.query.download === '1' ? DRIVE_DOWNLOAD_URL : DRIVE_VIEW_URL;

  if (req.xhr || req.headers.accept?.includes('application/json') || req.query.format === 'json') {
    return res.json({
      success: true,
      verified: true,
      deliveryUrl: DRIVE_VIEW_URL,
      downloadUrl: DRIVE_DOWNLOAD_URL
    });
  }

  return res.redirect(targetUrl);
});

// Dedicated SSE Stream for an order checkout
app.get('/api/v1/checkout/events/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const merchant = store.getMerchantById(order.merchantId);
  if (merchant) {
    if (!process.env.VERCEL && process.env.PAYMENT_VERIFICATION_ENABLED === 'true') {
      const watcher = watcherManager.getOrCreate(merchant);
      if (watcher) watcher.subscribeOrder(orderId, res);
    }
  }
});

// Manual UTR submission on paywall
app.post('/api/v1/checkout/verify-utr', async (req, res) => {
  const { orderId, utr } = req.body;
  if (!orderId || !utr) {
    return res.status(400).json({ error: 'Order ID and UTR required' });
  }

  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (process.env.VERCEL || process.env.PAYMENT_VERIFICATION_ENABLED !== 'true') return res.status(503).json({error:'Trusted bank verification worker is not available'});
  if (!/^\d{12}$/.test(String(utr).trim())) return res.status(400).json({error:'A valid 12-digit UTR is required'});
  const merchant = store.getMerchantById(order.merchantId);
  if (!merchant) return res.status(404).json({error:'Merchant not found'});
  const watcher = watcherManager.getOrCreate(merchant);
  if (!watcher) return res.status(503).json({ error: 'Verification watcher is not configured' });

  await watcher.syncAndProcess(25);

  const cleanUtr = utr.trim().toLowerCase();
  const matched = watcher.recentPayments.find(p => {
    const pUtr = (p.utr || '').toLowerCase();
    const pTxn = (p.txnId || '').toLowerCase();
    const pSnippet = (p.snippet || '').toLowerCase();
    return (pUtr.includes(cleanUtr) || pTxn.includes(cleanUtr) || pSnippet.includes(cleanUtr)) &&
           Math.abs(p.amount - order.amount) < 0.01 &&
           !watcher.isPaymentClaimed(p);
  });

  if (matched) {
    watcher.executeOrderMatch(order, matched, 'MANUAL_UTR_CONFIRMATION');
    const updated = store.getOrder(orderId);
    return res.json({
      success: true,
      verified: true,
      order: updated
    });
  }

  return res.json({
    success: false,
    verified: false,
    message: 'UTR not yet detected in inbox. Please allow a few seconds for the bank email alert.'
  });
});

// Simulation endpoint to test concurrent payments
app.post('/api/v1/simulate-payment', (req, res) => {
  const { merchantId = req.merchant.id, amount = 5, payerName = 'Concurrent Tester', utr } = req.body;
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const watcher = watcherManager.getOrCreate(merchant);
  const simulatedPayment = {
    uid: Math.floor(10000 + Math.random() * 90000),
    amount: parseFloat(amount),
    senderName: payerName,
    utr: utr || Math.floor(100000000000 + Math.random() * 900000000000).toString(),
    txnId: `FMPIB${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    date: new Date(),
    rawSubject: `You received ₹${amount} in your FamX account`,
    snippet: `Hey Monu Kumar, You have successfully received ₹${amount} from ${payerName}. UTR: ${utr || '123'}.`,
    source: 'Simulation Engine'
  };

  watcher.handleIncomingPayment(simulatedPayment);

  res.json({
    success: true,
    simulatedPayment,
    warning: 'TEST DATA ONLY - not proof of any bank transaction'
  });
});

// ==============================================================
// 5. HOSTED PAYWALL ROUTE
// ==============================================================

app.get(['/pay/:orderId', '/checkout/:orderId', '/test/:orderId', '/test'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paywall.html'));
});

// Unknown API paths must not silently return the dashboard HTML.
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// Fallback to Main Dashboard / Landing SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 AuraPay Platform running at: http://localhost:${PORT}`);
  console.log(`💼 Active Merchant: ${defaultMerchant ? defaultMerchant.businessName : 'N/A'}`);
  console.log(`📧 Monitoring Email: ${defaultMerchant ? defaultMerchant.gmailUser : 'N/A'}`);
  console.log(`====================================================`);
});
