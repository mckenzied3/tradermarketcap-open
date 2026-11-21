// Exchange readers, checked offline: fetch is swapped for a saved copy of the real response shape.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READERS, VENUES } from '../collector/sources/exchanges.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answer every request with this body, and remember which URLs were asked for.
function fakeFetch(body) {
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify(body), { status: 200 }); };
  return urls;
}

const bybitFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bybit-spot-tickers.json', import.meta.url), 'utf8'));
const bitgetFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bitget-spot-tickers.json', import.meta.url), 'utf8'));

test('bybit: USD-quoted spot pairs with volume, change and links', async () => {
  const urls = fakeFetch(bybitFixture());
  const ms = await READERS.bybit();
  assert.deepEqual(urls, ['https://api.bybit.com/v5/market/tickers?category=spot']);
  assert.ok(VENUES.bybit);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  const btc = ms[0];
  assert.equal(btc.venue, 'bybit');
  assert.equal(btc.price, 97000.15);
  assert.equal(btc.volBase, 10000.5);
  assert.equal(btc.volQuote, 970001500.5);
  assert.ok(Math.abs(btc.change24h - 2.11) < 1e-9);
  assert.equal(btc.api, 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT');
  assert.equal(btc.trade, 'https://www.bybit.com/en/trade/spot/BTC/USDT');
  assert.ok(ms[1].change24h < 0);
});

test('bybit: an error answer (retCode not 0) fails the read', async () => {
  fakeFetch({ retCode: 10001, retMsg: 'params error', result: {} });
  await assert.rejects(READERS.bybit(), /retCode 10001/);
});

test('bitget: USD-quoted spot pairs with volume, change and links', async () => {
  const urls = fakeFetch(bitgetFixture());
  const ms = await READERS.bitget();
  assert.deepEqual(urls, ['https://api.bitget.com/api/v2/spot/market/tickers']);
  assert.ok(VENUES.bitget);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  const btc = ms[0];
  assert.equal(btc.venue, 'bitget');
  assert.equal(btc.price, 97000.15);
  assert.equal(btc.volBase, 10000.5);
  assert.equal(btc.volQuote, 970001500.5);
  assert.ok(Math.abs(btc.change24h - 2.11) < 1e-9);
  assert.equal(btc.api, 'https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT');
  assert.equal(btc.trade, 'https://www.bitget.com/spot/BTCUSDT');
  assert.ok(ms[1].change24h < 0);
});

test('bitget: an error answer (code not 00000) fails the read', async () => {
  fakeFetch({ code: '40017', msg: 'params error', data: [] });
  await assert.rejects(READERS.bitget(), /code 40017/);
});


// HTX answers one call with a status wrapper; route by URL so a wrong path is visible.
function routedFetch(routes) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    const hit = Object.keys(routes).find(k => u.includes(k));
    if (!hit) return new Response('{"status":"error"}', { status: 404 });
    return new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
  return urls;
}

const htxTickers = () => JSON.parse(readFileSync(new URL('./fixtures/htx-tickers.json', import.meta.url), 'utf8'));

test('htx: glued lowercase symbols, USD/USDT/USDC kept, change derived from close/open', async () => {
  const body = htxTickers();
  const urls = routedFetch({ '/market/tickers': body });
  const ms = await READERS.htx();
  assert.ok(VENUES.htx);
  assert.deepEqual(urls, ['https://api.huobi.pro/market/tickers']);
  assert.ok(ms.length > 0);
  for (const m of ms) {
    assert.equal(m.venue, 'htx');
    assert.ok(['USD', 'USDT', 'USDC'].includes(m.quote));
    assert.match(m.base, /^[A-Z0-9]+$/);
    assert.equal(typeof m.price, 'number');
    assert.match(m.trade, /^https:\/\/www\.htx\.com\/en-us\/trade\/[a-z0-9]+_(usd|usdt|usdc)$/);
  }
  const raw = body.data[0];
  const q = ['usdt', 'usdc', 'usd'].find(x => raw.symbol.endsWith(x));
  const b = raw.symbol.slice(0, -q.length).toUpperCase();
  const row = ms.find(m => m.base === b && m.quote === q.toUpperCase());
  assert.ok(row);
  assert.equal(row.price, raw.close);
  assert.equal(row.volBase, raw.amount);
  assert.equal(row.volQuote, raw.vol);
  if (raw.open) assert.ok(Math.abs(row.change24h - (raw.close / raw.open - 1) * 100) < 1e-9);
});

test('htx: a status other than ok fails the read', async () => {
  routedFetch({ '/market/tickers': { status: 'error', 'err-code': 'bad' } });
  await assert.rejects(READERS.htx(), /htx tickers/);
});
