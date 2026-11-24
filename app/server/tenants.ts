// Tenants: every account has its own folder with the same
// locked JSON store, media and job folders the single-user site uses. Local mode keeps one tenant — the owner's
// existing data in the project — exactly as before; accounts mode opens `<data>/users/<userId>/` per signed-in user.
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './schema.ts';
import { MEASURE_KEYS, SCHEMA_VERSION } from './schema.ts';
import { HttpError, createStore, now, type Store } from './store.ts';
import { createRunner, type Limiter } from './runner.ts';
import type { OpenAIEngine } from './openai-engine.ts';
import { ACCOUNT_LIMITS } from './media.ts';
import { accountQuota, meteredStore, type AccountQuota, type QuotaConfig, type QuotaKind, type Usage } from './quota.ts';
import type { Ctx } from './routes.ts';

export type Runner = ReturnType<typeof createRunner>;
export interface Tenant {
  id: string;
  /** Root that stored media paths are relative to. */
  root: string;
  store: Store;
  runner: Runner;
  ctx: Ctx;
  /** Accounts mode: this account's monthly allowances. */
  quota?: AccountQuota;
}

/** Every API call's cost goes to the account's ledger. */
export const meteredEngine = (engine: OpenAIEngine, cost: (usd: number) => void): OpenAIEngine => ({
  ...engine,
  async json(req) {
    const out = await engine.json(req);
    if (out.usage) cost(out.usage.costUsd);
    return out;
  },
  async image(req) {
    const out = await engine.image(req);
    if (out.usage) cost(out.usage.costUsd);
    return out;
  },
});

/** A new account's wardrobe: empty, valid, nothing seeded from anyone else's data. */
export function emptyDb(): DB {
  const at = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    updatedAt: at,
    photos: [], items: [], needs: [], products: [], looks: [], capsules: [], jobs: [], results: [], comparisons: [],
    profile: {
      rev: 1,
      basePhotoIds: [],
      measurements: Object.fromEntries(MEASURE_KEYS.map((k) => [k, { value: null }])) as DB['profile']['measurements'],
      knownSizes: [],
      preferences: { comfort: '', materials: '', fit: '', branding: '' },
    },
    settings: { codexModel: 'gpt-6.1-sol', reasoningEffort: 'medium', tailscaleLogin: '' },
  } as DB;
}

export const AI_OWNER_ONLY = 'AI поки працює лише для власника сайту';

/** Account ids come from the auth database; anything else is refused before it can name a folder. */
const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** `aiOwnerOnly`: AI runs on the owner's own subscription, so only the owner and their test accounts may queue or start AI work. */
export function createTenants(opts: { projectRoot: string; dataDir: string; seed: () => DB; limiter?: Limiter; codexBin?: string; engine?: OpenAIEngine; quota?: { cfg: QuotaConfig; usage: Usage }; aiOwnerOnly?: boolean }) {
  const cache = new Map<string, Tenant>();

  function open(id: string, root: string, dataDir: string, seed: () => DB, account?: { owner: boolean; test?: boolean }): Tenant {
    const raw = createStore(dataDir, seed);
    const quota = account && opts.quota ? accountQuota(opts.quota.cfg, opts.quota.usage, id, account.owner) : undefined;
    const store = quota ? meteredStore(raw, quota) : raw;
    const engine = quota && opts.engine ? meteredEngine(opts.engine, quota.cost) : opts.engine;
    const noAI = Boolean(opts.aiOwnerOnly && account && !account.owner && !account.test);
    // Invited and test accounts start try-ons explicitly, preserving their monthly allowance.
    const autoTryOn = !account || account.owner;
    const runner = createRunner(store, root, opts.codexBin, { limiter: opts.limiter, engine, canStart: noAI ? () => false : quota?.canStart, autoTryOn });
    const admit = noAI
      ? () => { throw new HttpError(403, AI_OWNER_ONLY); }
      : quota ? (kind: QuotaKind, n?: number) => quota.admit(store.read(), kind, n) : undefined;
    const limits = account && !account.owner ? ACCOUNT_LIMITS : undefined;
    const tenant: Tenant = { id, root, store, runner, quota, ctx: { store, projectRoot: root, drain: () => void runner.drain(), admit, limits, autoTryOn } };
    // A run stopped by a restart continues when its account is opened again; an account's queue resumes too
    // (it may have waited for the budget). The owner's local site keeps its queue as it was left.
    void runner.recover().then((n) => (n > 0 || account ? runner.drain() : undefined)).catch(() => undefined);
    return tenant;
  }

  /** The owner's single local site: the project folder and its existing data. */
  function local(): Tenant {
    let t = cache.get('local');
    if (!t) cache.set('local', (t = open('local', opts.projectRoot, opts.dataDir, opts.seed)));
    return t;
  }

  const userRoot = (userId: string) => {
    if (!SAFE_ID.test(userId)) throw new Error('Unsafe account id');
    return path.join(opts.dataDir, 'users', userId);
  };

  /** `test`: one of the owner's test accounts, with an ordinary account's allowances. */
  function forUser(userId: string, owner = false, test = false): Tenant {
    let t = cache.get(userId);
    if (!t) {
      const root = userRoot(userId);
      cache.set(userId, (t = open(userId, root, root, emptyDb, { owner, test })));
    }
    return t;
  }

  /** What an account holds, for the admin: read from its file without opening it, so no queue starts. */
  function summary(userId: string): { photos: number; items: number; looks: number; capsules: number } | null {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(userRoot(userId), 'db.json'), 'utf8')) as DB;
      return { photos: db.photos.length, items: db.items.length, looks: db.looks.length, capsules: db.capsules.length };
    } catch {
      return null;
    }
  }

  /** Account deletion: the queue stops, the whole folder goes and its counts are forgotten. */
  function remove(userId: string) {
    const root = userRoot(userId);
    cache.get(userId)?.runner.stop();
    cache.delete(userId);
    fs.rmSync(root, { recursive: true, force: true });
    opts.quota?.usage.forget(userId);
  }

  /** Stops every open tenant's runner and background timers (graceful shutdown). */
  function stopAll() {
    for (const t of cache.values()) t.runner.stop();
  }

  return { local, forUser, remove, userRoot, summary, stopAll };
}
