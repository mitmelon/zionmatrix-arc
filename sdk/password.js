const crypto = require('crypto');
const { Wallet } = require('ethers');
const { ZionError } = require('./errors');

// An access password is exactly 16 characters, with no spaces, and it is NOT only digits.
const LENGTH = 16;

// Characters used when we generate one for a business (no look-alikes such as 0/O or 1/l/I).
const CLASSES = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%&*?',
};

// secp256k1 curve order: a private key must be between 1 and ORDER - 1.
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Makes a random password (about 95 bits of randomness). Show it to the business once.
function generateAccessPassword() {
  const all = Object.values(CLASSES).join('');
  for (; ;) {
    let pw = '';
    for (let i = 0; i < LENGTH; i++) pw += all[crypto.randomInt(all.length)];
    if (Object.values(CLASSES).every((set) => [...pw].some((c) => set.includes(c)))) return pw;
  }
}

// "Xk7! mQ2p Ab9# Zr4T" is easier to read and copy than 16 characters in a row.
function formatAccessPassword(password) {
  return password.match(/.{1,4}/g).join(' ');
}

// Accepts what a person typed: trims and removes spaces used for readability.
function normalizeAccessPassword(input) {
  return String(input ?? '').replace(/\s+/g, '');
}

// Rules for a NEW password. Returns a list of problems (empty = fine).
function passwordProblems(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length !== LENGTH) problems.push(`must be exactly ${LENGTH} characters`);
  else {
    if (/\s/.test(password)) problems.push('must not contain spaces');
    if (/^\d+$/.test(password)) problems.push('must not be only numbers');
    if (new Set(password).size < 6) problems.push('must not repeat the same few characters');
  }
  return problems;
}

function assertNewPassword(password) {
  const problems = passwordProblems(password);
  if (problems.length) {
    throw new ZionError({
      code: 'WEAK_PASSWORD',
      message: `The access password ${problems.join(', ')}.`,
      httpStatus: 400,
    });
  }
}

// For an EXISTING password a typo must not count as a wrong attempt on the account.
function assertWellFormed(password) {
  if (typeof password !== 'string' || password.length !== LENGTH || /\s/.test(password)) {
    throw new ZionError({
      code: 'INVALID_PASSWORD_FORMAT',
      message: `The access password must be exactly ${LENGTH} characters. Please check it and try again.`,
      httpStatus: 400,
    });
  }
}

function newSalt() {
  return '0x' + crypto.randomBytes(32).toString('hex');
}

function deriveWalletEncryptionKey(password, salt, domain = 'arc-wallet:v1') {
  const text = String(password ?? '').normalize('NFKC');
  const saltBytes = Buffer.from(String(salt).replace(/^0x/, ''), 'hex');
  return crypto.scryptSync(`${domain}:${text}`, saltBytes, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
}

function encryptWalletPrivateKey(privateKey, password, salt, domain = 'arc-wallet:v1') {
  const key = deriveWalletEncryptionKey(password, salt, domain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const raw = Buffer.from(String(privateKey).replace(/^0x/, ''), 'hex');
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  return {
    salt,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    privateKey: encrypted.toString('hex'),
  };
}

function decryptWalletPrivateKey({ salt, iv, tag, privateKey }, password, domain = 'arc-wallet:v1') {
  const key = deriveWalletEncryptionKey(password, salt, domain);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(privateKey, 'hex')), decipher.final()]);
  return '0x' + plain.toString('hex');
}

function createArcWallet({ password, businessId } = {}) {
  assertWellFormed(password);
  const wallet = Wallet.createRandom();
  const salt = newSalt();
  const domain = `arc-wallet:${String(businessId || 'default')}:v1`;
  const encrypted = encryptWalletPrivateKey(wallet.privateKey, password, salt, domain);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    encrypted: {
      address: wallet.address,
      businessId: businessId ? String(businessId) : undefined,
      salt,
      iv: encrypted.iv,
      tag: encrypted.tag,
      privateKey: encrypted.privateKey,
    },
  };
}

function loadArcWallet({ password, businessId, address, salt, iv, tag, privateKey, encryptedPrivateKey } = {}) {
  assertWellFormed(password);
  const cipherText = privateKey ?? encryptedPrivateKey;
  if (!cipherText || !salt || !iv || !tag) {
    if (privateKey && !salt && !iv && !tag) return { address, privateKey };
    throw new ZionError({
      code: 'WALLET_NOT_FOUND',
      message: 'No encrypted Arc wallet exists for this business.',
      httpStatus: 404,
    });
  }

  const wallet = new Wallet(decryptWalletPrivateKey({ salt, iv, tag, privateKey: cipherText }, password, `arc-wallet:${String(businessId || 'default')}:v1`));
  return { address: address || wallet.address, privateKey: wallet.privateKey };
}

// Slow, memory-hard hash (scrypt): password + secret salt -> private key.
function deriveKey(password, salt) {
  const text = password.normalize('NFKC');
  const saltBytes = Buffer.from(salt.replace(/^0x/, ''), 'hex');
  for (let i = 0; ; i++) {
    const key = crypto.scryptSync(i === 0 ? text : `${text}:${i}`, saltBytes, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
    const n = BigInt('0x' + key.toString('hex'));
    if (n > 0n && n < ORDER) return '0x' + key.toString('hex');
  }
}

// The wallet that signs access approvals. It is never stored or sent; only its address goes on-chain.
function accessWallet(password, salt) {
  assertWellFormed(password);
  return new Wallet(deriveKey(password, salt));
}

// Once per business (and again whenever the password changes):
// put `accessKey` on the card, keep `salt` in your secret store.
function createAccess(password) {
  assertNewPassword(password);
  const salt = newSalt();
  return { salt, accessKey: accessWallet(password, salt).address };
}

module.exports = {
  LENGTH,
  generateAccessPassword,
  formatAccessPassword,
  normalizeAccessPassword,
  passwordProblems,
  assertNewPassword,
  assertWellFormed,
  newSalt,
  deriveWalletEncryptionKey,
  encryptWalletPrivateKey,
  decryptWalletPrivateKey,
  createArcWallet,
  loadArcWallet,
  accessWallet,
  createAccess,
};
