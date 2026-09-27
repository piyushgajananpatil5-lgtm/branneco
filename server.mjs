import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import { rateLimit } from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SESSION_MS = 12 * 60 * 60 * 1000;
await mkdir(path.join(ROOT, 'data'), { recursive: true });
await mkdir(path.join(ROOT, 'uploads'), { recursive: true });
const db = new Database(path.join(ROOT, 'data', 'branneco.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, page TEXT NOT NULL, inr TEXT NOT NULL, usd TEXT NOT NULL, image_url TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, currency TEXT NOT NULL, subtotal REAL NOT NULL, status TEXT NOT NULL DEFAULT 'new', items TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread', reply TEXT, created_at TEXT NOT NULL, replied_at TEXT);
  CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
`);
const now = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function seedProducts() {
  if (db.prepare('SELECT count(*) AS total FROM products').get().total) return;
  const insert = db.prepare('INSERT OR IGNORE INTO products (sku,name,category,page,inr,usd,image_url,updated_at) VALUES (@sku,@name,@category,@page,@inr,@usd,@image_url,@updated_at)');
  const pages = ['areca_leaf.html', 'rice_husk_range.html', 'sugarcane_bagasse.html', 'paper_kraft_packaging.html', 'wooden_cutlery.html'];
  const seed = db.transaction((records) => records.forEach((product) => insert.run(product)));
  for (const page of pages) {
    const file = path.join(ROOT, 'pages', page);
    const html = await readFile(file, 'utf8');
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
        insert.run({ sku, name: `${label}${description ? ` · ${description}` : ''}`, category: label, page: path.basename(page, '.html'), inr: cells[rupees], usd: cells[dollars], image_url: `/${imagePath}`, updated_at: now() });
      });
    }
  }
}

await seedProducts();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/uploads', express.static(path.join(ROOT, 'uploads'), { dotfiles: 'deny', immutable: true, maxAge: '1d' }));
app.use(['/data', '/node_modules', '/scripts', '/server.mjs', '/package.json', '/package-lock.json'], (_req, res) => res.sendStatus(404));
app.use(express.static(ROOT, { dotfiles: 'deny', index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
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
  const a = Buffer.from(left || ''); const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
function getSession(req) {
  const cookies = parseCookie(req.headers.cookie);
  const token = cookies['branneco_admin'];
  if (!token || !/^[\da-f]{64}$/.test(token)) return null;
  const session = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), Date.now());
  return session ? { ...session, token } : null;
}
function requireAdmin(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ error: 'Please sign in again.' });
  next();
}
function requireCsrf(req, res, next) {
  const session = getSession(req);
  if (!session || !safeEqual(sha(req.get('x-csrf-token') || ''), session.csrf_hash)) return res.status(403).json({ error: 'Security token expired. Refresh the page and sign in again.' });
  next();
}
const admin = (method, handler) => app[method]('/api/admin/*path', requireAdmin, requireCsrf, adminLimiter, handler);

app.get('/api/health', (_req, res) => res.json({ ok: true, adminConfigured: configuredAdmin(), smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) }));
app.get('/api/catalog', (req, res) => {
  const products = req.query.category
    ? db.prepare('SELECT sku,name,category,page,inr,usd,image_url FROM products WHERE page = ? ORDER BY sku').all(String(req.query.category).slice(0, 80))
    : db.prepare('SELECT sku,name,category,page,inr,usd,image_url FROM products ORDER BY category,sku').all();
  res.set('Cache-Control', 'no-store').json({ products });
});
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!configuredAdmin()) return res.status(503).json({ error: 'Admin account is not set up. Run npm run admin:create, then restart the server.' });
  const emailMatches = safeEqual(email, process.env.ADMIN_EMAIL.toLowerCase());
  const passwordMatches = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH).catch(() => false);
  if (!emailMatches || !passwordMatches) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO admin_sessions (token_hash, csrf_hash, expires_at) VALUES (?, ?, ?)').run(sha(token), sha(csrf), Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `branneco_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${req.secure ? '; Secure' : ''}`);
  res.json({ email, csrfToken: csrf, expiresIn: SESSION_MS });
});
app.get('/api/admin/session', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in.' });
  const csrfToken = randomBytes(32).toString('hex');
  db.prepare('UPDATE admin_sessions SET csrf_hash = ? WHERE token_hash = ?').run(sha(csrfToken), sha(session.token));
  res.json({ email: process.env.ADMIN_EMAIL, csrfToken });
});
app.post('/api/admin/logout', requireAdmin, requireCsrf, (req, res) => {
  const session = getSession(req);
  if (session) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha(session.token));
  res.setHeader('Set-Cookie', 'branneco_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

const listProducts = () => db.prepare('SELECT sku,name,category,page,inr,usd,image_url,updated_at FROM products ORDER BY category,sku').all();
app.get('/api/admin/products', requireAdmin, adminLimiter, (_req, res) => res.json({ products: listProducts() }));
function cleanPrice(value) {
  const price = String(value ?? '').trim();
  if (!price || price.length > 60 || !/^[\p{L}\p{N}\s.,₹$€£–—+\/()%'-]+$/u.test(price)) throw new Error('Enter a price, range, or quote text (maximum 60 characters).');
  return price;
}
app.patch('/api/admin/products/:sku', requireAdmin, requireCsrf, adminLimiter, (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(String(req.params.sku).slice(0, 80));
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const inr = cleanPrice(req.body?.inr ?? product.inr);
    const usd = cleanPrice(req.body?.usd ?? product.usd);
    const imageUrl = req.body?.image_url === undefined ? product.image_url : String(req.body.image_url).slice(0, 500);
    if (!/^\/(?:images|uploads)\/[\w./%-]+$/.test(imageUrl)) return res.status(400).json({ error: 'Choose an image from the catalogue or upload a JPG, PNG, or WebP.' });
    db.prepare('UPDATE products SET inr = ?, usd = ?, image_url = ?, updated_at = ? WHERE sku = ?').run(inr, usd, imageUrl, now(), product.sku);
    return res.json({ product: db.prepare('SELECT * FROM products WHERE sku = ?').get(product.sku) });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
app.post('/api/admin/upload', requireAdmin, requireCsrf, adminLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, or WebP image smaller than 5 MB.' });
  const detected = await fileTypeFromBuffer(req.file.buffer);
  if (!detected || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) return res.status(400).json({ error: 'That file is not a valid JPG, PNG, or WebP image.' });
  const filename = `${randomUUID()}.${detected.ext}`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(ROOT, 'uploads', filename), req.file.buffer, { flag: 'wx', mode: 0o644 });
  res.json({ image_url: `/uploads/${filename}` });
});

function orderItems(input, currency) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new Error('Add between 1 and 50 products to your order.');
  let subtotal = 0;
  const exchangeRates = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.67 };
  const items = input.map((item) => {
    const sku = String(item?.sku || '').slice(0, 80);
    const quantity = Math.floor(Number(item?.quantity));
    if (!sku || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Check product quantities and try again.');
    const product = db.prepare('SELECT sku,name,inr,usd FROM products WHERE sku = ?').get(sku);
    if (!product) throw new Error(`Product ${sku} is no longer available.`);
    const amountText = currency === 'INR' ? product.inr : product.usd;
    const amount = /^\d+(?:\.\d+)?$/.test(amountText.replace(/,/g, '')) ? Number(amountText.replace(/,/g, '')) * (currency === 'INR' ? 1 : exchangeRates[currency]) : null;
    if (amount !== null) subtotal += amount * quantity;
    return { sku, name: product.name, quantity, inr: product.inr, usd: product.usd };
  });
  return { items, subtotal };
}
app.post('/api/orders', publicLimiter, (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const phone = String(req.body?.phone || '').trim().slice(0, 32);
    const currency = ['INR', 'USD', 'EUR', 'GBP', 'AED'].includes(req.body?.currency) ? req.body.currency : 'INR';
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 7) return res.status(400).json({ error: 'Enter your name, a valid email address, and phone number.' });
    const { items, subtotal } = orderItems(req.body?.items, currency);
    const createdAt = now();
    const result = db.prepare('INSERT INTO orders (name,email,phone,currency,subtotal,items,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(name, email, phone, currency, subtotal, JSON.stringify(items), createdAt, createdAt);
    const reference = `BE-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(result.lastInsertRowid).padStart(5, '0')}`;
    db.prepare('UPDATE orders SET reference = ? WHERE id = ?').run(reference, result.lastInsertRowid);
    res.status(201).json({ reference });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/admin/orders', requireAdmin, adminLimiter, (req, res) => {
  const status = String(req.query.status || 'all');
  const orders = status === 'all'
    ? db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all()
    : db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 300').all(status);
  res.json({ orders: orders.map((order) => ({ ...order, items: JSON.parse(order.items) })) });
});
app.patch('/api/admin/orders/:id', requireAdmin, requireCsrf, adminLimiter, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['new', 'contacted', 'confirmed', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (req.body?.emailCustomer && !mailer()) return res.status(503).json({ error: 'Order was saved but email replies are not configured. Set SMTP_* in .env.' });
  if (req.body?.emailCustomer) {
    try { await mailer().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: order.email, subject: `Your BrannEco order ${order.reference}`, text: String(req.body.message || `Your order status is now ${status}.`).slice(0, 5000) }); }
    catch { return res.status(502).json({ error: 'Could not send email. Check your SMTP settings; the order status was not changed.' }); }
  }
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), order.id);
  res.json({ ok: true });
});

app.post('/api/inquiries', publicLimiter, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  const subject = String(req.body?.subject || 'Product enquiry').trim().slice(0, 180);
  const message = String(req.body?.message || '').trim().slice(0, 5000);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email address, and a message of at least 8 characters.' });
  const result = db.prepare('INSERT INTO inquiries (name,email,subject,message,created_at) VALUES (?,?,?,?,?)').run(name, email, subject, message, now());
  res.status(201).json({ reference: `Q-${String(result.lastInsertRowid).padStart(5, '0')}` });
});
app.get('/api/admin/inquiries', requireAdmin, adminLimiter, (req, res) => {
  const status = String(req.query.status || 'all');
  const inquiries = status === 'all'
    ? db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 300').all()
    : db.prepare('SELECT * FROM inquiries WHERE status = ? ORDER BY id DESC LIMIT 300').all(status);
  res.json({ inquiries });
});
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}
app.post('/api/admin/inquiries/:id/reply', requireAdmin, requireCsrf, adminLimiter, async (req, res) => {
  const reply = String(req.body?.reply || '').trim().slice(0, 5000);
  if (reply.length < 2) return res.status(400).json({ error: 'Write a reply before sending.' });
  const inquiry = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(Number(req.params.id));
  if (!inquiry) return res.status(404).json({ error: 'Enquiry not found.' });
  const transport = mailer();
  if (!transport) return res.status(503).json({ error: 'Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env before replying. No email was sent.' });
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: inquiry.email, replyTo: process.env.MAIL_FROM || process.env.SMTP_USER, subject: `Re: ${inquiry.subject}`, text: `Hi ${inquiry.name},\n\n${reply}\n\n— BrannEco` });
  } catch (error) { console.error('Inquiry email failed:', error.message); return res.status(502).json({ error: 'Email could not be delivered. Check SMTP configuration and try again.' }); }
  db.prepare("UPDATE inquiries SET reply = ?, status = 'replied', replied_at = ? WHERE id = ?").run(reply, now(), inquiry.id);
  res.json({ ok: true });
});
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Images must be smaller than 5 MB.' : 'Choose one valid image.' });
  return res.status(500).json({ error: 'Something went wrong. Check the server log for details.' });
});
app.listen(PORT, () => console.log(`BrannEco is ready at http://localhost:${PORT}${configuredAdmin() ? '' : ' — run npm run admin:create to configure the admin login'}`));
