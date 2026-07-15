(function (global) {
  'use strict';
  var TOKEN_KEY = 'ottomanbey_token_v1';
  var SESSION_KEY = 'ottomanbey_session_v1';

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function getSession() { try { var r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function setSession(u) { try { if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u)); else localStorage.removeItem(SESSION_KEY); } catch (e) {} }
  function clearSession() { setToken(null); setSession(null); }

  function apiCall(method, urlPath, body) {
    var headers = { 'Content-Type': 'application/json' };
    var tok = getToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    return fetch(urlPath, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function qs(params) {
    var usp = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null && v !== '') usp.set(k, v);
    });
    var s = usp.toString();
    return s ? ('?' + s) : '';
  }

  var POS_DB = {
    login: function (username, password) {
      return apiCall('POST', '/api/login', { username: username, password: password }).then(function (d) {
        setToken(d.token); setSession(d.user); return d;
      });
    },
    logout: function () {
      return apiCall('POST', '/api/logout').catch(function () {}).then(function () {
        clearSession();
        return { ok: true };
      });
    },
    me: function () { return apiCall('GET', '/api/me').then(function (d) { return d.user; }); },
    dashboard: function () { return apiCall('GET', '/api/dashboard'); },
    getSettings: function () { return apiCall('GET', '/api/settings'); },
    updateSettings: function (body) { return apiCall('PUT', '/api/settings', body); },
    getStaff: function () { return apiCall('GET', '/api/staff'); },
    createStaff: function (body) { return apiCall('POST', '/api/staff', body); },
    updateStaff: function (id, body) { return apiCall('PUT', '/api/staff/' + id, body); },
    deleteStaff: function (id) { return apiCall('DELETE', '/api/staff/' + id); },
    getRoles: function () { return apiCall('GET', '/api/roles'); },
    getReports: function (from, to) { return apiCall('GET', '/api/reports' + qs({ from: from, to: to })); },
    getMenu: function () { return apiCall('GET', '/api/menu'); },
    getCats: function () { return apiCall('GET', '/api/categories'); },
    createMenu: function (body) { return apiCall('POST', '/api/menu', body); },
    updateMenu: function (id, body) { return apiCall('PUT', '/api/menu/' + id, body); },
    deleteMenu: function (id) { return apiCall('DELETE', '/api/menu/' + id); },
    addCat: function (body) { return apiCall('POST', '/api/categories', body); },
    getOrders: function (params) { return apiCall('GET', '/api/orders' + qs(params)); },
    getOrder: function (id) { return apiCall('GET', '/api/orders/' + id); },
    createOrder: function (body) { return apiCall('POST', '/api/orders', body); },
    approveOrder: function (id) { return apiCall('POST', '/api/orders/' + id + '/approve'); },
    setStatus: function (id, status, payment_method) { return apiCall('PUT', '/api/orders/' + id + '/status', { status: status, payment_method: payment_method }); },
    platesTaken: function (id) { return apiCall('POST', '/api/orders/' + id + '/plates-taken'); },
    platesReturned: function (id) { return apiCall('POST', '/api/orders/' + id + '/plates-returned'); },
    getMessages: function () { return apiCall('GET', '/api/messages'); },
    getUnread: function () { return apiCall('GET', '/api/messages/unread'); },
    getStaffList: function () { return apiCall('GET', '/api/staff-list'); },
    sendMsg: function (body) { return apiCall('POST', '/api/messages', body); },
    markAllRead: function () { return apiCall('POST', '/api/messages/read-all'); },
    getWaiterAvailability: function () { return apiCall('GET', '/api/waiter-availability'); },
    createOrderForWaiter: function (body) { return apiCall('POST', '/api/orders', body); },
    postStock: function (id, count) { return apiCall('POST', '/api/menu/' + id + '/stock', { count: count }); },
    clockIn: function () { return apiCall('POST', '/api/attendance/clock-in'); },
    clockOut: function () { return apiCall('POST', '/api/attendance/clock-out'); },
    getMyAttendance: function () { return apiCall('GET', '/api/attendance/me'); },
    getAllAttendance: function () { return apiCall('GET', '/api/attendance'); },
    exportBackup: function () { return apiCall('GET', '/api/backup').then(function (d) { return JSON.stringify(d, null, 2); }); },
    importBackup: function (json) { return apiCall('POST', '/api/backup', typeof json === 'string' ? JSON.parse(json) : json); },
    getChatMessages: function () { return apiCall('GET', '/api/chat'); },
    sendChatMessage: function (text) { return apiCall('POST', '/api/chat', { text: text }); },
    clearChat: function () { return apiCall('DELETE', '/api/chat'); }
  };

  // ── realtime bus, backed by a single persistent Socket.io connection ──
  var listeners = {};
  var BUS = {
    on: function (type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
    offAll: function () { listeners = {}; },
    _dispatch: function (type, payload) {
      (listeners[type] || []).forEach(function (cb) { try { cb(payload); } catch (e) { console.error(e); } });
    }
  };

  function connectSocket() {
    if (typeof io === 'undefined') return;
    var socket = io();
    var EVENTS = ['order:new', 'order:approved', 'order:status', 'order:plates', 'settings:updated', 'menu:updated', 'message:new', 'message:sent'];
    EVENTS.forEach(function (ev) { socket.on(ev, function (payload) { BUS._dispatch(ev, payload); }); });
    socket.on('connect', function () { var dot = document.getElementById('ws-dot'); if (dot) dot.classList.add('live'); });
    socket.on('disconnect', function () { var dot = document.getElementById('ws-dot'); if (dot) dot.classList.remove('live'); });
  }
  connectSocket();

  global.POS_DB = POS_DB;
  global.POS_BUS = BUS;
  global.POS_SESSION = { get: getSession, clear: clearSession };
})(window);
