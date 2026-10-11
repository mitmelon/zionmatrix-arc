const { parseUnits, formatUnits } = require('ethers');

// Native USDC on Arc has 18 decimals: 1 USDC = 10^18 units.
const usdc = (amount) => parseUnits(String(amount), 18);
const formatUsdc = (units) => formatUnits(units, 18);

module.exports = { usdc, formatUsdc };
