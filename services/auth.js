'use strict';
const crypto = require('crypto');
const COOKIE_NAME = 'aurapay_session';
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_AGE_SEC = 7 * 24 * 60 * 60;
function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(p, salt, 210000, 32, 'sha256').toString('hex');
  return 'pbkdf2_sha256$210000$' + salt + '$' + hash;
}
function validPassword(entered, stored) {
  if (typeof entered !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const count = Number(parts[1]);
  if (!Number.isInteger(count) || count < 100000 || count > 1000000 || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
  const digest = crypto.pbkdf2Sync(entered, parts[2], count, 32, 'sha256');
  const expected = Buffer.from(parts[3], 'hex');
  return crypto.timingSafeEqual(digest, expected);
}
function hmac(msg) { return crypto.createHmac('sha256', secret).update(msg).digest('base64url'); }
function makeSession(merchantId) {
  const data = Buffer.from(JSON.stringify({ id: merchantId, exp: Math.floor(Date.now()/1000)+SESSION_AGE_SEC, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return data + '.' + hmac(data);
}
function readSession(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(hmac(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof data.id !== 'string' || data.id.length > 100 || !Number.isInteger(data.exp) || data.exp <= Date.now()/1000) return null;
    return data.id;
  } catch { return null; }
}
function setCookie(res, merchantId) {
  res.cookie(COOKIE_NAME, makeSession(merchantId), { httpOnly:true, sameSite:'strict', secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production', path:'/', maxAge: SESSION_AGE_SEC*1000 });
}
function clearCookie(res) { res.clearCookie(COOKIE_NAME, { httpOnly:true, sameSite:'strict', secure: process.env.VERCEL === '1' || process.env.NODE_ENV === 'production', path:'/' }); }
function requireMerchant(store) {
  return (req,res,next) => {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/(?:^|;\s*)aurapay_session=([^;]+)/);
    const id = readSession(match ? decodeURIComponent(match[1]) : '');
    const merchant = id && store.getMerchantById(id);
    if (!merchant) return res.status(401).json({ error: 'Sign in required' });
    req.merchant = merchant;
    next();
  };
}
module.exports = { hashPassword, validPassword, setCookie, clearCookie, requireMerchant };
