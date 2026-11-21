'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { OrderModel } = require('../services/mongo');

test('verified credit audit fields are part of MongoDB schema', () => {
  const schema = OrderModel.schema;
  assert.ok(schema.path('paymentDetails.utr'));
  assert.ok(schema.path('paymentDetails.eventId'));
  assert.ok(schema.path('paymentDetails.verificationMethod'));
  const indexes = schema.indexes();
  for (const field of ['paymentDetails.utr', 'paymentDetails.eventId']) {
    assert.ok(indexes.some(([fields, options]) => fields[field] === 1 && options.unique === true),
      'Expected unique index for ' + field);
  }
});

test('database diagnostic exits safely when MongoDB credentials are absent', () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-mongodb.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MONGODB_URI: '' },
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MONGODB_URI: missing/);
  assert.doesNotMatch(result.stdout + result.stderr, /mongodb\+srv:\/\/[^ ]*:[^ ]*@/);
});
