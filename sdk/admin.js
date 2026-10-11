const { Contract, ContractFactory, Wallet, ZeroAddress } = require('ethers');
const factoryArtifact = require('./artifacts/BusinessCardFactory.json');
const cardArtifact = require('./artifacts/BusinessCard.json');
const { Card } = require('./card');
const { createAccess, generateAccessPassword, assertNewPassword } = require('./password');
const { toZionError } = require('./errors');
const { makeProvider } = require('./provider');
const { cardIface, factoryIface } = require('./events');
const { hashBusinessId } = require('./factory');

const ROLES = ['CREATOR_ROLE', 'GUARDIAN_ROLE', 'RECOVERY_ROLE'];

// ZionMatrix-side controls: card versions (upgrades), emergency stops, unlocking accounts, roles.
// Use the wallet that holds the matching role (admin for upgrades, guardian for stops, recovery for unlocks).
class ZionAdmin {
  constructor(factoryAddress, signer, { secrets } = {}) {
    this.signer = signer;
    this.address = factoryAddress;
    this.secrets = secrets;
    this.contract = new Contract(factoryAddress, factoryArtifact.abi, signer);
  }

  static connect({ rpcUrl, privateKey, factory, secrets }) {
    return new ZionAdmin(factory, new Wallet(privateKey, makeProvider(rpcUrl)), { secrets });
  }

  async _send(call) {
    try {
      const tx = await call();
      const receipt = await tx.wait();
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    } catch (e) {
      throw toZionError(e, factoryIface, cardIface);
    }
  }

  async _card(businessId) {
    const address = await this.contract.cardOf(hashBusinessId(businessId));
    if (address === ZeroAddress) throw new Error(`No account for ${businessId}`);
    return new Card(address, this.signer);
  }

  // ----- Accounts: locks and recovery -----

  freezeCard(businessId) { return this._card(businessId).then((c) => c.freeze()); }

  // Lifts any lock (emergency freeze, 24-hour lock, permanent lock). Needs the RECOVERY wallet.
  // This is what you run when a business contacts support.
  unlockCard(businessId) { return this._card(businessId).then((c) => c.unfreeze()); }

  // Lost password: sets a new one after a 72-hour public delay. Returns the new password to give to the business.
  async startRecovery({ businessId, settlement, relayer, newPassword }) {
    const card = await this._card(businessId);
    const password = newPassword ?? generateAccessPassword();
    if (newPassword) assertNewPassword(password);
    const { salt, accessKey } = createAccess(password);
    const result = await this._send(() => card.contract.proposeRecovery(settlement, accessKey, relayer));
    return { ...result, newAccessPassword: password, newSalt: salt, note: 'Call finishRecovery after 72 hours, then store newSalt.' };
  }

  async finishRecovery({ businessId, newSalt }) {
    const card = await this._card(businessId);
    const result = await this._send(() => card.contract.executeRecovery());
    if (this.secrets && newSalt) await this.secrets.setSalt(businessId, newSalt);
    return result;
  }

  vetoRecovery(businessId) { return this._card(businessId).then((c) => c.vetoRecovery()); }
  vetoSettlement(businessId) { return this._card(businessId).then((c) => c.vetoSettlement()); }

  // ----- Upgrades: deploy a new card version, propose, wait 7 days, approve -----

  // Deploys a new BusinessCard implementation built for this factory. Returns its address.
  async deployImplementation(artifact = cardArtifact) {
    const c = await new ContractFactory(artifact.abi, artifact.bytecode, this.signer).deploy(this.address);
    await c.waitForDeployment();
    return c.getAddress();
  }

  proposeUpgrade(implementation) { return this._send(() => this.contract.proposeUpgrade(implementation)); }
  approveUpgrade(implementation, { makeDefault = false } = {}) { return this._send(() => this.contract.approveUpgrade(implementation, makeDefault)); }
  cancelUpgrade(implementation) { return this._send(() => this.contract.cancelUpgrade(implementation)); }
  revokeUpgrade(implementation) { return this._send(() => this.contract.revokeUpgrade(implementation)); }

  async upgradeStatus(implementation) {
    const [approved, readyAt, current] = await Promise.all([
      this.contract.approved(implementation),
      this.contract.upgradeReadyAt(implementation),
      this.contract.defaultImplementation(),
    ]);
    return { approved, proposed: readyAt !== 0n, readyAt: Number(readyAt), isDefault: current.toLowerCase() === implementation.toLowerCase() };
  }

  // ----- Emergency -----

  haltWithdrawals() { return this._send(() => this.contract.haltWithdrawals()); }
  resumeWithdrawals() { return this._send(() => this.contract.resumeWithdrawals()); }
  pauseCreation() { return this._send(() => this.contract.pauseCreation()); }
  unpauseCreation() { return this._send(() => this.contract.unpauseCreation()); }

  // ----- Roles -----

  async grantRole(role, account) {
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    return this._send(async () => this.contract.grantRole(await this.contract[role](), account));
  }

  async revokeRole(role, account) {
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    return this._send(async () => this.contract.revokeRole(await this.contract[role](), account));
  }

  async roles(account) {
    const out = {};
    for (const role of ROLES) out[role] = await this.contract.hasRole(await this.contract[role](), account);
    out.ADMIN = await this.contract.hasRole(await this.contract.DEFAULT_ADMIN_ROLE(), account);
    return out;
  }

  // ----- Admin handover (two steps, with a delay) -----

  beginAdminTransfer(newAdmin) { return this._send(() => this.contract.beginDefaultAdminTransfer(newAdmin)); }
  acceptAdminTransfer() { return this._send(() => this.contract.acceptDefaultAdminTransfer()); }
  cancelAdminTransfer() { return this._send(() => this.contract.cancelDefaultAdminTransfer()); }

  async adminTransferStatus() {
    const [pending, schedule] = await this.contract.pendingDefaultAdmin();
    return {
      currentAdmin: await this.contract.defaultAdmin(),
      pendingAdmin: pending === ZeroAddress ? null : pending,
      acceptableAt: Number(schedule),
    };
  }
}

module.exports = { ZionAdmin };
