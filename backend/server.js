'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: '*' }));

const API_KEY    = process.env.BYBIT_API_KEY    || '';
const API_SECRET = process.env.BYBIT_API_SECRET || '';
const TESTNET    = (process.env.BYBIT_TESTNET   || 'true') === 'true';
const PORT       = parseInt(process.env.PORT    || '3001', 10);
const BASE_URL   = TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
const AUTH_TOKEN = process.env.JOURNAL_AUTH_TOKEN || '';

// Small local storage file for journal/signal sync. This survives restarts only if your host keeps the filesystem.
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'journal-store.json');

console.log('[Orayan] Mode   :', TESTNET ? 'TESTNET' : 'LIVE');
console.log('[Orayan] Port   :', PORT);
console.log('[Orayan] Key    :', API_KEY ? API_KEY.slice(0,6)+'...' : 'NOT SET');

function sign(timestamp, recvWindow, payload) {
  const raw = `${timestamp}${API_KEY}${recvWindow}${payload}`;
  return crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
}

async function bybitRequest(method, requestPath, params = {}) {
  const timestamp  = Date.now().toString();
  const recvWindow = '5000';
  let url = BASE_URL + requestPath;
  let bodyString = '';
  let queryString = '';

  if (method === 'GET' || method === 'DELETE') {
    queryString = new URLSearchParams(params).toString();
    if (queryString) url += '?' + queryString;
  } else {
    bodyString = JSON.stringify(params);
  }

  const sigPayload = (method === 'GET' || method === 'DELETE') ? queryString : bodyString;
  const signature  = sign(timestamp, recvWindow, sigPayload);

  const headers = {
    'X-BAPI-API-KEY':     API_KEY,
    'X-BAPI-TIMESTAMP':   timestamp,
    'X-BAPI-SIGN':        signature,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type':       'application/json',
  };

  const res  = await fetch(url, { method, headers, body: method === 'POST' ? bodyString : undefined });
  const data = await res.json();
  if (data.retCode !== 0) {
    const err = new Error('Bybit ' + data.retCode + ': ' + data.retMsg);
    err.bybitCode = data.retCode;
    throw err;
  }
  return data;
}

function requireKeys(res) {
  if (!API_KEY || !API_SECRET) {
    res.status(500).json({ ok: false, error: 'API keys not set on server' });
    return false;
  }
  return true;
}

function requireJournalAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const given = req.header('X-Auth-Token') || '';
  if (given !== AUTH_TOKEN) return res.status(401).json({ ok: false, error: 'Invalid X-Auth-Token' });
  next();
}

function emptyStore() {
  return { journal: [], signals: [], updatedAt: Date.now() };
}

function readStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch (e) {
    console.error('[Orayan] Failed reading store:', e.message);
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2));
}

function mergeRows(existingRows, incomingRows, limit = 500) {
  const map = new Map();
  for (const row of existingRows || []) {
    if (row && row.id) map.set(row.id, row);
  }
  let added = 0;
  let updated = 0;
  for (const row of incomingRows || []) {
    if (!row || !row.id) continue;
    const old = map.get(row.id);
    if (!old) {
      map.set(row.id, row);
      added += 1;
    } else if ((row.ts || row.updatedAt || 0) >= (old.ts || old.updatedAt || 0)) {
      map.set(row.id, { ...old, ...row });
      updated += 1;
    }
  }
  const rows = [...map.values()].sort((a, b) => (b.ts || b.updatedAt || 0) - (a.ts || a.updatedAt || 0)).slice(0, limit);
  return { rows, added, updated };
}

app.get('/', (req, res) => {
  res.json({ ok: true, mode: TESTNET ? 'testnet' : 'live', keySet: !!(API_KEY && API_SECRET), ts: Date.now() });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, mode: TESTNET ? 'testnet' : 'live', keySet: !!(API_KEY && API_SECRET), ts: Date.now() });
});

app.get('/api/status', requireJournalAuth, (req, res) => {
  const store = readStore();
  res.json({ ok: true, journalCount: store.journal.length, signalCount: store.signals.length, updatedAt: store.updatedAt });
});

app.get('/api/journal', requireJournalAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 1000);
  const store = readStore();
  res.json({ ok: true, rows: store.journal.slice(0, limit), journal: store.journal.slice(0, limit), updatedAt: store.updatedAt });
});

app.post('/api/journal/push', requireJournalAuth, (req, res) => {
  const incoming = Array.isArray(req.body?.rows) ? req.body.rows : Array.isArray(req.body?.journal) ? req.body.journal : [];
  const store = readStore();
  const merged = mergeRows(store.journal, incoming, 500);
  store.journal = merged.rows;
  writeStore(store);
  res.json({ ok: true, rows: store.journal, added: merged.added, updated: merged.updated, count: store.journal.length });
});

// Extra simple routes in case the app/user tests /journal directly.
app.get('/journal', requireJournalAuth, (req, res) => {
  const store = readStore();
  res.json({ ok: true, rows: store.journal, journal: store.journal, updatedAt: store.updatedAt });
});

app.post('/journal', requireJournalAuth, (req, res) => {
  const incoming = Array.isArray(req.body?.rows) ? req.body.rows : Array.isArray(req.body?.journal) ? req.body.journal : [];
  const store = readStore();
  const merged = mergeRows(store.journal, incoming, 500);
  store.journal = merged.rows;
  writeStore(store);
  res.json({ ok: true, added: merged.added, updated: merged.updated, count: store.journal.length });
});

app.get('/api/signals', requireJournalAuth, (req, res) => {
  const store = readStore();
  res.json(store.signals || []);
});

app.post('/api/signals', requireJournalAuth, (req, res) => {
  const incoming = Array.isArray(req.body?.signals) ? req.body.signals : Array.isArray(req.body) ? req.body : [];
  const store = readStore();
  const merged = mergeRows(store.signals, incoming, 1000);
  store.signals = merged.rows;
  writeStore(store);
  res.json({ ok: true, added: merged.added, updated: merged.updated, count: store.signals.length });
});

app.post('/bybit/order', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, side, qty, price, orderType, slPrice, tpPrice, reduceOnly } = req.body;
  if (!symbol || !side || !qty || !orderType) return res.status(400).json({ ok: false, error: 'Missing params' });
  try {
    const params = { category: 'linear', symbol, side, orderType, qty: String(qty), timeInForce: orderType === 'Limit' ? 'GTC' : 'IOC' };
    if (price)     params.price      = String(price);
    if (slPrice)   params.stopLoss   = String(slPrice);
    if (tpPrice)   params.takeProfit = String(tpPrice);
    if (reduceOnly) params.reduceOnly = true;
    const data = await bybitRequest('POST', '/v5/order/create', params);
    res.json({ ok: true, orderId: data.result?.orderId, raw: data.result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, bybitCode: e.bybitCode });
  }
});

app.delete('/bybit/order', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, orderId } = req.body;
  if (!symbol || !orderId) return res.status(400).json({ ok: false, error: 'Missing params' });
  try {
    const data = await bybitRequest('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId });
    res.json({ ok: true, raw: data.result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/bybit/sl-tp', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, slPrice, tpPrice, positionIdx = 0 } = req.body;
  if (!symbol) return res.status(400).json({ ok: false, error: 'Missing symbol' });
  try {
    const params = { category: 'linear', symbol, positionIdx };
    if (slPrice) params.stopLoss   = String(slPrice);
    if (tpPrice) params.takeProfit = String(tpPrice);
    const data = await bybitRequest('POST', '/v5/position/trading-stop', params);
    res.json({ ok: true, raw: data.result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/bybit/leverage', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, leverage } = req.body;
  if (!symbol || !leverage) return res.status(400).json({ ok: false, error: 'Missing params' });
  try {
    const data = await bybitRequest('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage)
    });
    res.json({ ok: true, raw: data.result });
  } catch (e) {
    if (e.bybitCode === 110043) return res.json({ ok: true, note: 'leverage unchanged' });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/bybit/positions', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const params = { category: 'linear', settleCoin: 'USDT', limit: 50 };
    if (req.query.symbol) params.symbol = req.query.symbol;
    const data = await bybitRequest('GET', '/v5/position/list', params);
    const positions = (data.result?.list || []).filter(p => parseFloat(p.size) > 0);
    res.json({ ok: true, positions });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/bybit/wallet', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const data = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const account  = data.result?.list?.[0];
    const usdtCoin = account?.coin?.find(c => c.coin === 'USDT');
    res.json({
      ok: true,
      totalEquity:      parseFloat(account?.totalEquity || 0),
      availableBalance: parseFloat(usdtCoin?.availableToWithdraw || usdtCoin?.walletBalance || 0),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/bybit/order-status', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, orderId } = req.query;
  if (!symbol || !orderId) return res.status(400).json({ ok: false, error: 'Missing params' });
  try {
    const data = await bybitRequest('GET', '/v5/order/realtime', { category: 'linear', symbol, orderId });
    res.json({ ok: true, order: data.result?.list?.[0] || null });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log('[Orayan] Proxy running on port', PORT));
