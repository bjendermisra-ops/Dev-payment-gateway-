'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildUpiUri, generateDynamicQrDataUrl } = require('../services/qrHelper');
const { setupUpiIntentLinks } = require('../public/js/checkout');

test('dynamic QR uses the specific merchant UPI ID and exact customer amount', async () => {
  for (const amount of [1, 100, 257.35]) {
    const orderId = 'PAY-1234abcd5678';
    const result = await generateDynamicQrDataUrl({
      upiId:'myshop@okaxis', payeeName:'My Shop', amount, note:'Order payment', orderId
    });
    const link = new URL(result.upiUri);
    assert.equal(link.protocol, 'upi:');
    assert.equal(link.hostname, 'pay');
    assert.equal(link.searchParams.get('pa'), 'myshop@okaxis');
    assert.equal(link.searchParams.get('am'), amount.toFixed(2));
    assert.equal(link.searchParams.get('cu'), 'INR');
    assert.equal(link.searchParams.get('tr'), orderId);
    assert.ok(result.qrDataUrl.startsWith('data:image/png;base64,'));
  }
});

test('reject malformed merchant UPI IDs and invalid amounts', () => {
  assert.throws(() => buildUpiUri({upiId:'another-person-account',payeeName:'Shop',amount:100}), /valid merchant UPI ID/);
  assert.throws(() => buildUpiUri({upiId:'myshop@upi',payeeName:'Shop',amount:0}), /Amount must/);
  assert.throws(() => buildUpiUri({upiId:'myshop@upi',payeeName:'Shop',amount:10.001}), /Amount must/);
});

test('UPI intent buttons carry this order amount and UPI ID', () => {
  const ids=['btnPayDirect','btnFamPay','btnGPay','btnPhonePe','btnPaytm','btnNavi','btnSuperMoney'];
  const elements=Object.fromEntries(ids.map(id=>[id, {href:'#'}]));
  const prevDoc=global.document, prevNavigator=global.navigator;
  try {
    global.document={getElementById(id){return elements[id]||null;}};
    Object.defineProperty(global,'navigator',{value:{userAgent:'Mozilla/5.0 (Linux; Android 14)'},configurable:true});
    const upiUri=buildUpiUri({upiId:'shopkeeper@oksbi',payeeName:'Shop Keeper',amount:149.25,orderId:'PAY-XYZ'});
    setupUpiIntentLinks({dynamicUpiUrl:upiUri,amount:149.25});
    for(const id of ids){
      const href=elements[id].href;
      assert.ok(href.includes('pa=shopkeeper@oksbi'), id+' payee');
      assert.ok(href.includes('am=149.25'),id+' amount');
    }
    assert.ok(elements.btnPayDirect.href.startsWith('upi://pay?'));
    assert.ok(elements.btnGPay.href.startsWith('tez://upi/pay?'));
    assert.ok(elements.btnPhonePe.href.startsWith('phonepe://pay?'));
    assert.ok(elements.btnPaytm.href.startsWith('intent://pay?'));
    Object.defineProperty(global,'navigator',{value:{userAgent:'Mozilla/5.0 (iPhone)'},configurable:true});
    setupUpiIntentLinks({dynamicUpiUrl:upiUri,amount:149.25});
    assert.ok(elements.btnGPay.href.startsWith('gpay://upi/pay?'));
  } finally {
    if(prevDoc===undefined)delete global.document;else global.document=prevDoc;
    if(prevNavigator===undefined)delete global.navigator;else Object.defineProperty(global,'navigator',{value:prevNavigator,configurable:true});
  }
});
