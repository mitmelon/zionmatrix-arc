'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { Worker, Queue, UnrecoverableError } = require('bullmq');
const { id: keccakId, formatUnits, zeroPadValue } = require('ethers');
const { metaKey, indexKey, versionKey, seenKey, totalKey } = require('./PaymentReceiverRegistry');
const { WebhookSender } = require('../../../../../utils/WebhookSender');

const DEFAULT_RPC = { 5042: ['https://rpc.mainnet.arc.io'], 5042002: ['https://rpc.testnet.arc.io'] };
const DEFAULT_WS = { 5042: 'wss://rpc.mainnet.arc.io', 5042002: 'wss://rpc.testnet.arc.io' };
function loadRpcUrls() {
  const custom = JSON.parse(process.env.RPC_URLS || '{}');
  const out = {};
  for (const k of new Set([...Object.keys(DEFAULT_RPC), ...Object.keys(custom)])) {
    out[k] = [...[].concat(custom[k] || []), ...(DEFAULT_RPC[k] || [])];
  }
  return out;
}
const loadWsUrls = () => ({ ...DEFAULT_WS, ...JSON.parse(process.env.WS_URLS || '{}') });

// Arc EIP-7708: every native USDC movement emits Transfer(from,to,value) from this system address (18 decimals)
const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');
const DUST_DIVISOR = 10n ** 12n; // 18-decimal native -> 6-decimal USDC "micro" units

const POLL_EVERY_MS = Number(process.env.POLL_EVERY_MS || 3000);
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_EVERY_MS || 60_000);
const NOTIFY_EXPIRED = process.env.NOTIFY_EXPIRED !== 'false';

const MAX_BLOCK_RANGE = Math.min(Number(process.env.MAX_BLOCK_RANGE || 9), 9999); // Arc limit: 10,000
const ADDR_PER_CALL = Number(process.env.ADDR_PER_CALL || 100);   // addresses per eth_getLogs / WS subscription
const BATCH_SIZE = Number(process.env.RPC_BATCH_SIZE || 100);
const DUE_PER_CYCLE = 200;
const BLOCKS_PER_SECOND = Number(process.env.BLOCKS_PER_SECOND || 2);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 2);     // Arc has deterministic finality; this also dodges -32014 head-lag
const OVERLAP_BLOCKS = Number(process.env.OVERLAP_BLOCKS || 10);
const RECORD_TTL_SECONDS = 3 * 24 * 3600;

// Atomic, idempotent crediting: the same log (tx:index) can never be counted twice, even with WS + poll racing.
// Totals are kept in 6-decimal micro-USDC so they fit Redis integers.
const CREDIT_LUA = `
  local fresh = redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  if fresh == 1 then
    redis.call('INCRBY', KEYS[2], ARGV[2])
  end
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  return tonumber(redis.call('GET', KEYS[2]) or '0')
`;

const hex = (n) => '0x' + BigInt(n).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (addr) => zeroPadValue(addr, 32).toLowerCase();
// Deterministic ids: same event => same id (no colons: BullMQ rejects them in job ids)
const eventId = (...parts) => 'evt_' + crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
const usdc = (micro) => formatUnits(BigInt(Math.trunc(micro)), 6);

class PaymentReceiverWorker {
  constructor(opts) {
    this.redisConnection = opts.redisConnection;
    this.redis = opts.redis;
    this.rpcUrls = loadRpcUrls();
    this.wsUrls = loadWsUrls();

    this.logger = new opts.logger({
      name: 'PaymentReceiverWorker',
      dir: './storage/logs/receivers',
      level: process.env.WORKER_LOG_LEVEL || 'info',
      auditFile: true,
    });

    this.sender = new WebhookSender({
      url: process.env.PAYMENT_WEBHOOK_URL,
      secret: process.env.PAYMENT_WEBHOOK_SECRET,
      retries: 2,
    });

    this.MONITOR_QUEUE = 'zionmatrix-usdc-receiver-monitor';
    this.WEBHOOK_QUEUE = 'zionmatrix-usdc-receiver-webhook';
    this.POLL_JOB_ID = 'receiver-usdc-monitor-recurring';

    this.sockets = {};
    this.wsBackoff = {};
    this.subIds = {};       
    this.subVersion = {};   
    this.lastReconcile = {};
    this.inflight = new Set();
    this.stopping = false;
  }

  async start() {
    this.logger.info('[ReceiverWorker] 🔎 Starting payment monitor (WS + poll + balance reconcile)...');

    this.queue = new Queue(this.MONITOR_QUEUE, { connection: this.redisConnection });
    this.webhookQueue = new Queue(this.WEBHOOK_QUEUE, { connection: this.redisConnection });

    this.worker = new Worker(this.MONITOR_QUEUE, async (job) => {
      if (job.data.type === 'poll') await this._runPollCycle();
    }, { connection: this.redisConnection, lockDuration: 10 * 60 * 1000, concurrency: 1 });

    this.webhookWorker = new Worker(this.WEBHOOK_QUEUE, async (job) => {
      await this._deliverWebhook(job.data);
    }, { connection: this.redisConnection, concurrency: 10 });

    this.worker.on('failed', (job, err) =>
      this.logger.error(`[ReceiverWorker] ❌ Monitor job ${job?.id} failed: ${err.message}`));
    this.webhookWorker.on('completed', (job) =>
      this.logger.info(`[ReceiverWorker] 📨 Webhook ${job.id} (${job.data.type}) delivered`));
    this.webhookWorker.on('failed', (job, err) =>
      this.logger.warn(`[ReceiverWorker] Webhook ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));

    await this._registerRepeatableJobs().catch((err) =>
      this.logger.error(`[ReceiverWorker] Failed to register repeatable job: ${err.message}`));

    for (const chainId of Object.keys(this.wsUrls)) this._connectSocket(chainId);
  }

  async _registerRepeatableJobs() {
    const existing = await this.queue.getRepeatableJobs();
    for (const j of existing) if (j.id === this.POLL_JOB_ID) await this.queue.removeRepeatableByKey(j.key);

    await this.queue.add('receiver_poll', { type: 'poll' }, {
      repeat: { every: POLL_EVERY_MS },
      jobId: this.POLL_JOB_ID,
      removeOnComplete: { count: 10 },
      removeOnFail: { age: 24 * 3600 },
    });
    this.logger.info(`[ReceiverWorker] Poll job registered (every ${POLL_EVERY_MS}ms)`);
  }

  _connectSocket(chainId) {
    if (this.stopping) return;

    const ws = new WebSocket(this.wsUrls[chainId]);
    let alive = true;
    let heartbeat;
    this.sockets[chainId] = ws;
    this.subIds[chainId] = new Set();
    this.subVersion[chainId] = undefined;
    this.pendingSubs = new Set();

    ws.on('open', () => {
      this.wsBackoff[chainId] = 1000;
      this.logger.info(`[ReceiverWorker] 🔌 WS connected (chain ${chainId})`);
      this._syncSubscriptions(chainId).catch((err) =>
        this.logger.warn(`[ReceiverWorker] WS subscribe sync failed: ${err.message}`));
      heartbeat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 20_000);
    });

    ws.on('pong', () => { alive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Responses to our eth_subscribe calls
      if (msg.id && typeof msg.id === 'string' && msg.id.startsWith('sub-')) {
        if (msg.error) this.logger.error(`[ReceiverWorker] WS subscribe error (chain ${chainId}): ${msg.error.message}`);
        else this.subIds[chainId].add(msg.result);
        return;
      }

      if (msg.method === 'eth_subscription' && msg.params?.result && !msg.params.result.removed) {
        this._creditLog(chainId, msg.params.result).catch((err) =>
          this.logger.error({ err }, '[ReceiverWorker] WS log handling failed (poller will retry)'));
      }
    });

    ws.on('error', (err) => this.logger.warn(`[ReceiverWorker] WS error (chain ${chainId}): ${err.message}`));

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (this.stopping) return;
      const delay = Math.min(this.wsBackoff[chainId] || 1000, 15_000);
      this.wsBackoff[chainId] = delay * 2;
      this.logger.warn(`[ReceiverWorker] WS closed (chain ${chainId}), reconnecting in ${delay}ms (poller covers the gap)`);
      setTimeout(() => this._connectSocket(chainId), delay);
    });
  }

  /** Rebuild subscriptions when addresses were registered since the last build. Removals need no rebuild (unknown logs are ignored). */
  async _syncSubscriptions(chainId, addrs) {
    const ws = this.sockets[chainId];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const version = (await this.redis.getRaw(versionKey(chainId))) || '0';
    if (this.subVersion[chainId] === version) return;

    addrs = addrs || (await this.redis.zrange(indexKey(chainId), 0, -1));

    for (const id of this.subIds[chainId]) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: `unsub-${id}`, method: 'eth_unsubscribe', params: [id] }));
    }
    this.subIds[chainId] = new Set();

    for (let i = 0; i < addrs.length; i += ADDR_PER_CALL) {
      const chunk = addrs.slice(i, i + ADDR_PER_CALL).map(pad);
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: `sub-${chainId}-${i}`, method: 'eth_subscribe',
        params: ['logs', { address: SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, null, chunk] }],
      }));
    }
    this.subVersion[chainId] = version;
  }

  // ═══════════════════════════════════════════════
  // CREDITING: one Transfer log -> atomic, deduped credit -> completion check
  // ═══════════════════════════════════════════════
  async _creditLog(chainId, log) {
    if (log.address.toLowerCase() !== SYSTEM_EMITTER) return;
    if (!log.topics || log.topics.length < 3) return;

    const to = '0x' + log.topics[2].slice(26).toLowerCase();
    const meta = await this.redis.get(metaKey(chainId, to));
    if (!meta) return; // not one of ours (or already completed)

    const amountMicro = Number(BigInt(log.data) / DUST_DIVISOR);
    if (amountMicro <= 0) return;

    const logId = `${log.transactionHash}:${Number(BigInt(log.logIndex))}`;
    const total = Number(await this.redis.client.eval(
      CREDIT_LUA, 2, seenKey(chainId, to), totalKey(chainId, to), logId, amountMicro, RECORD_TTL_SECONDS
    ));

    // Re-check even when the log was already counted: if a crash happened between crediting and completing, this heals it
    if (total >= meta.thresholdMicro) {
      await this._complete(meta, {
        totalMicro: total,
        txHash: log.transactionHash,
        from: '0x' + log.topics[1].slice(26).toLowerCase(),
        blockNumber: Number(BigInt(log.blockNumber)),
        detectedBy: 'transfer_log',
      });
    }
  }

  // ═══════════════════════════════════════════════
  // RPC (fallback URLs + retry on Arc's -32014 head-lag error)
  // ═══════════════════════════════════════════════
  async _send(chainId, body) {
    const urls = this.rpcUrls[chainId];
    if (!urls || urls.length === 0) throw new Error(`No RPC url configured for chain ${chainId}`);

    let lastErr;
    for (const url of urls) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`RPC ${res.status} from ${url}`);
          const out = await res.json();

          if (!Array.isArray(out) && out.error?.code === -32014) {
            lastErr = new Error(`RPC -32014 (backend behind head): ${out.error.message}`);
            await sleep(300 * (attempt + 1));
            continue;
          }
          return out;
        } catch (err) {
          lastErr = err;
          break;
        }
      }
    }
    throw lastErr;
  }

  async _call(chainId, method, params = []) {
    const out = await this._send(chainId, { jsonrpc: '2.0', id: 1, method, params });
    if (out.error) throw new Error(`${method}: ${out.error.message} (${out.error.code})`);
    return out.result;
  }

  async _runPollCycle() {
      await Promise.all(Object.keys(this.rpcUrls).map(async (chainId) => {
        try {
          const addrs = await this.redis.zrange(indexKey(chainId), 0, -1);
          if (!addrs || addrs.length === 0) return;
  
          await this._syncSubscriptions(chainId, addrs).catch(() => {});
          
          await this._reconcileBalances(chainId, addrs);
          await this._handleDue(chainId);
  
          await this._scanTransfers(chainId, addrs);
        } catch (err) {
          this.logger.error({ err }, `[ReceiverWorker] Chain ${chainId} cycle failed`);
        }
      }));
    }

  async _scanTransfers(chainId, addrs) {
    const latest = Number(BigInt(await this._call(chainId, 'eth_blockNumber'))) - CONFIRMATIONS;
    const cursorKey = `receiver:cursor:${chainId}`;

    // If the cursor is missing/stale, never look back further than the payment window
    const floor = Math.max(0, latest - Math.ceil((24 * 3600) * BLOCKS_PER_SECOND * 1.3));
    const stored = await this.redis.getRaw(cursorKey);
    const from = stored !== null ? Math.max(Number(stored) + 1 - OVERLAP_BLOCKS, floor) : floor;
    if (from > latest) return;

    for (let s = from; s <= latest; s += MAX_BLOCK_RANGE) {
      const e = Math.min(s + MAX_BLOCK_RANGE - 1, latest);

      for (let i = 0; i < addrs.length; i += ADDR_PER_CALL) {
        const chunk = addrs.slice(i, i + ADDR_PER_CALL).map(pad);
        const logs = await this._getLogs(chainId, s, e, chunk);
        for (const log of logs) await this._creditLog(chainId, log);
      }
      await this.redis.setRaw(cursorKey, e); // advance only after the whole chunk succeeded
    }
  }

  /** If the RPC complains about result size / range, split the block range and retry. */
    async _getLogs(chainId, s, e, toTopics, depth = 0) {
      try {
        return await this._call(chainId, 'eth_getLogs', [{
          fromBlock: hex(s), toBlock: hex(e),
          address: SYSTEM_EMITTER,
          topics: [TRANSFER_TOPIC, null, toTopics],
        }]);
      } catch (err) {
        const isRangeError = /limit|too many|exceed|range|more than|10000|free tier|-32600/i.test(err.message || '');
  
        if (e > s && depth < 12 && isRangeError) {
          const mid = s + Math.floor((e - s) / 2);
          return [
            ...(await this._getLogs(chainId, s, mid, toTopics, depth + 1)),
            ...(await this._getLogs(chainId, mid + 1, e, toTopics, depth + 1)),
          ];
        }
        throw err;
      }
    }

  // ═══════════════════════════════════════════════
  // GROUND TRUTH: balances (independent of logs/WS). Used every minute and at the deadline.
  // ═══════════════════════════════════════════════
  async _balances(chainId, addresses) {
    const result = new Map();

    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const slice = addresses.slice(i, i + BATCH_SIZE);
      const batch = slice.map((address, idx) => ({
        jsonrpc: '2.0', id: idx, method: 'eth_getBalance', params: [address, 'latest'],
      }));

      let out;
      try { out = await this._send(chainId, batch); } catch { out = null; }

      if (Array.isArray(out)) {
        for (const r of out) if (!r.error && r.result) result.set(slice[r.id], BigInt(r.result));
      } else {
        for (const address of slice) {
          try { result.set(address, BigInt(await this._call(chainId, 'eth_getBalance', [address, 'latest']))); } catch { /* retry next cycle */ }
        }
      }
    }
    return result;
  }

  async _reconcileBalances(chainId, addrs) {
    if (Date.now() - (this.lastReconcile[chainId] || 0) < RECONCILE_EVERY_MS) return;
    this.lastReconcile[chainId] = Date.now();

    const balances = await this._balances(chainId, addrs);
    for (const [address, bal] of balances) {
      if (bal === 0n) continue;
      const meta = await this.redis.get(metaKey(chainId, address));
      if (!meta) continue;

      const micro = Number(bal / DUST_DIVISOR);
      if (micro >= meta.thresholdMicro) {
        await this._complete(meta, { totalMicro: micro, detectedBy: 'balance' });
      }
    }
  }

  // ═══════════════════════════════════════════════
  // DEADLINES: final balance check decides paid vs underpaid vs no payment
  // ═══════════════════════════════════════════════
  async _handleDue(chainId) {
    const key = indexKey(chainId);
    const due = await this.redis.client.zrangebyscore(key, '-inf', Date.now(), 'LIMIT', 0, DUE_PER_CYCLE);
    if (due.length === 0) return;

    const entries = [];
    await Promise.all(due.map(async (address) => {
      const meta = await this.redis.get(metaKey(chainId, address));
      if (meta) entries.push([address, meta]);
      else await this.redis.zrem(key, address); // orphan
    }));
    if (entries.length === 0) return;

    const balances = await this._balances(chainId, entries.map(([a]) => a));

    for (const [address, meta] of entries) {
      const bal = balances.get(address);
      if (bal === undefined) continue; // RPC hiccup: never expire blindly, retry next cycle

      const micro = Number(bal / DUST_DIVISOR);
      if (micro >= meta.thresholdMicro) {
        await this._complete(meta, { totalMicro: micro, detectedBy: 'balance_at_deadline' });
      } else {
        await this._expire(meta, micro > 0 ? 'underpaid' : 'no_payment', micro);
      }
    }
  }

  // ═══════════════════════════════════════════════
  // COMPLETE / EXPIRE (webhook queued first, then removed from Redis)
  // ═══════════════════════════════════════════════
  async _complete(meta, info) {
    const id = eventId('payment.received', meta.chainId, meta.address);
    if (this.inflight.has(id)) return; // WS + poller racing in the same process
    this.inflight.add(id);
    setTimeout(() => this.inflight.delete(id), 60_000).unref();

    const event = {
      id,
      type: 'payment.received',
      created: Math.floor(Date.now() / 1000),
      chainId: meta.chainId,
      reference: meta.reference,
      extra: meta.extra,
      data: {
        address: meta.address, // the predicted receiver address: deploy and sweep now
        receivedMicro: String(info.totalMicro),
        received: usdc(info.totalMicro),
        expected: meta.expectedMicro == null ? null : usdc(meta.expectedMicro),
        txHash: info.txHash || null,
        from: info.from || null,
        blockNumber: info.blockNumber || null,
        detectedBy: info.detectedBy,
      },
    };

    try {
      await this._queueWebhook(event);
    } catch (err) {
      this.inflight.delete(id);
      throw err; // stays in Redis; next pass retries
    }
    await this._remove(meta.chainId, meta.address);
    this.logger.info(`[ReceiverWorker] ✅ Payment received at ${meta.address} (${usdc(info.totalMicro)} USDC via ${info.detectedBy}), removed from Redis`);
  }

  async _expire(meta, reason, receivedMicro) {
    if (NOTIFY_EXPIRED) {
      await this._queueWebhook({
        id: eventId('payment.expired', meta.chainId, meta.address, meta.registeredAt),
        type: 'payment.expired',
        created: Math.floor(Date.now() / 1000),
        chainId: meta.chainId,
        reference: meta.reference,
        extra: meta.extra,
        data: {
          address: meta.address,
          reason, // 'no_payment' | 'underpaid'
          receivedMicro: String(receivedMicro),
          received: usdc(receivedMicro),
          expected: meta.expectedMicro == null ? null : usdc(meta.expectedMicro),
        },
      });
    }
    await this._remove(meta.chainId, meta.address);
    this.logger.info(`[ReceiverWorker] ⌛ ${meta.address} expired (${reason}), removed from Redis`);
  }

  async _remove(chainId, address) {
    await this.redis.zrem(indexKey(chainId), address);
    await this.redis.del(metaKey(chainId, address));
    await this.redis.del(seenKey(chainId, address));
    await this.redis.del(totalKey(chainId, address));
  }

  // ═══════════════════════════════════════════════
  // WEBHOOK (signed via WebhookSender, durable via BullMQ)
  // ═══════════════════════════════════════════════
  async _queueWebhook(event) {
    await this.webhookQueue.add('deliver', event, {
      jobId: event.id, // deterministic: the same payment can't be queued twice
      attempts: 10,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  async _deliverWebhook(event) {
    try {
      await this.sender.send(event);
    } catch (err) {
      if (err.retryable === false) throw new UnrecoverableError(err.message); // e.g. endpoint answered 401/404
      throw err;
    }
  }

  async triggerNow() {
    if (!this.queue) return;
    await this.queue.add('receiver_poll_manual', { type: 'poll' }, { jobId: `receiver-manual-${Date.now()}` });
  }

  async shutdown() {
    this.stopping = true;
    for (const ws of Object.values(this.sockets)) { try { ws.close(); } catch { /* ignore */ } }
    if (this.worker) await this.worker.close();
    if (this.webhookWorker) await this.webhookWorker.close();
    if (this.queue) await this.queue.close();
    if (this.webhookQueue) await this.webhookQueue.close();
    this.logger.info('[ReceiverWorker] Shutdown complete');
  }
}

module.exports = PaymentReceiverWorker;