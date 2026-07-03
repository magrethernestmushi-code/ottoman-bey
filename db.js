'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MONGO_DB_NAME = process.env.MONGODB_DB_NAME || 'ottoman_bey_pos';
const MONGO_COLLECTION = 'posdb';
const MONGO_DOC_ID = 'main';
const ROLES = ['Admin', 'Cashier', 'Waiter', 'Kitchen'];
const MENU_MANAGE_ROLES = ['Admin', 'Kitchen', 'Cashier'];

function nowISO() { return new Date().toISOString(); }
function todayStr() { return nowISO().slice(0, 10); }
function dateOf(iso) { return (iso || '').slice(0, 10); }
function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.trunc((Date.parse(b) - Date.parse(a)) / 60000);
}
function round2(n) { return parseFloat((Number(n) || 0).toFixed(2)); }
function uuid() { return crypto.randomUUID(); }

function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
}
function verifyPassword(password, salt, hash) {
  const test = hashPassword(password, salt);
  const a = Buffer.from(test, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── seed data (same menu as the offline edition) ──────────────────
function seedDB() {
  const db = {
    version: 2,
    staff: [],
    categories: [],
    menu_items: [],
    orders: [],
    messages: [],
    settings: { vat_enabled: '1', vat_rate: '0.18' },
    _seq: { categories: 0, menu_items: 0 }
  };
  function nextId(kind) { db._seq[kind] += 1; return db._seq[kind]; }

  const salt = genSalt();
  db.staff.push({
    id: uuid(), username: 'superadmin',
    password_hash: hashPassword('Admin@Ottoman2024!', salt), salt,
    full_name: 'Super Admin', role: 'Admin', is_active: 1, created_at: nowISO()
  });

  const cats = [
    { n: 'Breakfast', i: '🌅', s: 0 },
    { n: 'Main Meals', i: '🍽️', s: 1 },
    { n: 'Grill & Specials', i: '🔥', s: 2 },
    { n: 'Rice & Chips', i: '🍚', s: 3 }
  ];
  const catId = {};
  cats.forEach(c => {
    const id = nextId('categories');
    catId[c.n] = id;
    db.categories.push({ id, name: c.n, icon: c.i, sort_order: c.s });
  });

  const menuItems = [
    ['Breakfast', "Supu ya Ng'ombe", '🍲', 3000, 900],
    ['Breakfast', 'Supu ya Samaki', '🐟', 9000, 3000],
    ['Breakfast', 'Mkia', '🦴', 3000, 900],
    ['Breakfast', 'Kongoro', '🥩', 2500, 800],
    ['Breakfast', 'Chapati', '🫓', 500, 150],
    ['Breakfast', 'Andazi', '🍩', 500, 150],
    ['Breakfast', 'Sambusa', '🥟', 500, 150],
    ['Main Meals', 'Pilau Roast', '🍛', 3000, 900],
    ['Main Meals', 'Pilau', '🍛', 3000, 900],
    ['Main Meals', 'Ugali Nyama Choma', '🍖', 4000, 1300],
    ['Main Meals', "Mshikaki wa Ng'ombe", '🍢', 1000, 300],
    ['Main Meals', 'Kuku Robo', '🍗', 3000, 950],
    ['Main Meals', 'Kuku Nusu', '🍗', 6000, 1900],
    ['Main Meals', 'Kuku Mzima', '🐔', 12000, 3800],
    ['Grill & Specials', 'Soseji', '🌭', 1000, 300],
    ['Grill & Specials', 'Ndizi Mzuzu', '🍌', 1000, 300],
    ['Grill & Specials', 'Ndizi Roast', '🍌', 3000, 900],
    ['Grill & Specials', 'Kisinia watu 2', '🍽️', 25000, 8000],
    ['Grill & Specials', 'Kisinia watu 3', '🍽️', 35000, 11000],
    ['Grill & Specials', 'Kisinia watu 4-6', '🍽️', 45000, 14000],
    ['Grill & Specials', 'Makange ya Kuku', '🥘', 15000, 5000],
    ['Rice & Chips', 'Chips Kavu', '🍟', 2000, 600],
    ['Rice & Chips', 'Chips Yai', '🍟', 3000, 900],
    ['Rice & Chips', "Biryani Ng'ombe", '🍛', 7000, 2200],
    ['Rice & Chips', 'Biryani Kuku', '🍛', 9000, 2800],
    ['Rice & Chips', 'Nyama Choma Pande', '🥩', 4000, 1300]
  ];
  menuItems.forEach(row => {
    const id = nextId('menu_items');
    db.menu_items.push({
      id, category_id: catId[row[0]], name: row[1], icon: row[2],
      price: row[3], cost_price: row[4], is_available: 1, low_stock: 0, description: ''
    });
  });

  return db;
}

function migrateDB(db) {
  if (!db) return db;
  db.categories = db.categories || [];
  db.menu_items = db.menu_items || [];
  db.orders = db.orders || [];
  db.messages = db.messages || [];
  db.staff = db.staff || [];
  db.settings = db.settings || { vat_enabled: '1', vat_rate: '0.18' };
  db._seq = db._seq || {};
  if (typeof db._seq.categories === 'undefined') db._seq.categories = db.categories.reduce((m, c) => Math.max(m, c.id || 0), 0);
  if (typeof db._seq.menu_items === 'undefined') db._seq.menu_items = db.menu_items.reduce((m, i) => Math.max(m, i.id || 0), 0);
  db.menu_items.forEach(mi => { if (typeof mi.low_stock === 'undefined') mi.low_stock = 0; });
  db.version = 2;
  return db;
}

// ── load / save ──────────────────────────────────────────────────
// Two storage modes:
//  1. MONGODB_URI set  -> permanent storage in MongoDB Atlas (survives
//     restarts/redeploys on Render's free tier, which has no persistent disk).
//  2. MONGODB_URI unset -> local data/data.json file only (fine for running
//     on your own computer, but resets on every Render restart).
// Either way, all business logic below reads/writes the in-memory _DB
// object synchronously — persistence happens underneath, on save.
let _DB = null;
let _mongoCollection = null;
let _mongoClient = null;

async function initStorage() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      _mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
      await _mongoClient.connect();
      _mongoCollection = _mongoClient.db(MONGO_DB_NAME).collection(MONGO_COLLECTION);
      console.log('db: connected to MongoDB — data will persist permanently.');
    } catch (e) {
      console.error('db: could not connect to MongoDB, falling back to local file storage.', e.message);
      _mongoCollection = null;
    }
  } else {
    console.warn('db: MONGODB_URI not set — using local file storage only. ' +
      'On Render\'s free tier this resets on every restart/redeploy. ' +
      'Set MONGODB_URI to a free MongoDB Atlas cluster for permanent storage.');
  }

  if (_mongoCollection) {
    const doc = await _mongoCollection.findOne({ _id: MONGO_DOC_ID });
    if (doc) {
      delete doc._id;
      _DB = migrateDB(doc);
    } else {
      _DB = seedDB();
      await persistToMongo();
    }
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) {
        _DB = migrateDB(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      } else {
        _DB = seedDB();
        saveDB();
      }
    } catch (e) {
      console.error('db: failed to load data.json, reseeding', e);
      _DB = seedDB();
      saveDB();
    }
  }
  return _DB;
}

function loadDB() {
  // By the time any request handler runs, initStorage() has already
  // populated _DB during server startup — this is just a safe getter.
  if (!_DB) _DB = seedDB();
  return _DB;
}

function persistToMongo() {
  if (!_mongoCollection) return Promise.resolve();
  const doc = Object.assign({ _id: MONGO_DOC_ID }, _DB);
  return _mongoCollection.replaceOne({ _id: MONGO_DOC_ID }, doc, { upsert: true })
    .catch(e => console.error('db: MongoDB save failed (will retry on next change):', e.message));
}

function saveDB() {
  // Always keep a local copy too (handy for local dev / as a safety net).
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_DB));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    // Non-fatal: on Render's free tier this still works, it just won't
    // survive a restart. MongoDB (below) is the durable copy.
  }
  // Fire-and-forget durable write. Not awaited so requests stay fast;
  // in-memory _DB is already updated by the caller before saveDB() runs.
  persistToMongo();
}

// ── sessions (in-memory token -> session) ──────────────────────────
const sessions = new Map();
function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const sess = { id: user.id, name: user.full_name, username: user.username, role: user.role };
  sessions.set(token, sess);
  return { token, session: sess };
}
function getSessionByToken(token) { return token ? sessions.get(token) : null; }
function destroySession(token) { sessions.delete(token); }

function requireSession(sess) {
  if (!sess) throw new HttpError(401, 'Unauthorized');
  return sess;
}
function requireRole(sess, ...roles) {
  requireSession(sess);
  if (!roles.includes(sess.role)) throw new HttpError(403, 'Forbidden');
  return sess;
}

// ── lookups ─────────────────────────────────────────────────────────
function findStaff(id) { return loadDB().staff.find(s => s.id === id); }
function findMenuItem(id) { return loadDB().menu_items.find(m => m.id === Number(id)); }
function findOrder(id) { return loadDB().orders.find(o => o.id === id); }

function enrichOrder(o) {
  if (!o) return null;
  const waiter = findStaff(o.waiter_id) || {};
  const items = (o.items || []).map(it => {
    const mi = findMenuItem(it.menu_item_id);
    if (!mi) return null;
    return { id: it.id, order_id: o.id, menu_item_id: it.menu_item_id, quantity: it.quantity,
      unit_price: it.unit_price, line_total: it.line_total, item_name: mi.name, icon: mi.icon };
  }).filter(Boolean);
  const out = Object.assign({}, o);
  out.waiter_name = waiter.full_name;
  out.items = items;
  return out;
}

// ── business logic (ported 1:1 from the offline edition) ───────────
const LOCAL = {};

LOCAL.login = (username, password) => {
  const db = loadDB();
  if (!username || !password) throw new HttpError(400, 'Credentials required');
  const uname = String(username).trim().toLowerCase();
  const user = db.staff.find(s => s.username.toLowerCase() === uname && s.is_active);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) throw new HttpError(401, 'Invalid username or password');
  const { token, session } = createSession(user);
  return { token, user: session };
};

LOCAL.dashboard = (sess) => {
  requireSession(sess);
  const db = loadDB(), today = todayStr();
  const paidToday = db.orders.filter(o => o.status === 'paid' && dateOf(o.created_at) === today);
  const revenue = paidToday.reduce((s, o) => s + o.total_amount, 0);
  const ordersToday = db.orders.filter(o => dateOf(o.created_at) === today).length;
  const active = db.orders.filter(o => o.status !== 'paid' && o.status !== 'cancelled').length;
  const staffCount = db.staff.filter(s => s.is_active).length;

  const salesMap = {};
  db.orders.filter(o => dateOf(o.created_at) === today).forEach(o => {
    (o.items || []).forEach(it => {
      const mi = findMenuItem(it.menu_item_id); if (!mi) return;
      const key = mi.id;
      if (!salesMap[key]) salesMap[key] = { name: mi.name, icon: mi.icon, qty: 0, revenue: 0 };
      salesMap[key].qty += it.quantity; salesMap[key].revenue += it.line_total;
    });
  });
  const bestSelling = Object.values(salesMap).sort((a, b) => b.qty - a.qty).slice(0, 8);

  const recentOrders = db.orders.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10).map(o => { const e = enrichOrder(o); delete e.items; return e; });

  const plateAlerts = db.orders.filter(o => o.plates_taken_at && !o.plates_returned)
    .sort((a, b) => a.plates_taken_at.localeCompare(b.plates_taken_at))
    .map(o => { const waiter = findStaff(o.waiter_id) || {}; const e = Object.assign({}, o); e.waiter_name = waiter.full_name; return e; });

  const lowStockItems = db.menu_items.filter(m => m.low_stock).map(m => ({ id: m.id, name: m.name, icon: m.icon }));

  const waiterStats = db.staff.filter(s => s.role === 'Waiter' && s.is_active).map(s => {
    const todays = db.orders.filter(o => o.waiter_id === s.id && dateOf(o.created_at) === today);
    const durations = todays.filter(o => o.status === 'paid' && o.plates_taken_at)
      .map(o => minutesBetween(o.created_at, o.updated_at)).filter(n => n !== null);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    return { id: s.id, full_name: s.full_name, orders_served: todays.length,
      total_sales: todays.reduce((a, o) => a + o.total_amount, 0), avg_order_minutes: avg };
  }).sort((a, b) => b.total_sales - a.total_sales);

  const todaysReady = db.orders.filter(o => dateOf(o.created_at) === today && o.prep_ready_at);
  const prepDurations = todaysReady.filter(o => o.prep_started_at && o.prep_ready_at)
    .map(o => minutesBetween(o.prep_started_at, o.prep_ready_at));
  const avgPrep = prepDurations.length ? Math.round(prepDurations.reduce((a, b) => a + b, 0) / prepDurations.length) : 0;
  const kitchenStats = db.staff.filter(s => s.role === 'Kitchen' && s.is_active).map(s => ({
    id: s.id, full_name: s.full_name, orders_prepared: todaysReady.length, avg_prep_minutes: avgPrep
  }));

  const approvalsToday = db.orders.filter(o => dateOf(o.updated_at) === today && ['confirmed', 'paid', 'cancelled'].includes(o.status)).length;
  const paymentsToday = db.orders.filter(o => dateOf(o.updated_at) === today && o.status === 'paid').length;
  const cashierStats = db.staff.filter(s => s.role === 'Cashier' && s.is_active).map(s => {
    const plateReturns = db.orders.filter(o => dateOf(o.updated_at) === today && o.plate_return_approved_by === s.id).length;
    return { id: s.id, full_name: s.full_name, approvals_today: approvalsToday, payments_processed: paymentsToday, plate_returns_approved: plateReturns };
  });

  return { revenue, ordersToday, active, staff: staffCount, bestSelling, recentOrders, plateAlerts, lowStockItems,
    roleStats: { waiters: waiterStats, kitchen: kitchenStats, cashiers: cashierStats } };
};

LOCAL.getSettings = (sess) => { requireRole(sess, 'Admin'); return { settings: Object.assign({}, loadDB().settings) }; };
LOCAL.updateSettings = (sess, body) => {
  requireRole(sess, 'Admin');
  const db = loadDB(); body = body || {};
  if (typeof body.vat_enabled !== 'undefined') db.settings.vat_enabled = body.vat_enabled ? '1' : '0';
  if (typeof body.vat_rate !== 'undefined') {
    const rate = parseFloat(body.vat_rate);
    if (isNaN(rate) || rate < 0 || rate > 1) throw new HttpError(400, 'vat_rate must be a decimal between 0 and 1 (e.g. 0.18 for 18%)');
    db.settings.vat_rate = String(rate);
  }
  saveDB();
  return { settings: Object.assign({}, db.settings) };
};

LOCAL.getStaff = (sess) => {
  requireRole(sess, 'Admin');
  return { staff: loadDB().staff.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(s => ({ id: s.id, username: s.username, full_name: s.full_name, role: s.role, is_active: s.is_active, created_at: s.created_at })) };
};
LOCAL.createStaff = (sess, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  const { username, password, full_name, role } = body;
  if (!username || !password || !full_name || !role) throw new HttpError(400, 'All fields required');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
  const db = loadDB(), uname = String(username).toLowerCase();
  if (db.staff.some(s => s.username === uname)) throw new HttpError(409, 'Username already exists');
  const id = uuid(), salt = genSalt();
  db.staff.push({ id, username: uname, password_hash: hashPassword(password, salt), salt,
    full_name, role, is_active: 1, created_at: nowISO() });
  saveDB();
  return { ok: true, id };
};
LOCAL.updateStaff = (sess, id, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  const s = findStaff(id);
  if (s) {
    if (body.full_name) s.full_name = body.full_name;
    if (body.role && ROLES.includes(body.role)) s.role = body.role;
    if (typeof body.is_active !== 'undefined') s.is_active = body.is_active ? 1 : 0;
    if (body.password) { s.salt = genSalt(); s.password_hash = hashPassword(body.password, s.salt); }
    saveDB();
  }
  return { ok: true };
};
LOCAL.deleteStaff = (sess, id) => {
  requireRole(sess, 'Admin');
  if (id === sess.id) throw new HttpError(400, 'Cannot delete yourself');
  const s = findStaff(id);
  if (s) { s.is_active = 0; saveDB(); }
  return { ok: true };
};
LOCAL.getRoles = (sess) => { requireSession(sess); return { roles: ROLES.map((n, i) => ({ id: i + 1, name: n })) }; };

LOCAL.getWaiterAvailability = (sess) => {
  requireRole(sess, 'Cashier', 'Admin');
  const db = loadDB(), today = todayStr();
  const waiters = db.staff.filter(s => s.role === 'Waiter' && s.is_active).map(s => {
    const mine = db.orders.filter(o => o.waiter_id === s.id);
    const active = mine.filter(o => o.status !== 'paid' && o.status !== 'cancelled').length;
    const todays = mine.filter(o => dateOf(o.created_at) === today);
    const salesToday = todays.filter(o => o.status === 'paid').reduce((a, o) => a + o.total_amount, 0);
    const lastOrderAt = mine.reduce((m, o) => (!m || o.created_at > m) ? o.created_at : m, null);
    return { id: s.id, full_name: s.full_name, active_orders: active, orders_today: todays.length, sales_today: salesToday, last_order_at: lastOrderAt };
  }).sort((a, b) => a.active_orders - b.active_orders || a.full_name.localeCompare(b.full_name));
  return { waiters };
};

LOCAL.getReports = (sess, from, to) => {
  requireRole(sess, 'Admin', 'Cashier');
  const today = todayStr();
  const f = from || today, t = to || today;
  const db = loadDB();
  const inRange = db.orders.filter(o => o.status === 'paid' && dateOf(o.created_at) >= f && dateOf(o.created_at) <= t);
  const summary = { total_orders: inRange.length,
    revenue: inRange.reduce((a, o) => a + o.total_amount, 0),
    subtotal: inRange.reduce((a, o) => a + o.subtotal, 0),
    tax: inRange.reduce((a, o) => a + o.tax_amount, 0) };
  const byMethodMap = {};
  inRange.forEach(o => {
    const m = o.payment_method || null;
    if (!byMethodMap[m]) byMethodMap[m] = { payment_method: m, cnt: 0, total: 0 };
    byMethodMap[m].cnt++; byMethodMap[m].total += o.total_amount;
  });
  const dailyMap = {};
  inRange.forEach(o => {
    const d = dateOf(o.created_at);
    if (!dailyMap[d]) dailyMap[d] = { day: d, orders: 0, revenue: 0 };
    dailyMap[d].orders++; dailyMap[d].revenue += o.total_amount;
  });
  const daily = Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day));
  return { summary, byMethod: Object.values(byMethodMap), daily };
};

LOCAL.getMenu = (sess) => {
  requireSession(sess);
  const db = loadDB();
  const items = db.menu_items.map(mi => {
    const c = db.categories.find(c => c.id === mi.category_id) || {};
    return Object.assign({}, mi, { category_name: c.name, cat_icon: c.icon, _sort: c.sort_order || 0 });
  }).sort((a, b) => a._sort - b._sort || a.name.localeCompare(b.name));
  items.forEach(i => delete i._sort);
  return { items };
};
LOCAL.getCats = (sess) => { requireSession(sess); return { categories: loadDB().categories.slice().sort((a, b) => a.sort_order - b.sort_order) }; };
LOCAL.addCat = (sess, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  if (!body.name) throw new HttpError(400, 'Name required');
  const db = loadDB();
  db._seq.categories += 1;
  const id = db._seq.categories;
  db.categories.push({ id, name: body.name, icon: body.icon || '🍽️', sort_order: db.categories.length });
  saveDB();
  return { ok: true, id };
};
LOCAL.createMenu = (sess, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  if (!body.category_id || !body.name || !body.price) throw new HttpError(400, 'Required fields missing');
  const db = loadDB();
  db._seq.menu_items += 1;
  const id = db._seq.menu_items;
  db.menu_items.push({ id, category_id: Number(body.category_id), name: body.name, icon: body.icon || '🍽️',
    price: Number(body.price), cost_price: Number(body.cost_price) || 0, is_available: 1, low_stock: 0, description: body.description || '' });
  saveDB();
  return { ok: true, id };
};
LOCAL.updateMenu = (sess, id, body) => {
  requireRole(sess, ...MENU_MANAGE_ROLES);
  body = body || {};
  const mi = findMenuItem(id);
  let changed = null;
  if (mi) {
    if (typeof body.is_available !== 'undefined') mi.is_available = body.is_available ? 1 : 0;
    if (typeof body.low_stock !== 'undefined') mi.low_stock = body.low_stock ? 1 : 0;
    if (body.name) mi.name = body.name;
    if (body.price) mi.price = Number(body.price);
    if (body.cost_price) mi.cost_price = Number(body.cost_price);
    if (body.icon) mi.icon = body.icon;
    if (body.category_id) mi.category_id = Number(body.category_id);
    if (body.description) mi.description = body.description;
    saveDB();
    changed = mi;
  }
  return { ok: true, _item: changed };
};
LOCAL.deleteMenu = (sess, id) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  db.menu_items = db.menu_items.filter(m => m.id !== Number(id));
  saveDB();
  return { ok: true };
};

LOCAL.getOrders = (sess, query) => {
  requireSession(sess);
  query = query || {};
  const db = loadDB();
  let list = db.orders.slice();
  if (sess.role === 'Waiter') list = list.filter(o => o.waiter_id === sess.id);
  else if (query.waiter_id) list = list.filter(o => o.waiter_id === query.waiter_id);
  if (query.status) {
    const statuses = String(query.status).split(',').map(s => s.trim());
    list = list.filter(o => statuses.includes(o.status));
  }
  list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { orders: list.map(enrichOrder) };
};
LOCAL.getOrder = (sess, id) => {
  requireSession(sess);
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  return { order: enrichOrder(o) };
};
LOCAL.createOrder = (sess, body) => {
  requireRole(sess, 'Waiter', 'Cashier', 'Admin');
  body = body || {};
  const { items, notes, waiter_id } = body;
  if (!items || !items.length) throw new HttpError(400, 'At least one item is required');
  const db = loadDB();

  const orderId = uuid();
  const orderNum = 'ORD-' + Date.now().toString().slice(-6);
  let subtotal = 0;
  const assignedWaiter = ((sess.role === 'Cashier' || sess.role === 'Admin') && waiter_id) ? waiter_id : sess.id;

  const resolvedItems = items.map(item => {
    const mi = findMenuItem(item.menu_item_id);
    if (!mi || !mi.is_available) throw new HttpError(400, 'Item ' + item.menu_item_id + ' is not available');
    const lineTotal = mi.price * item.quantity;
    subtotal += lineTotal;
    return { menu_item_id: mi.id, quantity: item.quantity, unit_price: mi.price, line_total: lineTotal };
  });

  const vatEnabled = db.settings.vat_enabled ? db.settings.vat_enabled === '1' : true;
  const vatRate = db.settings.vat_rate ? parseFloat(db.settings.vat_rate) : 0.18;
  const tax = vatEnabled ? round2(subtotal * vatRate) : 0;
  const total = round2(subtotal + tax);
  const initialStatus = (sess.role === 'Cashier' || sess.role === 'Admin') ? 'confirmed' : 'pending_payment';
  const now = nowISO();

  db.orders.push({
    id: orderId, order_number: orderNum, waiter_id: assignedWaiter,
    status: initialStatus, payment_method: null, subtotal, tax_amount: tax, total_amount: total,
    notes: notes || '', plates_taken_at: null, plates_returned: 0, plates_returned_at: null,
    plate_return_approved_by: null, created_at: now, updated_at: now,
    prep_started_at: null, prep_ready_at: null, vat_applied: vatEnabled ? 1 : 0, items: resolvedItems
  });
  saveDB();

  const full = enrichOrder(findOrder(orderId));
  return { ok: true, order: full, _event: initialStatus === 'confirmed' ? 'order:approved' : 'order:new' };
};
LOCAL.approveOrder = (sess, id) => {
  requireRole(sess, 'Cashier', 'Admin');
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  if (o.status !== 'pending_payment') throw new HttpError(400, 'Order is not pending payment');
  o.status = 'confirmed'; o.updated_at = nowISO();
  saveDB();
  return { ok: true, order: enrichOrder(o) };
};
LOCAL.setStatus = (sess, id, status, payment_method) => {
  requireSession(sess);
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  const allowed = {
    Admin: ['confirmed', 'preparing', 'ready', 'served', 'paid', 'cancelled'],
    Cashier: ['paid', 'cancelled'],
    Kitchen: ['preparing', 'ready'],
    Waiter: ['served']
  };
  if (!(allowed[sess.role] || []).includes(status)) throw new HttpError(403, 'Cannot set this status');
  o.status = status; o.updated_at = nowISO();
  if (payment_method) o.payment_method = payment_method;
  if (status === 'preparing' && !o.prep_started_at) o.prep_started_at = nowISO();
  if (status === 'ready' && !o.prep_ready_at) o.prep_ready_at = nowISO();
  saveDB();
  return { ok: true, order: enrichOrder(o) };
};
LOCAL.platesTaken = (sess, id) => {
  requireRole(sess, 'Waiter', 'Admin');
  const o = findOrder(id);
  if (o) { o.plates_taken_at = nowISO(); o.updated_at = nowISO(); saveDB(); }
  return { ok: true, order: enrichOrder(o) };
};
LOCAL.platesReturned = (sess, id) => {
  requireRole(sess, 'Cashier', 'Admin');
  const o = findOrder(id);
  if (o) { o.plates_returned = 1; o.plates_returned_at = nowISO(); o.plate_return_approved_by = sess.id; o.updated_at = nowISO(); saveDB(); }
  return { ok: true, order: enrichOrder(o) };
};

LOCAL.getMessages = (sess) => {
  requireSession(sess);
  const msgs = loadDB().messages.filter(m =>
    m.sender_id === sess.id || m.target_staff_id === sess.id || m.target_role === sess.role || m.target_role === 'ALL'
  ).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100);
  return { messages: msgs };
};
LOCAL.getUnread = (sess) => {
  requireSession(sess);
  const cnt = loadDB().messages.filter(m =>
    (m.target_staff_id === sess.id || m.target_role === sess.role || m.target_role === 'ALL') && m.sender_id !== sess.id && !m.is_read
  ).length;
  return { count: cnt };
};
LOCAL.getStaffList = (sess) => {
  requireSession(sess);
  const staff = loadDB().staff.filter(s => s.is_active && s.id !== sess.id)
    .sort((a, b) => a.role.localeCompare(b.role) || a.full_name.localeCompare(b.full_name))
    .map(s => ({ id: s.id, full_name: s.full_name, role: s.role }));
  return { staff };
};
LOCAL.sendMsg = (sess, body) => {
  requireSession(sess);
  body = body || {};
  if (!body.body || !body.body.trim()) throw new HttpError(400, 'Message body required');
  if (!body.target_staff_id && !body.target_role) throw new HttpError(400, 'Provide a target');
  if (body.target_role && body.target_role !== 'Admin' && sess.role !== 'Admin') throw new HttpError(403, 'Staff can only message Admin or individuals');
  const db = loadDB();
  const msg = { id: uuid(), sender_id: sess.id, sender_name: sess.name, sender_role: sess.role,
    target_staff_id: body.target_staff_id || null, target_role: body.target_role || null,
    subject: body.subject || null, body: body.body.trim(), is_read: 0, created_at: nowISO() };
  db.messages.push(msg);
  saveDB();
  return { ok: true, message: msg };
};
LOCAL.markAllRead = (sess) => {
  requireSession(sess);
  loadDB().messages.forEach(m => {
    if ((m.target_staff_id === sess.id || m.target_role === sess.role || m.target_role === 'ALL') && m.sender_id !== sess.id) m.is_read = 1;
  });
  saveDB();
  return { ok: true };
};

LOCAL.exportBackup = (sess) => { requireSession(sess); return loadDB(); };
LOCAL.importBackup = (sess, parsed) => {
  requireRole(sess, 'Admin');
  if (!parsed || !Array.isArray(parsed.staff) || !Array.isArray(parsed.orders)) throw new HttpError(400, 'That file does not look like a valid Ottoman Bey backup.');
  _DB = migrateDB(parsed);
  saveDB();
  return { ok: true };
};

module.exports = {
  initStorage, loadDB, saveDB, LOCAL, HttpError,
  getSessionByToken, destroySession, requireSession
};
