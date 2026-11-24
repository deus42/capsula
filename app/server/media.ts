import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './store.ts';

const run = promisify(execFile);

// Bound libvips native memory inside the production container.
if (process.env.NODE_ENV === 'production') {
  sharp.cache(false);
  sharp.concurrency(1);
}

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/** Beta storage per account, the owner excepted. */
export interface StorageLimits { fileBytes: number; photos: number; storageBytes: number }
export const ACCOUNT_LIMITS: StorageLimits = { fileBytes: 15 * 1024 ** 2, photos: 300, storageBytes: 2 * 1024 ** 3 };

/** Bytes in a folder and everything under it. */
export function folderBytes(dir: string): number {
  let total = 0;
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? folderBytes(p) : d.isFile() ? fs.statSync(p).size : 0;
  }
  return total;
}

/** Async folder size walk so upload quota checks never block the event loop. */
export async function folderBytesAsync(dir: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) total += await folderBytesAsync(p);
    else if (d.isFile()) total += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export function detectImageType(buf: Buffer): 'jpg' | 'png' | 'heic' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

/**
 * Stores an uploaded original untouched. HEIC (iPhone) gets an extra JPEG display copy — macOS `sips` on the
 * owner's Mac, sharp elsewhere when its build reads HEIC (the site converts HEIC in the browser before upload).
 */
export async function saveUpload(projectRoot: string, dataDir: string, id: string, buf: Buffer) {
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Файл більший за 40 МБ');
  const type = detectImageType(buf);
  if (!type) throw new HttpError(415, 'Підтримуються JPEG, PNG, HEIC і WebP');
  const dir = path.join(dataDir, 'media', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `${id}.${type}`);
  fs.writeFileSync(original, buf, { flag: 'wx' });
  let display = original;
  if (type === 'heic') {
    display = path.join(dir, `${id}.jpg`);
    try {
      if (process.platform === 'darwin') await run('sips', ['-s', 'format', 'jpeg', original, '--out', display]);
      else await sharp(original).rotate().jpeg({ quality: 90 }).toFile(display);
    } catch {
      fs.rmSync(original, { force: true });
      throw new HttpError(422, 'Не вдалося прочитати HEIC — завантаж це фото як JPEG');
    }
  }
  return {
    path: path.relative(projectRoot, display),
    originalPath: display === original ? undefined : path.relative(projectRoot, original),
  };
}

/** Thumbnails come in three sizes so caching and prewarming cover every request. */
export function snapWidth(w: number) {
  if (w <= 200) return 160;
  if (w <= 600) return 480;
  return 960;
}

const warmQueue: { projectRoot: string; dataDir: string; rel: string; size: number }[] = [];
let warming = 0;
function pumpWarm() {
  while (warming < 2 && warmQueue.length) {
    const t = warmQueue.shift()!;
    warming += 1;
    thumbnail(t.projectRoot, t.dataDir, t.rel, t.rel, t.size)
      .catch(() => undefined)
      .finally(() => {
        warming -= 1;
        pumpWarm();
      });
  }
}

/** Generates thumbnails in the background (two at a time). */
export function prewarm(projectRoot: string, dataDir: string, rels: string[], sizes = [160, 480]) {
  for (const rel of rels) for (const size of sizes) warmQueue.push({ projectRoot, dataDir, rel, size });
  pumpWarm();
}

const inflight = new Map<string, Promise<string>>();

/** Lazily builds a cached JPEG thumbnail with sharp (EXIF-upright, never enlarged); concurrent requests share one run. */
export async function thumbnail(projectRoot: string, dataDir: string, key: string, relPath: string, size = 720) {
  const dir = path.join(dataDir, 'media', 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${key.replace(/[^\w.-]/g, '_')}-${size}.jpg`);
  const src = path.join(projectRoot, relPath);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  const pending = inflight.get(out);
  if (pending) return pending;
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.jpg`;
  const job = sharp(src).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(tmp)
    // A format sharp cannot read falls back to macOS `sips` on the owner's Mac.
    .catch((e: unknown) => (process.platform === 'darwin' ? run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(size), src, '--out', tmp]) : Promise.reject(e)))
    .then(() => {
      fs.renameSync(tmp, out);
      return out;
    })
    .finally(() => {
      inflight.delete(out);
      fs.rmSync(tmp, { force: true });
    });
  inflight.set(out, job);
  return job;
}

/** Only these project folders may be served or attached to Codex jobs. */
export function allowedRoots(projectRoot: string, dataDir: string) {
  return [path.join(projectRoot, 'assets', 'photos'), path.join(dataDir, 'media'), path.join(projectRoot, 'output', 'prototypes')].map((p) => path.resolve(p) + path.sep);
}

export function resolveAllowed(projectRoot: string, dataDir: string, relPath: string, scope: 'media' | 'job-log' = 'media') {
  const abs = path.resolve(projectRoot, relPath);
  const roots = scope === 'job-log' ? [path.resolve(dataDir, 'jobs') + path.sep] : allowedRoots(projectRoot, dataDir);
  if (!roots.some((root) => abs.startsWith(root))) throw new HttpError(403, 'Шлях поза дозволеними каталогами');
  return abs;
}

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
