// Quotas and the monthly budget, accounts mode only.
// Every account has a monthly allowance per kind of AI work; finished jobs are counted in a small SQLite ledger
// (jobs can be deleted from a wardrobe, the ledger keeps the count). Every API call's cost is recorded too: once
// the accounts' total reaches MONTHLY_BUDGET_USD, generation pauses for everyone but the owner until the 1st.
// The owner has no allowance and their spending is kept apart from the budget.
import { DatabaseSync } from 'node:sqlite';
import type { DB, Job } from './schema.ts';
import { HttpError, type Store } from './store.ts';

export type QuotaKind = 'tryon' | 'packshot' | 'intake' | 'styling' | 'advice';
export const QUOTA_KINDS: QuotaKind[] = ['tryon', 'packshot', 'intake', 'styling', 'advice'];

/** Which allowance a job uses: «Підібрати», «Нові», onboarding plans/matches and shop searches share styling; identity setup counts as a try-on. */
export function quotaKind(job: Pick<Job, 'kind'>): QuotaKind {
  switch (job.kind ?? 'tryon') {
    case 'tryon':
    case 'identity_prep': return 'tryon';
    case 'packshot': return 'packshot';
    case 'intake': return 'intake';
    case 'advise': return 'advice';
    default: return 'styling';
  }
}

const EXHAUSTED: Record<QuotaKind, string> = {
  tryon: 'Ліміт примірок на цей місяць вичерпано',
  packshot: 'Ліміт фото речей на цей місяць вичерпано',
  intake: 'Ліміт розпізнавання фото на цей місяць вичерпано',
  styling: 'Ліміт підборів на цей місяць вичерпано',
  advice: 'Ліміт порадника на цей місяць вичерпано',
};
export const PAUSED = 'Генерацію призупинено до 1-го числа: місячний бюджет вичерпано';

export interface QuotaConfig {
  limits: Record<QuotaKind, number>;
  /** Try-ons waiting or running at once per account. */
  tryonQueue: number;
  /** Hard monthly spend for every account but the owner's; null leaves only the OpenAI project limit. */
  budgetUsd: number | null;
}

const count = (v: string | undefined, fallback: number) => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Quota values must be whole numbers ≥ 0, got "${v}"`);
  return n;
};

export function quotaConfigFromEnv(env: NodeJS.ProcessEnv): QuotaConfig {
  const budget = env.MONTHLY_BUDGET_USD?.trim();
  const budgetUsd = budget ? Number(budget) : null;
  if (budgetUsd !== null && !(Number.isFinite(budgetUsd) && budgetUsd >= 0)) throw new Error(`MONTHLY_BUDGET_USD must be a number, got "${budget}"`);
  return {
    limits: {
      tryon: count(env.QUOTA_TRYON, 10),
      packshot: count(env.QUOTA_PACKSHOT, 60),
      intake: count(env.QUOTA_INTAKE, 100),
      styling: count(env.QUOTA_STYLING, 30),
      advice: count(env.QUOTA_ADVICE, 30),
    },
    tryonQueue: count(env.QUOTA_TRYON_QUEUE, 3),
    budgetUsd,
  };
}

/** The calendar month in UTC, e.g. "2026-11"; allowances renew on the 1st. */
export const monthOf = (at = new Date()) => at.toISOString().slice(0, 7);

/** The ledger: finished jobs per account, month and kind, and the cost of every API call. */
export function createUsage(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS usage_done (
    month TEXT NOT NULL, userId TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, userId, kind))`);
  db.exec(`CREATE TABLE IF NOT EXISTS usage_cost (
    month TEXT NOT NULL, userId TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (month, userId))`);
  return {
    addDone(userId: string, kind: QuotaKind, month = monthOf()) {
      db.prepare('INSERT INTO usage_done (month, userId, kind, count) VALUES (?, ?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1').run(month, userId, kind);
    },
    addCost(userId: string, owner: boolean, usd: number, month = monthOf()) {
      if (!(usd > 0)) return;
      db.prepare('INSERT INTO usage_cost (month, userId, owner, usd) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET usd = usd + excluded.usd').run(month, userId, owner ? 1 : 0, usd);
    },
    done(userId: string, month = monthOf()): Record<QuotaKind, number> {
      const out = Object.fromEntries(QUOTA_KINDS.map((k) => [k, 0])) as Record<QuotaKind, number>;
      for (const row of db.prepare('SELECT kind, count FROM usage_done WHERE month = ? AND userId = ?').all(month, userId) as { kind: QuotaKind; count: number }[]) out[row.kind] = row.count;
      return out;
    },
    spent(userId: string, month = monthOf()) {
      return (db.prepare('SELECT usd FROM usage_cost WHERE month = ? AND userId = ?').get(month, userId) as { usd: number } | undefined)?.usd ?? 0;
    },
    /** What counts against the budget: every account but the owner's. */
    budgetSpent(month = monthOf()) {
      return (db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM usage_cost WHERE month = ? AND owner = 0').get(month) as { usd: number }).usd;
    },
    /** A deleted account: its counts go; its spending stays in the month's total under no account. */
    forget(userId: string) {
      db.prepare('DELETE FROM usage_done WHERE userId = ?').run(userId);
      db.prepare("UPDATE usage_cost SET userId = 'deleted:' || month || ':' || rowid WHERE userId = ?").run(userId);
    },
    close: () => db.close(),
  };
}
export type Usage = ReturnType<typeof createUsage>;

const pendingJob = (j: Job) => j.state === 'queued' || j.state === 'running';

export interface QuotaStatus {
  month: string;
  owner: boolean;
  paused: boolean;
  /** Per kind: finished this month plus waiting or running now, against the allowance (null for the owner). */
  kinds: Record<QuotaKind, { used: number; limit: number | null }>;
  /** Owner only: this month's spending of all accounts against the budget, and the owner's own apart. */
  spentUsd?: number;
  budgetUsd?: number | null;
  ownSpentUsd?: number;
}

/** One account's view of the allowances: checks before a request, trims what slips through, counts what finishes. */
export function accountQuota(cfg: QuotaConfig, usage: Usage, userId: string, owner: boolean) {
  const paused = () => !owner && cfg.budgetUsd !== null && usage.budgetSpent() >= cfg.budgetUsd;

  function used(db: DB, exclude?: Set<string>) {
    const done = usage.done(userId);
    for (const j of db.jobs) if (pendingJob(j) && !exclude?.has(j.id)) done[quotaKind(j)] += 1;
    return done;
  }
  const tryonsPending = (db: DB, exclude?: Set<string>) => db.jobs.filter((j) => quotaKind(j) === 'tryon' && pendingJob(j) && !exclude?.has(j.id)).length;

  return {
    paused,
    /** Before a request that starts AI work: a clear 429 instead of a job that would never run. */
    admit(db: DB, kind: QuotaKind, n = 1) {
      if (owner) return;
      if (paused()) throw new HttpError(429, PAUSED, { quota: 'budget' });
      if (used(db)[kind] + n > cfg.limits[kind]) throw new HttpError(429, EXHAUSTED[kind], { quota: kind });
      if (kind === 'tryon' && tryonsPending(db) + n > cfg.tryonQueue) throw new HttpError(429, `У черзі вже ${cfg.tryonQueue} примірки — дочекайся, поки вони будуть готові`, { quota: 'queue' });
    },
    /**
     * Inside every write: new jobs beyond an allowance (or while paused) are dropped, so background work such
     * as the advisor or covers after a photo never goes over. Returns the dropped ids.
     */
    trim(db: DB, before: Set<string>): string[] {
      if (owner) return [];
      const fresh = db.jobs.filter((j) => !before.has(j.id) && j.state === 'queued');
      if (!fresh.length) return [];
      const freshIds = new Set(fresh.map((j) => j.id));
      const counts = used(db, freshIds);
      let tryons = tryonsPending(db, freshIds);
      const stop = paused();
      const dropped = new Set<string>();
      for (const j of fresh) {
        const k = quotaKind(j);
        if (stop || counts[k] + 1 > cfg.limits[k] || (k === 'tryon' && tryons + 1 > cfg.tryonQueue)) dropped.add(j.id);
        else {
          counts[k] += 1;
          if (k === 'tryon') tryons += 1;
        }
      }
      if (dropped.size) db.jobs = db.jobs.filter((j) => !dropped.has(j.id));
      return [...dropped];
    },
    finished: (kind: QuotaKind) => usage.addDone(userId, kind),
    cost: (usd: number) => usage.addCost(userId, owner, usd),
    /** A queued job may start: everything waits while the budget is spent, except the owner's. */
    canStart: () => !paused(),
    status(db: DB): QuotaStatus {
      const counts = used(db);
      const kinds = Object.fromEntries(QUOTA_KINDS.map((k) => [k, { used: counts[k], limit: owner ? null : cfg.limits[k] }])) as QuotaStatus['kinds'];
      const base = { month: monthOf(), owner, paused: paused(), kinds };
      return owner ? { ...base, spentUsd: round(usage.budgetSpent()), budgetUsd: cfg.budgetUsd, ownSpentUsd: round(usage.spent(userId)) } : base;
    },
  };
}
export type AccountQuota = ReturnType<typeof accountQuota>;

const round = (usd: number) => Math.round(usd * 100) / 100;

/**
 * The account's store with its allowances applied: every write drops new jobs beyond them, and jobs that
 * finish in a write are counted once it is saved.
 */
export function meteredStore(store: Store, quota: AccountQuota): Store {
  return {
    ...store,
    async mutate<T>(fn: (db: DB) => T): Promise<T> {
      let finished: Job[] = [];
      const out = await store.mutate((db) => {
        const before = new Map(db.jobs.map((j) => [j.id, j.state] as const));
        const result = fn(db);
        quota.trim(db, new Set(before.keys()));
        finished = db.jobs.filter((j) => j.state === 'done' && before.has(j.id) && before.get(j.id) !== 'done');
        return result;
      });
      for (const j of finished) quota.finished(quotaKind(j));
      return out;
    },
  };
}
