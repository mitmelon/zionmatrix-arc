const { Contract, Interface, formatUnits } = require('ethers');
const fs = require('fs');
const factoryArtifact = require('./artifacts/BusinessCardFactory.json');
const cardArtifact = require('./artifacts/BusinessCard.json');

const cardIface = new Interface(cardArtifact.abi);
const factoryIface = new Interface(factoryArtifact.abi);

// Contract event name -> the name you receive in webhooks and handlers.
const CARD_EVENTS = {
  PaymentReceived: 'payment.received',
  Withdrawn: 'withdrawal.completed',
  PasswordRejected: 'access.password_rejected',
  CardLocked: 'account.locked',
  PasswordChanged: 'access.password_changed',
  RelayerAdded: 'relayer.added',
  RelayerRemoved: 'relayer.removed',
  SettlementProposed: 'settlement.proposed',
  SettlementChanged: 'settlement.changed',
  SettlementCancelled: 'settlement.cancelled',
  Frozen: 'account.frozen',
  Unfrozen: 'account.unfrozen',
  RecoveryProposed: 'recovery.proposed',
  RecoveryExecuted: 'recovery.executed',
  RecoveryCancelled: 'recovery.cancelled',
};
const FACTORY_EVENTS = { CardCreated: 'account.created' };
const usdc = (v) => formatUnits(v, 18);

// Which action a PasswordRejected event refers to.
const ACTION_NAMES = {};
for (const name of ['WITHDRAW', 'WITHDRAW_ALL', 'CHANGE_PASSWORD', 'SETTLEMENT', 'CANCEL_SETTLEMENT', 'CANCEL_RECOVERY', 'ADD_RELAYER', 'REMOVE_RELAYER', 'UPGRADE']) {
  ACTION_NAMES[require('ethers').id(name)] = name;
}

// Plain, JSON-safe data for each event type (amounts in USDC strings, numbers as numbers).
function describe(name, a) {
  switch (name) {
    case 'PaymentReceived': return { from: a.from, amount: usdc(a.amount), amountRaw: a.amount.toString() };
    case 'Withdrawn': return { to: a.to, amount: usdc(a.amount), amountRaw: a.amount.toString(), relayer: a.relayer };
    case 'PasswordRejected': return { action: ACTION_NAMES[a.action] || a.action, attemptsLeft: Number(a.attemptsLeft) };
    case 'CardLocked': return a.forever ? { forever: true, until: null } : { forever: false, until: Number(a.until) };
    case 'PasswordChanged': return { newAccessKey: a.newAccessKey };
    case 'RelayerAdded':
    case 'RelayerRemoved': return { relayer: a.relayer };
    case 'SettlementProposed': return { newSettlement: a.newSettlement, readyAt: Number(a.readyAt) };
    case 'SettlementChanged': return { oldSettlement: a.oldSettlement, newSettlement: a.newSettlement };
    case 'SettlementCancelled':
    case 'Frozen':
    case 'Unfrozen':
    case 'RecoveryCancelled': return { by: a.cancelledBy ?? a.by };
    case 'RecoveryProposed': return { newSettlement: a.newSettlement, newRelayer: a.newRelayer, readyAt: Number(a.readyAt) };
    case 'RecoveryExecuted': return { newSettlement: a.newSettlement, newRelayer: a.newRelayer };
    case 'CardCreated': return { settlement: a.settlement, relayer: a.relayer };
    default: return {};
  }
}

// Reads logs and keeps only the ones that really come from a card made by YOUR factory.
// (Anyone can deploy a contract that emits the same event name, so we check with the factory.)
class CardLogReader {
  constructor({ provider, factory, resolveBusiness }) {
    this.provider = provider;
    this.factoryAddress = factory;
    this.factory = new Contract(factory, factoryArtifact.abi, provider);
    this.resolveBusiness = resolveBusiness;
    this.cardCache = new Map(); // card address -> business id hash (or null if not ours)
    this.blockTimes = new Map();
  }

  // Topic hashes to ask the node for (card events + the factory's CardCreated).
  get topics() {
    const names = Object.keys(CARD_EVENTS).map((n) => cardIface.getEvent(n).topicHash);
    return [...names, factoryIface.getEvent('CardCreated').topicHash];
  }

  async _cardHash(address) {
    const key = address.toLowerCase();
    if (!this.cardCache.has(key)) {
      const hash = await this.factory.businessIdOf(address);
      this.cardCache.set(key, /^0x0+$/.test(hash) ? null : hash);
    }
    return this.cardCache.get(key);
  }

  async _timestamp(blockNumber) {
    if (!this.blockTimes.has(blockNumber)) {
      this.blockTimes.set(blockNumber, (await this.provider.getBlock(blockNumber)).timestamp);
      if (this.blockTimes.size > 500) this.blockTimes.delete(this.blockTimes.keys().next().value);
    }
    return this.blockTimes.get(blockNumber);
  }

  // Turns one raw log into an event object, or null if it is not one of ours.
  async decode(log, { head } = {}) {
    const fromFactory = log.address.toLowerCase() === this.factoryAddress.toLowerCase();
    let parsed;
    try {
      parsed = (fromFactory ? factoryIface : cardIface).parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return null;
    }
    const names = fromFactory ? FACTORY_EVENTS : CARD_EVENTS;
    if (!parsed || !names[parsed.name]) return null;

    const hash = parsed.args.businessId;
    if (!fromFactory) {
      const real = await this._cardHash(log.address);
      if (!real || real.toLowerCase() !== hash.toLowerCase()) return null; // fake card
    } else if ((await this.factory.cardOf(hash)).toLowerCase() !== parsed.args.card.toLowerCase()) {
      return null;
    }

    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.index ?? log.logIndex);
    return {
      id: `${log.transactionHash}:${logIndex}`,
      type: names[parsed.name],
      businessIdHash: hash,
      businessId: this.resolveBusiness ? await this.resolveBusiness(hash) : null,
      card: fromFactory ? parsed.args.card : log.address,
      txHash: log.transactionHash,
      logIndex,
      blockNumber,
      blockTimestamp: await this._timestamp(blockNumber),
      confirmations: head === undefined ? undefined : head - blockNumber + 1,
      data: describe(parsed.name, parsed.args),
    };
  }

  async decodeAll(logs, opts) {
    const out = [];
    for (const log of logs) {
      const e = await this.decode(log, opts);
      if (e) out.push(e);
    }
    return out;
  }
}

// ---------- Where the watcher remembers how far it got ----------

class MemoryEventStore {
  constructor() {
    this.cursor = null;
    this.done = new Map(); // event id -> block number
  }
  async getCursor() { return this.cursor; }
  async setCursor(n) { this.cursor = n; }
  async wasProcessed(id) { return this.done.has(id); }
  async markProcessed(id, blockNumber) { this.done.set(id, blockNumber); }
  async prune(belowBlock) {
    for (const [id, b] of this.done) if (b < belowBlock) this.done.delete(id);
  }
}

// Survives restarts. In production use a database table instead.
class FileEventStore extends MemoryEventStore {
  constructor(path) {
    super();
    this.path = path;
    if (fs.existsSync(path)) {
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      this.cursor = saved.cursor;
      this.done = new Map(Object.entries(saved.done || {}));
    }
  }
  _save() {
    fs.writeFileSync(this.path, JSON.stringify({ cursor: this.cursor, done: Object.fromEntries(this.done) }));
  }
  async setCursor(n) { await super.setCursor(n); this._save(); }
  async markProcessed(id, b) { await super.markProcessed(id, b); this._save(); }
  async prune(b) { await super.prune(b); this._save(); }
}

// ---------- The listener ----------

// Watches every card made by your factory and calls your handlers once per event, after it has
// the confirmations you asked for. Delivery is at-least-once: an event whose handler throws is
// retried on the next poll, and events already handled are never repeated.
//
//   const watcher = new EventWatcher({ provider, factory, confirmations: 1 });
//   watcher.on('payment.received', async (e) => { ... });
//   watcher.start();
//
// Arc finalises a block in under a second, so 1 confirmation is final. Use more if you want extra margin.
class EventWatcher {
  constructor({
    provider,
    factory,
    confirmations = 1,
    store = new MemoryEventStore(),
    startBlock,
    pollMs = 3000,
    chunk = 9000, // Arc limits eth_getLogs to 10,000 blocks per call
    resolveBusiness,
    onError = (e) => console.error('[zion watcher]', e.message),
  }) {
    if (confirmations < 1) throw new Error('confirmations must be at least 1');
    Object.assign(this, { provider, confirmations, store, startBlock, pollMs, chunk, onError });
    this.reader = new CardLogReader({ provider, factory, resolveBusiness });
    this.handlers = new Map();
    this.timer = null;
    this.running = false;
  }

  // type: 'payment.received', 'withdrawal.completed', ... or '*' for everything.
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return this;
  }

  async _dispatch(event) {
    for (const h of [...(this.handlers.get(event.type) || []), ...(this.handlers.get('*') || [])]) await h(event);
  }

  // Handles ONE raw log pushed to you by a provider webhook (QuickNode, Circle, ...) instead of polling.
  // It is verified against the factory and de-duplicated like any other event.
  async ingestLog(log) {
    const head = await this.provider.getBlockNumber();
    const event = await this.reader.decode(log, { head });
    if (!event || event.confirmations < this.confirmations) return null;
    if (await this.store.wasProcessed(event.id)) return null;
    await this._dispatch(event);
    await this.store.markProcessed(event.id, event.blockNumber);
    return event;
  }

  // One round of work. Returns how many events were handled.
  async pollOnce() {
    const head = await this.provider.getBlockNumber();
    const safeHead = head - this.confirmations + 1; // newest block that has enough confirmations

    let cursor = await this.store.getCursor();
    if (cursor === null || cursor === undefined) cursor = this.startBlock ?? safeHead; // default: from now on
    let handled = 0;

    for (let from = cursor; from <= safeHead; from += this.chunk) {
      const to = Math.min(from + this.chunk - 1, safeHead);
      const logs = await this._getLogs(from, to);
      logs.sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? a.logIndex) - (b.index ?? b.logIndex));

      for (const event of await this.reader.decodeAll(logs, { head })) {
        if (await this.store.wasProcessed(event.id)) continue;
        await this._dispatch(event); // if this throws, the cursor does not move and we retry
        await this.store.markProcessed(event.id, event.blockNumber);
        handled += 1;
      }
      await this.store.setCursor(to + 1);
    }
    if (handled) await this.store.prune(safeHead - 200_000);
    return handled;
  }

  async _getLogs(fromBlock, toBlock) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.provider.getLogs({ fromBlock, toBlock, topics: [this.reader.topics] });
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  start() {
    if (this.running) return this;
    this.running = true;
    const tick = async () => {
      try {
        await this.pollOnce();
      } catch (e) {
        this.onError(e);
      }
      if (this.running) this.timer = setTimeout(tick, this.pollMs);
    };
    tick();
    return this;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}

module.exports = {
  CardLogReader,
  EventWatcher,
  MemoryEventStore,
  FileEventStore,
  CARD_EVENTS,
  FACTORY_EVENTS,
  cardIface,
  factoryIface,
};
