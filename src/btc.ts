/**
 * Bitcoin address handling, written out rather than pulled in.
 *
 * An address is this product's only identity, so it is the one field where
 * accepting garbage would be structural rather than cosmetic. Both encodings
 * are checksummed, which means "the user typed it wrong" is a thing we can
 * actually detect instead of discovering later.
 */

import { createHash } from 'node:crypto';


const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'witness';
export type Network = 'mainnet' | 'testnet';

export interface AddressInfo {
  address: string;
  kind: AddressKind;
  network: Network;
}

export type ValidationResult =
  | { valid: true; info: AddressInfo }
  | { valid: false; reason: string };

// ---- bech32 ---------------------------------------------------------------

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= BECH32_GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Returns null when the bit stream has non-zero padding, which is how BIP-173 defines rejection. */
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

type Bech32Decode =
  | { ok: true; hrp: string; data: number[]; spec: 'bech32' | 'bech32m' }
  | { ok: false; reason: string };

function decodeBech32(address: string): Bech32Decode {
  if (address.length > 90) return { ok: false, reason: 'bech32 addresses are at most 90 characters' };
  // BIP-173 forbids mixed case anywhere in the string.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    return { ok: false, reason: 'bech32 addresses cannot mix upper and lower case' };
  }
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) return { ok: false, reason: 'missing or misplaced separator' };
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v === -1) return { ok: false, reason: `"${ch}" is not in the bech32 character set` };
    data.push(v);
  }
  const checksum = polymod([...hrpExpand(hrp), ...data]);
  const spec = checksum === BECH32_CONST ? 'bech32' : checksum === BECH32M_CONST ? 'bech32m' : null;
  if (spec === null) return { ok: false, reason: 'checksum does not match, so this is a typo' };
  return { ok: true, hrp, data: data.slice(0, -6), spec };
}

function validateBech32(address: string): ValidationResult {
  const decoded = decodeBech32(address);
  if (!decoded.ok) return { valid: false, reason: decoded.reason };

  const { hrp, data, spec } = decoded;
  const network: Network | null = hrp === 'bc' ? 'mainnet' : hrp === 'tb' ? 'testnet' : null;
  if (network === null) return { valid: false, reason: `unknown bech32 prefix "${hrp}"` };

  const version = data[0];
  if (version === undefined) return { valid: false, reason: 'no witness version' };
  if (version > 16) return { valid: false, reason: 'witness version above 16' };

  const program = convertBits(data.slice(1), 5, 8, false);
  if (program === null) return { valid: false, reason: 'bad padding in witness program' };

  if (version === 0) {
    if (spec !== 'bech32') return { valid: false, reason: 'witness v0 must use bech32, not bech32m' };
    if (program.length !== 20 && program.length !== 32) {
      return { valid: false, reason: `witness v0 program must be 20 or 32 bytes, got ${program.length}` };
    }
    return {
      valid: true,
      info: { address, kind: program.length === 20 ? 'p2wpkh' : 'p2wsh', network },
    };
  }

  if (spec !== 'bech32m') return { valid: false, reason: 'witness v1+ must use bech32m' };
  if (program.length < 2 || program.length > 40) {
    return { valid: false, reason: `witness program must be 2 to 40 bytes, got ${program.length}` };
  }
  return {
    valid: true,
    info: { address, kind: version === 1 && program.length === 32 ? 'p2tr' : 'witness', network },
  };
}

// ---- base58check ----------------------------------------------------------

function base58Decode(input: string): Uint8Array | null {
  const index = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) index.set(BASE58_ALPHABET[i]!, i);

  const bytes: number[] = [0];
  for (const ch of input) {
    const value = index.get(ch);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading '1' is a leading zero byte, which the loop above cannot express.
  for (const ch of input) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

function validateBase58(address: string): ValidationResult {
  const decoded = base58Decode(address);
  if (decoded === null) {
    return { valid: false, reason: 'contains a character that is not valid base58' };
  }
  if (decoded.length !== 25) {
    return { valid: false, reason: `base58check payload must be 25 bytes, got ${decoded.length}` };
  }
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(checksum).equals(Buffer.from(expected))) {
    return { valid: false, reason: 'base58 checksum does not match' };
  }
  const version = payload[0]!;
  const table: Record<number, { kind: AddressKind; network: Network }> = {
    0x00: { kind: 'p2pkh', network: 'mainnet' },
    0x05: { kind: 'p2sh', network: 'mainnet' },
    0x6f: { kind: 'p2pkh', network: 'testnet' },
    0xc4: { kind: 'p2sh', network: 'testnet' },
  };
  const entry = table[version];
  if (!entry) return { valid: false, reason: `unknown version byte 0x${version.toString(16)}` };
  return { valid: true, info: { address, kind: entry.kind, network: entry.network } };
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

// ---- public API -----------------------------------------------------------

export function validateAddress(address: string): ValidationResult {
  const trimmed = address.trim();
  if (trimmed.length < 14) return { valid: false, reason: 'too short to be an address' };
  // Dispatch on the prefix rather than by trying both: the two character sets
  // overlap, so "try bech32, then base58" can report a base58 error for a
  // bech32 typo, which is exactly the wrong sentence to show someone.
  if (/^(bc|tb|bcrt)1/i.test(trimmed)) return validateBech32(trimmed);
  return validateBase58(trimmed);
}

/**
 * bech32 is case-insensitive and base58 is not, so the stored form is the
 * lowercased one for bech32 and the literal one everywhere else. Two spellings
 * of the same bech32 address should not be two accounts.
 */
export function normaliseAddress(address: string): string {
  const trimmed = address.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bc1') || lower.startsWith('tb1') || lower.startsWith('bcrt1')) return lower;
  return trimmed;
}

// ---- chain read -----------------------------------------------------------

export interface ChainBalance {
  ok: boolean;
  address: string;
  receivedSats: number | null;
  txCount: number | null;
  error?: string;
}

interface MempoolAddressResponse {
  chain_stats?: { funded_txo_sum?: number; funded_txo_count?: number };
  mempool_stats?: { funded_txo_sum?: number; funded_txo_count?: number };
}

const cache = new Map<string, { at: number; value: ChainBalance }>();
const CACHE_TTL_MS = 60_000;

/**
 * Reads how much an address has ever received. Unauthenticated, and the failure
 * mode is surfaced rather than swallowed: "we could not reach the chain" and
 * "nobody has sent anything" are different statements and the page says which.
 */
export async function fetchReceived(address: string, apiBase: string): Promise<ChainBalance> {
  const cached = cache.get(address);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: ChainBalance;
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/address/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      value = {
        ok: false,
        address,
        receivedSats: null,
        txCount: null,
        error: `chain API returned ${res.status}`,
      };
    } else {
      const body = (await res.json()) as MempoolAddressResponse;
      const received =
        (body.chain_stats?.funded_txo_sum ?? 0) + (body.mempool_stats?.funded_txo_sum ?? 0);
      const count =
        (body.chain_stats?.funded_txo_count ?? 0) + (body.mempool_stats?.funded_txo_count ?? 0);
      value = { ok: true, address, receivedSats: received, txCount: count };
    }
  } catch (err) {
    value = {
      ok: false,
      address,
      receivedSats: null,
      txCount: null,
      error: err instanceof Error ? err.message : 'unknown chain error',
    };
  }
  cache.set(address, { at: Date.now(), value });
  return value;
}

export function formatBtc(sats: number): string {
  const sign = sats < 0 ? '-' : '';
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / 100_000_000);
  const frac = (abs % 100_000_000).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? '.' + frac : ''}`;
}
