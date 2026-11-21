#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { connectMongo, MerchantModel, OrderModel } = require('../services/mongo');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI: missing');
    console.error('Connect MongoDB Atlas Free from Vercel Marketplace -> dev-payment-gateway -> Projects.');
    console.error('Do not paste your database URI, password or credentials into chat or GitHub.');
    process.exitCode = 2;
    return;
  }
  try {
    const ok = await connectMongo();
    if (!ok || mongoose.connection.readyState !== 1) throw new Error('Connection unsuccessful');
    const reply = await mongoose.connection.db.admin().ping();
    if (reply.ok !== 1) throw new Error('Database ping unsuccessful');
    console.log('MongoDB Atlas: CONNECTED');
    console.log('Database:', mongoose.connection.db.databaseName);
    console.log('Collections:', MerchantModel.collection.collectionName, OrderModel.collection.collectionName);
    console.log('Payment verification:', process.env.PAYMENT_VERIFICATION_ENABLED === 'true'
      ? 'configured as enabled; confirm bank/PSP integration before use' : 'DISABLED (safe default)');
  } catch (_) {
    console.error('MongoDB Atlas: NOT CONNECTED');
    console.error('Check MONGODB_URI, your Atlas database user, IP access rules and Vercel deployment variables.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => { console.error('Database check failed.'); process.exitCode = 1; });
