// Accounts: Google sign-in only, through better-auth with
// Node's built-in SQLite. Sign-up needs an invite link while the beta is closed (`SIGNUP=open` opens it); the
// owner, named by `OWNER_EMAIL`, needs none and is the admin. Google tokens are never stored, and there are no
// passwords, emails or account linking. The owner's test accounts sign in with one-time links (test-accounts.ts).
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type http from 'node:http';
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import { testAccounts } from './test-accounts.ts';

export const INVITE_COOKIE = 'capsula_invite';
/** Marks a Google callback already relayed to the canonical address, so it is handled there and not relayed again. */
export const RELAY_MARK = 'capsula_relay';
const INVITE_DAYS = 14;
const DEV_SECRET = 'capsula-development-only-secret-not-for-production';

export interface AuthConfig {
  dataDir: string;
  baseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  ownerEmail?: string;
  openSignup: boolean;
  /** Only the owner may have an account (AI runs on the owner's own subscription); invites admit no one. */
  ownerOnly?: boolean;
  /**
   * A private alias such as https://capsula.home.arpa cannot be registered with Google (not a public domain). Then
   * Google returns to this registered address on the same server, which relays the browser to the alias.
   */
  googleRedirectURI?: string;
  /** Further origins the server is reached under, e.g. the registered address a private gateway presents. */
  trustedOrigins?: string[];
}

/** Who may create an account: the owner always; anyone else needs open sign-up or a valid invite, and never when owner-only. */
export function mayCreateAccount(c: { owner: boolean; ownerOnly?: boolean; openSignup: boolean; validInvite: boolean }) {
  if (c.owner) return true;
  if (c.ownerOnly) return false;
  return c.openSignup || c.validInvite;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv, dataDir: string): AuthConfig | null {
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!googleClientId && !googleClientSecret) return null;
  if (!googleClientId || !googleClientSecret) throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable accounts.');
  const baseURL = new URL(env.BETTER_AUTH_URL?.trim() || 'http://localhost:4317').origin;
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (env.NODE_ENV === 'production' && (!secret || secret.length < 32)) throw new Error('BETTER_AUTH_SECRET (32+ characters) is required in production.');
  const redirect = env.GOOGLE_REDIRECT_URI?.trim();
  if (redirect && !/^https:\/\/[^/]+\/api\/auth\/callback\/google$/.test(redirect)) throw new Error('GOOGLE_REDIRECT_URI must be https://<host>/api/auth/callback/google.');
  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin);
  return { dataDir, baseURL, secret: secret || DEV_SECRET, googleClientId, googleClientSecret, ownerEmail: env.OWNER_EMAIL?.trim().toLowerCase() || undefined, openSignup: env.SIGNUP === 'open', googleRedirectURI: redirect || undefined, trustedOrigins };
}

/**
 * The Google callback on the registered address of a private alias: where to send the browser so the callback is
 * handled on the alias, where its sign-in state cookie lives. Null when no relay is needed. State and PKCE are
 * still checked by Better Auth on the alias, and the code exchange uses the registered address.
 */
export function callbackRelay(cfg: Pick<AuthConfig, 'baseURL' | 'googleRedirectURI'>, url: URL): string | null {
  if (!cfg.googleRedirectURI) return null;
  const registered = new URL(cfg.googleRedirectURI);
  if (registered.origin === cfg.baseURL || url.pathname !== registered.pathname || url.searchParams.has(RELAY_MARK)) return null;
  const params = new URLSearchParams(url.searchParams);
  params.set(RELAY_MARK, '1');
  return `${cfg.baseURL}${registered.pathname}?${params}`;
}

function cookieValue(header: string | null | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export interface Invite { code: string; createdAt: string; expiresAt: string; usedBy: string | null; usedAt: string | null; disabled: number }
/** An account as the admin sees it: who, since when, the last sign-in, and whether it is one of the owner's test accounts. */
export interface AccountRow { id: string; name: string; email: string; image: string | null; createdAt: string; lastSignIn: string | null; owner: boolean; test: boolean }

export async function createAuth(cfg: AuthConfig) {
  const db = new DatabaseSync(path.join(cfg.dataDir, 'app.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS invite (
    code TEXT PRIMARY KEY, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL,
    usedBy TEXT, usedAt TEXT, disabled INTEGER NOT NULL DEFAULT 0)`);

  const validInvite = (code: string | undefined) => {
    if (!code) return null;
    const row = db.prepare('SELECT * FROM invite WHERE code = ?').get(code) as unknown as Invite | undefined;
    return row && !row.usedBy && !row.disabled && row.expiresAt > new Date().toISOString() ? row : null;
  };
  const isOwner = (email: string | null | undefined) => Boolean(cfg.ownerEmail && email?.toLowerCase() === cfg.ownerEmail);
  const requestHeaders = (ctx: unknown) => {
    const c = ctx as { request?: Request; headers?: Headers } | null | undefined;
    return c?.request?.headers ?? c?.headers;
  };
  // Google returns tokens on sign-in; Capsula needs none of them, so none are kept.
  const withoutTokens = (account: Record<string, unknown>) => ({
    data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null },
  });
  const provider = google({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret });
  const tests = testAccounts(db);
  // `/t/<code>` (index.ts) lands here: a valid one-time code opens a session for its test account, nothing else.
  const testSignIn = {
    id: 'capsula-test-sign-in',
    endpoints: {
      testSignIn: createAuthEndpoint('/test-sign-in', { method: 'GET' }, async (c) => {
        const code = c.request ? new URL(c.request.url).searchParams.get('code') : null;
        const userId = code ? tests.consume(code) : null;
        const user = userId ? await c.context.internalAdapter.findUserById(userId) : null;
        if (!user) throw c.redirect('/?test=invalid');
        const session = await c.context.internalAdapter.createSession(user.id);
        await setSessionCookie(c, { session, user });
        throw c.redirect('/');
      }),
    },
  } satisfies BetterAuthPlugin;

  const options: BetterAuthOptions = {
    appName: 'Capsula',
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    trustedOrigins: [cfg.baseURL, ...(cfg.trustedOrigins ?? [])],
    database: db,
    session: { expiresIn: 60 * 60 * 24 * 30 },
    // No address is kept with a session; sign-in is rate-limited in front of better-auth (rate-limit.ts).
    advanced: { useSecureCookies: cfg.baseURL.startsWith('https://'), ipAddress: { disableIpTracking: true } },
    account: { accountLinking: { enabled: false } },
    socialProviders: {
      google: {
        clientId: cfg.googleClientId,
        clientSecret: cfg.googleClientSecret,
        prompt: 'select_account',
        accessType: 'online',
        ...(cfg.googleRedirectURI ? { redirectURI: cfg.googleRedirectURI } : {}),
        async getUserInfo(tokens) {
          // The ID token is verified, not only decoded; an unverified email never signs in.
          if (!tokens.idToken) return null;
          const profile = await verifyGoogleIdToken({ token: tokens.idToken, audience: cfg.googleClientId });
          if (!profile || profile.email_verified !== true || typeof profile.email !== 'string') return null;
          const info = await provider.getUserInfo(tokens);
          if (!info) return null;
          return { ...info, user: { ...info.user, email: profile.email.trim().toLowerCase(), emailVerified: true } };
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const code = cookieValue(requestHeaders(ctx)?.get('cookie'), INVITE_COOKIE);
            if (!mayCreateAccount({ owner: isOwner(user.email), ownerOnly: cfg.ownerOnly, openSignup: cfg.openSignup, validInvite: Boolean(validInvite(code)) })) throw new APIError('FORBIDDEN', { message: 'invite_required' });
            return { data: user };
          },
          after: async (user, ctx) => {
            const code = cookieValue(requestHeaders(ctx)?.get('cookie'), INVITE_COOKIE);
            if (code && !isOwner(user.email)) db.prepare('UPDATE invite SET usedBy = ?, usedAt = ? WHERE code = ? AND usedBy IS NULL').run(user.id, new Date().toISOString(), code);
          },
        },
      },
      account: {
        create: { before: async (account) => withoutTokens(account as unknown as Record<string, unknown>) as never },
        update: { before: async (account) => withoutTokens(account as unknown as Record<string, unknown>) as never },
      },
    },
    onAPIError: { errorURL: `${cfg.baseURL}/` },
    plugins: [testSignIn],
  };

  const migrations = await getMigrations(options);
  await migrations.runMigrations();
  const auth = betterAuth(options);
  const handler = toNodeHandler(auth);

  return {
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => handler(req, res),
    async userOf(req: http.IncomingMessage) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return null;
      const { id, name, email, image } = session.user;
      return { id, name, email, image: image ?? null, owner: isOwner(email), test: tests.isTest(id) };
    },
    validInvite: (code: string | undefined) => (cfg.ownerOnly ? null : validInvite(code)),
    invites: {
      list: () => db.prepare('SELECT * FROM invite ORDER BY createdAt DESC').all() as unknown as Invite[],
      create() {
        const code = randomBytes(12).toString('base64url');
        const at = new Date();
        const expires = new Date(at.getTime() + INVITE_DAYS * 86400_000);
        db.prepare('INSERT INTO invite (code, createdAt, expiresAt) VALUES (?, ?, ?)').run(code, at.toISOString(), expires.toISOString());
        return validInvite(code)!;
      },
      disable: (code: string) => void db.prepare('UPDATE invite SET disabled = 1 WHERE code = ?').run(code),
    },
    admin: {
      users: () => (db.prepare(`SELECT u.id, u.name, u.email, u.image, u.createdAt,
          (SELECT MAX(s.createdAt) FROM session s WHERE s.userId = u.id) AS lastSignIn,
          EXISTS (SELECT 1 FROM test_account t WHERE t.userId = u.id) AS test
        FROM user u ORDER BY u.createdAt`).all() as unknown as (Omit<AccountRow, 'owner' | 'test'> & { test: number })[]).map((u) => ({ ...u, owner: isOwner(u.email), test: Boolean(u.test) })) as AccountRow[],
      tests,
    },
    /** Removes the account's sign-in records; its wardrobe folder is removed by the caller. */
    deleteUser(userId: string) {
      db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
      db.prepare('DELETE FROM account WHERE userId = ?').run(userId);
      db.prepare('DELETE FROM user WHERE id = ?').run(userId);
    },
    close: () => db.close(),
  };
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
