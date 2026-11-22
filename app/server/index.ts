import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.ts';
import { createLimiter } from './runner.ts';
import { createTenants, emptyDb, type Tenant } from './tenants.ts';
import { INVITE_COOKIE, RELAY_MARK, authConfigFromEnv, callbackRelay, createAuth } from './auth.ts';
import { createOpenAIEngine, openAIConfigFromEnv } from './openai-engine.ts';
import { createUsage, quotaConfigFromEnv } from './quota.ts';
import { stateView } from './state-view.ts';
import { RATE_LIMITED, RATE_RULES, clientAddress, createRateLimiter, type Rule } from './rate-limit.ts';
import { dispatch, upload } from './routes.ts';
import { CONTENT_TYPES, MAX_UPLOAD_BYTES, prewarm, resolveAllowed, snapWidth, thumbnail } from './media.ts';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = path.resolve(APP_DIR, '..');
const DATA_DIR = path.resolve(process.env.CAPSULA_DATA_DIR || path.join(PROJECT_ROOT, '.local', 'app-data'));
const DIST = path.join(APP_DIR, 'dist');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';

// Two modes: without Google credentials the owner's single local site runs exactly as before;
// with them, every signed-in account gets its own wardrobe folder and the queue shares a cap on running jobs.
const authConfig = authConfigFromEnv(process.env, DATA_DIR);
const ACCOUNTS = Boolean(authConfig);
fs.mkdirSync(DATA_DIR, { recursive: true });
// Generation: the OpenAI API when configured, else Codex.
const openAI = openAIConfigFromEnv(process.env);
const PRODUCTION = process.env.NODE_ENV === 'production';
// Without an API key, production accounts run on the owner's own ChatGPT subscription through Codex. By default
// only the owner (and the owner's test accounts) sign in and use AI. `CODEX_ACCESS=accounts` lets invited accounts
// use it too, each within its monthly allowances; whether the subscription may serve other people is for its owner
// to check against the provider's terms. Sign-up stays invite-only either way.
const CODEX_PRODUCTION = ACCOUNTS && PRODUCTION && !openAI;
const OWNER_ONLY = CODEX_PRODUCTION && process.env.CODEX_ACCESS !== 'accounts';
if (CODEX_PRODUCTION && (!authConfig!.ownerEmail || authConfig!.openSignup)) throw new Error('Without OPENAI_API_KEY, production runs on the owner\'s Codex subscription: set OWNER_EMAIL and keep SIGNUP closed.');
if (CODEX_PRODUCTION && process.env.CODEX_HOME) fs.mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
// Accounts have monthly allowances; production with the API also needs the budget and the prices it is counted with.
const quotaConfig = ACCOUNTS ? quotaConfigFromEnv(process.env) : null;
if (ACCOUNTS && PRODUCTION && openAI && (quotaConfig!.budgetUsd === null || !openAI.prices)) throw new Error('Accounts in production need MONTHLY_BUDGET_USD and OPENAI_PRICES.');
const usage = ACCOUNTS ? createUsage(path.join(DATA_DIR, 'usage.sqlite')) : null;
/** Ko-fi or another page for «Підтримати»; shown when an allowance runs out. */
const SUPPORT_URL = process.env.SUPPORT_URL?.trim() || null;
const tenants = createTenants({
  projectRoot: PROJECT_ROOT,
  dataDir: DATA_DIR,
  seed: emptyDb,
  limiter: ACCOUNTS ? createLimiter(Math.max(1, Number(process.env.MAX_JOBS) || 2)) : undefined,
  engine: openAI ? createOpenAIEngine(openAI) : undefined,
  quota: quotaConfig && usage ? { cfg: quotaConfig, usage } : undefined,
  aiOwnerOnly: OWNER_ONLY,
});
const auth = authConfig ? await createAuth({ ...authConfig, ownerOnly: OWNER_ONLY }) : null;
const localTenant = ACCOUNTS ? null : tenants.local();

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Local Mac requests use a loopback Host. Anything else must come through
 * `tailscale serve`, which injects the tailnet identity header; only the
 * owner's login is accepted. The server itself never listens beyond loopback.
 */
const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-headers-info', 'x-forwarded-for', 'forwarded'];

/**
 * Trusted without a login: plain loopback requests, and requests from a
 * reverse proxy on the same machine that checks the owner's identity itself
 * and forwards with a loopback Host and X-Forwarded-Host. `tailscale serve`
 * requests carry the tailnet hostname and identity headers and are checked below.
 */
function authorize(req: http.IncomingMessage): string | null {
  const host = req.headers.host ?? '';
  const fwdHost = req.headers['x-forwarded-host'];
  const localForward = fwdHost === undefined || LOOPBACK_HOST.test(String(fwdHost));
  const proxied = PROXY_HEADERS.some((h) => h in req.headers);
  if (LOOPBACK_HOST.test(host) && localForward && !proxied) return null;
  const login = String(req.headers['tailscale-user-login'] ?? '').toLowerCase();
  const allowed = (process.env.CAPSULA_TAILSCALE_LOGIN || localTenant!.store.read().settings.tailscaleLogin || '').toLowerCase();
  if (!allowed) return 'Віддалений доступ вимкнено: у налаштуваннях не вказано Tailscale-логін власника';
  if (!login || login !== allowed) return 'Доступ дозволено лише власнику через Tailscale';
  return null;
}

const acceptsGzip = (req?: http.IncomingMessage) => /\bgzip\b/.test(String(req?.headers['accept-encoding'] ?? ''));

function send(res: http.ServerResponse, status: number, data: unknown, req?: http.IncomingMessage) {
  const body = JSON.stringify(data ?? { ok: true });
  const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding' };
  if (body.length > 2048 && acceptsGzip(req)) {
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(body, { level: 6 }));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

const gzCache = new Map<string, { mtime: number; buf: Buffer }>();
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg']);

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Запит завеликий'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendFile(res: http.ServerResponse, file: string, cache = 'no-cache', req?: http.IncomingMessage) {
  const ext = path.extname(file).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const headers: http.OutgoingHttpHeaders = { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' };
  if (COMPRESSIBLE.has(ext) && acceptsGzip(req)) {
    const mtime = fs.statSync(file).mtimeMs;
    let hit = gzCache.get(file);
    if (!hit || hit.mtime !== mtime) {
      hit = { mtime, buf: zlib.gzipSync(fs.readFileSync(file), { level: 9 }) };
      gzCache.set(file, hit);
    }
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
    res.end(hit.buf);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const secureCookies = Boolean(authConfig?.baseURL.startsWith('https://'));
/** Accounts mode: `www.` of the site's own host is sent to the site itself, so sign-in cookies stay on one host. */
const WWW_HOST = authConfig ? `www.${new URL(authConfig.baseURL).host}` : null;
// Accounts mode only: sign-in and uploads are rate-limited.
const rateLimiter = ACCOUNTS ? createRateLimiter() : null;
const TRUST_CLOUDFLARE = process.env.TRUST_PROXY === 'cloudflare';

/** Counts the request against each key; answers 429 with Retry-After when one is used up. */
function limited(res: http.ServerResponse, checks: [string, Rule][]): boolean {
  for (const [key, rule] of checks) {
    const wait = rateLimiter?.take(key, rule) ?? 0;
    if (!wait) continue;
    res.setHeader('retry-after', String(wait));
    send(res, 429, { error: RATE_LIMITED });
    return true;
  }
  return false;
}

/**
 * Accounts mode: the public site sends a strict CSP and the usual hardening headers; HSTS only over
 * HTTPS. The owner's local site is left as it was.
 */
const SECURITY_HEADERS: [string, string][] = [
  ['content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'same-origin'],
  ['x-content-type-options', 'nosniff'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(self)'],
  ...(secureCookies ? [['strict-transport-security', 'max-age=31536000'] as [string, string]] : []),
];

/** Accounts mode: sign-in, invites and the signed-in account's tenant; local mode: the owner's site. */
async function accountTenant(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string): Promise<Tenant | null> {
  if (!auth) return localTenant;
  const address = clientAddress(req, TRUST_CLOUDFLARE);
  if ((url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/i/') || url.pathname.startsWith('/t/')) && limited(res, [[`sign-in:${address}`, RATE_RULES.signIn]])) return null;
  // A test account's one-time link: better-auth opens the session (auth.ts, test-sign-in).
  if (method === 'GET' && url.pathname.startsWith('/t/')) {
    req.url = `/api/auth/test-sign-in?code=${encodeURIComponent(decodeURIComponent(url.pathname.slice(3)))}`;
    await auth.handler(req, res);
    return null;
  }
  if (url.pathname.startsWith('/api/auth/')) {
    const relay = method === 'GET' ? callbackRelay(authConfig!, url) : null;
    if (relay) {
      res.writeHead(302, { location: relay, 'cache-control': 'no-store' });
      res.end();
      return null;
    }
    if (url.searchParams.has(RELAY_MARK)) {
      url.searchParams.delete(RELAY_MARK);
      req.url = url.pathname + url.search;
    }
    await auth.handler(req, res);
    return null;
  }
  // An invite link sets a short-lived cookie that the Google sign-up checks, then opens the landing page.
  if (method === 'GET' && url.pathname.startsWith('/i/')) {
    const code = decodeURIComponent(url.pathname.slice(3));
    const ok = Boolean(auth.validInvite(code));
    res.writeHead(302, {
      location: ok ? '/?invite=1' : '/?invite=invalid',
      ...(ok ? { 'set-cookie': `${INVITE_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}` } : {}),
      'cache-control': 'no-store',
    });
    res.end();
    return null;
  }
  const needsAccount = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/thumb/');
  if (!needsAccount) return null;
  const user = await auth.userOf(req);
  if (method === 'GET' && url.pathname === '/api/session') {
    const tenant = user ? tenants.forUser(user.id, user.owner, user.test) : null;
    send(res, 200, { mode: 'accounts', user, quota: tenant?.quota?.status(tenant.store.read()) ?? null, support: SUPPORT_URL, invites: !OWNER_ONLY });
    return null;
  }
  if (!user) {
    send(res, 401, { error: 'Потрібно увійти' });
    return null;
  }
  if (url.pathname.startsWith('/api/') && method !== 'GET' && req.headers['x-capsula'] !== '1') {
    send(res, 403, { error: 'Запит без заголовка сайту відхилено' });
    return null;
  }
  // Owner: invite links. Everyone: delete their own account and everything in it.
  if (url.pathname === '/api/invites' || url.pathname.startsWith('/api/invites/')) {
    if (!user.owner) send(res, 403, { error: 'Лише для власника' });
    else if (OWNER_ONLY && method === 'POST') send(res, 403, { error: 'Запрошення вимкнені: AI працює на підписці власника' });
    else if (method === 'GET') send(res, 200, auth.invites.list());
    else if (method === 'POST') send(res, 200, auth.invites.create());
    else if (method === 'DELETE') send(res, 200, (auth.invites.disable(decodeURIComponent(url.pathname.split('/')[3] ?? '')), { ok: true }));
    else send(res, 405, { error: 'Метод не підтримується' });
    return null;
  }
  // The owner is the admin: everyone with an account, and the owner's test accounts with their one-time links.
  if (url.pathname.startsWith('/api/admin/')) {
    await admin(req, res, url, method, user.owner);
    return null;
  }
  if (method === 'POST' && url.pathname === '/api/upload' && !user.owner && limited(res, [[`upload:${user.id}`, RATE_RULES.uploadAccount], [`upload-address:${address}`, RATE_RULES.uploadAddress]])) return null;
  if (method === 'DELETE' && url.pathname === '/api/account') {
    tenants.remove(user.id);
    auth.deleteUser(user.id);
    send(res, 200, { ok: true });
    return null;
  }
  return tenants.forUser(user.id, user.owner, user.test);
}

/** `/api/admin/…`, the owner only: accounts with what they hold and this month's AI work; test accounts. */
async function admin(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string, owner: boolean) {
  if (!owner) return send(res, 403, { error: 'Лише для власника' });
  const [, , , what, id, action] = url.pathname.split('/').map((p) => decodeURIComponent(p));
  const tests = auth!.admin.tests;
  const link = (code: string) => `${authConfig!.baseURL}/t/${code}`;
  if (what === 'users' && !id && method === 'GET') {
    return send(res, 200, auth!.admin.users().map((u) => ({ ...u, wardrobe: tenants.summary(u.id), ai: usage?.done(u.id) ?? null })), req);
  }
  if (what !== 'test-accounts') return send(res, 404, { error: 'Не знайдено' });
  if (!id && method === 'POST') {
    let name: string | undefined;
    try {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { name?: unknown };
      name = typeof body.name === 'string' ? body.name : undefined;
    } catch {
      throw new HttpError(400, 'Неправильний JSON');
    }
    const account = tests.create(name);
    return send(res, 200, { ...account, link: link(tests.link(account.id)!) });
  }
  if (!id || !tests.isTest(id)) return send(res, 404, { error: 'Тестового акаунта немає' });
  if (action === 'link' && method === 'POST') return send(res, 200, { link: link(tests.link(id)!) });
  if (!action && method === 'DELETE') {
    tenants.remove(id);
    tests.remove(id);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'Метод не підтримується' });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const method = req.method ?? 'GET';
  if (ACCOUNTS) for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
  if (WWW_HOST && req.headers.host?.toLowerCase() === WWW_HOST) {
    res.writeHead(301, { location: `${authConfig!.baseURL}${url.pathname}${url.search}`, 'cache-control': 'public, max-age=3600' });
    return void res.end();
  }
  // Uptime checks and the container health check: no data, no sign-in.
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (!ACCOUNTS) {
    const denied = authorize(req);
    if (denied) return send(res, 403, { error: denied });
  }
  const isTenantPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/thumb/') || url.pathname.startsWith('/i/') || (ACCOUNTS && url.pathname.startsWith('/t/'));
  const tenant = isTenantPath ? await accountTenant(req, res, url, method) : localTenant;
  if (isTenantPath && !tenant) return; // answered: sign-in, invite, test link, session, admin tools or account deletion
  const { store, runner, ctx, root } = tenant ?? localTenant ?? ({} as Tenant);

  if (url.pathname.startsWith('/api/')) {
    if (method !== 'GET' && req.headers['x-capsula'] !== '1') return send(res, 403, { error: 'Запит без заголовка сайту відхилено' });
    if (method === 'GET' && url.pathname === '/api/session') return send(res, 200, { mode: 'local', user: null });
    if (method === 'GET' && url.pathname === '/api/state') {
      const db = store.read();
      return send(res, 200, { db: stateView(db), runner: runner.state, recovered: store.recovered(), dataDir: path.relative(root, store.dataDir) }, req);
    }
    if (method === 'GET' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/log')) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const job = store.read().jobs.find((j) => j.id === id);
      if (!job?.logPath) return send(res, 404, { error: 'Журналу немає' });
      const text = fs.existsSync(path.join(root, job.logPath)) ? fs.readFileSync(path.join(root, job.logPath), 'utf8') : '';
      return send(res, 200, { log: text.slice(-20000) });
    }
    if (method === 'POST' && url.pathname === '/api/upload') {
      const buf = await readBody(req, MAX_UPLOAD_BYTES + 1);
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
      return send(res, 200, await upload(ctx, url.searchParams, buf, name));
    }
    const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req, 1024 * 1024);
    let body: Record<string, unknown> = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Неправильний JSON');
      }
    }
    return send(res, 200, await dispatch(ctx, method, url.pathname, body), req);
  }

  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'Метод не підтримується' });

  if (url.pathname.startsWith('/media/')) {
    const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
    const file = resolveAllowed(root, store.dataDir, rel);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Файл не знайдено' });
    return sendFile(res, file, 'private, max-age=3600');
  }

  if (url.pathname.startsWith('/thumb/')) {
    const rel = decodeURIComponent(url.pathname.slice('/thumb/'.length));
    const file = resolveAllowed(root, store.dataDir, rel);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Файл не знайдено' });
    const size = snapWidth(Number(url.searchParams.get('w')) || 480);
    const thumb = await thumbnail(root, store.dataDir, rel, rel, size);
    return sendFile(res, thumb, 'private, max-age=86400');
  }

  const asset = path.resolve(DIST, `.${url.pathname}`);
  if (asset.startsWith(DIST + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile()) {
    return sendFile(res, asset, url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', req);
  }
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) return send(res, 503, { error: 'Інтерфейс не зібрано: запусти npm start' });
  return sendFile(res, index, 'no-cache', req);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    const err = e instanceof HttpError ? e : new HttpError(500, (e as Error)?.message || 'Внутрішня помилка');
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, err.status, { error: err.message, details: err.details });
    else res.end();
  });
});

// Local mode warms the thumbnail cache for everything the UI shows, in the background (the tenant resumes an interrupted run itself).
if (localTenant) {
  const db = localTenant.store.read();
  prewarm(PROJECT_ROOT, DATA_DIR, [...db.photos.map((p) => p.path), ...db.results.map((r) => r.imagePath)]);
}
server.listen(PORT, HOST, () => {
  console.log(`${new Date().toISOString()} Capsula: http://${HOST}:${PORT}  (${ACCOUNTS ? `акаунти, ${authConfig!.baseURL}, AI: ${openAI ? 'OpenAI API' : OWNER_ONLY ? 'Codex, лише власник' : CODEX_PRODUCTION ? 'Codex, акаунти за запрошенням' : 'Codex'}` : `дані: ${path.relative(PROJECT_ROOT, DATA_DIR)}, Codex: ${localTenant!.runner.state.codexBin}`})`);
});
