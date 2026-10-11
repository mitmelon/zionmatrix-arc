const fs = require('fs');
const path = require('path');
const { ContractFactory, Contract, Wallet, keccak256, toUtf8Bytes, ZeroAddress } = require('ethers');
const factoryArtifact = require('./artifacts/BusinessCardFactory.json');
const { Card } = require('./card');
const { createAccess, generateAccessPassword, assertNewPassword, createArcWallet, loadArcWallet } = require('./password');
const { toZionError, ZionError } = require('./errors');
const { makeProvider } = require('./provider');
const { usdc, formatUsdc } = require('./units');
const { CardLogReader, EventWatcher, cardIface, factoryIface } = require('./events');

// Your business ID (any string, e.g. "biz_123") becomes the on-chain hash.
const hashBusinessId = (id) => keccak256(toUtf8Bytes(String(id)));

// The amount the business is owed for an invoice, in raw units. Accepts a human USDC amount
// ("10.37" or 10.37) or an already-raw bigint. It is part of the receiver address, so it must be
// the exact same value every time you predict, watch or sweep the same invoice: store it with the
// invoice when you quote it, never recompute it from a live rate.
const toRawExpected = (value) => {
  let raw;
  if (typeof value === 'bigint') raw = value;
  else if (value === undefined || value === null || value === '') raw = 0n;
  else raw = usdc(String(value));
  if (raw <= 0n) {
    throw new ZionError({
      code: 'EXPECTED_AMOUNT_REQUIRED',
      message: 'expectedAmount (the amount the business is owed for this invoice) is required and must be greater than 0.',
      httpStatus: 400,
    });
  }
  return raw;
};

// Deploys the factory once. The same shared source works on every Arc network.
// the relayer pays gas and the admin
// keeps factory-level controls; a separate multisig is optional, not required.
async function deployFactory(signer, options = {}) {
  const me = await signer.getAddress();
  const { adminDelay = 3 * 24 * 3600, creator = me, guardian = me, recovery = guardian, newAdmin } = options;

  const deployer = new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, signer);
  const factory = await deployer.deploy(adminDelay, me);
  await factory.waitForDeployment();

  for (const [role, who] of [['CREATOR_ROLE', creator], ['GUARDIAN_ROLE', guardian], ['RECOVERY_ROLE', recovery]]) {
    await (await factory.grantRole(await factory[role](), who)).wait();
  }
  if (newAdmin) await (await factory.beginDefaultAdminTransfer(newAdmin)).wait();
  return { address: await factory.getAddress(), creator, guardian, recovery, admin: newAdmin || me };
}

function resolveFactoryAddress(factoryAddress) {
  const candidate = typeof factoryAddress === 'string' ? factoryAddress.trim() : '';
  if (candidate) return candidate;

  const networkName = (process.env.ZION_NETWORK || process.env.NETWORK || 'testnet').toLowerCase();
  const arcDir = path.resolve(__dirname, '..');
  const candidates = [
    path.join(arcDir, 'deployment.json'),
    path.join(arcDir, `deployment-${networkName}.json`),
    path.join(process.cwd(), 'deployment.json'),
    path.join(process.cwd(), `deployment-${networkName}.json`),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const resolved = config.factory || config.address || config.factoryAddress || config.contractAddress;
      if (resolved) return String(resolved);
    } catch {
      // ignore broken or non-JSON deployment files and keep looking
    }
  }

  const env = (process.env.FACTORY_ADDRESS || '').trim();
  if (env) return env;

  throw new Error('No Arc factory address found. Pass factory explicitly or ensure deployment.json exists in the Arc package.');
}

// The bank-style API your backend uses. A business only ever has a business ID and an access
// password: no wallet, no contract address. `signer` is the relayer wallet (it pays network fees).
class ZionCards {
  constructor(factoryAddress, signer, { secrets, resolveBusiness } = {}) {
    this.factoryAddress = factoryAddress;
    this.signer = signer;
    this.provider = signer.provider;
    this.secrets = secrets;
    this.contract = new Contract(factoryAddress, factoryArtifact.abi, signer);
    this.reader = new CardLogReader({ provider: this.provider, factory: factoryAddress, resolveBusiness });
    this.resolveBusiness = resolveBusiness;
  }

  static connect({ rpcUrl, privateKey, factory, secrets, resolveBusiness }) {
    const factoryAddress = resolveFactoryAddress(factory);
    return new ZionCards(factoryAddress, new Wallet(privateKey, makeProvider(rpcUrl)), { secrets, resolveBusiness });
  }

  // ----- Accounts -----

  // Opens an account for a business. If you do not pass a `password`, one is generated and returned
  // as `accessPassword`: show it to the business ONCE and never store it. The salt goes into your secret store.
  async createCard({ businessId, settlement, password, relayer }) {
    const accessPassword = password ?? generateAccessPassword();
    if (password) assertNewPassword(password);
    const { salt, accessKey } = createAccess(accessPassword);
    const wallet = createArcWallet({ password: accessPassword, businessId });
    const settlementAddress = settlement || wallet.address;
    const hash = hashBusinessId(businessId);

    let receipt;
    try {
      const tx = await this.contract.createCard(hash, settlementAddress, accessKey, relayer || (await this.signer.getAddress()));
      receipt = await tx.wait();
    } catch (e) {
      throw toZionError(e, factoryIface, cardIface);
    }
    const card = await this.contract.cardOf(hash);

    if (this.secrets) {
      await this.secrets.setSalt(businessId, salt);
      await this.secrets.setWallet(businessId, wallet.encrypted);
    }
    return {
      businessId,
      businessIdHash: hash,
      card,
      settlement: settlementAddress,
      wallet: { address: wallet.address },
      accessPassword: password ? undefined : accessPassword,
      salt: this.secrets ? undefined : salt,
      txHash: receipt.hash,
      createdBlock: receipt.blockNumber,
    };
  }

  async createWallet({ businessId, password }) {
    const walletPassword = password ?? generateAccessPassword();
    const wallet = createArcWallet({ password: walletPassword, businessId });
    if (this.secrets) await this.secrets.setWallet(businessId, wallet.encrypted);
    return {
      businessId,
      wallet: { address: wallet.address },
      accessPassword: password ? undefined : walletPassword,
    };
  }

  async getCardData({ businessId }) {
    const hash = hashBusinessId(businessId);
    
    const cardAddress = await this.cardAddress(businessId);
    if (!cardAddress) {
      throw new ZionError({
        code: 'ACCOUNT_NOT_FOUND',
        message: `No account exists for business "${businessId}".`,
        httpStatus: 404
      });
    }

    let info = null;
    try {
      info = await this.contract.getCardInfo(hash);
    } catch (err) {
      throw new ZionError({
        code: 'CONTRACT_ERROR',
        message: `Error occurred while fetching card info for business "${businessId}".`,
        httpStatus: 500
      });
    }

    // 3. Fallback logic
    let settlement = info?.card !== ZeroAddress ? info?.settlement : null;
    if (!settlement || settlement === ZeroAddress) {
      const cardContract = await this.card(businessId);
      const cardStatus = await cardContract.info();
      settlement = cardStatus.settlement;
    }

    const salt = this.secrets ? await this.secrets.getSalt(businessId) : null;
    const wallet = this.secrets ? await this.secrets.getWallet(businessId) : null;

    return {
      businessId,
      businessIdHash: hash,
      card: cardAddress,
      settlement,
      relayer: info?.relayer !== ZeroAddress ? info?.relayer : null,
      accessKey: info?.accessKey !== ZeroAddress ? info?.accessKey : null,
      wallet: { address: wallet && wallet.address ? wallet.address : null },
      accessPassword: undefined,
      salt: salt ?? undefined,
      createdBlock: info?.createdBlock ? Number(info.createdBlock) : null,
      createdAt: info?.createdAt ? Number(info.createdAt) : null,
    };
  }

  async getCard({ businessId }) {
    return this.getCardData({ businessId });
  }

  async loadWallet({ businessId, password }) {
    if (!this.secrets) throw new Error('Pass a `secrets` store to ZionCards so it can decrypt the wallet');
    const encrypted = await this.secrets.getWallet(businessId);
    if (!encrypted) throw new ZionError({ code: 'WALLET_NOT_FOUND', message: `No Arc wallet stored for business "${businessId}".`, httpStatus: 404 });
    if (!password) return { businessId, wallet: { address: encrypted.address } };
    const wallet = loadArcWallet({ ...encrypted, businessId, password });
    return { businessId, wallet: { address: wallet.address } };
  }

  // Address of a business's card, or null if it has none.
  async cardAddress(businessId) {
    const address = await this.contract.cardOf(hashBusinessId(businessId));
    return address === ZeroAddress ? null : address;
  }

  // A low-level Card handle (for explicit salts or admin calls).
  async card(businessId, signer = this.signer) {
    const address = await this.cardAddress(businessId);
    if (!address) {
      throw new ZionError({ code: 'ACCOUNT_NOT_FOUND', message: `No account exists for business "${businessId}".`, httpStatus: 404 });
    }
    return new Card(address, signer);
  }

  async status(businessId) {
    return (await this.card(businessId)).info();
  }

  async balance(businessId) {
    return (await this.card(businessId)).balance();
  }

  // The receiver address depends on the amount the business is owed for this invoice.
  async paymentReceiver({ businessId, invoiceId, expectedAmount }) {
    return this.contract.predictReceiver(hashBusinessId(businessId), hashBusinessId(invoiceId), toRawExpected(expectedAmount));
  }

  async virtualRemitBalance({ businessId, invoiceId, expectedAmount }) {
    const [receiver, card] = await Promise.all([
      this.paymentReceiver({ businessId, invoiceId, expectedAmount }), this.cardAddress(businessId),
    ]);
    const [receiverRaw, cardRaw] = await Promise.all([
      this.provider.getBalance(receiver), this.provider.getBalance(card),
    ]);
    return { receiver, receiverBalance: formatUsdc(receiverRaw), receiverBalanceRaw: receiverRaw.toString(), card, cardBalance: formatUsdc(cardRaw), cardBalanceRaw: cardRaw.toString() };
  }

  // On-chain proof for this invoice: receiver deployment state, direct balances, and all factory sweep events.
  async virtualRemitStatus({ businessId, invoiceId, expectedAmount, fromBlock = 0 }) {
    const businessIdHash = hashBusinessId(businessId);
    const invoiceIdHash = hashBusinessId(invoiceId);
    const [balance, code, events] = await Promise.all([
      this.virtualRemitBalance({ businessId, invoiceId, expectedAmount }),
      this.provider.getCode(await this.paymentReceiver({ businessId, invoiceId, expectedAmount })),
      this.contract.queryFilter(this.contract.filters.ReceiverSwept(businessIdHash, invoiceIdHash), fromBlock),
    ]);
    const receiver = balance.receiver.toLowerCase();
    return {
      ...balance,
      deployed: code !== '0x',
      sweeps: events
        .filter((event) => String(event.args.receiver).toLowerCase() === receiver)
        .map((event) => ({
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          amount: formatUsdc(event.args.amount),
          amountRaw: event.args.amount.toString(),
          expectedAmount: formatUsdc(event.args.expectedAmount),
          fee: formatUsdc(event.args.fee),
          feeRaw: event.args.fee.toString(),
          net: formatUsdc(event.args.net),
          netRaw: event.args.net.toString(),
        })),
    };
  }

  // Deploys the receiver if needed and sweeps it. The business card gets up to `expectedAmount`;
  // anything above that (the excess) goes to the relayer as the fee. No excess means no fee.
  // 
  async sweepInvoice({ businessId, invoiceId, expectedAmount }) {
    const expectedRaw = toRawExpected(expectedAmount);
    const before = await this.virtualRemitBalance({ businessId, invoiceId, expectedAmount: expectedRaw });
    if (before.receiverBalanceRaw === '0') return { alreadySwept: true, swept: '0.0', before, after: before };
    try {
      
      const tx = await this.contract.sweep(hashBusinessId(businessId), hashBusinessId(invoiceId), expectedRaw);
      const receipt = await tx.wait();
      const after = await this.virtualRemitBalance({ businessId, invoiceId, expectedAmount: expectedRaw });

      let swept = null;
      for (const log of receipt.logs) {
        if (String(log.address).toLowerCase() !== String(this.factoryAddress).toLowerCase()) continue;
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed && parsed.name === 'ReceiverSwept') { swept = parsed.args; break; }
        } catch {
          // not a factory event we know; keep looking
        }
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        swept: before.receiverBalance,
        expectedAmount: formatUsdc(expectedRaw),
        fee: swept ? formatUsdc(swept.fee) : null,
        feeRaw: swept ? swept.fee.toString() : null,
        net: swept ? formatUsdc(swept.net) : null,
        netRaw: swept ? swept.net.toString() : null,
        before,
        after,
      };
    } catch (e) {
      throw toZionError(e, factoryIface, cardIface);
    }
  }

  // `expectedAmount` is what the business is owed; `amount` is what the customer sends through LayerSwap.
  async createLayerSwapRemit({ layerSwap, businessId, invoiceId, expectedAmount, sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', amount }) {
    if (!layerSwap || typeof layerSwap.createSwap !== 'function') throw new Error('Pass a LayerSwap client');
    const receiver = await this.paymentReceiver({ businessId, invoiceId, expectedAmount });
    const referenceId = `${invoiceId}_USDC_${Date.now()}`;
    const request = { sourceNetwork, sourceToken, destinationNetwork, destinationToken, destinationAddress: receiver, amount, referenceId };
    const swap = await layerSwap.createSwap(request);
    return { receiver, referenceId, request, swap };
  }

  async layerSwapSources({ layerSwap, destinationNetwork, destinationToken = 'USDC' }) {
    return layerSwap.sources({ destinationNetwork, destinationToken });
  }

  async layerSwapDestinations({ layerSwap, sourceNetwork, sourceToken = 'USDC' }) {
    return layerSwap.destinations({ sourceNetwork, sourceToken });
  }

  async layerSwapQuote({ layerSwap, sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', amount }) {
    return layerSwap.quote({ sourceNetwork, sourceToken, destinationNetwork, destinationToken, amount });
  }

  async layerSwapDetailedQuote({ layerSwap, sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', amount }) {
    return layerSwap.detailedQuote({ sourceNetwork, sourceToken, destinationNetwork, destinationToken, amount });
  }

  async layerSwapStatus({ layerSwap, swapId }) { return layerSwap.swap(swapId); }

  // ----- Actions that need the access password -----

  async withdraw({ businessId, amount, password }) {
    return (await this.card(businessId)).withdraw({ amount, password, salt: await this._salt(businessId) });
  }

  async withdrawAll({ businessId, password }) {
    return (await this.card(businessId)).withdrawAll({ password, salt: await this._salt(businessId) });
  }

  // Leave `newPassword` out to generate one; it comes back as `newAccessPassword` (show it once).
  async changePassword({ businessId, password, newPassword }) {
    const next = newPassword ?? generateAccessPassword();
    const card = await this.card(businessId);
    const result = await card.changePassword({ password, salt: await this._salt(businessId), newPassword: next });
    await this.secrets.setSalt(businessId, result.newSalt);
    return { ...result, newAccessPassword: newPassword ? undefined : next, newSalt: undefined };
  }

  async proposeSettlement({ businessId, newSettlement, password }) {
    return (await this.card(businessId)).proposeSettlement({ newSettlement, password, salt: await this._salt(businessId) });
  }

  async confirmSettlement({ businessId }) {
    return (await this.card(businessId)).confirmSettlement();
  }

  async cancelSettlement({ businessId, password }) {
    return (await this.card(businessId)).cancelSettlement({ password, salt: await this._salt(businessId) });
  }

  async addRelayer({ businessId, relayer, password }) {
    return (await this.card(businessId)).addRelayer({ relayer, password, salt: await this._salt(businessId) });
  }

  async removeRelayer({ businessId, relayer, password }) {
    return (await this.card(businessId)).removeRelayer({ relayer, password, salt: await this._salt(businessId) });
  }

  async upgrade({ businessId, implementation, data, password }) {
    return (await this.card(businessId)).upgrade({ implementation, data, password, salt: await this._salt(businessId) });
  }

  // ----- Payments and transactions -----

  // History for one business, read in safe chunks. For live updates use watcher().
  async payments({ businessId, fromBlock }) {
    return (await this.card(businessId)).payments({ fromBlock });
  }

  // Look up any transaction by its hash and see, in plain terms, what it did.
  //   status: 'not_found' | 'pending' | 'success' | 'failed'
  //   final : true once it has at least `confirmations` confirmations (Arc: 1 is final)
  async getTransaction(txHash, { confirmations = 1 } = {}) {
    const [tx, receipt] = await Promise.all([this.provider.getTransaction(txHash), this.provider.getTransactionReceipt(txHash)]);
    if (!tx) return { hash: txHash, found: false, status: 'not_found', confirmations: 0, final: false, events: [] };

    const base = { hash: txHash, found: true, from: tx.from, to: tx.to, value: formatUsdc(tx.value) };
    if (!receipt) return { ...base, status: 'pending', confirmations: 0, final: false, events: [] };

    const head = await this.provider.getBlockNumber();
    const count = head - receipt.blockNumber + 1;
    const events = await this.reader.decodeAll(receipt.logs, { head });
    return {
      ...base,
      status: receipt.status === 1 ? 'success' : 'failed',
      blockNumber: receipt.blockNumber,
      confirmations: count,
      final: receipt.status === 1 && count >= confirmations,
      gasUsed: receipt.gasUsed.toString(),
      events,
    };
  }

  // "Did this transaction really pay this business?" Use it to settle an invoice.
  async verifyPayment({ txHash, businessId, expectedAmount, confirmations = 1 }) {
    const tx = await this.getTransaction(txHash, { confirmations });
    const no = (reason, message, extra = {}) => ({ verified: false, reason, message, confirmations: tx.confirmations, ...extra });

    if (!tx.found) return no('TRANSACTION_NOT_FOUND', 'No transaction with that hash was found.');
    if (tx.status === 'pending') return no('NOT_CONFIRMED_YET', 'The transaction has not been included in a block yet.');
    if (tx.status === 'failed') return no('TRANSACTION_FAILED', 'The transaction failed, so no money moved.');

    const hash = hashBusinessId(businessId).toLowerCase();
    const mine = tx.events.filter((e) => e.type === 'payment.received' && e.businessIdHash.toLowerCase() === hash);
    if (!mine.length) return no('NO_PAYMENT_TO_THIS_ACCOUNT', 'This transaction did not pay this business.');

    const total = mine.reduce((sum, e) => sum + BigInt(e.data.amountRaw), 0n);
    const payment = { amount: formatUsdc(total), from: mine[0].data.from, card: mine[0].card, blockNumber: tx.blockNumber };
    if (tx.confirmations < confirmations) {
      return no('WAITING_FOR_CONFIRMATIONS', `Waiting for confirmations (${tx.confirmations} of ${confirmations}).`, { payment, required: confirmations });
    }
    if (expectedAmount !== undefined && total < usdc(expectedAmount)) {
      return no('AMOUNT_TOO_LOW', `The payment was ${formatUsdc(total)} USDC but ${expectedAmount} USDC was expected.`, { payment });
    }
    return { verified: true, reason: 'OK', message: 'Payment confirmed.', confirmations: tx.confirmations, payment };
  }

  // A ready-made listener for payments, withdrawals and every other card event. See EventWatcher.
  watcher(options = {}) {
    return new EventWatcher({
      provider: this.provider,
      factory: this.factoryAddress,
      resolveBusiness: this.resolveBusiness,
      ...options,
    });
  }

  async _salt(businessId) {
    if (!this.secrets) throw new Error('Pass a `secrets` store to ZionCards so it can look up the salt');
    const salt = await this.secrets.getSalt(businessId);
    if (!salt) throw new ZionError({ code: 'ACCOUNT_NOT_FOUND', message: `No access salt stored for business "${businessId}".`, httpStatus: 404 });
    return salt;
  }
}

module.exports = { deployFactory, ZionCards, hashBusinessId };
