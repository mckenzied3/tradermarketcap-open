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


// Upbit needs two endpoints; route by URL so the market-list and ticker paths are both exercised.
function routedFetch(routes) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    const hit = Object.keys(routes).find(k => u.includes(k));
    if (!hit) return new Response('{"error":{"name":"not_found"}}', { status: 404 });
    return new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
  return urls;
}

const upbitMarkets = () => JSON.parse(readFileSync(new URL('./fixtures/upbit-market-all.json', import.meta.url), 'utf8'));
const upbitTickers = () => JSON.parse(readFileSync(new URL('./fixtures/upbit-ticker.json', import.meta.url), 'utf8'));

test('upbit: USDT markets only, batched ticker call, volume in both currencies', async () => {
  const markets = upbitMarkets();
  const tickers = upbitTickers();
  const urls = routedFetch({ '/v1/market/all': markets, '/v1/ticker?markets=': tickers });
  const ms = await READERS.upbit();
  assert.ok(VENUES.upbit);
  assert.equal(urls[0], 'https://api.upbit.com/v1/market/all');
  assert.match(urls[1], /^https:\/\/api\.upbit\.com\/v1\/ticker\?markets=USDT-/);
  assert.ok(ms.length > 0);
  for (const m of ms) {
    assert.equal(m.venue, 'upbit');
    assert.equal(m.quote, 'USDT');
    assert.equal(typeof m.price, 'number');
    assert.match(m.api, /^https:\/\/api\.upbit\.com\/v1\/ticker\?markets=USDT-[A-Z0-9]+$/);
    assert.match(m.trade, /^https:\/\/upbit\.com\/exchange\?code=CRIX\.UPBIT\.USDT-[A-Z0-9]+$/);
  }
  const first = tickers[0];
  const [q, b] = first.market.split('-');
  const row = ms.find(m => m.base === b && m.quote === q);
  assert.ok(row);
  assert.equal(row.volBase, first.acc_trade_volume_24h);
  assert.equal(row.volQuote, first.acc_trade_price_24h);
  // signed_change_rate is a fraction on Upbit; it must be shown as a percentage.
  assert.ok(Math.abs(row.change24h - first.signed_change_rate * 100) < 1e-9);
});

test('upbit: a non-array market list fails the read', async () => {
  routedFetch({ '/v1/market/all': { error: { name: 'invalid_parameter', message: 'bad' } } });
  await assert.rejects(READERS.upbit(), /upbit market list/);
});
