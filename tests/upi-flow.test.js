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


test('Android Chrome opens PhonePe by app-targeted intent and retains original upstream link', () => {
  const ids=['btnPayDirect','btnFamPay','btnGPay','btnPhonePe','btnPhonePeOriginal','btnPaytm','btnNavi','btnSuperMoney'];
  const elements=Object.fromEntries(ids.map(id=>[id,{href:'#'}]));
  const prevDoc=global.document, prevNavigator=global.navigator, prevWindow=global.window;
  try {
    global.document={getElementById(id){return elements[id]||null;}};
    global.window={location:{href:'https://dev-payment-gateway.vercel.app/pay/PAY-demo'}};
    Object.defineProperty(global,'navigator',{value:{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'},configurable:true});
    const upiUri=buildUpiUri({upiId:'store@paytm',payeeName:'My Store',amount:5,orderId:'PAY-test',note:'Website Hosting 891'});
    setupUpiIntentLinks({dynamicUpiUrl:upiUri,amount:5});
    assert.match(elements.btnPhonePe.href,/^intent:\/\/pay\?pa=store@paytm&pn=My%20Store&am=5\.00/);
    assert.match(elements.btnPhonePe.href,/#Intent;scheme=upi;package=com\.phonepe\.app;/);
    assert.match(elements.btnPhonePe.href,/S\.browser_fallback_url=https%3A%2F%2Fdev-payment-gateway\.vercel\.app/);
    assert.match(elements.btnPhonePeOriginal.href,/^phonepe:\/\/pay\?pa=store@paytm/);
    assert.match(elements.btnPhonePeOriginal.href,/am=5\.00/);
    assert.match(elements.btnPayDirect.href,/^upi:\/\/pay\?pa=store@paytm/);
    assert.match(elements.btnGPay.href,/^tez:\/\/upi\/pay\?/);
    assert.match(elements.btnPaytm.href,/package=net\.one97\.paytm/);
  } finally {
    if(prevDoc===undefined)delete global.document;else global.document=prevDoc;
    if(prevWindow===undefined)delete global.window;else global.window=prevWindow;
    if(prevNavigator===undefined)delete global.navigator;else Object.defineProperty(global,'navigator',{value:prevNavigator,configurable:true});
  }
});

test('Android WebView preserves original upstream phonepe deep link', () => {
  const elements={btnPhonePe:{href:'#'},btnPhonePeOriginal:{href:'#'}};
  const prevDoc=global.document, prevNavigator=global.navigator;
  try {
    global.document={getElementById(id){return elements[id]||null;}};
    Object.defineProperty(global,'navigator',{value:{userAgent:'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/131.0 Mobile Safari/537.36'},configurable:true});
    setupUpiIntentLinks({dynamicUpiUrl:buildUpiUri({upiId:'store@oksbi',payeeName:'Store',amount:2100,orderId:'PAY-test-2'}),amount:2100});
    assert.match(elements.btnPhonePe.href,/^phonepe:\/\/pay\?pa=store@oksbi/);
    assert.match(elements.btnPhonePe.href,/am=2100\.00/);
  } finally {
    if(prevDoc===undefined)delete global.document;else global.document=prevDoc;
    if(prevNavigator===undefined)delete global.navigator;else Object.defineProperty(global,'navigator',{value:prevNavigator,configurable:true});
  }
});
