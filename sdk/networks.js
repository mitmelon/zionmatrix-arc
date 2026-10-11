// Arc network settings. Source: https://docs.arc.io/arc/references/rpc-endpoints
module.exports = {
  testnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    faucet: 'https://faucet.circle.com',
  },
  mainnet: {
    name: 'Arc Mainnet',
    chainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
  },
};
