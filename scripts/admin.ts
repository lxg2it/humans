/**
 * The operator's command line.
 *
 * Keys are minted here as well as on the operator page because there has to be a
 * way to get the first one, and a fresh instance has no page to visit. This is
 * the one program in the service whose job is to print a secret, and it prints
 * it to a terminal rather than to a log.
 */
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { Store } from '../src/db.ts';

function usage(): never {
  console.log(`usage: npm run admin -- <command>

  key responder <name>              mint a responder key (the console)
  key caller <name>                 mint a caller key (the Anthropic-compatible endpoint)
  list                              list credentials
  revoke <credential-id>            revoke a credential
  owing                             what is owed, per responder
  settle <responder> <sats> <address> <txid> [note]
                                    record a payment that has been made
  stats                             queue and money totals
`);
  process.exit(1);
}

const store = new Store(join(config.dataDir, 'humans.sqlite'), {
  claimLeaseMs: config.claimLeaseMs,
  callTimeoutMs: config.callTimeoutMs,
  poolSats: config.poolSats,
});

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'key': {
    const [kind, name] = args;
    if ((kind !== 'caller' && kind !== 'responder') || !name) usage();
    const minted = store.mintCredential(kind, name);
    console.log(`${kind} key for "${name}" (id ${minted.id})`);
    console.log('');
    console.log(`  ${minted.key}`);
    console.log('');
    console.log('Stored hashed. This is the only time it can be shown.');
    break;
  }

  case 'list': {
    const credentials = store.listCredentials();
    if (credentials.length === 0) console.log('no credentials');
    for (const credential of credentials) {
      const used = credential.last_used_at ? new Date(credential.last_used_at).toISOString() : 'never used';
      console.log(
        `${credential.id}  ${credential.kind.padEnd(9)}  ${credential.name.padEnd(20)}  ` +
          `${credential.active === 1 ? 'active  ' : 'revoked '}  ${used}`,
      );
    }
    break;
  }

  case 'revoke': {
    const [id] = args;
    if (!id) usage();
    console.log(store.revokeCredential(id) ? `revoked ${id}` : `no active credential with id ${id}`);
    break;
  }

  case 'owing': {
    const summary = store.responderSummary();
    if (summary.length === 0) console.log('nobody has answered anything yet');
    for (const row of summary) {
      const rating = row.averageRating === null ? 'unrated' : `${row.averageRating.toFixed(2)}/5 (${row.ratings})`;
      console.log(
        `${row.responder.padEnd(20)}  ${String(row.replies).padStart(5)} replies  ` +
          `earned ${String(row.earnedSats).padStart(8)}  paid ${String(row.paidSats).padStart(8)}  ` +
          `owed ${String(row.owedSats).padStart(8)}  ${rating}`,
      );
    }
    console.log('');
    console.log(`pool: ${config.poolSats} sats`);
    break;
  }

  case 'settle': {
    const [responder, satsRaw, address, txid, ...noteParts] = args;
    const sats = Number(satsRaw);
    if (!responder || !Number.isInteger(sats) || sats <= 0 || !address || !txid) usage();
    const before = store.earnings(responder);
    if (before.earnedSats === 0) {
      console.error(`${responder} has no ledger entries; refusing to record a payment to an unknown responder`);
      process.exit(2);
    }
    store.addLedger({
      responder,
      kind: 'settlement',
      sats,
      address,
      txid,
      note: noteParts.length > 0 ? noteParts.join(' ') : null,
    });
    const after = store.earnings(responder);
    console.log(`recorded ${sats} sats to ${responder}`);
    console.log(`owed: ${before.owedSats} -> ${after.owedSats}`);
    break;
  }

  case 'stats': {
    console.log(JSON.stringify(store.stats(), null, 2));
    break;
  }

  default:
    usage();
}

store.close();
