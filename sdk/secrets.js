const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A secret store keeps each business's salt (the second half of its access key).
// Anything with these two async methods works, so you can back it with a vault or a database:
//   getSalt(businessId) -> salt string | null
//   setSalt(businessId, salt)

class MemorySecretStore {
  constructor() { this.map = new Map(); }
  async getSalt(id) {
    const row = this.map.get(id) ?? {};
    return row.salt ?? null;
  }
  async setSalt(id, salt) {
    const row = this.map.get(id) ?? {};
    row.salt = salt;
    this.map.set(id, row);
  }
  async getWallet(id) {
    const row = this.map.get(id) ?? {};
    return row.wallet ?? null;
  }
  async setWallet(id, wallet) {
    const row = this.map.get(id) ?? {};
    row.wallet = wallet;
    this.map.set(id, row);
  }
}

// Salts in a file, each one encrypted with AES-256-GCM. `key` is 32 bytes (64 hex characters)
// that you keep OUTSIDE the file, for example in an environment variable.
class EncryptedFileSecretStore {
  constructor({ path: filePath, key }) {
    if (!/^[0-9a-fA-F]{64}$/.test(key || '')) throw new Error('key must be 64 hex characters (32 bytes)');
    this.path = filePath;
    this.key = Buffer.from(key, 'hex');
    this._ensureFile();
  }

  // Ensures directory tree and initial JSON file exist
  _ensureFile() {
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, JSON.stringify({}, null, 2), { mode: 0o600 });
    }
  }

  _load() {
    this._ensureFile();
    try {
      const content = fs.readFileSync(this.path, 'utf8').trim();
      return content ? JSON.parse(content) : {};
    } catch {
      return {};
    }
  }

  _write(all) {
    this._ensureFile();
    fs.writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  _encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
  }

  _decrypt(row) {
    if (!row) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(row.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(row.data, 'hex')), decipher.final()]);
    try {
      return JSON.parse(plain.toString('utf8'));
    } catch {
      return plain.toString('utf8');
    }
  }

  async getSalt(id) {
    const row = this._load()[id];
    if (!row || !row.salt) return null;
    return this._decrypt(row.salt);
  }

  async setSalt(id, salt) {
    const all = this._load();
    const row = all[id] ?? {};
    row.salt = this._encrypt(salt);
    all[id] = row;
    this._write(all);
  }

  async getWallet(id) {
    const row = this._load()[id];
    if (!row || !row.wallet) return null;
    return this._decrypt(row.wallet);
  }

  async setWallet(id, wallet) {
    const all = this._load();
    const row = all[id] ?? {};
    row.wallet = this._encrypt(wallet);
    all[id] = row;
    this._write(all);
  }
}

module.exports = { MemorySecretStore, EncryptedFileSecretStore };