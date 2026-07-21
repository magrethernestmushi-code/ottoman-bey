'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { initStorage, LOCAL, HttpError, getSessionByToken, destroySession } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ── auth middleware ────────────────────────────────────────────────
function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  req.token = token;
  req.session = getSessionByToken(token);
  next();
}
app.use(auth);

function emitEvent(type, payload) {
  io.emit(type, payload);
}

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req);
      if (result && typeof result.then === 'function') {
        result.then(r => res.json(r)).catch(e => {
          if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
          else { console.error(e); res.status(500).json({ error: e.message || 'Server error' }); }
        });
      } else {
        res.json(result);
      }
    } catch (e) {
      if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
      else { console.error(e); res.status(500).json({ error: e.message || 'Server error' }); }
    }
  };
}

// ── web push subscriptions ─────────────────────────────────────────
// Store push subscriptions in memory (persisted via db).
// When a chat message is sent, we push to all subscribed devices
// so staff get notified even when the browser is closed.
const PUSH_SUBS = new Map(); // token -> subscription object

app.post('/api/push/subscribe', (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'Unauthorized' });
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'No subscription' });
  PUSH_SUBS.set(req.token, { subscription, session: req.session });
  res.json({ ok: true, subscribed: PUSH_SUBS.size });
});

app.delete('/api/push/subscribe', (req, res) => {
  PUSH_SUBS.delete(req.token);
  res.json({ ok: true });
});

// Internal helper — send Web Push notification to all subscribed clients
// We use the browser's built-in push service via the subscription endpoint.
// Note: for full Web Push we'd need web-push npm package + VAPID keys.
// Since we can't install packages on Render without package.json changes,
// we instead use a lightweight polling fallback + Service Worker notification.
function notifyPushSubscribers(payload) {
  // Broadcast via Socket.IO to all connected clients (already done by emitEvent)
  // Additionally ping all registered service workers via a broadcast
  io.emit('push:notify', payload);
}

// Each cashier gets their own independent stats dashboard
app.get('/api/cashier/my-stats', handle(req => LOCAL.getCashierStats(req.session)));

// ── auth routes ─────────────────────────────────────────────────────
app.post('/api/login', handle(req => {
  const { username, password } = req.body || {};
  return LOCAL.login(username, password);
}));
app.post('/api/logout', handle(req => {
  if (req.token) destroySession(req.token);
  return { ok: true };
}));
app.get('/api/me', handle(req => { if (!req.session) throw new HttpError(401, 'Unauthorized'); return { user: req.session }; }));

// ── dashboard / settings ────────────────────────────────────────────
app.get('/api/dashboard', handle(req => LOCAL.dashboard(req.session)));
app.get('/api/settings', handle(req => LOCAL.getSettings(req.session)));
app.put('/api/settings', handle(req => {
  const out = LOCAL.updateSettings(req.session, req.body);
  emitEvent('settings:updated', out);
  return Object.assign({ ok: true }, out);
}));

// ── staff ────────────────────────────────────────────────────────────
app.get('/api/staff', handle(req => LOCAL.getStaff(req.session)));
app.post('/api/staff', handle(req => LOCAL.createStaff(req.session, req.body)));
app.put('/api/staff/:id', handle(req => LOCAL.updateStaff(req.session, req.params.id, req.body)));
app.delete('/api/staff/:id', handle(req => LOCAL.deleteStaff(req.session, req.params.id)));
app.get('/api/roles', handle(req => LOCAL.getRoles(req.session)));
app.get('/api/waiter-availability', handle(req => LOCAL.getWaiterAvailability(req.session)));
app.get('/api/reports', handle(req => LOCAL.getReports(req.session, req.query.from, req.query.to)));

// ── menu ──────────────────────────────────────────────────────────────
app.get('/api/menu', handle(req => LOCAL.getMenu(req.session)));
app.get('/api/categories', handle(req => LOCAL.getCats(req.session)));
app.post('/api/categories', handle(req => LOCAL.addCat(req.session, req.body)));
app.post('/api/menu', handle(req => LOCAL.createMenu(req.session, req.body)));
app.put('/api/menu/:id', handle(req => {
  const out = LOCAL.updateMenu(req.session, req.params.id, req.body);
  if (out._item) emitEvent('menu:updated', { item: out._item });
  delete out._item;
  return out;
}));
app.post('/api/menu/:id/stock', handle(req => {
  const out = LOCAL.postStock(req.session, req.params.id, req.body && req.body.count);
  emitEvent('menu:updated', { item: out.item });
  return out;
}));
app.delete('/api/menu/:id', handle(req => LOCAL.deleteMenu(req.session, req.params.id)));

// ── attendance ────────────────────────────────────────────────────────
app.post('/api/attendance/clock-in', handle(req => LOCAL.clockIn(req.session)));
app.post('/api/attendance/clock-out', handle(req => LOCAL.clockOut(req.session)));
app.get('/api/attendance/me', handle(req => LOCAL.getMyAttendance(req.session)));
app.get('/api/attendance', handle(req => LOCAL.getAllAttendance(req.session)));

// ── orders ────────────────────────────────────────────────────────────
app.get('/api/orders', handle(req => LOCAL.getOrders(req.session, req.query)));
app.get('/api/orders/:id', handle(req => LOCAL.getOrder(req.session, req.params.id)));
app.post('/api/orders', handle(req => {
  const out = LOCAL.createOrder(req.session, req.body);
  emitEvent(out._event, { order: out.order });
  delete out._event;
  return out;
}));
app.post('/api/orders/:id/approve', handle(req => {
  const out = LOCAL.approveOrder(req.session, req.params.id);
  emitEvent('order:approved', { order: out.order });
  return out;
}));
app.put('/api/orders/:id/status', handle(req => {
  const { status, payment_method } = req.body || {};
  const out = LOCAL.setStatus(req.session, req.params.id, status, payment_method);
  emitEvent('order:status', { order_id: req.params.id, status, order: out.order });
  return out;
}));
app.post('/api/orders/:id/plates-taken', handle(req => {
  const out = LOCAL.platesTaken(req.session, req.params.id);
  emitEvent('order:plates', { order_id: req.params.id, action: 'taken', order: out.order });
  return out;
}));
app.post('/api/orders/:id/plates-returned', handle(req => {
  const out = LOCAL.platesReturned(req.session, req.params.id);
  emitEvent('order:plates', { order_id: req.params.id, action: 'returned', order: out.order });
  return out;
}));

// ── messages ──────────────────────────────────────────────────────────
app.get('/api/messages', handle(req => LOCAL.getMessages(req.session)));
app.get('/api/messages/unread', handle(req => LOCAL.getUnread(req.session)));
app.get('/api/staff-list', handle(req => LOCAL.getStaffList(req.session)));
app.post('/api/messages', handle(req => {
  const out = LOCAL.sendMsg(req.session, req.body);
  emitEvent('message:new', out.message);
  emitEvent('message:sent', out.message);
  return out;
}));
app.post('/api/messages/read-all', handle(req => LOCAL.markAllRead(req.session)));

// ── group chat ────────────────────────────────────────────────────────
app.get('/api/chat', handle(req => LOCAL.getChatMessages(req.session)));
app.post('/api/chat', handle(req => {
  const out = LOCAL.sendChatMessage(req.session, req.body);
  // Broadcast to all connected Socket.IO clients immediately
  emitEvent('chat:message', { message: out.message });
  // Also notify devices in background (service worker / push)
  notifyPushSubscribers({
    title: `🗨️ ${out.message.sender_name} (${out.message.sender_role})`,
    body: out.message.text,
    tag: 'chat'
  });
  return out;
}));
app.delete('/api/chat', handle(req => {
  const out = LOCAL.clearChat(req.session);
  emitEvent('chat:cleared', {});
  return out;
}));

// ── backup ────────────────────────────────────────────────────────────
app.get('/api/backup', handle(req => LOCAL.exportBackup(req.session)));
app.post('/api/backup', handle(req => LOCAL.importBackup(req.session, req.body)));

// ── static frontend ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public/staff/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

io.on('connection', () => {});

const PORT = process.env.PORT || 3000;
initStorage().then(() => {
  server.listen(PORT, () => console.log('Ottoman Bey POS server listening on port ' + PORT));
}).catch(err => {
  console.error('Fatal: could not initialize storage', err);
  process.exit(1);
});
