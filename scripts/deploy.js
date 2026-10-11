// Deploys the BusinessCardFactory.
// Same source is used for testnet and mainnet. Switch the chain with RPC_URL and NETWORK.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Wallet, formatUnits } = require('ethers');
const { makeProvider, deployFactory, networks } = require('../sdk');

async function main() {
  const name = process.argv[2] || process.env.ZION_NETWORK || process.env.NETWORK || 'testnet';
  const net = networks[name];
  if (!net) throw new Error(`Unknown network "${name}". Use testnet or mainnet.`);

  const deployerKey = process.env.ADMIN_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || deployerKey;
  if (!deployerKey) throw new Error('Set ADMIN_PRIVATE_KEY or PRIVATE_KEY in .env');
  if (!relayerKey) throw new Error('Set RELAYER_PRIVATE_KEY or PRIVATE_KEY in .env');

  const rpcUrl = process.env.RPC_URL || net.rpcUrl;
  const provider = makeProvider(rpcUrl);
  const deployer = new Wallet(deployerKey, provider);
  const { chainId } = await provider.getNetwork();

  if (Number(chainId) !== net.chainId) {
    throw new Error(`RPC is on chain ${chainId} but ${net.name} is chain ${net.chainId}. Check RPC_URL.`);
  }

  const relayer = process.env.RELAYER_ADDRESS || new Wallet(relayerKey, provider).address;
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const guardian = process.env.GUARDIAN_ADDRESS || admin || relayer;

  const roles = {
    creator: relayer,
    guardian,
    recovery: guardian,
    newAdmin: admin !== deployer.address ? admin : undefined,
  };

  const balance = await provider.getBalance(deployer.address);
  console.log(`Network   : ${net.name} (chain ${chainId})`);
  console.log(`RPC       : ${rpcUrl}`);
  console.log(`Deployer  : ${deployer.address}`);
  console.log(`Relayer   : ${relayer}`);
  console.log(`Admin     : ${admin}`);
  console.log(`Balance   : ${formatUnits(balance, 18)} USDC`);
  if (balance === 0n) throw new Error(`No USDC for gas.${net.faucet ? ` Get some at ${net.faucet}` : ''}`);

  console.log('Deploying factory using the shared contract source...');
  const result = await deployFactory(deployer, roles);

  const file = path.join(__dirname, '..', `deployment-${name}.json`);
  const record = { network: name, chainId: Number(chainId), rpcUrl, factory: result.address, ...result };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'deployment.json'), JSON.stringify(record, null, 2));

  console.log('\nFactory deployed:', result.address);
  console.log(`Explorer: ${net.explorer}/address/${result.address}`);
  console.log(`Saved to deployment-${name}.json (and deployment.json)`);
  if (roles.newAdmin) {
    console.log(`Admin handover target: ${roles.newAdmin}`);
  }
}

main().catch((e) => {
  console.error('Deploy failed:', e.shortMessage || e.message);
  process.exit(1);
});
