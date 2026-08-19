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
function normName(s) { return String(s || '').trim().toLowerCase(); }

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
    version: 3,
    staff: [],
    categories: [],
    menu_items: [],
    orders: [],
    attendance: [],
    expenses: [],
    stock_log: [],
    stock_audits: [],
    settings: { lipa_namba: '' },
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
      price: row[3], cost_price: row[4] || 0, is_available: 0, stock_count: 0, stock_date: null, description: ''
    });
  });

  return db;
}

function migrateDB(db) {
  if (!db) return db;
  db.categories = db.categories || [];
  db.menu_items = db.menu_items || [];
  db.orders = db.orders || [];
  delete db.messages; // old unused direct-messages feature, fully removed
  db.staff = db.staff || [];
  db.settings = db.settings || { lipa_namba: '' };
  if (typeof db.settings.lipa_namba === 'undefined') db.settings.lipa_namba = '';
  delete db.settings.vat_enabled;
  delete db.settings.vat_rate;
  delete db.settings.quick_sale_enabled; // legacy toggle removed — access is Cashier-login-gated now
  db.attendance = db.attendance || [];
  db.chat = db.chat || [];
  db.sessions = db.sessions || {}; // token -> session, persisted so a server restart doesn't log everyone out mid-shift
  db.expenses = db.expenses || [];
  db.stock_log = db.stock_log || [];
  db.stock_audits = db.stock_audits || [];
  db._seq = db._seq || {};
  if (typeof db._seq.categories === 'undefined') db._seq.categories = db.categories.reduce((m, c) => Math.max(m, c.id || 0), 0);
  if (typeof db._seq.menu_items === 'undefined') db._seq.menu_items = db.menu_items.reduce((m, i) => Math.max(m, i.id || 0), 0);
  db.menu_items.forEach(mi => {
    if (typeof mi.stock_count === 'undefined') mi.stock_count = 0;
    if (typeof mi.stock_date === 'undefined') mi.stock_date = null;
    if (typeof mi.cost_price === 'undefined') mi.cost_price = 0;
    delete mi.low_stock;
  });
  db.version = 4;
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

let _mongoRetryTimer = null;
let _lastMongoError = null;
function persistToMongo() {
  if (!_mongoCollection) return Promise.resolve();
  const doc = Object.assign({ _id: MONGO_DOC_ID }, _DB);
  return _mongoCollection.replaceOne({ _id: MONGO_DOC_ID }, doc, { upsert: true })
    .then(() => { _lastMongoError = null; })
    .catch(e => {
      // Don't just log and drop it — a failed write here (network blip,
      // Atlas hiccup) means the latest changes only exist in memory. Keep
      // retrying every 5s until it succeeds, so a Render restart in that
      // window is the only way to actually lose data.
      _lastMongoError = e.message;
      console.error('db: MongoDB save failed, retrying in 5s:', e.message);
      if (_mongoRetryTimer) clearTimeout(_mongoRetryTimer);
      _mongoRetryTimer = setTimeout(() => persistToMongo(), 5000);
    });
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

// ── sessions ─────────────────────────────────────────────────────────
// Kept in an in-memory Map for fast lookup on every request, AND mirrored
// into the durable _DB (Mongo/local file) so that a server restart —
// which happens often on Render's free tier (idle spin-down, redeploys) —
// does NOT silently log every staff member out mid-shift. On boot, the
// Map is rehydrated from the last saved sessions.
const sessions = new Map();
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const sess = { id: user.id, name: user.full_name, username: user.username, role: user.role };
  sessions.set(token, sess);
  const db = loadDB();
  db.sessions = db.sessions || {};
  db.sessions[token] = Object.assign({ created_at: nowISO() }, sess);
  // Opportunistic cleanup: drop sessions older than 30 days so this doesn't
  // grow forever with daily logins on shared devices.
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  Object.keys(db.sessions).forEach(t => {
    const s = db.sessions[t];
    if (s && s.created_at && Date.parse(s.created_at) < cutoff) delete db.sessions[t];
  });
  saveDB();
  return { token, session: sess };
}
function getSessionByToken(token) {
  if (!token) return null;
  if (sessions.has(token)) return sessions.get(token);
  // Not in memory (e.g. right after a restart) — check the durable copy
  // and rehydrate the in-memory Map so subsequent lookups are fast.
  const db = loadDB();
  const sess = db.sessions && db.sessions[token];
  if (sess) { sessions.set(token, sess); return sess; }
  return null;
}
function destroySession(token) {
  sessions.delete(token);
  const db = loadDB();
  if (db.sessions && db.sessions[token]) { delete db.sessions[token]; saveDB(); }
}

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

function enrichOrder(o, sess) {
  if (!o) return null;
  const waiter = findStaff(o.waiter_id) || {};
  // Cost/profit margins are sensitive — only Admin and Cashier ever see them.
  // Waiter and Kitchen get the same order data they always did, unchanged.
  const canSeeCost = !!sess && (sess.role === 'Admin' || sess.role === 'Cashier');
  const items = (o.items || []).map(it => {
    const mi = it.menu_item_id ? findMenuItem(it.menu_item_id) : null;
    const line = { id: it.id, order_id: o.id, menu_item_id: it.menu_item_id || null, quantity: it.quantity,
      unit_price: it.unit_price, line_total: it.line_total,
      item_name: it.item_name || (mi && mi.name) || 'Kipengele',
      icon: it.icon || (mi && mi.icon) || '🍽️' };
    if (canSeeCost) { line.unit_cost = it.unit_cost || 0; line.line_cost = it.line_cost || 0; }
    return line;
  });
  const out = Object.assign({}, o);
  out.waiter_name = waiter.full_name;
  out.items = items;
  if (!canSeeCost) { delete out.cost_amount; delete out.profit_amount; }
  return out;
}

// ── business logic (ported 1:1 from the offline edition) ───────────
// ── Chef-prepared vs Quick-Sale-sold reconciliation helpers ─────────
// "Prepared" quantity for a given day = sum of the deltas Kitchen logged
// via postStock that day (new_count - previous_count each time they post).
function preparedQtyForDate(db, menuItemId, date) {
  return db.stock_log
    .filter(l => l.type === 'prepared' && l.menu_item_id === menuItemId && dateOf(l.created_at) === date)
    .reduce((sum, l) => sum + (l.new_count - l.previous_count), 0);
}
// Quick Sale has no menu_item_id link (it's free-text), so we match by
// name (case/whitespace-insensitive) against paid Quick Sale line items.
function quickSoldQtyForName(db, nameLower, date) {
  return db.orders
    .filter(o => o.status === 'paid' && dateOf(o.created_at) === date)
    .reduce((sum, o) => sum + (o.items || [])
      .filter(it => it.menu_item_id === null && normName(it.item_name) === nameLower)
      .reduce((s, it) => s + it.quantity, 0), 0);
}

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
  const active = db.orders.filter(o => o.status !== 'paid' && o.status !== 'cancelled' && dateOf(o.created_at) === today).length;
  const staffCount = db.staff.filter(s => s.is_active).length;

  const salesMap = {};
  db.orders.filter(o => dateOf(o.created_at) === today).forEach(o => {
    (o.items || []).forEach(it => {
      const mi = it.menu_item_id ? findMenuItem(it.menu_item_id) : null;
      // Quick Sale items have no menu_item_id (free-text entry), so key on
      // the item name instead of skipping them — otherwise Quick Sale
      // never shows up in Best Selling even though it's real revenue.
      const key = mi ? mi.id : 'qs:' + (it.item_name || '').trim().toLowerCase();
      if (!key || key === 'qs:') return;
      if (!salesMap[key]) salesMap[key] = { name: mi ? mi.name : (it.item_name || 'Kipengele'), icon: mi ? mi.icon : (it.icon || '🍽️'), qty: 0, revenue: 0 };
      salesMap[key].qty += it.quantity; salesMap[key].revenue += it.line_total;
    });
  });
  const bestSelling = Object.values(salesMap).sort((a, b) => b.qty - a.qty).slice(0, 8);

  const recentOrders = db.orders.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10).map(o => { const e = enrichOrder(o, sess); delete e.items; return e; });

  const plateAlerts = db.orders.filter(o => o.plates_taken_at && !o.plates_returned)
    .sort((a, b) => a.plates_taken_at.localeCompare(b.plates_taken_at))
    .map(o => { const waiter = findStaff(o.waiter_id) || {}; const e = Object.assign({}, o); e.waiter_name = waiter.full_name; return e; });

  const outOfStockItems = db.menu_items.filter(m => m.stock_date === today && m.stock_count <= 0).map(m => ({ id: m.id, name: m.name, icon: m.icon }));

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
    const myOrders = db.orders.filter(o => o.cashier_id === s.id && dateOf(o.created_at) === today);
    const myPaid = myOrders.filter(o => o.status === 'paid');
    const myRevenue = myPaid.reduce((sum, o) => sum + o.total_amount, 0);
    const myApprovals = db.orders.filter(o => o.cashier_id === s.id && dateOf(o.updated_at) === today).length;
    const plateReturns = db.orders.filter(o => dateOf(o.updated_at) === today && o.plate_return_approved_by === s.id).length;
    return {
      id: s.id,
      full_name: s.full_name,
      approvals_today: myApprovals,
      payments_processed: myPaid.length,
      revenue_today: myRevenue,
      plate_returns_approved: plateReturns
    };
  });

  return { revenue, ordersToday, active, staff: staffCount, bestSelling, recentOrders, plateAlerts, outOfStockItems,
    roleStats: { waiters: waiterStats, kitchen: kitchenStats, cashiers: cashierStats } };
};

LOCAL.getSettings = (sess) => { requireRole(sess, 'Admin', 'Cashier'); return { settings: Object.assign({}, loadDB().settings) }; };
LOCAL.updateSettings = (sess, body) => {
  requireRole(sess, 'Admin');
  const db = loadDB(); body = body || {};
  if (typeof body.lipa_namba !== 'undefined') db.settings.lipa_namba = String(body.lipa_namba).trim();
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
  const db = loadDB();
  const idx = db.staff.findIndex(s => s.id === id);
  if (idx !== -1) { db.staff.splice(idx, 1); saveDB(); }
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
  let inRange = db.orders.filter(o => o.status === 'paid' && dateOf(o.created_at) >= f && dateOf(o.created_at) <= t);
  // Each cashier sees only the orders THEY personally processed (their own till).
  // Admin sees every order from every cashier, so nothing is hidden from management.
  if (sess.role === 'Cashier') inRange = inRange.filter(o => o.cashier_id === sess.id);
  const costTotal = round2(inRange.reduce((a, o) => a + (o.cost_amount || 0), 0));
  const revenueTotal = round2(inRange.reduce((a, o) => a + o.total_amount, 0));
  const expensesInRange = (sess.role === 'Cashier'
    ? db.expenses.filter(e => e.recorded_by === sess.id)
    : db.expenses.slice()
  ).filter(e => e.date >= f && e.date <= t);
  const expensesTotal = round2(expensesInRange.reduce((a, e) => a + e.amount, 0));
  const summary = { total_orders: inRange.length,
    revenue: revenueTotal,
    subtotal: inRange.reduce((a, o) => a + o.subtotal, 0),
    tax: inRange.reduce((a, o) => a + o.tax_amount, 0),
    cost_of_goods: costTotal,
    gross_profit: round2(revenueTotal - costTotal),
    expenses: expensesTotal,
    net_profit: round2(revenueTotal - costTotal - expensesTotal),
    net_balance: round2(revenueTotal - expensesTotal) };
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
  // Full order-by-order log — date, time, payment method, amount, and which
  // cashier handled it — so Admin can see every transaction in detail.
  const orders = inRange.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(o => ({
    id: o.id,
    order_number: o.order_number,
    table_number: o.table_number,
    date: dateOf(o.updated_at || o.created_at),
    paid_at: o.updated_at || o.created_at,
    payment_method: o.payment_method || null,
    amount: o.total_amount,
    cashier_id: o.cashier_id || null,
    cashier_name: o.cashier_name || null,
    items: (o.items || []).map(it => {
      const mi = it.menu_item_id ? findMenuItem(it.menu_item_id) : null;
      return { name: it.item_name || (mi && mi.name) || 'Kipengele', quantity: it.quantity, icon: it.icon || (mi && mi.icon) || '🍽️' };
    })
  }));
  // Cancelled orders in range — kept as a separate log (not counted toward
  // revenue) so cleared/cancelled orders remain visible and searchable.
  let cancelledInRange = db.orders.filter(o => o.status === 'cancelled' && dateOf(o.updated_at || o.created_at) >= f && dateOf(o.updated_at || o.created_at) <= t);
  if (sess.role === 'Cashier') cancelledInRange = cancelledInRange.filter(o => o.cashier_id === sess.id);
  const cancelled = cancelledInRange.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(o => ({
    id: o.id,
    order_number: o.order_number,
    table_number: o.table_number,
    date: dateOf(o.updated_at || o.created_at),
    cancelled_at: o.updated_at || o.created_at,
    amount: o.total_amount,
    waiter_id: o.waiter_id || null,
    cashier_id: o.cashier_id || null,
    cashier_name: o.cashier_name || null,
    items: (o.items || []).map(it => {
      const mi = it.menu_item_id ? findMenuItem(it.menu_item_id) : null;
      return { name: it.item_name || (mi && mi.name) || 'Kipengele', quantity: it.quantity, icon: it.icon || (mi && mi.icon) || '🍽️' };
    })
  }));
  return { summary, byMethod: Object.values(byMethodMap), daily, orders, cancelled };
};

LOCAL.getMenu = (sess) => {
  requireSession(sess);
  const db = loadDB(), today = todayStr();
  const canSeeCost = sess.role === 'Admin' || sess.role === 'Cashier';
  const items = db.menu_items.map(mi => {
    const c = db.categories.find(c => c.id === mi.category_id) || {};
    const postedToday = mi.stock_date === today;
    const stock = postedToday ? mi.stock_count : 0;
    const out = Object.assign({}, mi, {
      category_name: c.name, cat_icon: c.icon, _sort: c.sort_order || 0,
      stock, posted_today: postedToday, is_available: stock > 0 ? 1 : 0
    });
    if (!canSeeCost) delete out.cost_price;
    return out;
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
    price: Number(body.price), cost_price: Number(body.cost_price) || 0,
    is_available: 0, stock_count: 0, stock_date: null, description: body.description || '' });
  saveDB();
  return { ok: true, id };
};
LOCAL.updateMenu = (sess, id, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  const mi = findMenuItem(id);
  let changed = null;
  if (mi) {
    if (body.name) mi.name = body.name;
    if (body.price) mi.price = Number(body.price);
    if (typeof body.cost_price !== 'undefined') mi.cost_price = Number(body.cost_price) || 0;
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
// Kitchen posts today's available quantity for a dish each morning (and any
// time during the day) — e.g. "Pilau, 15 servings ready". Stock counts down
// automatically as orders are placed, and resets to 0/unposted the next day
// until Kitchen posts it again.
LOCAL.postStock = (sess, id, count) => {
  requireRole(sess, 'Kitchen', 'Admin');
  const mi = findMenuItem(id);
  if (!mi) throw new HttpError(404, 'Not found');
  const n = Number(count);
  if (isNaN(n) || n < 0) throw new HttpError(400, 'Idadi si sahihi');
  const db = loadDB();
  const previous = mi.stock_date === todayStr() ? mi.stock_count : 0;
  mi.stock_count = Math.trunc(n);
  mi.stock_date = todayStr();
  mi.is_available = mi.stock_count > 0 ? 1 : 0;
  // Audit trail: every time Kitchen posts a count, log the before/after so
  // Admin can later trace exactly when and by whom stock was set.
  db.stock_log.push({
    id: uuid(), menu_item_id: mi.id, item_name: mi.name, type: 'prepared',
    previous_count: previous, new_count: mi.stock_count,
    staff_id: sess.id, staff_name: sess.name, role: sess.role, created_at: nowISO()
  });
  saveDB();
  const c = loadDB().categories.find(c => c.id === mi.category_id) || {};
  return { ok: true, item: Object.assign({}, mi, { category_name: c.name, cat_icon: c.icon, stock: mi.stock_count, posted_today: true }) };
};

// ── reset (Admin button: wipe orders + attendance history, keep
// staff accounts/passwords, menu, categories, chat, and settings) ────
LOCAL.resetOperationalData = (sess) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  const ordersCleared = db.orders.length;
  const attendanceCleared = db.attendance.length;
  db.orders = [];
  db.attendance = [];
  saveDB();
  return { ok: true, orders_cleared: ordersCleared, attendance_cleared: attendanceCleared };
};

// ── clear active orders + plate alerts (Admin button: cancels every
// order that is not already paid/cancelled, and marks every open plate
// alert as returned. Paid orders, sales history, staff accounts, menu,
// and attendance are all left untouched — this is a lighter-weight
// "start the floor clean" action than the full data reset above) ─────
LOCAL.clearActiveOrders = (sess) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  const now = nowISO();
  let ordersCleared = 0, platesCleared = 0;
  db.orders.forEach(o => {
    if (o.status !== 'paid' && o.status !== 'cancelled') {
      o.status = 'cancelled';
      o.updated_at = now;
      ordersCleared++;
    }
    if (o.plates_taken_at && !o.plates_returned) {
      o.plates_returned = 1;
      o.plates_returned_at = now;
      o.plate_return_approved_by = sess.id;
      platesCleared++;
    }
  });
  saveDB();
  return { ok: true, orders_cleared: ordersCleared, plates_cleared: platesCleared };
};

LOCAL.getOrders = (sess, query) => {
  requireSession(sess);
  query = query || {};
  const db = loadDB();
  let list = db.orders.slice();

  if (sess.role === 'Waiter') {
    // Waiter sees only their own orders
    list = list.filter(o => o.waiter_id === sess.id);
  } else if (sess.role === 'Cashier') {
    // Each cashier is independent:
    // - ALL cashiers see pending_payment orders (so any cashier can approve incoming orders)
    // - Once approved/paid, each cashier sees only orders THEY handled (cashier_id = their id)
    // - Plate alerts: cashier sees plates they are responsible for
    list = list.filter(o =>
      o.status === 'pending_payment' ||           // any cashier can approve new orders
      o.cashier_id === sess.id ||                  // orders this cashier approved or paid
      (!o.cashier_id && o.status !== 'paid' && o.status !== 'cancelled') || // safety net: orders from before the cashier_id fix, or any other edge case that left it unset — don't let them vanish, show to any cashier
      (o.plates_taken_at && !o.plates_returned && o.cashier_id === sess.id) // their plate alerts
    );
  } else if (query.waiter_id) {
    list = list.filter(o => o.waiter_id === query.waiter_id);
  }

  if (query.status) {
    const statuses = String(query.status).split(',').map(s => s.trim());
    list = list.filter(o => statuses.includes(o.status));
  }
  list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { orders: list.map(o => enrichOrder(o, sess)) };
};
LOCAL.getOrder = (sess, id) => {
  requireSession(sess);
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  return { order: enrichOrder(o, sess) };
};
LOCAL.createOrder = (sess, body) => {
  requireRole(sess, 'Waiter', 'Cashier', 'Admin');
  body = body || {};
  const { items, notes, waiter_id, table_number } = body;
  if (!items || !items.length) throw new HttpError(400, 'At least one item is required');
  const db = loadDB(), today = todayStr();

  let tableNo = null;
  if (table_number !== undefined && table_number !== null && table_number !== '') {
    tableNo = Number(table_number);
    if (!Number.isInteger(tableNo) || tableNo < 1 || tableNo > 20) throw new HttpError(400, 'Namba ya meza lazima iwe kati ya 1 na 20');
  }

  const orderId = uuid();
  const orderNum = 'ORD-' + Date.now().toString().slice(-6);
  let subtotal = 0;
  const assignedWaiter = ((sess.role === 'Cashier' || sess.role === 'Admin') && waiter_id) ? waiter_id : sess.id;

  // Validate stock availability for every line first (so a failed order
  // doesn't partially decrement some items).
  const grouped = {};
  items.forEach(item => {
    grouped[item.menu_item_id] = (grouped[item.menu_item_id] || 0) + Number(item.quantity);
  });
  Object.keys(grouped).forEach(menuItemId => {
    const mi = findMenuItem(menuItemId);
    if (!mi) throw new HttpError(400, 'Kipengele hakipatikani');
    const postedToday = mi.stock_date === today;
    const available = postedToday ? mi.stock_count : 0;
    if (!available || available < grouped[menuItemId]) {
      throw new HttpError(400, mi.name + ' hazitoshi (zilizobaki: ' + (available || 0) + ')');
    }
  });

  let costSubtotal = 0;
  const resolvedItems = items.map(item => {
    const mi = findMenuItem(item.menu_item_id);
    const lineTotal = mi.price * item.quantity;
    // Snapshot the ingredient cost NOW, at the moment of sale — if Admin
    // edits cost_price tomorrow, today's already-sold orders keep the
    // margin that was actually true when they were sold.
    const unitCost = Number(mi.cost_price) || 0;
    const lineCost = round2(unitCost * item.quantity);
    subtotal += lineTotal;
    costSubtotal += lineCost;
    return { menu_item_id: mi.id, quantity: item.quantity, unit_price: mi.price, line_total: lineTotal,
      unit_cost: unitCost, line_cost: lineCost };
  });
  // Decrement stock now that every line has passed validation.
  Object.keys(grouped).forEach(menuItemId => {
    const mi = findMenuItem(menuItemId);
    mi.stock_count = Math.max(0, mi.stock_count - grouped[menuItemId]);
  });

  const total = round2(subtotal);
  const costAmount = round2(costSubtotal);
  const initialStatus = (sess.role === 'Cashier' || sess.role === 'Admin') ? 'confirmed' : 'pending_payment';
  const now = nowISO();

  db.orders.push({
    id: orderId, order_number: orderNum, waiter_id: assignedWaiter, table_number: tableNo,
    status: initialStatus, payment_method: null, subtotal, tax_amount: 0, total_amount: total,
    cost_amount: costAmount, profit_amount: round2(total - costAmount),
    notes: notes || '', plates_taken_at: null, plates_returned: 0, plates_returned_at: null,
    plate_return_approved_by: null, created_at: now, updated_at: now,
    prep_started_at: null, prep_ready_at: null, items: resolvedItems,
    // BUG FIX: orders a Cashier creates directly (skipping pending_payment/
    // approve) never got cashier_id set, so getOrders' Cashier-visibility
    // filter (status==='pending_payment' || cashier_id===sess.id) silently
    // dropped them the moment status moved past 'confirmed' — the order
    // would vanish from that cashier's screen forever, even after refresh.
    cashier_id: sess.role === 'Cashier' ? sess.id : null,
    cashier_name: sess.role === 'Cashier' ? sess.name : null
  });
  saveDB();

  const full = enrichOrder(findOrder(orderId), sess);
  return { ok: true, order: full, _event: initialStatus === 'confirmed' ? 'order:approved' : 'order:new' };
};
// ── quick sale (standalone simple cashier till) ─────────────────────
// One-step sale, fully independent from the kitchen/menu/stock/table
// system. Cashier just types what was sold + price and taps which
// waiter served it. No stock is touched, no menu item is required —
// this is a free-form sales log, not a kitchen order. Cashier-only.
LOCAL.quickSale = (sess, body) => {
  requireRole(sess, 'Cashier');
  body = body || {};
  const { items, waiter_id, payment_method } = body;
  if (!items || !items.length) throw new HttpError(400, 'Ongeza angalau chakula kimoja');
  if (!waiter_id) throw new HttpError(400, 'Chagua mhudumu (waiter)');
  const waiter = findStaff(waiter_id);
  if (!waiter || waiter.role !== 'Waiter' || !waiter.is_active) throw new HttpError(400, 'Mhudumu si sahihi');
  const validMethods = ['cash', 'card', 'mpesa', 'tigopesa', 'airtelmoney', 'bank'];
  if (!validMethods.includes(payment_method)) throw new HttpError(400, 'Chagua njia ya malipo');

  const db = loadDB();
  let subtotal = 0;
  const resolvedItems = items.map(item => {
    const name = String(item.name || '').trim();
    const qty = Number(item.quantity);
    const price = Number(item.price);
    if (!name) throw new HttpError(400, 'Andika jina la chakula');
    if (!qty || qty <= 0) throw new HttpError(400, 'Idadi si sahihi kwa ' + name);
    if (isNaN(price) || price < 0) throw new HttpError(400, 'Bei si sahihi kwa ' + name);
    const lineTotal = round2(price * qty);
    subtotal += lineTotal;
    return { menu_item_id: null, quantity: qty, unit_price: price, line_total: lineTotal, item_name: name, icon: '🍽️' };
  });

  const orderId = uuid();
  const orderNum = 'ORD-' + Date.now().toString().slice(-6);
  const total = round2(subtotal);
  const now = nowISO();

  db.orders.push({
    id: orderId, order_number: orderNum, waiter_id, table_number: null,
    status: 'paid', payment_method, subtotal, tax_amount: 0, total_amount: total,
    // Quick Sale has no linked menu item, so there's no ingredient cost to
    // snapshot — leave cost/profit null (not tracked) rather than implying
    // a false 100% margin.
    cost_amount: null, profit_amount: null,
    notes: '', plates_taken_at: null, plates_returned: 0, plates_returned_at: null,
    plate_return_approved_by: null, created_at: now, updated_at: now,
    prep_started_at: null, prep_ready_at: null, items: resolvedItems,
    cashier_id: sess.id, cashier_name: sess.name, paid_by: sess.id
  });
  saveDB();

  // ── Instant reconciliation: if this Quick Sale's item name matches a
  // real menu item, check whether TODAY's cumulative Quick Sale total for
  // that item now exceeds what the Chef actually logged as prepared.
  // Selling more than was ever cooked is the clearest fraud/theft signal —
  // flag it immediately rather than waiting for an end-of-day report.
  const today = todayStr();
  const flags = [];
  const seenNames = new Set();
  resolvedItems.forEach(it => {
    const key = normName(it.item_name);
    if (seenNames.has(key)) return; // avoid double-flagging the same item twice in one order
    seenNames.add(key);
    const mi = db.menu_items.find(m => normName(m.name) === key);
    if (!mi) return; // no matching menu item — nothing to reconcile against
    const prepared = preparedQtyForDate(db, mi.id, today);
    const quickSold = quickSoldQtyForName(db, key, today);
    if (quickSold > prepared) {
      const audit = {
        id: uuid(), menu_item_id: mi.id, item_name: mi.name, date: today,
        source: 'quick_sale_reconciliation',
        prepared_qty: prepared, quick_sold_qty: quickSold, discrepancy: quickSold - prepared,
        flagged: true, order_id: orderId,
        note: "Quick Sale total exceeded Chef's prepared quantity today",
        recorded_by: sess.id, recorded_by_name: sess.name, recorded_by_role: sess.role,
        created_at: nowISO()
      };
      db.stock_audits.push(audit);
      flags.push(audit);
    }
  });
  if (flags.length) saveDB();

  const full = enrichOrder(findOrder(orderId), sess);
  return { ok: true, order: full, _flags: flags };
};
// ── delete historical Quick Sale orders (Admin one-time cleanup) ────
// The standalone "Mauzo (Cashier Quick Sale)" feature has been removed
// from the app entirely (button, page, and API). This lets Admin purge
// the old records it already created — identified by every item on the
// order having menu_item_id === null, which only ever happened via the
// old quick-sale endpoint (regular orders always reference a real menu item).
LOCAL.deleteQuickSaleOrders = (sess) => {
  requireRole(sess, 'Admin');
  // RETIRED: Quick Sale is a permanent, live feature again (not a removed
  // one), so every Quick Sale order — old or from five minutes ago — has
  // the same signature (menu_item_id === null on every line). This action
  // can no longer tell "old junk" apart from today's real paid sales, so
  // it's disabled to prevent accidentally deleting legitimate revenue
  // history. Use the date-range Reports / export Backup instead.
  throw new HttpError(410, 'Kipengele hiki kimezimwa: haiwezekani tena kutofautisha mauzo ya zamani na ya sasa ya Quick Sale bila hatari ya kufuta taarifa halisi.');
};

LOCAL.approveOrder = (sess, id) => {
  requireRole(sess, 'Cashier', 'Admin');
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  if (o.status !== 'pending_payment') throw new HttpError(400, 'Order is not pending payment');
  // Record WHICH cashier approved this order — used for per-cashier stats and filtering
  o.status = 'confirmed';
  o.cashier_id = sess.id;
  o.cashier_name = sess.name;
  o.updated_at = nowISO();
  saveDB();
  return { ok: true, order: enrichOrder(o, sess) };
};
LOCAL.setStatus = (sess, id, status, payment_method) => {
  requireSession(sess);
  const o = findOrder(id);
  if (!o) throw new HttpError(404, 'Not found');
  const allowed = {
    Admin: ['confirmed', 'preparing', 'ready', 'served', 'paid', 'cancelled'],
    Cashier: ['served', 'paid', 'cancelled'],
    Kitchen: ['preparing', 'ready'],
    Waiter: ['served']
  };
  if (!(allowed[sess.role] || []).includes(status)) throw new HttpError(403, 'Cannot set this status');
  o.status = status; o.updated_at = nowISO();
  if (payment_method) o.payment_method = payment_method;
  if (status === 'preparing' && !o.prep_started_at) o.prep_started_at = nowISO();
  if (status === 'ready' && !o.prep_ready_at) o.prep_ready_at = nowISO();
  // When cashier marks as paid, record who processed the payment
  if (status === 'paid' && sess.role === 'Cashier') {
    if (!o.cashier_id) o.cashier_id = sess.id;
    if (!o.cashier_name) o.cashier_name = sess.name;
    o.paid_by = sess.id;
  }
  saveDB();
  return { ok: true, order: enrichOrder(o, sess) };
};
LOCAL.platesTaken = (sess, id) => {
  requireRole(sess, 'Waiter', 'Admin');
  const o = findOrder(id);
  if (o) { o.plates_taken_at = nowISO(); o.updated_at = nowISO(); saveDB(); }
  return { ok: true, order: enrichOrder(o, sess) };
};
LOCAL.platesReturned = (sess, id) => {
  requireRole(sess, 'Cashier', 'Admin');
  const o = findOrder(id);
  if (o) { o.plates_returned = 1; o.plates_returned_at = nowISO(); o.plate_return_approved_by = sess.id; o.updated_at = nowISO(); saveDB(); }
  return { ok: true, order: enrichOrder(o, sess) };
};

LOCAL.getCashierStats = (sess) => {
  requireRole(sess, 'Cashier', 'Admin');
  const db = loadDB();
  const today = dateOf(nowISO());
  // Filter only orders this cashier handled
  const myOrders = db.orders.filter(o => o.cashier_id === sess.id);
  const myToday  = myOrders.filter(o => dateOf(o.created_at) === today);
  const myPaid   = myToday.filter(o => o.status === 'paid');
  const myActive = myOrders.filter(o => !['paid','cancelled'].includes(o.status));
  const myPlateAlerts = myOrders.filter(o => o.plates_taken_at && !o.plates_returned &&
    Math.floor((Date.now() - new Date(o.plates_taken_at).getTime()) / 60000) > 15);
  const revenue = myPaid.reduce((s, o) => s + o.total_amount, 0);
  return {
    cashier_id:   sess.id,
    cashier_name: sess.name,
    stats: {
      revenue_today:       revenue,
      paid_orders_today:   myPaid.length,
      orders_today:        myToday.length,
      active_orders:       myActive.length,
      plate_alerts:        myPlateAlerts.length,
    },
    paid_orders: myPaid.slice(-20).map(o => enrichOrder(o, sess)),
    active_orders: myActive.map(o => enrichOrder(o, sess)),
    plate_alerts: myPlateAlerts.map(o => enrichOrder(o, sess)),
  };
};

// ── expenses (operational costs, stock purchases, etc.) ─────────────
// Only Admin and Cashier can record or manage expenses. Waiter and
// Kitchen have no access to this at all — matches till/cash-handling roles.
LOCAL.getExpenses = (sess, from, to) => {
  requireRole(sess, 'Admin', 'Cashier');
  const db = loadDB();
  const today = todayStr();
  const f = from || today, t = to || today;
  let list = db.expenses.filter(e => e.date >= f && e.date <= t);
  // Cashiers see only what they personally recorded, same pattern as reports.
  // Admin sees everything.
  if (sess.role === 'Cashier') list = list.filter(e => e.recorded_by === sess.id);
  list = list.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { expenses: list, total: round2(list.reduce((s, e) => s + e.amount, 0)) };
};
LOCAL.addExpense = (sess, body) => {
  requireRole(sess, 'Admin', 'Cashier');
  body = body || {};
  const category = String(body.category || '').trim();
  const description = String(body.description || '').trim();
  const amount = Number(body.amount);
  if (!category) throw new HttpError(400, 'Chagua aina ya gharama');
  if (!amount || amount <= 0) throw new HttpError(400, 'Kiasi si sahihi');
  const db = loadDB();
  const exp = {
    id: uuid(), category, description, amount: round2(amount),
    recorded_by: sess.id, recorded_by_name: sess.name, recorded_by_role: sess.role,
    date: todayStr(), created_at: nowISO()
  };
  db.expenses.push(exp);
  saveDB();
  return { ok: true, expense: exp };
};
// Editing/deleting is Admin-only even though Cashiers can create expenses —
// this stops a cashier from being able to quietly erase their own entries.
LOCAL.updateExpense = (sess, id, body) => {
  requireRole(sess, 'Admin');
  body = body || {};
  const db = loadDB();
  const exp = db.expenses.find(e => e.id === id);
  if (!exp) throw new HttpError(404, 'Not found');
  if (body.category) exp.category = String(body.category).trim();
  if (typeof body.description !== 'undefined') exp.description = String(body.description).trim();
  if (typeof body.amount !== 'undefined') {
    const amount = Number(body.amount);
    if (!amount || amount <= 0) throw new HttpError(400, 'Kiasi si sahihi');
    exp.amount = round2(amount);
  }
  saveDB();
  return { ok: true, expense: exp };
};
LOCAL.deleteExpense = (sess, id) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  const idx = db.expenses.findIndex(e => e.id === id);
  if (idx !== -1) { db.expenses.splice(idx, 1); saveDB(); }
  return { ok: true };
};

// ── stock audit (kitchen ↔ cashier reconciliation, theft/shrinkage) ──
// The system already tracks an "expected remaining" count automatically:
// mi.stock_count starts at what Kitchen posted and drops by exactly what
// Cashier sells (see createOrder). That number can only be wrong if reality
// (a physical recount of plates/portions in the kitchen) doesn't match it —
// which is exactly the theft/shrinkage signal we want to catch. Any staff
// who can physically see the kitchen stock can submit a recount; Admin and
// Cashier can review flagged mismatches.
LOCAL.recordStockCount = (sess, id, actualCount, note) => {
  requireRole(sess, 'Admin', 'Cashier', 'Kitchen');
  const mi = findMenuItem(id);
  if (!mi) throw new HttpError(404, 'Not found');
  const actual = Number(actualCount);
  if (isNaN(actual) || actual < 0) throw new HttpError(400, 'Idadi si sahihi');
  const db = loadDB();
  const expected = mi.stock_count;
  const actualTrunc = Math.trunc(actual);
  const discrepancy = actualTrunc - expected;
  const audit = {
    id: uuid(), menu_item_id: mi.id, item_name: mi.name, date: todayStr(),
    expected_qty: expected, actual_qty: actualTrunc, discrepancy,
    flagged: discrepancy !== 0,
    recorded_by: sess.id, recorded_by_name: sess.name, recorded_by_role: sess.role,
    note: note || '', created_at: nowISO()
  };
  db.stock_audits.push(audit);
  // Reconcile the system to the physical count so subsequent sales stay accurate.
  mi.stock_count = actualTrunc;
  mi.is_available = mi.stock_count > 0 ? 1 : 0;
  saveDB();
  return { ok: true, audit };
};
// Legitimate waste/spoilage/breakage — logging this BEFORE a recount keeps
// it from being wrongly flagged as a discrepancy. Kitchen or Admin only.
LOCAL.recordStockWaste = (sess, id, qty, reason) => {
  requireRole(sess, 'Admin', 'Kitchen');
  const mi = findMenuItem(id);
  if (!mi) throw new HttpError(404, 'Not found');
  const n = Number(qty);
  if (!n || n <= 0) throw new HttpError(400, 'Idadi si sahihi');
  const db = loadDB();
  mi.stock_count = Math.max(0, mi.stock_count - Math.trunc(n));
  mi.is_available = mi.stock_count > 0 ? 1 : 0;
  db.stock_log.push({
    id: uuid(), menu_item_id: mi.id, item_name: mi.name, type: 'waste', qty: Math.trunc(n),
    reason: reason || '', staff_id: sess.id, staff_name: sess.name, role: sess.role, created_at: nowISO()
  });
  saveDB();
  return { ok: true, item: mi };
};
LOCAL.getStockAudits = (sess) => {
  requireRole(sess, 'Admin', 'Cashier');
  const db = loadDB();
  const list = db.stock_audits.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { audits: list.slice(0, 200), unresolved: list.filter(a => a.flagged) };
};
LOCAL.getStockLog = (sess) => {
  requireRole(sess, 'Admin', 'Cashier');
  const db = loadDB();
  return { log: db.stock_log.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200) };
};

// ── Chef ↔ Quick Sale reconciliation report (Admin review) ──────────
// For a given day: how much did Kitchen log as prepared for each item,
// vs. how much did Cashier actually sell of that item through Quick Sale?
// A positive variance (sold > prepared) means more was sold than was ever
// cooked — the clear fraud/theft signal this feature exists to catch.
// A negative variance just means unsold leftovers (normal, not flagged).
LOCAL.getReconciliation = (sess, date) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  const targetDate = date || todayStr();
  const rows = db.menu_items.map(mi => {
    const prepared = preparedQtyForDate(db, mi.id, targetDate);
    const quickSold = quickSoldQtyForName(db, normName(mi.name), targetDate);
    if (prepared === 0 && quickSold === 0) return null; // nothing happened with this item today
    const variance = quickSold - prepared;
    return {
      menu_item_id: mi.id, item_name: mi.name, icon: mi.icon,
      prepared_qty: prepared, quick_sold_qty: quickSold, variance,
      status: variance > 0 ? 'critical' : (variance < 0 ? 'leftover' : 'matched')
    };
  }).filter(Boolean).sort((a, b) => b.variance - a.variance);

  // Quick Sale entries whose typed name doesn't match ANY menu item at all —
  // these can't be reconciled against a production log by name-matching,
  // which is itself worth surfacing (could be a typo, or something never
  // logged as prepared in the first place).
  const menuNamesLower = new Set(db.menu_items.map(mi => normName(mi.name)));
  const unmatchedMap = {};
  db.orders.filter(o => o.status === 'paid' && dateOf(o.created_at) === targetDate).forEach(o => {
    (o.items || []).filter(it => it.menu_item_id === null).forEach(it => {
      const key = normName(it.item_name);
      if (key && !menuNamesLower.has(key)) {
        if (!unmatchedMap[key]) unmatchedMap[key] = { item_name: it.item_name, qty: 0 };
        unmatchedMap[key].qty += it.quantity;
      }
    });
  });

  return {
    date: targetDate,
    rows,
    critical_count: rows.filter(r => r.status === 'critical').length,
    unmatched_quick_sale_items: Object.values(unmatchedMap)
  };
};

// ── Integrated expense & sales settlement (Admin, Cashier only) ─────
// Straightforward: revenue in the range, minus expenses in the range,
// equals the net balance. Kept separate from getReports' more detailed
// COGS-based profit figures because this is the simple top-line number
// Admin/Cashier need at end of shift/day.
LOCAL.getSettlement = (sess, from, to) => {
  requireRole(sess, 'Admin', 'Cashier');
  const db = loadDB();
  const today = todayStr();
  const f = from || today, t = to || today;
  let paidOrders = db.orders.filter(o => o.status === 'paid' && dateOf(o.created_at) >= f && dateOf(o.created_at) <= t);
  let expenses = db.expenses.filter(e => e.date >= f && e.date <= t);
  // Same pattern as reports: a Cashier sees their own till only, Admin sees everything.
  if (sess.role === 'Cashier') {
    paidOrders = paidOrders.filter(o => o.cashier_id === sess.id);
    expenses = expenses.filter(e => e.recorded_by === sess.id);
  }
  const revenue = round2(paidOrders.reduce((s, o) => s + o.total_amount, 0));
  const expensesTotal = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const byCategory = {};
  expenses.forEach(e => {
    if (!byCategory[e.category]) byCategory[e.category] = { category: e.category, total: 0, count: 0 };
    byCategory[e.category].total = round2(byCategory[e.category].total + e.amount);
    byCategory[e.category].count += 1;
  });
  return {
    from: f, to: t,
    revenue, expenses: expensesTotal,
    net_balance: round2(revenue - expensesTotal),
    expense_breakdown: Object.values(byCategory)
  };
};

// ── attendance (clock in / clock out) ───────────────────────────────
LOCAL.clockIn = (sess) => {
  requireSession(sess);
  const db = loadDB(), today = todayStr();
  let rec = db.attendance.find(a => a.staff_id === sess.id && a.date === today);
  if (rec) {
    if (!rec.clock_in_at) { rec.clock_in_at = nowISO(); saveDB(); }
    return { ok: true, record: rec, already: true };
  }
  rec = { id: uuid(), staff_id: sess.id, staff_name: sess.name, date: today, clock_in_at: nowISO(), clock_out_at: null };
  db.attendance.push(rec);
  saveDB();
  return { ok: true, record: rec };
};
LOCAL.clockOut = (sess) => {
  requireSession(sess);
  const db = loadDB(), today = todayStr();
  const rec = db.attendance.find(a => a.staff_id === sess.id && a.date === today);
  if (!rec || !rec.clock_in_at) throw new HttpError(400, 'Hujaingia kazini leo bado');
  if (rec.clock_out_at) return { ok: true, record: rec, already: true };
  rec.clock_out_at = nowISO();
  saveDB();
  return { ok: true, record: rec };
};
LOCAL.getMyAttendance = (sess) => {
  requireSession(sess);
  const today = todayStr();
  const records = loadDB().attendance.filter(a => a.staff_id === sess.id).sort((a, b) => b.date.localeCompare(a.date));
  const todayRec = records.find(r => r.date === today) || null;
  return { records, today: todayRec };
};
LOCAL.getAllAttendance = (sess) => {
  requireRole(sess, 'Admin');
  const records = loadDB().attendance.slice().sort((a, b) => b.date.localeCompare(a.date) || a.staff_name.localeCompare(b.staff_name));
  return { records };
};

LOCAL.exportBackup = (sess) => { requireSession(sess); return loadDB(); };
LOCAL.importBackup = (sess, parsed) => {
  requireRole(sess, 'Admin');
  if (!parsed || !Array.isArray(parsed.staff) || !Array.isArray(parsed.orders)) throw new HttpError(400, 'That file does not look like a valid Ottoman Bey backup.');
  _DB = migrateDB(parsed);
  saveDB();
  return { ok: true };
};

// ── group chat ─────────────────────────────────────────────────────
// Separate from private messages — this is a live group chat visible
// to ALL staff roles. Messages are stored in DB so history persists.
LOCAL.getChatMessages = (sess) => {
  requireSession(sess);
  const db = loadDB();
  if (!db.chat) db.chat = [];
  return { messages: db.chat.slice(-200) }; // last 200 messages
};
LOCAL.sendChatMessage = (sess, body) => {
  requireSession(sess);
  body = body || {};
  const text = (body.text || '').trim();
  if (!text) throw new HttpError(400, 'Message text required');
  if (text.length > 500) throw new HttpError(400, 'Message too long (max 500 chars)');
  const db = loadDB();
  if (!db.chat) db.chat = [];
  const msg = {
    id: uuid(),
    sender_id: sess.id,
    sender_name: sess.name,
    sender_role: sess.role,
    text,
    created_at: nowISO()
  };
  db.chat.push(msg);
  if (db.chat.length > 500) db.chat = db.chat.slice(-500);
  saveDB();
  return { ok: true, message: msg };
};
LOCAL.clearChat = (sess) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  db.chat = [];
  saveDB();
  return { ok: true };
};

function isMongoConnected() { return !!_mongoCollection; }
function getLastMongoError() { return _lastMongoError; }

// ── system status (Admin diagnostic: is MongoDB actually connected,
// or are we silently running on the ephemeral local file that resets
// on every Render restart?) ────────────────────────────────────────
LOCAL.getSystemStatus = (sess) => {
  requireRole(sess, 'Admin');
  const db = loadDB();
  return {
    mongo_connected: isMongoConnected(),
    storage_mode: isMongoConnected() ? 'mongodb' : 'local_file',
    last_save_error: getLastMongoError(),
    orders_count: db.orders.length,
    staff_count: db.staff.length,
    menu_items_count: db.menu_items.length
  };
};

module.exports = {
  initStorage, loadDB, saveDB, LOCAL, HttpError,
  getSessionByToken, destroySession, requireSession, isMongoConnected
};
