import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * The key that signs reasoning blocks.
 *
 * A real API signs its thinking blocks so that a caller echoing a conversation
 * back cannot put words in the model's mouth. Here the "model" is a person, and
 * the same reasoning applies with more force: the transcript is the record of
 * what somebody wrote. Signing it means an echoed block that has been edited in
 * transit is detected rather than billed as theirs.
 *
 * It is stored beside the database rather than derived from configuration, so
 * that it survives restarts and does not change when an unrelated setting does.
 */

let cached: Buffer | null = null;

export function signingKey(): Buffer {
  if (cached) return cached;

  const fromEnv = process.env.HUMANS_SIGNING_KEY;
  if (fromEnv !== undefined && fromEnv !== '') {
    cached = Buffer.from(fromEnv, 'base64url');
    return cached;
  }

  const path = join(config.dataDir, 'signing-key');
  if (existsSync(path)) {
    const stored = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
    if (stored.length < 16) throw new Error(`${path} is too short to be a signing key`);
    cached = stored;
    return cached;
  }

  const key = randomBytes(32);
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(path, `${key.toString('base64url')}\n`, { mode: 0o600 });
  cached = key;
  return cached;
}

/** Test hook. Never called from the server. */
export function resetSigningKey(): void {
  cached = null;
}
