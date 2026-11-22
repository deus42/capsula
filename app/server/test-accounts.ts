// Test accounts: the owner's own accounts for trying the site and its AI work, by hand or by agents, with made-up
// data. They have no Google sign-in and no lasting key: a one-time link (10 minutes, single use) opens a session.
// The owner makes links in «Адмін»; agents with shell access to the host use `scripts/test-account.ts`.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const TEST_LINK_MINUTES = 10;
/** Reserved for tests (RFC 2606): no Google account can ever have it, so a test account never matches a real one. */
export const TEST_EMAIL_DOMAIN = 'test.invalid';

export interface TestAccount { id: string; name: string; email: string; createdAt: string }

const digest = (code: string) => createHash('sha256').update(code).digest('hex');

/** Test accounts in the auth database: kept apart in `test_account`, links stored only as hashes in `test_link`. */
export function testAccounts(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS test_account (userId TEXT PRIMARY KEY, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS test_link (hash TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt TEXT NOT NULL)`);
  const isTest = (userId: string) => Boolean(db.prepare('SELECT 1 FROM test_account WHERE userId = ?').get(userId));
  const inTransaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    isTest,
    list: () => db.prepare('SELECT u.id, u.name, u.email, t.createdAt FROM test_account t JOIN user u ON u.id = t.userId ORDER BY t.createdAt').all() as unknown as TestAccount[],
    find(idOrName: string): TestAccount | undefined {
      return db.prepare('SELECT u.id, u.name, u.email, t.createdAt FROM test_account t JOIN user u ON u.id = t.userId WHERE u.id = ? OR u.name = ? ORDER BY t.createdAt LIMIT 1').get(idOrName, idOrName) as unknown as TestAccount | undefined;
    },
    create(name?: string): TestAccount {
      const id = randomBytes(16).toString('base64url');
      const at = new Date().toISOString();
      const count = (db.prepare('SELECT COUNT(*) AS n FROM test_account').get() as { n: number }).n;
      const account = { id, name: name?.trim().slice(0, 60) || `Test ${count + 1}`, email: `test-${randomBytes(6).toString('hex')}@${TEST_EMAIL_DOMAIN}`, createdAt: at };
      inTransaction(() => {
        db.prepare('INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 1, NULL, ?, ?)').run(id, account.name, account.email, at, at);
        db.prepare('INSERT INTO test_account (userId, createdAt) VALUES (?, ?)').run(id, at);
      });
      return account;
    },
    /** A one-time sign-in code for a test account (never for any other), valid for TEST_LINK_MINUTES. */
    link(userId: string): string | null {
      if (!isTest(userId)) return null;
      const code = randomBytes(24).toString('base64url');
      db.prepare('DELETE FROM test_link WHERE expiresAt <= ?').run(new Date().toISOString());
      db.prepare('INSERT INTO test_link (hash, userId, expiresAt) VALUES (?, ?, ?)').run(digest(code), userId, new Date(Date.now() + TEST_LINK_MINUTES * 60_000).toISOString());
      return code;
    },
    /** Uses up a code: the test account it opens, once and only before it expires; else null. */
    consume(code: string): string | null {
      return inTransaction(() => {
        const row = db.prepare('SELECT userId, expiresAt FROM test_link WHERE hash = ?').get(digest(code)) as { userId: string; expiresAt: string } | undefined;
        if (!row) return null;
        db.prepare('DELETE FROM test_link WHERE hash = ?').run(digest(code));
        return row.expiresAt > new Date().toISOString() && isTest(row.userId) ? row.userId : null;
      });
    },
    /** Removes a test account's sign-in records (its wardrobe folder is removed by the caller); false for any other account. */
    remove(userId: string): boolean {
      if (!isTest(userId)) return false;
      inTransaction(() => {
        for (const sql of ['DELETE FROM test_link WHERE userId = ?', 'DELETE FROM session WHERE userId = ?', 'DELETE FROM account WHERE userId = ?', 'DELETE FROM test_account WHERE userId = ?', 'DELETE FROM user WHERE id = ?']) db.prepare(sql).run(userId);
      });
      return true;
    },
  };
}

export type TestAccounts = ReturnType<typeof testAccounts>;
