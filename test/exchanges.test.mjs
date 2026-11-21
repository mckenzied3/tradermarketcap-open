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


const geminiFeed = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-pricefeed.json', import.meta.url), 'utf8'));
const geminiTicker = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-pubticker.json', import.meta.url), 'utf8'));

// Gemini needs two endpoints: pricefeed for pairs/price/change, pubticker for volume.
// Route by URL so the volume path is actually exercised, not stubbed by one shared body.
function routedFetch(routes) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    const hit = Object.keys(routes).find(k => u.includes(k));
    if (!hit) return new Response('{"result":"error","reason":"EndpointNotFound"}', { status: 404 });
    return new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
  return urls;
}

test('gemini: USD-quoted pairs, pricefeed for price/change, pubticker for volume', async () => {
  const feed = geminiFeed();
  const ticker = geminiTicker();
  const urls = routedFetch({ '/v1/pricefeed': feed, '/v1/pubticker/': ticker });
  const ms = await READERS.gemini();
  assert.ok(VENUES.gemini);
  assert.equal(urls[0], 'https://api.gemini.com/v1/pricefeed');
  assert.ok(ms.length > 0);
  for (const m of ms) {
    assert.equal(m.venue, 'gemini');
    assert.ok(['USD', 'USDT', 'USDC'].includes(m.quote));
    assert.equal(typeof m.price, 'number');
    assert.match(m.api, /^https:\/\/api\.gemini\.com\/v1\/pubticker\/[a-z0-9]+$/);
    assert.match(m.trade, /^https:\/\/www\.gemini\.com\/trade\/[A-Z0-9]+$/);
  }
  const btc = ms.find(m => m.base === 'BTC' && m.quote === 'USD');
  if (btc) {
    assert.equal(btc.volBase, 529.76994275);
    assert.equal(btc.volQuote, 31813405.54925964);
  }
  // percentChange24h is already a percentage on Gemini, so it must not be multiplied again.
  const first = ms[0];
  const raw = feed.find(p => p.pair.toLowerCase() === `${first.base}${first.quote}`.toLowerCase());
  if (raw) assert.ok(Math.abs(first.change24h - Number(raw.percentChange24h)) < 1e-9);
});

test('gemini: a non-array pricefeed answer fails the read', async () => {
  routedFetch({ '/v1/pricefeed': { result: 'error', reason: 'InvalidApiKey' } });
  await assert.rejects(READERS.gemini(), /gemini pricefeed/);
});

test('gemini: a failed pubticker leaves volume null instead of failing the read', async () => {
  const feed = geminiFeed();
  routedFetch({ '/v1/pricefeed': feed });   // every pubticker call 404s
  const ms = await READERS.gemini();
  assert.equal(ms.length, feed.filter(p => /(USD|USDT|USDC)$/.test(p.pair)).length);
  assert.ok(ms.every(m => m.volBase === null && m.volQuote === null));
});
