import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './schema.ts';
import { validateDb } from './schema.ts';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Store {
  dataDir: string;
  read(): DB;
  mutate<T>(fn: (db: DB) => T): Promise<T>;
  /** True when the last load fell back to the previous valid copy. */
  recovered(): boolean;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * File store: one JSON document, cross-process lock, atomic replace and a
 * previous-valid backup. Every mutation reloads from disk inside the lock, so
 * concurrent writers (site and agent tooling) never overwrite each other blindly.
 */
export function createStore(dataDir: string, seed: () => DB): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  const prev = path.join(dataDir, 'db.prev.json');
  const lockFile = path.join(dataDir, 'db.lock');
  let fellBack = false;
  let cache: { key: string; db: DB } | null = null;

  function statKey(f: string): string | null {
    try {
      const s = fs.statSync(f);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  function parseValid(f: string): DB | null {
    try {
      const db = JSON.parse(fs.readFileSync(f, 'utf8')) as DB;
      return validateDb(db) ? null : db;
    } catch {
      return null;
    }
  }

  function writeAtomic(db: DB) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(db, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const existingKey = statKey(file);
    if (existingKey && ((cache && cache.key === existingKey) || parseValid(file))) fs.copyFileSync(file, prev);
    fs.renameSync(tmp, file);
    const nextKey = statKey(file);
    cache = nextKey ? { key: nextKey, db: structuredClone(db) } : null;
  }

  function load(): DB {
    const key = statKey(file);
    if (key && cache && cache.key === key) {
      fellBack = false;
      return structuredClone(cache.db);
    }
    if (!key && !fs.existsSync(prev)) {
      const db = seed();
      const err = validateDb(db);
      if (err) throw new Error(`Початкові дані невалідні: ${err}`);
      writeAtomic(db);
      fellBack = false;
      return structuredClone(db);
    }
    const current = key ? parseValid(file) : null;
    if (current) {
      fellBack = false;
      cache = key ? { key, db: current } : null;
      return structuredClone(current);
    }
    cache = null;
    const backup = fs.existsSync(prev) ? parseValid(prev) : null;
    if (backup) {
      fellBack = true;
      return backup;
    }
    throw new Error('db.json пошкоджений і валідної резервної копії немає — дані не перезаписано');
  }

  async function acquire(): Promise<() => void> {
    const started = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => fs.rmSync(lockFile, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 15_000) fs.rmSync(lockFile, { force: true });
        } catch {
          /* lock vanished between checks */
        }
        if (Date.now() - started > 10_000) throw new HttpError(503, 'Сховище зайняте іншим процесом');
        await wait(25);
      }
    }
  }

  let chain: Promise<unknown> = Promise.resolve();

  return {
    dataDir,
    read: () => load(),
    recovered: () => fellBack,
    mutate<T>(fn: (db: DB) => T): Promise<T> {
      const run = chain.then(async () => {
        const release = await acquire();
        try {
          const db = load();
          const out = fn(db);
          db.revision += 1;
          db.updatedAt = new Date().toISOString();
          const err = validateDb(db);
          if (err) throw new HttpError(422, err);
          writeAtomic(db);
          fellBack = false;
          return out;
        } finally {
          release();
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export function now() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Optimistic concurrency for editable entities. */
export function bump<T extends { rev: number; updatedAt?: string }>(entity: T, expectedRev: unknown) {
  if (typeof expectedRev === 'number' && expectedRev !== entity.rev) {
    throw new HttpError(409, 'Запис уже змінено в іншому місці — оновіть сторінку', entity);
  }
  entity.rev += 1;
  if ('updatedAt' in entity) entity.updatedAt = now();
}

export function findOr404<T extends { id: string }>(list: T[], id: string, label: string): T {
  const found = list.find((e) => e.id === id);
  if (!found) throw new HttpError(404, `${label} не знайдено`);
  return found;
}
