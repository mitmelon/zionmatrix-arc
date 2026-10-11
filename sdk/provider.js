const { JsonRpcProvider, FeeData } = require('ethers');

// Arc drops any transaction whose maxFeePerGas is below 20 Gwei, silently (no error, no receipt).
const MIN_FEE = 20_000_000_000n;

class ArcProvider extends JsonRpcProvider {
  // Same as ethers, but never suggests a fee under Arc's floor.
  async getFeeData() {
    const fee = await super.getFeeData();
    let max = fee.maxFeePerGas ?? fee.gasPrice ?? MIN_FEE;
    if (max < MIN_FEE) max = MIN_FEE;
    let tip = fee.maxPriorityFeePerGas ?? 0n;
    if (tip > max) tip = max;
    return new FeeData(fee.gasPrice, max, tip);
  }
}

// Arc confirms in under a second. Turning off ethers' short request cache stops it from reusing
// a stale transaction count when you send transactions back to back.
const makeProvider = (rpcUrl) => new ArcProvider(rpcUrl, undefined, { cacheTimeout: -1 });

module.exports = { ArcProvider, makeProvider, MIN_FEE };
