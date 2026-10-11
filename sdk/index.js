const { deployFactory, ZionCards, hashBusinessId } = require('./factory');
const { ZionAdmin } = require('./admin');
const { Card } = require('./card');
const password = require('./password');
const { createArcWallet, loadArcWallet } = password;
const { ZionError, toZionError } = require('./errors');
const { EventWatcher, MemoryEventStore, FileEventStore, CardLogReader } = require('./events');
const { MemorySecretStore, EncryptedFileSecretStore } = require('./secrets');
const { makeProvider, MIN_FEE } = require('./provider');
const { usdc, formatUsdc } = require('./units');
const networks = require('./networks');
const { LayerSwap } = require('./layerswap');

module.exports = {
  // main APIs
  ZionCards,
  ZionAdmin,
  Card,
  deployFactory,
  hashBusinessId,
  // access password
  generateAccessPassword: password.generateAccessPassword,
  formatAccessPassword: password.formatAccessPassword,
  normalizeAccessPassword: password.normalizeAccessPassword,
  passwordProblems: password.passwordProblems,
  createAccess: password.createAccess,
  accessWallet: password.accessWallet,
  createArcWallet,
  loadArcWallet,
  // listening and webhooks
  EventWatcher,
  MemoryEventStore,
  FileEventStore,
  CardLogReader,
  // secrets
  MemorySecretStore,
  EncryptedFileSecretStore,
  // errors
  ZionError,
  toZionError,
  // helpers
  makeProvider,
  MIN_FEE,
  usdc,
  formatUsdc,
  networks,
  LayerSwap,
};
