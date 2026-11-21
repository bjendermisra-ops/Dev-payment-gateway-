'use strict';
// Example: mount this router in YOUR website server, never inside browser JS.
// Requires Node.js >= 22. Do not use actual transactions until your gateway's
// authoritative bank verification and persistent backend are configured.
const express = require('express');
const router = express.Router();

const products = {
  ebook: { description: 'Digital Ebook', price: 100 },
  donation: { description: 'Demo Donation', price: 25 }
};
const base = process.env.AURAPAY_BASE_URL;
const key = process.env.AURAPAY_API_KEY;

router.post('/payments/create', express.json(), async (req, res) => {
  const product = products[req.body.productId];
  if (!product) return res.status(400).json({ error: 'Unknown product' });
  if (!base || !key) return res.status(503).json({ error: 'Gateway is not configured' });
  let serverOrigin;
  try {
    serverOrigin = new URL(base).origin;
    if (!serverOrigin.startsWith('https://')) throw new Error('TLS is required');
  } catch {
    return res.status(503).json({ error: 'Invalid gateway URL configuration' });
  }
  try {
    const upstream = await fetch(serverOrigin + '/api/v1/checkout/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        amount: product.price, // Never accept payment amount from the customer
        customerName: String(req.body.customerName || 'Customer').slice(0, 100),
        note: product.description
      }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await upstream.json();
    if (!upstream.ok || !result.checkoutUrl) {
      return res.status(upstream.status >= 500 ? 503 : 400).json({ error: result.error || 'Checkout unavailable' });
    }
    const checkout = new URL(result.checkoutUrl);
    if (checkout.origin !== serverOrigin || !checkout.pathname.startsWith('/pay/')) throw new Error('Unexpected checkout destination');
    return res.json({ orderId: result.orderId, checkoutUrl: checkout.toString() });
  } catch (err) {
    return res.status(503).json({ error: 'Gateway is unavailable' });
  }
});

// Always recheck paid status on your server with a trusted source.
// Do not ship goods based solely on a browser redirect.
router.get('/payments/status/:orderId', async (req, res) => {
  if (!base || !key) return res.status(503).json({ error: 'Gateway is not configured' });
  try {
    const id = String(req.params.orderId);
    if (!/^PAY-[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid order ID' });
    const upstream = await fetch(new URL(base).origin + '/api/v1/checkout/status/' + encodeURIComponent(id), {
      signal: AbortSignal.timeout(10000)
    });
    const result = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: result.error || 'Order not found' });
    return res.json({ verified: Boolean(result.verified), status: result.order?.status || 'UNKNOWN' });
  } catch {
    return res.status(503).json({ error: 'Status service unavailable' });
  }
});
module.exports = router;
