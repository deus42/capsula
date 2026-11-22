// The owner's test accounts from the command line, for agents and scripts with shell access to the host (the same
// accounts the owner manages in Profile → «Адмін»). It works on the auth database the running server uses.
//
//   node scripts/test-account.ts list
//   node scripts/test-account.ts create [name]   a new test account and its first one-time sign-in link
//   node scripts/test-account.ts link <name|id>   a one-time sign-in link (single use, valid 10 minutes)
//
// Reads CAPSULA_DATA_DIR (the folder holding app.sqlite) and BETTER_AUTH_URL (the site address for the link),
// as the server does. In the container: docker exec capsula-capsula-1 node /srv/capsula/scripts/test-account.ts …
// Removing a test account is done in «Адмін», where the server also stops its queue and removes its folder.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TEST_LINK_MINUTES, testAccounts } from '../app/server/test-accounts.ts';

const [command, ...rest] = process.argv.slice(2);
const dataDir = process.env.CAPSULA_DATA_DIR;
const base = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : null;
const file = dataDir ? path.join(dataDir, 'app.sqlite') : '';
if (!dataDir || !base || !fs.existsSync(file)) {
  console.error('Set CAPSULA_DATA_DIR (with app.sqlite, created by the server in accounts mode) and BETTER_AUTH_URL.');
  process.exit(2);
}
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
const tests = testAccounts(db);
const linkOf = (id: string) => `${base}/t/${tests.link(id)}`;

if (command === 'list') {
  for (const a of tests.list()) console.log(`${a.name}\t${a.id}\t${a.createdAt}`);
} else if (command === 'create') {
  const account = tests.create(rest.join(' ') || undefined);
  console.log(`${account.name}\t${account.id}`);
  console.log(linkOf(account.id));
} else if (command === 'link' && rest.length) {
  const account = tests.find(rest.join(' '));
  if (!account) {
    console.error('No such test account.');
    process.exit(1);
  }
  console.log(linkOf(account.id));
  console.error(`Single use, valid ${TEST_LINK_MINUTES} minutes.`);
} else {
  console.error('Usage: node scripts/test-account.ts list | create [name] | link <name|id>');
  process.exit(2);
}
db.close();
