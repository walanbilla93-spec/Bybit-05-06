'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const API_KEY    = process.env.BYBIT_API_KEY    || '';
const API_SECRET = process.env.BYBIT_API_SECRET || '';
const TESTNET    = (process.env.BYBIT_TESTNET   || 'true') === 'true';
const PORT       = parseInt(process.env.PORT    || '3001', 10);
const BASE_URL   = TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

console.log('[Orayan] Mode   :', TESTNET ? 'TESTNET' : 'LIVE');
console.log('[Orayan] Port   :', PORT);
console.log('[Orayan] Key    :', API_KEY ? API_KEY.slice(0,6)+'...' : 'NOT SET');

function sign(timestamp, recvWindow, payload) {
  const raw = `${timestamp}${API_KEY}${recvWindow}${payload}`;
  return crypto.createHmac('sha256', API_SECRET).update(raw).digest('hex');
}

async function bybitRequest(method, path, params = {}) {
  const timestamp  = Date.now().toString();
  const recvWindow = '5000';
  let url = BASE_URL + path;
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

app.get('/health', (req, res) => {
  res.json({ ok: true, mode: TESTNET ? 'testnet' : 'live', keySet: !!(API_KEY && API_SECRET), ts: Date.now() });
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

app.listen(PORT, () => console.log('[Orayan] Proxy running on port', PORT));
