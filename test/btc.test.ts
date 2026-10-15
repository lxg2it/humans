import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBtc, normaliseAddress, validateAddress } from '../src/btc.ts';

// The genesis coinbase address and friends: long-lived, publicly known, and
// checksum-valid. Anything we get wrong here would reject real addresses.
const VALID = [
  { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', kind: 'p2pkh' },
  { address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', kind: 'p2sh' },
  { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', kind: 'p2wpkh' },
  { address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', kind: 'p2wsh' },
  { address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', kind: 'p2tr' },
];

test('accepts known-good addresses of every mainnet encoding', () => {
  for (const { address, kind } of VALID) {
    const result = validateAddress(address);
    assert.equal(result.valid, true, `${address} should be valid: ${JSON.stringify(result)}`);
    if (result.valid) {
      assert.equal(result.info.kind, kind, `${address} kind`);
      assert.equal(result.info.network, 'mainnet', `${address} network`);
    }
  }
});

test('rejects a valid address with exactly one character changed', () => {
  // The control that matters: if the checksum were not computed, these would
  // pass, and every mutant would be indistinguishable from the original.
  for (const { address } of VALID) {
    for (let i = 0; i < address.length; i++) {
      const original = address[i]!;
      const replacements = ['q', 'z', '7', 'K'].filter((c) => c !== original);
      for (const replacement of replacements) {
        const mutated = address.slice(0, i) + replacement + address.slice(i + 1);
        if (mutated === address) continue;
        const result = validateAddress(mutated);
        assert.equal(
          result.valid,
          false,
          `mutating position ${i} of ${address} to ${replacement} produced a valid address: ${mutated}`,
        );
      }
    }
  }
});

test('rejects structurally invalid input without throwing', () => {
  const cases: Array<[string, string]> = [
    ['', 'empty'],
    ['1', 'single character'],
    ['not an address at all', 'prose'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bech32 checksum off by one'],
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'all-uppercase bech32 is valid, see below'],
    ['bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mixed case'],
    ['bc1zw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'witness v2 with a bech32 checksum'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90', 'v0 with a long program'],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'valid testnet address, not a rejection'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf0a', 'base58 checksum off by one'],
    ['0OIl', 'characters outside the base58 alphabet'],
  ];
  // Two of the entries above are valid on purpose; assert only the rejections,
  // and assert the acceptances separately so a change to either is loud.
  const expectedValid = new Set([
    'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  ]);
  for (const [address, what] of cases) {
    const result = validateAddress(address);
    assert.equal(
      result.valid,
      expectedValid.has(address),
      `${what}: ${JSON.stringify(address)} gave ${JSON.stringify(result)}`,
    );
  }
});

test('uppercase bech32 is the same address, and is accepted', () => {
  const upper = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4';
  const result = validateAddress(upper);
  assert.equal(result.valid, true);
  assert.equal(normaliseAddress(upper), upper.toLowerCase());
  assert.equal(
    normaliseAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    'base58 is case-sensitive and must not be lowercased',
  );
});

test('recognises testnet rather than rejecting it', () => {
  const result = validateAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.info.network, 'testnet');
});

test('formats satoshis without floating point', () => {
  assert.equal(formatBtc(0), '0');
  assert.equal(formatBtc(1), '0.00000001');
  assert.equal(formatBtc(100_000_000), '1');
  assert.equal(formatBtc(150_000_000), '1.5');
  assert.equal(formatBtc(123_456_789), '1.23456789');
  assert.equal(formatBtc(2_100_000_000_000_000), '21000000');
});

test('validation never throws, whatever it is handed', () => {
  const fuzz = ['', ' ', '\u0000', 'x'.repeat(200), '1'.repeat(100), 'bc1', 'bc11', '3'.repeat(40)];
  for (const value of fuzz) {
    assert.doesNotThrow(() => validateAddress(value), `threw on ${JSON.stringify(value)}`);
  }
});
