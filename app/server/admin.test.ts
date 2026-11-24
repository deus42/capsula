// The admin (the owner) and the owner's test accounts: one-time sign-in links, the owner-only admin routes, and AI
// for test accounts when the site runs on the owner's own subscription.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { testAccounts, TEST_EMAIL_DOMAIN } from './test-accounts.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'owner@example.test';

test('test accounts: one-time codes open only test accounts, once, before they expire; removal leaves real accounts alone', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, createdAt date, updatedAt date);
    CREATE TABLE session (id TEXT, userId TEXT); CREATE TABLE account (id TEXT, userId TEXT);
    INSERT INTO user (id, name, email) VALUES ('real-rrrrrr', 'Real', 'real@example.test')`);
  const tests = testAccounts(db);
  const a = tests.create('Тест 1');
  assert.match(a.id, /^[A-Za-z0-9_-]{6,64}$/, 'a test account id names a safe folder');
  assert.ok(a.email.endsWith(`@${TEST_EMAIL_DOMAIN}`), 'a reserved domain no Google account can have');
  assert.equal(tests.create().name, 'Test 2');
  assert.equal(tests.link('real-rrrrrr'), null, 'no link for a real account');
  const code = tests.link(a.id)!;
  assert.equal(tests.consume(code), a.id);
  assert.equal(tests.consume(code), null, 'single use');
  assert.equal(tests.consume('made-up'), null);
  const stale = tests.link(a.id)!;
  db.prepare('UPDATE test_link SET expiresAt = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(tests.consume(stale), null, 'expired');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM test_link').get() as { n: number }).n, 0, 'only hashes are stored, and used or expired ones go');
  assert.equal(tests.find('Тест 1')?.id, a.id);
  assert.equal(tests.remove('real-rrrrrr'), false, 'a real account is never removed here');
  assert.equal(tests.remove(a.id), true);
  assert.equal(tests.isTest(a.id), false);
  assert.ok(db.prepare("SELECT 1 FROM user WHERE id = 'real-rrrrrr'").get());
  db.close();
});

test('owner-only AI: the owner and test accounts may use it, an invited account may not', async () => {
  const { createTenants, emptyDb, AI_OWNER_ONLY } = await import('./tenants.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-test-ai-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false', aiOwnerOnly: true });
  const guest = tenants.forUser('guest-gggggg');
  const tester = tenants.forUser('tester-tttttt', false, true);
  assert.throws(() => guest.ctx.admit!('tryon'), (e: { message: string }) => e.message === AI_OWNER_ONLY);
  assert.equal(tester.ctx.admit, undefined, 'a test account is the owner\'s own: not gated (its allowances apply when quotas are on)');
  assert.deepEqual(tenants.summary('tester-tttttt'), { photos: 0, items: 0, looks: 0, capsules: 0 });
  assert.equal(tenants.summary('nobody-nnnnnn'), null);
  guest.runner.stop();
  tester.runner.stop();
});

/** The real server in production accounts mode on the owner's subscription (no API key), on a free port. */
async function startServer(dir: string, extra: NodeJS.ProcessEnv = {}): Promise<{ base: string; env: NodeJS.ProcessEnv; child: ChildProcess }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', CAPSULA_DATA_DIR: dir,
    GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'y', BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: 's'.repeat(48),
    OWNER_EMAIL: OWNER, SIGNUP: 'invite', CODEX_HOME: path.join(dir, 'codex'), CAPSULA_CODEX_BIN: '/usr/bin/false', ...extra,
  };
  const child = spawn(process.execPath, ['server/index.ts'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (c) => (out += c));
  child.stderr!.on('data', (c) => (out += c));
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { base, env, child };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${out}`);
}

/** Follows a one-time link like a browser: the session cookie it sets, if any, and where it leads. */
async function signIn(link: string) {
  const res = await fetch(link, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { cookie, location: res.headers.get('location') };
}

test('admin over HTTP: test accounts sign in by link, only the owner reaches «Адмін», removal takes the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-admin-'));
  const { base, env, child } = await startServer(dir);
  try {
    const cli = (...args: string[]) => execFileSync(process.execPath, ['../scripts/test-account.ts', ...args], { cwd: APP, env, encoding: 'utf8' }).trim().split('\n');
    const [made, link] = cli('create', 'Агент');
    assert.match(made, /^Агент\t/);
    assert.ok(link.startsWith(`${base}/t/`), 'the command prints a link on the site address');

    const tester = await signIn(link);
    assert.equal(tester.location, '/');
    assert.match(tester.cookie, /session_token=/);
    const get = (p: string, cookie: string) => fetch(`${base}${p}`, { headers: { cookie } });
    const session = await (await get('/api/session', tester.cookie)).json();
    assert.equal(session.user.name, 'Агент');
    assert.equal(session.user.test, true);
    assert.equal(session.user.owner, false);
    assert.equal(session.invites, false, 'owner-only by default: invites stay off');
    assert.equal((await get('/api/state', tester.cookie)).status, 200, 'a test account has its own wardrobe');
    assert.equal((await get('/api/admin/users', tester.cookie)).status, 403, 'a test account is not the admin');
    assert.equal((await get('/api/admin/users', '')).status, 401);
    const again = await signIn(link);
    assert.equal(again.cookie, '', 'a used link opens nothing');
    assert.equal(again.location, '/?test=invalid');

    // The owner signs in with Google in real life; here the owner's row is made by hand and opened with a link.
    const db = new DatabaseSync(path.join(dir, 'app.sqlite'));
    const tests = testAccounts(db);
    const ownerRow = tests.create('Owner');
    db.prepare('UPDATE user SET email = ? WHERE id = ?').run(OWNER, ownerRow.id);
    const owner = await signIn(`${base}/t/${tests.link(ownerRow.id)}`);
    db.prepare('DELETE FROM test_account WHERE userId = ?').run(ownerRow.id);
    db.close();
    const users = await (await get('/api/admin/users', owner.cookie)).json();
    const agent = users.find((u: { name: string }) => u.name === 'Агент');
    assert.equal(agent.test, true);
    assert.deepEqual(agent.wardrobe, { photos: 0, items: 0, looks: 0, capsules: 0 });
    assert.ok(agent.lastSignIn);
    assert.equal(users.find((u: { email: string }) => u.email === OWNER).owner, true);

    const send = (method: string, p: string, cookie: string, body?: unknown) =>
      fetch(`${base}${p}`, { method, headers: { cookie, 'x-capsula': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await send('POST', '/api/admin/test-accounts', tester.cookie, {})).status, 403);
    const second = await (await send('POST', '/api/admin/test-accounts', owner.cookie, { name: 'Тест 2' })).json();
    assert.equal(second.name, 'Тест 2');
    assert.ok((await signIn(second.link)).cookie, "the first link of a new test account works");
    const fresh = await (await send('POST', `/api/admin/test-accounts/${agent.id}/link`, owner.cookie)).json();
    assert.ok(fresh.link.startsWith(`${base}/t/`));
    const ownerId = users.find((u: { email: string }) => u.email === OWNER).id;
    assert.equal((await send('POST', `/api/admin/test-accounts/${ownerId}/link`, owner.cookie)).status, 404, 'no sign-in link for a real account');
    assert.equal((await send('DELETE', `/api/admin/test-accounts/${ownerId}`, owner.cookie)).status, 404, 'a real account is not removed here');

    assert.ok(fs.existsSync(path.join(dir, 'users', agent.id)), 'the test account\'s folder exists after it signed in');
    assert.equal((await send('DELETE', `/api/admin/test-accounts/${agent.id}`, owner.cookie)).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'users', agent.id)), false, 'removal takes the folder');
    assert.equal((await get('/api/session', tester.cookie).then((r) => r.json())).user, null, 'and its sessions');
    assert.equal((await signIn(fresh.link)).cookie, '', 'and its open links');
  } finally {
    child.kill();
  }
});

/** The owner's session for a test server: the owner signs in with Google in real life; here the row is made by hand. */
function ownerLink(dir: string, base: string) {
  const db = new DatabaseSync(path.join(dir, 'app.sqlite'));
  const tests = testAccounts(db);
  const row = tests.create('Owner');
  db.prepare('UPDATE user SET email = ? WHERE id = ?').run(OWNER, row.id);
  const link = `${base}/t/${tests.link(row.id)}`;
  return { link, done: () => { db.prepare('DELETE FROM test_account WHERE userId = ?').run(row.id); db.close(); } };
}

/** A GET with a chosen Host header (fetch cannot set one): status and Location. */
function getWithHost(base: string, pathname: string, host: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    }).on('error', reject);
  });
}

test('CODEX_ACCESS=accounts: the owner\'s subscription serves invited accounts too, so invites work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-shared-'));
  const { base, child } = await startServer(dir, { CODEX_ACCESS: 'accounts' });
  try {
    const { link, done } = ownerLink(dir, base);
    const owner = await signIn(link);
    done();
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie: owner.cookie } })).json();
    assert.equal(session.invites, true);
    const res = await fetch(`${base}/api/invites`, { method: 'POST', headers: { cookie: owner.cookie, 'x-capsula': '1' } });
    assert.equal(res.status, 200);
    const invite = await fetch(`${base}/i/${(await res.json()).code}`, { redirect: 'manual' });
    assert.equal(invite.headers.get('location'), '/?invite=1', 'the invite link admits its holder to Google sign-up');
    const www = await getWithHost(base, '/privacy?lang=en', `www.${new URL(base).host}`);
    assert.deepEqual(www, { status: 301, location: `${base}/privacy?lang=en` }, 'www goes to the site itself, path and query kept');
    assert.equal((await getWithHost(base, '/health', new URL(base).host)).status, 200);
  } finally {
    child.kill();
  }
  const { createTenants, emptyDb } = await import('./tenants.ts');
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false', aiOwnerOnly: false });
  const guest = tenants.forUser('guest-gggggg');
  assert.equal(guest.ctx.admit, undefined, 'an invited account is not refused AI (its monthly allowances apply)');
  guest.runner.stop();
});

test('new looks get a try-on by themselves only in the owner\'s own wardrobe; invited and test accounts start it themselves', async () => {
  const { createTenants, emptyDb } = await import('./tenants.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-auto-tryon-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false' });
  const local = tenants.local();
  const owner = tenants.forUser('owner-oooooo', true);
  const guest = tenants.forUser('guest-gggggg');
  const tester = tenants.forUser('tester-tttttt', false, true);
  assert.equal(local.ctx.autoTryOn, true, 'the local site');
  assert.equal(owner.ctx.autoTryOn, true, "the owner's account");
  assert.equal(guest.ctx.autoTryOn, false, "an invited account's allowance is never spent unnoticed");
  assert.equal(tester.ctx.autoTryOn, false, 'a test account too');
  for (const t of [local, owner, guest, tester]) t.runner.stop();
});
