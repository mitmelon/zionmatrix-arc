'use strict';

const { isAddress, parseUnits } = require('ethers');
const redis = require('../../../../Redis'); // adjust path

const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_CHAINS = new Set(['5042', '5042002']); // Arc mainnet, Arc testnet
const MIN_PAYMENT_MICRO = Number(parseUnits(process.env.MIN_PAYMENT_USDC || '0.01', 6)); // used when no expected amount

const indexKey = (chainId) => `receiver:watch:index:${chainId}`; // zset: member = address, score = expiresAt (ms)
const metaKey = (chainId, address) => `receiver:watch:${chainId}:${String(address).toLowerCase()}`;
const versionKey = (chainId) => `receiver:ver:${chainId}`;      // bumped on registration so the worker refreshes its WS filter
const seenKey = (chainId, address) => `receiver:recv:seen:${chainId}:${String(address).toLowerCase()}`;
const totalKey = (chainId, address) => `receiver:recv:total:${chainId}:${String(address).toLowerCase()}`;

// SET NX + ZADD + version bump in one atomic step; registering twice is a no-op
const REGISTER_LUA = `
  if redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') then
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    redis.call('INCR', KEYS[3])
    return 1
  end
  return 0
`;

/**
 * Register a (predicted or deployed) address to watch for an incoming USDC payment.
 * @param {number|string} p.chainId          5042 (mainnet) | 5042002 (testnet)
 * @param {string} p.address                 predicted CREATE2 address
 * @param {string|number} p.expectedAmountUsdc  the amount the business is owed, e.g. "25.50" (same value used to predict the address). Required.
 * @param {string} [p.reference]             your order / invoice id (echoed in the webhook)
 * @param {object} [p.extra]                 small JSON echoed in the webhook
 */
async function registerReceiver({ chainId, address, expectedAmountUsdc = null, reference = null, card = null, extra = {} }) {
  chainId = String(chainId);
  // The receiver address is derived from the amount the business is owed, so that amount is required here.
  // Pass the SAME value you used to predict the address (calc.expectedUsdc), not the fee-inclusive total.
  if (expectedAmountUsdc == null) throw new Error('expectedAmountUsdc (the amount the business is owed) is required');
  if (!SUPPORTED_CHAINS.has(chainId)) throw new Error(`Unsupported chainId ${chainId}`);
  if (!isAddress(address)) throw new Error('Invalid address');

  const addr = String(address).toLowerCase();
  const expectedMicro = expectedAmountUsdc == null ? null : Number(parseUnits(String(expectedAmountUsdc), 6));
  if (expectedMicro !== null && expectedMicro <= 0) throw new Error('expectedAmountUsdc must be > 0');

  const now = Date.now();
  const expiresAt = now + WATCH_WINDOW_MS;
  const meta = {
    chainId, address: addr, reference, card, extra,
    expectedMicro,
    thresholdMicro: expectedMicro ?? MIN_PAYMENT_MICRO,
    registeredAt: now, expiresAt,
  };

  const created = await redis.client.eval(
    REGISTER_LUA, 3, metaKey(chainId, addr), indexKey(chainId), versionKey(chainId),
    JSON.stringify(meta), Math.ceil(WATCH_WINDOW_MS / 1000) + 3600, expiresAt, addr
  );

  return created === 1
    ? { registered: true, meta }
    : { registered: false, meta: await redis.get(metaKey(chainId, addr)) };
}

/**
 * Stop monitoring an address and remove everything the monitor stored for it.
 * @param {object} [opts]
 * @param {boolean} [opts.refresh=false]  bump the version key so the watcher drops the address from its
 *   live subscription right away (otherwise it is dropped the next time the worker refreshes on its own)
 * @returns {{ removed: boolean, meta: object|null }}  removed=false when the address was not registered
 */
async function unregisterReceiver(chainId, address, { refresh = false } = {}) {
  chainId = String(chainId);
  const a = String(address).toLowerCase();
  const meta = await redis.get(metaKey(chainId, a));
  const inIndex = await redis.zscore(indexKey(chainId), a);

  await redis.zrem(indexKey(chainId), a);
  await redis.del(metaKey(chainId, a));
  await redis.del(seenKey(chainId, a));
  await redis.del(totalKey(chainId, a));

  if (refresh) await redis.client.incr(versionKey(chainId));

  return { removed: !!meta || inIndex != null, meta: meta || null };
}

module.exports = {
  registerReceiver, unregisterReceiver,
  metaKey, indexKey, versionKey, seenKey, totalKey, WATCH_WINDOW_MS,
};