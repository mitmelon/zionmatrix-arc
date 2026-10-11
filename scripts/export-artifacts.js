// Copies ABI + bytecode from the Foundry build into sdk/artifacts (run after `forge build`).
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'contracts', 'out');
const dest = path.join(__dirname, '..', 'sdk', 'artifacts');
fs.mkdirSync(dest, { recursive: true });

for (const name of ['BusinessCardFactory', 'BusinessCard']) {
  const file = JSON.parse(fs.readFileSync(path.join(out, `${name}.sol`, `${name}.json`), 'utf8'));
  const artifact = { abi: file.abi, bytecode: file.bytecode.object };
  fs.writeFileSync(path.join(dest, `${name}.json`), JSON.stringify(artifact));
  console.log(`exported ${name} (${(artifact.bytecode.length - 2) / 2} bytes)`);
}
