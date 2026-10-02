import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { MongoClient, ObjectId } from 'mongodb';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import { rateLimit } from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const STORAGE_ROOT = process.env.VERCEL === '1' ? '/tmp/branneco' : ROOT;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'branneco';
await mkdir(path.join(STORAGE_ROOT, 'uploads'), { recursive: true });

let databasePromise;
async function database() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  if (!databasePromise) {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    databasePromise = client.connect().then(async () => {
      const db = client.db(MONGODB_DB);
      await db.collection('subadmins').createIndex({ email: 1 }, { unique: true });
      return db;
    });
  }
  return databasePromise;
}

const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const csrfForSession = (token) => createHmac('sha256', token).update('branneco-admin-csrf-v1').digest('hex');
const FALLBACK_EXCHANGE_RATES = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.67 };
const EXCHANGE_RATE_TTL_MS = 6 * 60 * 60 * 1000;
let exchangeRateCache = { base: 'USD', rates: { ...FALLBACK_EXCHANGE_RATES }, updatedAt: null, source: 'fallback' };
let exchangeRateCacheExpiresAt = 0;

async function getExchangeRates() {
  if (Date.now() < exchangeRateCacheExpiresAt) return exchangeRateCache;
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Exchange rate provider returned ${response.status}.`);
    const data = await response.json();
    if (data.result !== 'success' || data.base_code !== 'USD') throw new Error('Exchange rate provider returned an invalid response.');
    const rates = { USD: 1 };
    for (const currency of ['EUR', 'GBP', 'AED']) {
      const rate = Number(data.rates?.[currency]);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Exchange rate for ${currency} is unavailable.`);
      rates[currency] = rate;
    }
    exchangeRateCache = { base: 'USD', rates, updatedAt: data.time_last_update_utc || now(), source: 'live' };
    exchangeRateCacheExpiresAt = Date.now() + EXCHANGE_RATE_TTL_MS;
  } catch (error) {
    console.warn(`Live exchange rates unavailable; using ${exchangeRateCache.source} rates: ${error.message}`);
    exchangeRateCacheExpiresAt = Date.now() + 5 * 60 * 1000;
  }
  return exchangeRateCache;
}

async function seedProducts() {
  const db = await database();
  const products = db.collection('products');
  if (await products.countDocuments()) return;
  const pages = ['areca_leaf.html', 'rice_husk_range.html', 'sugarcane_bagasse.html', 'paper_kraft_packaging.html', 'wooden_cutlery.html'];
  const records = [];
  for (const page of pages) {
    const html = await readFile(path.join(ROOT, 'pages', page), 'utf8');
    const $ = cheerio.load(html);
    for (const table of $('table').toArray()) {
      const headings = $(table).find('tr').first().find('th').toArray().map((cell) => $(cell).text().trim());
      const rupees = headings.findIndex((heading) => /INR/i.test(heading));
      const dollars = headings.findIndex((heading) => /Export/i.test(heading));
      if (rupees < 0 || dollars < 0) continue;
      $(table).find('tr').slice(1).each((_, row) => {
        const cells = $(row).find('td').toArray().map((cell) => $(cell).text().trim());
        const sku = cells[0];
        if (!sku || !cells[rupees] || !cells[dollars]) return;
        const section = $(row).closest('.catsec');
        const label = section.find('.head').first().text().trim() || section.attr('data-catname') || sku;
        const description = cells.filter((_, index) => index !== 0 && index !== rupees && index !== dollars).join(' · ');
        const imageSource = section.find('.cat-photo').first().attr('src') || '';
        const imagePath = imageSource ? imageSource.replace(/^\.\.\//, '') : 'images/index/logo.jpg';
        records.push({ sku, name: `${label}${description ? ` · ${description}` : ''}`, category: label, page: path.basename(page, '.html'), inr: cells[rupees], usd: cells[dollars], image_url: `/${imagePath}`, updated_at: now() });
      });
    }
  }
  if (records.length) await products.insertMany(records, { ordered: false });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/uploads', express.static(path.join(STORAGE_ROOT, 'uploads'), { dotfiles: 'deny', immutable: true, maxAge: '1d' }));
app.use(['/data', '/node_modules', '/scripts', '/server.mjs', '/package.json', '/package-lock.json'], (_req, res) => res.sendStatus(404));
app.use(express.static(ROOT, { dotfiles: 'deny', index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });

function configuredAdmin() {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ADMIN_EMAIL || '') && /^\$2[aby]\$/.test(process.env.ADMIN_PASSWORD_HASH || '');
}
function parseCookie(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((parts) => parts.length === 2));
}
function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
async function getSession(req) {
  const token = parseCookie(req.headers.cookie).branneco_admin;
  if (!token || !/^[\da-f]{64}$/.test(token)) return null;
  const db = await database();
  const session = await db.collection('admin_sessions').findOne({ token_hash: sha(token), expires_at: { $gt: Date.now() } });
  return session ? { ...session, email: session.email || process.env.ADMIN_EMAIL, role: session.role || 'owner', token } : null;
}
async function requireAdmin(req, res, next) {
  try {
    req.adminSession = await getSession(req);
    if (!req.adminSession) return res.status(401).json({ error: 'Please sign in again.' });
    return next();
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
}
async function requireCsrf(req, res, next) {
  try {
    const session = await getSession(req);
    const providedToken = req.get('x-csrf-token') || '';
    const validToken = session?.csrf_version === 2
      ? safeEqual(providedToken, csrfForSession(session.token))
      : session && safeEqual(sha(providedToken), session.csrf_hash || '');
    if (!validToken) return res.status(403).json({ error: 'Security token expired. Refresh the page and sign in again.' });
    return next();
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
}

app.get('/api/health', async (_req, res) => {
  let mongoConnected = false;
  if (MONGODB_URI) {
    try { await database(); mongoConnected = true; } catch {}
  }
  res.json({ ok: true, mongoConfigured: Boolean(MONGODB_URI), mongoConnected, adminConfigured: configuredAdmin(), smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) });
});
app.get('/api/exchange-rates', async (_req, res) => {
  const exchangeRates = await getExchangeRates();
  res.set('Cache-Control', 'public, max-age=900').json(exchangeRates);
});
app.get('/api/catalog', async (req, res) => {
  try {
    await seedProducts();
    const db = await database();
    const filter = req.query.category ? { page: String(req.query.category).slice(0, 80) } : {};
    const products = await db.collection('products').find(filter, { projection: { _id: 0, sku: 1, name: 1, category: 1, page: 1, inr: 1, usd: 1, image_url: 1 } }).sort({ category: 1, sku: 1 }).toArray();
    res.set('Cache-Control', 'no-store').json({ products });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!configuredAdmin()) return res.status(503).json({ error: 'Admin account is not set up. Configure ADMIN_EMAIL and ADMIN_PASSWORD_HASH.' });
    const isOwner = safeEqual(email, process.env.ADMIN_EMAIL.toLowerCase());
    const db = await database();
    const subadmin = isOwner ? null : await db.collection('subadmins').findOne({ email, active: true });
    const passwordHash = isOwner ? process.env.ADMIN_PASSWORD_HASH : subadmin?.password_hash;
    const passwordMatches = await bcrypt.compare(password, passwordHash || '').catch(() => false);
    if ((!isOwner && !subadmin) || !passwordMatches) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = randomBytes(32).toString('hex');
    const csrf = csrfForSession(token);
    const role = isOwner ? 'owner' : 'subadmin';
    await db.collection('admin_sessions').insertOne({ token_hash: sha(token), csrf_version: 2, email, role, expires_at: Date.now() + SESSION_MS });
    res.setHeader('Set-Cookie', `branneco_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${req.secure ? '; Secure' : ''}`);
    res.json({ email, role, csrfToken: csrf, expiresIn: SESSION_MS });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.get('/api/admin/session', async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not signed in.' });
    const db = await database();
    const csrfToken = csrfForSession(session.token);
    if (session.csrf_version !== 2) {
      await db.collection('admin_sessions').updateOne(
        { token_hash: sha(session.token), csrf_version: { $ne: 2 } },
        { $set: { csrf_version: 2 }, $unset: { csrf_hash: '' } },
      );
    }
    res.set('Cache-Control', 'no-store').json({ email: session.email || process.env.ADMIN_EMAIL, role: session.role || 'owner', csrfToken });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.post('/api/admin/logout', requireAdmin, requireCsrf, async (req, res) => {
  const session = await getSession(req);
  if (session) { const db = await database(); await db.collection('admin_sessions').deleteOne({ token_hash: sha(session.token) }); }
  res.setHeader('Set-Cookie', 'branneco_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

function requireOwner(req, res, next) {
  if (req.adminSession?.role !== 'owner') return res.status(403).json({ error: 'Only the primary admin can manage sub-admins.' });
  next();
}
app.get('/api/admin/subadmins', requireAdmin, requireOwner, adminLimiter, async (_req, res) => {
  try {
    const db = await database();
    const subadmins = await db.collection('subadmins').find({ active: true }, { projection: { email: 1, role: 1, created_at: 1 } }).sort({ email: 1 }).toArray();
    res.json({ subadmins: subadmins.map(({ _id, ...user }) => ({ ...user, id: _id.toString() })) });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.post('/api/admin/subadmins', requireAdmin, requireCsrf, requireOwner, adminLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid sub-admin email address.' });
    if (safeEqual(email, process.env.ADMIN_EMAIL.toLowerCase())) return res.status(400).json({ error: 'The primary admin account cannot be added as a sub-admin.' });
    if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Sub-admin passwords must be 12 to 128 characters.' });
    const db = await database();
    const result = await db.collection('subadmins').insertOne({ email, password_hash: await bcrypt.hash(password, 12), role: 'subadmin', active: true, created_at: now() });
    res.status(201).json({ subadmin: { id: result.insertedId.toString(), email, role: 'subadmin', created_at: now() } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'A sub-admin with that email already exists.' });
    res.status(503).json({ error: error.message });
  }
});
app.delete('/api/admin/subadmins/:id', requireAdmin, requireCsrf, requireOwner, adminLimiter, async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(404).json({ error: 'Sub-admin not found.' });
  try {
    const db = await database();
    const subadmin = await db.collection('subadmins').findOne({ _id: new ObjectId(req.params.id) });
    if (!subadmin) return res.status(404).json({ error: 'Sub-admin not found.' });
    const result = await db.collection('subadmins').deleteOne({ _id: subadmin._id });
    if (!result.deletedCount) return res.status(404).json({ error: 'Sub-admin not found.' });
    await db.collection('admin_sessions').deleteMany({ role: 'subadmin', email: subadmin.email });
    res.json({ ok: true });
  } catch (error) { res.status(503).json({ error: error.message }); }
});

const listProducts = async () => {
  const db = await database();
  return db.collection('products').find({}, { projection: { _id: 0 } }).sort({ category: 1, sku: 1 }).toArray();
};
app.get('/api/admin/products', requireAdmin, adminLimiter, async (_req, res) => {
  try { res.json({ products: await listProducts() }); } catch (error) { res.status(503).json({ error: error.message }); }
});
function cleanPrice(value) {
  const price = String(value ?? '').trim();
  if (!price || price.length > 60 || !/^[\p{L}\p{N}\s.,₹$€£–—+\/%()'-]+$/u.test(price)) throw new Error('Enter a price, range, or quote text (maximum 60 characters).');
  return price;
}
app.patch('/api/admin/products/:sku', requireAdmin, requireCsrf, adminLimiter, async (req, res) => {
  try {
    const db = await database();
    const sku = String(req.params.sku).slice(0, 80);
    const product = await db.collection('products').findOne({ sku });
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const inr = cleanPrice(req.body?.inr ?? product.inr);
    const usd = cleanPrice(req.body?.usd ?? product.usd);
    const imageUrl = req.body?.image_url === undefined ? product.image_url : String(req.body.image_url).slice(0, 500);
    if (!/^\/(?:images|uploads)\/[\w./%-]+$/.test(imageUrl)) return res.status(400).json({ error: 'Choose an image from the catalogue or upload a JPG, PNG, or WebP.' });
    await db.collection('products').updateOne({ sku }, { $set: { inr, usd, image_url: imageUrl, updated_at: now() } });
    res.json({ product: await db.collection('products').findOne({ sku }, { projection: { _id: 0 } }) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
app.post('/api/admin/upload', requireAdmin, requireCsrf, adminLimiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, or WebP image smaller than 5 MB.' });
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) return res.status(400).json({ error: 'That file is not a valid JPG, PNG, or WebP image.' });
    const filename = `${randomUUID()}.${detected.ext}`;
    await writeFile(path.join(STORAGE_ROOT, 'uploads', filename), req.file.buffer, { flag: 'wx', mode: 0o644 });
    res.json({ image_url: `/uploads/${filename}` });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function orderItems(input, currency) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new Error('Add between 1 and 50 products to your order.');
  const validatedItems = input.map((item) => {
    const sku = String(item?.sku || '').slice(0, 80);
    const quantity = Math.floor(Number(item?.quantity));
    if (!sku || !Number.isInteger(quantity) || quantity < 500 || quantity > 999999) throw new Error('The minimum order is 500 units per product.');
    return { sku, quantity };
  });
  let subtotal = 0;
  const exchangeRates = ['EUR', 'GBP', 'AED'].includes(currency) ? (await getExchangeRates()).rates : { USD: 1 };
  const db = await database();
  const items = [];
  for (const { sku, quantity } of validatedItems) {
    const product = await db.collection('products').findOne({ sku });
    if (!product) throw new Error(`Product ${sku} is no longer available.`);
    const amountText = currency === 'INR' ? product.inr : product.usd;
    const amount = /^\d+(?:\.\d+)?$/.test(amountText.replace(/,/g, '')) ? Number(amountText.replace(/,/g, '')) * (currency === 'INR' ? 1 : exchangeRates[currency]) : null;
    if (amount !== null) subtotal += amount * quantity;
    items.push({ sku, name: product.name, quantity, inr: product.inr, usd: product.usd });
  }
  return { items, subtotal };
}
app.post('/api/orders', publicLimiter, async (req, res) => {
  try {
    const firstName = String(req.body?.firstName || '').trim().slice(0, 60);
    const lastName = String(req.body?.lastName || '').trim().slice(0, 60);
    const name = `${firstName} ${lastName}`.trim().slice(0, 120) || String(req.body?.name || '').trim().slice(0, 120);
    const company = String(req.body?.company || '').trim().slice(0, 160);
    const country = String(req.body?.country || '').trim().slice(0, 80);
    const address1 = String(req.body?.address1 || '').trim().slice(0, 200);
    const address2 = String(req.body?.address2 || '').trim().slice(0, 200);
    const city = String(req.body?.city || '').trim().slice(0, 100);
    const state = String(req.body?.state || '').trim().slice(0, 100);
    const postalCode = String(req.body?.postalCode || '').trim().slice(0, 20);
    const gstNumber = String(req.body?.gstNumber || '').trim().slice(0, 30);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const phone = String(req.body?.phone || '').trim().slice(0, 32);
    const currency = ['INR', 'USD', 'EUR', 'GBP', 'AED'].includes(req.body?.currency) ? req.body.currency : 'INR';
    if (name.length < 2 || company.length < 2 || !country || address1.length < 4 || city.length < 2 || state.length < 2 || postalCode.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 7) return res.status(400).json({ error: 'Complete the required billing and shipping details with a valid email and phone number.' });
    const { items, subtotal } = await orderItems(req.body?.items, currency);
    const createdAt = now();
    const db = await database();
    const result = await db.collection('orders').insertOne({ name, firstName, lastName, company, country, address1, address2, city, state, postalCode, gstNumber, email, phone, currency, subtotal, status: 'new', items, created_at: createdAt, updated_at: createdAt });
    const reference = `BE-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(result.insertedId).slice(-5).toUpperCase()}`;
    await db.collection('orders').updateOne({ _id: result.insertedId }, { $set: { reference } });
    res.status(201).json({ reference });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/admin/orders', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const db = await database();
    const filter = String(req.query.status || 'all') === 'all' ? {} : { status: String(req.query.status) };
    const orders = await db.collection('orders').find(filter).sort({ _id: -1 }).limit(300).toArray();
    res.json({ orders: orders.map(({ _id, ...order }) => ({ ...order, id: _id.toString() })) });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.patch('/api/admin/orders/:id', requireAdmin, requireCsrf, adminLimiter, async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['new', 'contacted', 'confirmed', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
    const db = await database();
    const order = await db.collection('orders').findOne({ $or: [{ reference: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? new ObjectId(req.params.id) : null }] });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (req.body?.emailCustomer && !mailer()) return res.status(503).json({ error: 'Order was saved but email replies are not configured. Set SMTP_* in .env.' });
    if (req.body?.emailCustomer) await mailer().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: order.email, subject: `Your BrannEco order ${order.reference}`, text: String(req.body.message || `Your order status is now ${status}.`).slice(0, 5000) });
    await db.collection('orders').updateOne({ _id: order._id }, { $set: { status, updated_at: now() } });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/inquiries', publicLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const subject = String(req.body?.subject || 'Product enquiry').trim().slice(0, 180);
    const message = String(req.body?.message || '').trim().slice(0, 5000);
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email address, and a message of at least 8 characters.' });
    const db = await database();
    const result = await db.collection('inquiries').insertOne({ name, email, subject, message, status: 'unread', reply: null, created_at: now(), replied_at: null });
    res.status(201).json({ reference: `Q-${String(result.insertedId).slice(-5).toUpperCase()}` });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/admin/inquiries', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const db = await database();
    const filter = String(req.query.status || 'all') === 'all' ? {} : { status: String(req.query.status) };
    const inquiries = await db.collection('inquiries').find(filter).sort({ _id: -1 }).limit(300).toArray();
    res.json({ inquiries: inquiries.map(({ _id, ...inquiry }) => ({ ...inquiry, id: _id.toString() })) });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}
app.post('/api/admin/inquiries/:id/reply', requireAdmin, requireCsrf, adminLimiter, async (req, res) => {
  try {
    const reply = String(req.body?.reply || '').trim().slice(0, 5000);
    if (reply.length < 2) return res.status(400).json({ error: 'Write a reply before sending.' });
    const db = await database();
    const inquiry = /^[0-9a-fA-F]{24}$/.test(req.params.id) ? await db.collection('inquiries').findOne({ _id: new ObjectId(req.params.id) }) : null;
    if (!inquiry) return res.status(404).json({ error: 'Enquiry not found.' });
    const transport = mailer();
    if (!transport) return res.status(503).json({ error: 'Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env before replying. No email was sent.' });
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: inquiry.email, replyTo: process.env.MAIL_FROM || process.env.SMTP_USER, subject: `Re: ${inquiry.subject}`, text: `Hi ${inquiry.name},\n\n${reply}\n\n- BrannEco` });
    await db.collection('inquiries').updateOne({ _id: inquiry._id }, { $set: { reply, status: 'replied', replied_at: now() } });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Images must be smaller than 5 MB.' : 'Choose one valid image.' });
  return res.status(500).json({ error: 'Something went wrong. Check the server log for details.' });
});

export default app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`BrannEco is ready at http://localhost:${PORT}${configuredAdmin() ? '' : ' - configure ADMIN_EMAIL and ADMIN_PASSWORD_HASH before admin login'}`));
}

seedProducts().catch((error) => console.warn(`Product seed skipped: ${error.message}`));
