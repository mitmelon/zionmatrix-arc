// End-to-end check of the SDK against a local node.
//   Terminal 1:  anvil --chain-id 5042002
//   Terminal 2:  npm run test:e2e
const assert = require('assert');
const http = require('http');
const { Wallet, HDNodeWallet, Interface, AbiCoder } = require('ethers');
const sdk = require('../sdk');
const {
  makeProvider, deployFactory, ZionCards, ZionAdmin, MemorySecretStore, MemoryEventStore, forwardToWebhook,
  verifyWebhook, WebhookSender, generateAccessPassword, usdc, formatUsdc, MIN_FEE, hashBusinessId,
} = sdk;

const MNEMONIC = 'test test test test test test test test test test test junk';
const KEYS = [0, 1, 2, 3, 4].map((i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).privateKey);

const ok = (msg) => console.log(`  ok  ${msg}`);
async function expectFail(name, fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `${name}: expected ${code}, got ${e.code} (${e.message})`);
    ok(`${name} -> ${code}: "${e.message}"`);
    return e;
  }
  throw new Error(`${name}: should have failed`);
}

(async () => {
  const provider = makeProvider(process.env.RPC_URL || 'http://127.0.0.1:8545');
  const [deployer, relayer2Wallet, payer, settlementWallet, newSettlementWallet] = KEYS.map((k) => new Wallet(k, provider));
  const jump = async (seconds) => { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); };
  const mine = (n) => Promise.all(Array.from({ length: n }, () => provider.send('evm_mine', [])));
  const pay = async (to, amount) => (await (await payer.sendTransaction({ to, value: usdc(amount) })).wait());

  console.log('1. deploy the factory and open an account (no wallet for the business)');
  const dep = await deployFactory(deployer);
  const secrets = new MemorySecretStore();
  const zion = new ZionCards(dep.address, deployer, { secrets });
  const admin = new ZionAdmin(dep.address, deployer, { secrets });
  const created = await zion.createCard({ businessId: 'biz_001', settlement: settlementWallet.address });
  assert.ok(created.accessPassword && created.accessPassword.length === 16, 'password generated');
  assert.strictEqual(created.salt, undefined, 'salt goes to the secret store, not back to the caller');
  const PW = created.accessPassword;
  ok(`account ${created.card}, generated password has ${PW.length} characters`);
  await expectFail('same business twice', () => zion.createCard({ businessId: 'biz_001', settlement: settlementWallet.address }), 'ACCOUNT_EXISTS');
  await expectFail('digits-only password', () => zion.createCard({ businessId: 'biz_x', settlement: settlementWallet.address, password: '1234567890123456' }), 'WEAK_PASSWORD');
  await expectFail('15-character password', () => zion.createCard({ businessId: 'biz_x', settlement: settlementWallet.address, password: 'abcDEF123!@#xyz' }), 'WEAK_PASSWORD');
  await expectFail('unknown business', () => zion.balance('nobody'), 'ACCOUNT_NOT_FOUND');

  console.log('2. listener: confirmations');
  const seen = [];
  const head0 = await provider.getBlockNumber();
  const strict = zion.watcher({ confirmations: 3, startBlock: head0 + 1, store: new MemoryEventStore(), resolveBusiness: async (h) => (h === hashBusinessId('biz_001') ? 'biz_001' : null) });
  strict.on('*', (e) => seen.push(e));
  const receipt = await pay(created.card, '25');
  assert.strictEqual(await strict.pollOnce(), 0);
  ok('payment with 1 confirmation is NOT delivered yet (needs 3)');
  await mine(2);
  assert.strictEqual(await strict.pollOnce(), 1);
  assert.strictEqual(seen[0].type, 'payment.received');
  assert.strictEqual(seen[0].data.amount, '25.0');
  assert.strictEqual(seen[0].businessId, 'biz_001');
  assert.strictEqual(seen[0].txHash, receipt.hash);
  assert.ok(seen[0].confirmations >= 3);
  assert.strictEqual(await strict.pollOnce(), 0);
  ok(`delivered after 3 confirmations, exactly once (confirmations=${seen[0].confirmations})`);

  console.log('3. look up a transaction by hash');
  const info = await zion.getTransaction(receipt.hash);
  assert.strictEqual(info.status, 'success');
  assert.ok(info.final);
  assert.strictEqual(info.events[0].type, 'payment.received');
  ok(`status=${info.status}, confirmations=${info.confirmations}, event=${info.events[0].type}`);
  assert.strictEqual((await zion.getTransaction('0x' + '11'.repeat(32))).status, 'not_found');
  ok('unknown hash -> not_found');
  const v1 = await zion.verifyPayment({ txHash: receipt.hash, businessId: 'biz_001', expectedAmount: '25' });
  assert.ok(v1.verified); ok('verifyPayment: verified');
  assert.strictEqual((await zion.verifyPayment({ txHash: receipt.hash, businessId: 'biz_001', expectedAmount: '30' })).reason, 'AMOUNT_TOO_LOW');
  assert.strictEqual((await zion.verifyPayment({ txHash: receipt.hash, businessId: 'someone_else' })).reason, 'NO_PAYMENT_TO_THIS_ACCOUNT');
  assert.strictEqual((await zion.verifyPayment({ txHash: receipt.hash, businessId: 'biz_001', confirmations: 500 })).reason, 'WAITING_FOR_CONFIRMATIONS');
  ok('verifyPayment: amount too low / wrong business / waiting for confirmations');
  const sent = await provider.getTransaction(receipt.hash);
  assert.ok(sent.maxFeePerGas >= MIN_FEE);
  ok(`fee floor respected (maxFeePerGas ${(sent.maxFeePerGas / 10n ** 9n)} Gwei)`);

  console.log('4. withdraw with the access password');
  const before = await provider.getBalance(settlementWallet.address);
  await zion.withdraw({ businessId: 'biz_001', amount: '10', password: PW });
  assert.strictEqual(formatUsdc((await provider.getBalance(settlementWallet.address)) - before), '10.0');
  assert.strictEqual(await zion.balance('biz_001'), '15.0');
  ok('settlement received 10 USDC');
  await strict.pollOnce(); await mine(2); await strict.pollOnce();
  assert.ok(seen.some((e) => e.type === 'withdrawal.completed' && e.data.amount === '10.0'));
  ok('listener reported withdrawal.completed');

  console.log('5. wrong passwords: counted on-chain, readable errors');
  const wrong = 'Wrong-Password-1';
  await expectFail('badly formed password (15 chars)', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: 'short15chars!!!!' .slice(0, 15) }), 'INVALID_PASSWORD_FORMAT');
  assert.strictEqual((await zion.status('biz_001')).lock.attemptsLeft, 3);
  ok('a malformed password is rejected locally and is NOT counted');
  const e1 = await expectFail('wrong password #1', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: wrong }), 'WRONG_PASSWORD');
  assert.strictEqual(e1.details.attemptsLeft, 2);
  const e2 = await expectFail('wrong password #2', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: wrong }), 'WRONG_PASSWORD');
  assert.strictEqual(e2.details.attemptsLeft, 1);
  await expectFail('wrong password #3 locks for 24h', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: wrong }), 'WRONG_PASSWORD_LOCKED');
  await expectFail('right password while locked', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW }), 'ACCOUNT_LOCKED');
  await pay(created.card, '1');
  ok('deposits still accepted while locked');
  await jump(24 * 3600 + 5);
  await expectFail('one wrong attempt after the lock -> permanent', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: wrong }), 'WRONG_PASSWORD_LOCKED_PERMANENTLY');
  await expectFail('right password, permanently locked', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW }), 'ACCOUNT_LOCKED_PERMANENTLY');
  await jump(30 * 24 * 3600);
  await expectFail('still locked a month later', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW }), 'ACCOUNT_LOCKED_PERMANENTLY');
  await admin.unlockCard('biz_001');
  assert.strictEqual((await zion.status('biz_001')).lock.attemptsLeft, 3);
  await zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW });
  ok('admin unlocked it; the right password works again');
  await strict.pollOnce(); await mine(2); await strict.pollOnce();
  const types = seen.map((e) => e.type);
  for (const t of ['access.password_rejected', 'account.locked', 'account.unfrozen']) assert.ok(types.includes(t), `listener should report ${t}`);
  assert.ok(seen.some((e) => e.type === 'account.locked' && e.data.forever === true));
  ok('listener reported access.password_rejected, account.locked (24h and permanent), account.unfrozen');

  console.log('6. change the access password');
  const changed = await zion.changePassword({ businessId: 'biz_001', password: PW });
  const PW2 = changed.newAccessPassword;
  assert.ok(PW2 && PW2 !== PW);
  await expectFail('old password after the change', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW }), 'WRONG_PASSWORD');
  await zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 });
  ok('new password works, old one is rejected');

  console.log('7. relayers (servers allowed to submit)');
  await zion.addRelayer({ businessId: 'biz_001', relayer: relayer2Wallet.address, password: PW2 });
  const viaRelayer2 = new ZionCards(dep.address, relayer2Wallet, { secrets });
  await viaRelayer2.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 });
  ok('a second relayer, added with the password, can submit withdrawals');
  await zion.removeRelayer({ businessId: 'biz_001', relayer: dep.creator, password: PW2 });
  await expectFail('removed relayer', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 }), 'NOT_AUTHORISED');
  await expectFail('removing the last relayer', () => viaRelayer2.removeRelayer({ businessId: 'biz_001', relayer: relayer2Wallet.address, password: PW2 }), 'LAST_RELAYER');
  await viaRelayer2.addRelayer({ businessId: 'biz_001', relayer: dep.creator, password: PW2 });
  ok('relayer removed with the password; the last one cannot be removed');

  console.log('8. settlement address (24h delay)');
  await zion.proposeSettlement({ businessId: 'biz_001', newSettlement: newSettlementWallet.address, password: PW2 });
  await expectFail('confirm too early', () => zion.confirmSettlement({ businessId: 'biz_001' }), 'TOO_EARLY');
  await jump(24 * 3600 + 1);
  await zion.confirmSettlement({ businessId: 'biz_001' });
  const b2 = await provider.getBalance(newSettlementWallet.address);
  await zion.withdrawAll({ businessId: 'biz_001', password: PW2 });
  assert.ok((await provider.getBalance(newSettlementWallet.address)) > b2);
  ok('funds now go to the new settlement address');
  await expectFail('withdraw from an empty account', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 }), 'INSUFFICIENT_BALANCE');

  console.log('9. webhooks');
  const SECRET = 'whsec_test_123';
  const received = [];
  let failures = 1; // answer 500 once to prove retries work
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failures-- > 0) { res.writeHead(500); return res.end(); }
      try {
        received.push(verifyWebhook({ rawBody: body, signature: req.headers['x-zion-signature'], secret: SECRET }));
        res.writeHead(200); res.end('ok');
      } catch (e) { res.writeHead(401); res.end(e.code); }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/hooks`;
  const hookWatcher = zion.watcher({ confirmations: 1, startBlock: (await provider.getBlockNumber()) + 1, store: new MemoryEventStore() });
  forwardToWebhook(hookWatcher, { url, secret: SECRET, types: ['payment.received', 'withdrawal.completed'], backoffMs: 10 });
  const payTx = await pay(created.card, '4');
  await hookWatcher.pollOnce();
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, 'payment.received');
  assert.strictEqual(received[0].txHash, payTx.hash);
  assert.strictEqual(received[0].data.amount, '4.0');
  ok('payment webhook delivered (after one 500 + retry), signature verified');
  await zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 });
  await hookWatcher.pollOnce();
  assert.strictEqual(received[1].type, 'withdrawal.completed');
  ok('withdrawal webhook delivered');
  await expectFail('tampered webhook body', async () => verifyWebhook({ rawBody: '{"a":1}', signature: `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}`, secret: SECRET }), 'INVALID_WEBHOOK_SIGNATURE');
  await expectFail('stale webhook', async () => verifyWebhook({ rawBody: '{}', signature: 't=1000,v1=ab', secret: SECRET }), 'INVALID_WEBHOOK_SIGNATURE');
  const dead = new WebhookSender({ url: 'http://127.0.0.1:9/never', secret: SECRET, retries: 1, backoffMs: 5, timeoutMs: 500 });
  await expectFail('endpoint down', () => dead.send({ id: 'x:1', type: 'payment.received' }), 'WEBHOOK_DELIVERY_FAILED');
  await new Promise((r) => server.close(r));

  console.log('10. a fake card cannot fool the listener');
  await strict.pollOnce(); await mine(2); await strict.pollOnce(); // catch up on earlier events first
  const fakeArt = require('./fixtures/FakeCard.json');
  const { ContractFactory } = require('ethers');
  const fake = await new ContractFactory(fakeArt.abi, fakeArt.bytecode, payer).deploy();
  await fake.waitForDeployment();
  const fakeTx = await (await fake.fake(hashBusinessId('biz_001'), { value: usdc('100') })).wait();
  const count = seen.length;
  await mine(2);
  await strict.pollOnce();
  assert.strictEqual(seen.length, count);
  ok('a contract that emits PaymentReceived for biz_001, but was not made by the factory, is ignored');
  const faked = await zion.verifyPayment({ txHash: fakeTx.hash, businessId: 'biz_001' });
  assert.strictEqual(faked.verified, false);
  assert.strictEqual(faked.reason, 'NO_PAYMENT_TO_THIS_ACCOUNT');
  ok('verifyPayment refuses the fake payment too');

  console.log('11. emergency stops');
  await pay(created.card, '3');
  await admin.freezeCard('biz_001');
  await expectFail('withdraw while frozen', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 }), 'ACCOUNT_FROZEN');
  await admin.unlockCard('biz_001');
  await admin.haltWithdrawals();
  await expectFail('withdraw while halted', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 }), 'WITHDRAWALS_PAUSED');
  await admin.resumeWithdrawals();
  await zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 });
  ok('freeze, unlock, global halt and resume all behave');

  console.log('12. lost password: recovery after 72h');
  const rec = await admin.startRecovery({ businessId: 'biz_001', settlement: settlementWallet.address, relayer: dep.creator });
  await jump(72 * 3600 + 1);
  await admin.finishRecovery({ businessId: 'biz_001', newSalt: rec.newSalt });
  await expectFail('old password after recovery', () => zion.withdraw({ businessId: 'biz_001', amount: '1', password: PW2 }), 'WRONG_PASSWORD');
  await zion.withdraw({ businessId: 'biz_001', amount: '1', password: rec.newAccessPassword });
  ok('recovery gave the business a new password');

  console.log('13. upgrade a card (password + approved version only)');
  const v2 = require('./fixtures/BusinessCardV2.json');
  const impl = await admin.deployImplementation(v2);
  const NEW = rec.newAccessPassword;
  await expectFail('upgrade before approval', () => zion.upgrade({ businessId: 'biz_001', implementation: impl, password: NEW }), 'UPGRADE_NOT_ALLOWED');
  await admin.proposeUpgrade(impl);
  await expectFail('approve before the 7-day delay', () => admin.approveUpgrade(impl), 'TOO_EARLY');
  await jump(7 * 24 * 3600 + 1);
  await admin.approveUpgrade(impl);
  await expectFail('upgrade with the wrong password', () => zion.upgrade({ businessId: 'biz_001', implementation: impl, password: wrong }), 'WRONG_PASSWORD');
  const migrate = new Interface(v2.abi).encodeFunctionData('migrate');
  await zion.upgrade({ businessId: 'biz_001', implementation: impl, data: migrate, password: NEW });
  const up = await zion.status('biz_001');
  assert.strictEqual(up.version, '2.0.0');
  ok(`card now runs ${up.version} and kept its balance (${up.balance} USDC) and settings`);

  console.log('14. admin handover (two steps)');
  const next = new ZionAdmin(dep.address, newSettlementWallet);
  await admin.beginAdminTransfer(newSettlementWallet.address);
  await expectFail('accept before the delay', () => next.acceptAdminTransfer(), 'TOO_EARLY');
  await jump(3 * 24 * 3600 + 1);
  await next.acceptAdminTransfer();
  assert.strictEqual((await next.adminTransferStatus()).currentAdmin, newSettlementWallet.address);
  ok('new admin is in charge');

  console.log('\nALL CHECKS PASSED');
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
