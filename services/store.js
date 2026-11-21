const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MerchantModel, OrderModel, connectMongo, getIsConnected } = require('./mongo');

const os = require('os');
// Vercel functions have a read-only deployment filesystem. Use /tmp for demo
// state; configure MongoDB for durable, multi-instance production storage.
const DB_PATH = process.env.AURAPAY_STORE_PATH ||
  (process.env.VERCEL ? path.join(os.tmpdir(), 'aurapay-store.json') : path.join(__dirname, '..', 'data', 'store.json'));

class Store {
  constructor() {
    this.data = {
      merchants: {},
      orders: {}
    };
    this.mongoReady = false;
    this.pendingWrites = [];
    this.loadLocal();
    this.ready = this.initMongo();
  }

  loadLocal() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.merchants) this.data.merchants = {};
        if (!this.data.orders) this.data.orders = {};
      }
    } catch (e) {
      console.warn('[Store] Could not load local store.json, using defaults:', e.message);
    }
  }

  saveLocal() {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Store] Local save failed:', e.message);
    }
  }

  async initMongo() {
    try {
      const connected = await connectMongo();
      if (!connected) return;
      this.mongoReady = true;

      // Sync existing records to MongoDB or load from MongoDB
      const countMerchants = await MerchantModel.countDocuments();
      if (countMerchants === 0) {
        console.log('[Store] Seeding local data to MongoDB Atlas...');
        await this.syncAllToMongo();
      } else {
        console.log('[Store] Loading data from MongoDB Atlas...');
        await this.loadFromMongo();
      }
    } catch (err) {
      console.error('[Store] MongoDB sync error:', err.message);
    }
  }

  async syncAllToMongo() {
    try {
      for (const m of Object.values(this.data.merchants)) {
        await MerchantModel.findOneAndUpdate({ id: m.id }, m, { upsert: true, returnDocument: 'after' });
      }
      for (const o of Object.values(this.data.orders)) {
        await OrderModel.findOneAndUpdate({ orderId: o.orderId }, o, { upsert: true, returnDocument: 'after' });
      }
      console.log('[Store] Initial seed to MongoDB Atlas complete.');
    } catch (err) {
      console.error('[Store] Seed to MongoDB failed:', err.message);
    }
  }

  async loadFromMongo() {
    try {
      const merchants = await MerchantModel.find({}).lean();
      for (const m of merchants) {
        this.data.merchants[m.id] = m;
      }
      const orders = await OrderModel.find({}).lean();
      for (const o of orders) {
        this.data.orders[o.orderId] = o;
      }
      this.saveLocal();
      console.log(`[Store] Synced from MongoDB Atlas: ${merchants.length} merchants, ${orders.length} orders.`);
    } catch (err) {
      console.error('[Store] Loading from MongoDB failed:', err.message);
    }
  }


  trackWrite(query) {
    if (!this.mongoReady) return;
    const promise = Promise.resolve(query).then(result => result);
    // Convert failures to values to avoid unhandled rejections before flushWrites.
    this.pendingWrites.push(promise.then(() => ({ok:true}), err => ({ok:false,error:err.message})));
  }

  async flushWrites() {
    const writes = this.pendingWrites.splice(0);
    const results = await Promise.all(writes);
    if (results.some(x => !x.ok)) throw new Error('Database persistence failed');
  }

  createMerchant(data) {
    const id = `merch_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const apiKey = `aura_live_${crypto.randomBytes(16).toString('hex')}`;
    const merchant = {
      id,
      name: data.name || 'Merchant',
      email: data.email.toLowerCase().trim(),
      password: data.password,
      businessName: data.businessName || `${data.name}'s Store`,
      upiId: data.upiId || '',
      qrImagePath: data.qrImagePath || '',
      gmailUser: data.gmailUser || data.email,
      gmailAppPass: data.gmailAppPass || '',
      apiKey,
      isOnboarded: false,
      createdAt: new Date().toISOString()
    };
    this.data.merchants[id] = merchant;
    this.saveLocal();

    // Persist to MongoDB
    this.trackWrite(MerchantModel.findOneAndUpdate({ id }, merchant, { upsert: true }));

    return merchant;
  }

  getMerchantById(id) {
    return this.data.merchants[id] || null;
  }

  getMerchantByEmail(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    return Object.values(this.data.merchants).find(m => m.email === clean) || null;
  }

  getMerchantByApiKey(apiKey) {
    if (!apiKey) return null;
    return Object.values(this.data.merchants).find(m => m.apiKey === apiKey) || null;
  }

  updateMerchant(id, updates) {
    const m = this.data.merchants[id];
    if (!m) return null;
    Object.assign(m, updates);
    this.saveLocal();

    // Persist to MongoDB
    this.trackWrite(MerchantModel.findOneAndUpdate({ id }, { $set: updates }));

    return m;
  }

  createOrder(data) {
    const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const order = {
      orderId,
      merchantId: data.merchantId,
      amount: parseFloat(data.amount),
      customerName: data.customerName || 'Customer',
      customerEmail: data.customerEmail || '',
      note: data.note || `Payment #${orderId}`,
      status: 'PENDING',
      dynamicUpiUrl: data.dynamicUpiUrl || '',
      dynamicQrDataUrl: data.dynamicQrDataUrl || '',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      paymentDetails: null
    };
    this.data.orders[orderId] = order;
    this.saveLocal();

    // Persist to MongoDB
    this.trackWrite(OrderModel.findOneAndUpdate({ orderId }, order, { upsert: true }));

    return order;
  }

  getOrder(orderId) {
    return this.data.orders[orderId] || null;
  }

  updateOrder(orderId, updates) {
    const order = this.data.orders[orderId];
    if (!order) return null;
    Object.assign(order, updates);
    this.saveLocal();

    // Persist to MongoDB
    this.trackWrite(OrderModel.findOneAndUpdate({ orderId }, { $set: updates }));

    return order;
  }

  getOrdersByMerchant(merchantId) {
    return Object.values(this.data.orders)
      .filter(o => o.merchantId === merchantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getPendingOrdersByMerchant(merchantId) {
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes maximum pending window
    return Object.values(this.data.orders)
      .filter(o => {
        if (o.merchantId !== merchantId || o.status !== 'PENDING') return false;
        const age = now - new Date(o.createdAt).getTime();
        return age <= MAX_AGE_MS;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Newest first
  }
}

module.exports = new Store();
