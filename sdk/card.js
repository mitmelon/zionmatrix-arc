const { Contract, AbiCoder, keccak256, id, ZeroAddress } = require('ethers');
const { abi } = require('./artifacts/BusinessCard.json');
const { accessWallet, createAccess } = require('./password');
const { usdc, formatUsdc } = require('./units');
const { toZionError, wrongPassword } = require('./errors');
const { cardIface, factoryIface } = require('./events');

const coder = AbiCoder.defaultAbiCoder();
const TYPES = {
  AccessAction: [
    { name: 'action', type: 'bytes32' },
    { name: 'data', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// One business's card. `signer` is the RELAYER wallet: it sends the transactions and pays the gas.
// Protected actions also take the business's `password` and `salt`, which are used to sign the
// approval (they are never sent anywhere). Most apps use ZionCards instead, which looks the salt up for you.
class Card {
  constructor(address, signer) {
    this.address = address;
    this.signer = signer;
    this.contract = new Contract(address, abi, signer);
  }

  async info() {
    const c = this.contract;
    const [businessIdHash, settlement, accessKey, nonce, balance, version, relayers, lock, pending] = await Promise.all([
      c.businessId(), c.settlement(), c.accessKey(), c.nonce(), c.balance(), c.version(), c.relayerCount(),
      c.lockStatus(), c.pendingSettlement(),
    ]);
    return {
      address: this.address,
      businessIdHash,
      settlement,
      accessKey,
      nonce: Number(nonce),
      balance: formatUsdc(balance),
      version,
      relayers: Number(relayers),
      lock: lockSummary(lock),
      pendingSettlement: pending.next === ZeroAddress ? null : { address: pending.next, readyAt: Number(pending.readyAt) },
    };
  }

  async balance() {
    return formatUsdc(await this.contract.balance());
  }

  async lockStatus() {
    return lockSummary(await this.contract.lockStatus());
  }

  // ----- Money out -----

  async withdraw({ amount, password, salt, ttl }) {
    const wei = usdc(amount);
    const settlement = await this.contract.settlement();
    return this._protected('WITHDRAW', ['uint256', 'address'], [wei, settlement], { password, salt, ttl },
      (deadline, sig) => this.contract.withdraw(wei, deadline, sig));
  }

  async withdrawAll({ password, salt, ttl }) {
    const settlement = await this.contract.settlement();
    return this._protected('WITHDRAW_ALL', ['address'], [settlement], { password, salt, ttl },
      (deadline, sig) => this.contract.withdrawAll(deadline, sig));
  }

  // ----- Access password -----

  // Returns the new salt: store it in place of the old one.
  async changePassword({ password, salt, newPassword, ttl }) {
    const next = createAccess(newPassword);
    const result = await this._protected('CHANGE_PASSWORD', ['address'], [next.accessKey], { password, salt, ttl },
      (deadline, sig) => this.contract.changePassword(next.accessKey, deadline, sig));
    return { ...result, newSalt: next.salt };
  }

  // ----- Relayers (servers allowed to submit this card's transactions) -----

  addRelayer({ relayer, password, salt, ttl }) {
    return this._protected('ADD_RELAYER', ['address'], [relayer], { password, salt, ttl },
      (deadline, sig) => this.contract.addRelayer(relayer, deadline, sig));
  }

  removeRelayer({ relayer, password, salt, ttl }) {
    return this._protected('REMOVE_RELAYER', ['address'], [relayer], { password, salt, ttl },
      (deadline, sig) => this.contract.removeRelayer(relayer, deadline, sig));
  }

  // ----- Settlement address (24h delay) -----

  proposeSettlement({ newSettlement, password, salt, ttl }) {
    return this._protected('SETTLEMENT', ['address'], [newSettlement], { password, salt, ttl },
      (deadline, sig) => this.contract.proposeSettlement(newSettlement, deadline, sig));
  }

  confirmSettlement() {
    return this._send(() => this.contract.confirmSettlement());
  }

  async cancelSettlement({ password, salt, ttl }) {
    const { next } = await this.contract.pendingSettlement();
    return this._protected('CANCEL_SETTLEMENT', ['address'], [next], { password, salt, ttl },
      (deadline, sig) => this.contract.cancelSettlement(deadline, sig));
  }

  // ----- Upgrade to a version the factory approved -----

  upgrade({ implementation, data = '0x', password, salt, ttl }) {
    return this._protected('UPGRADE', ['address', 'bytes32'], [implementation, keccak256(data)], { password, salt, ttl },
      (deadline, sig) => this.contract.upgrade(implementation, data, deadline, sig));
  }

  // ----- Emergency (guardian / recovery wallets only) -----

  freeze() { return this._send(() => this.contract.freeze()); }
  unfreeze() { return this._send(() => this.contract.unfreeze()); }
  vetoSettlement() { return this._send(() => this.contract.vetoSettlement()); }
  vetoRecovery() { return this._send(() => this.contract.vetoRecovery()); }

  // ----- Payments received (use txHash to match invoices) -----

  // Arc limits eth_getLogs to 10,000 blocks per call, so this reads in chunks.
  // `fromBlock` is required: use the block the card was created in (createCard returns it),
  // or the last block you already processed + 1. For live listening use EventWatcher instead.
  async payments({ fromBlock, toBlock = 'latest', chunk = 9000 } = {}) {
    if (fromBlock === undefined) throw new Error('payments() needs fromBlock (use createdBlock from createCard)');
    const provider = this.signer.provider;
    const last = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock;
    const filter = this.contract.filters.PaymentReceived();

    const found = [];
    for (let start = fromBlock; start <= last; start += chunk) {
      const stop = Math.min(start + chunk - 1, last);
      for (const e of await this.contract.queryFilter(filter, start, stop)) {
        found.push({ txHash: e.transactionHash, from: e.args.from, amount: formatUsdc(e.args.amount), blockNumber: e.blockNumber });
      }
    }
    return found;
  }

  // ----- Internals -----

  // Signs "I approve this exact action, once, before this deadline" with the access key.
  async _signature(action, types, values, { password, salt, ttl = 600 }) {
    const provider = this.signer.provider;
    const wallet = accessWallet(password, salt); // also rejects a badly formed password before it can count as an attempt
    const [{ chainId }, block, nonce] = await Promise.all([
      provider.getNetwork(),
      provider.getBlock('latest'),
      this.contract.nonce(),
    ]);
    const deadline = block.timestamp + ttl;
    const domain = { name: 'ZionMatrix Business Card', version: '1', chainId, verifyingContract: this.address };
    const value = { action: id(action), data: keccak256(coder.encode(types, values)), nonce, deadline };
    return { deadline, sig: await wallet.signTypedData(domain, TYPES, value) };
  }

  // Sends a password-protected call. A wrong password does NOT revert on-chain (the failure is
  // recorded there), so we read the receipt and turn a rejection into a clear error.
  async _protected(action, types, values, creds, call) {
    const { deadline, sig } = await this._signature(action, types, values, creds);
    const result = await this._send(() => call(deadline, sig));

    const rejected = result.events.find((e) => e.name === 'PasswordRejected');
    if (rejected) {
      const locked = result.events.find((e) => e.name === 'CardLocked');
      throw wrongPassword({
        attemptsLeft: Number(rejected.args.attemptsLeft),
        lockedUntil: locked && !locked.args.forever ? locked.args.until : null,
        lockedForever: !!locked?.args.forever,
      });
    }
    return result;
  }

  async _send(call) {
    try {
      const tx = await call();
      const receipt = await tx.wait();
      const events = [];
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
        try {
          const parsed = cardIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) events.push(parsed);
        } catch { /* not a card event */ }
      }
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber, events };
    } catch (e) {
      throw toZionError(e, cardIface, factoryIface);
    }
  }
}

function lockSummary([frozen, lockedForever, lockedUntil, attemptsLeft]) {
  const now = Math.floor(Date.now() / 1000);
  let status = 'active';
  if (frozen) status = 'frozen';
  else if (lockedForever) status = 'locked_permanently';
  else if (Number(lockedUntil) > now) status = 'locked';
  return { status, frozen, lockedForever, lockedUntil: Number(lockedUntil) || null, attemptsLeft: Number(attemptsLeft) };
}

module.exports = { Card };
