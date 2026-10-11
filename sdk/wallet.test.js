const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArcWallet, loadArcWallet, EncryptedFileSecretStore } = require('./index');

const password = 'A!bCdef1234567!x';

test('createArcWallet encrypts the private key and loadArcWallet restores it', async () => {
    const wallet = createArcWallet({ password, businessId: 'biz_123' });

    assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(wallet.encrypted)
    assert.notEqual(wallet.privateKey, wallet.encrypted.privateKey);
    assert.notEqual(wallet.privateKey, undefined);

    const loaded = loadArcWallet({
        ...wallet.encrypted,
        password,
    });

    assert.equal(loaded.address, wallet.address);
    assert.equal(loaded.privateKey, wallet.privateKey);
});

test('EncryptedFileSecretStore can persist and reload an encrypted wallet', async () => {
    const tmpPath = path.join(os.tmpdir(), `arc-wallet-${Date.now()}.json`);
    const secrets = new EncryptedFileSecretStore({
        path: tmpPath,
        key: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    const wallet = createArcWallet({ password, businessId: 'biz_123' });
    await secrets.setWallet('biz_123', wallet.encrypted);

    const stored = await secrets.getWallet('biz_123');
    const reloaded = loadArcWallet({ ...stored, password });

    assert.equal(reloaded.address, wallet.address);
    assert.equal(reloaded.privateKey, wallet.privateKey);

    fs.unlinkSync(tmpPath);
});
