// «Додати мій образ»: real photos of a saved look, read once by the existing engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { DB, Result } from './schema.ts';
import { SCHEMA_VERSION, emptySlots, validateDb } from './schema.ts';
import { HttpError, createStore } from './store.ts';
import { dispatch, upload, type Ctx } from './routes.ts';
import { createRunner } from './runner.ts';
import { stateView } from './state-view.ts';
import { wearRender } from './wear-review.ts';
import { currentWear, wearRenderOf } from '../src/lib.ts';

const at = '2026-11-21T00:00:00.000Z';

function fixture(): DB {
  const slots = { ...emptySlots(), top: [{ kind: 'item' as const, id: 'W-polo' }], bottom: [{ kind: 'item' as const, id: 'W-chino' }] };
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    updatedAt: at,
    photos: [],
    items: [
      { id: 'W-polo', rev: 1, category: 'shirts', title: 'Red polo', color: 'red', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at },
      { id: 'W-chino', rev: 1, category: 'trousers', title: 'Navy chinos', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at },
      { id: 'W-jeans', rev: 1, category: 'trousers', title: 'Grey jeans', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at },
    ],
    needs: [],
    products: [],
    looks: [{ id: 'L-1', rev: 1, capsuleId: 'C-1', name: 'City day', slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'owner', createdAt: at, updatedAt: at }],
    capsules: [{ id: 'C-1', rev: 1, name: 'Smart Casual', season: 'all', description: '', situations: [], favorite: false, lookIds: ['L-1'], origin: 'owner', createdAt: at, updatedAt: at }],
    jobs: [],
    results: [],
    comparisons: [],
    profile: {
      rev: 1,
      basePhotoIds: [],
      measurements: { height: { value: null }, chest: { value: null }, waist: { value: null }, hips: { value: null }, shoulders: { value: null }, sleeve: { value: null }, inseam: { value: null }, foot: { value: null } },
      knownSizes: [],
      preferences: { comfort: '', materials: '', fit: '', branding: '' },
    },
    settings: { codexModel: 'test-model', reasoningEffort: 'medium', tailscaleLogin: '' },
  };
}

const png = (background: string) => sharp({ create: { width: 24, height: 36, channels: 3, background } }).png().toBuffer();

function setup(admit?: Ctx['admit']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-wear-'));
  const store = createStore(dir, fixture);
  let drained = 0;
  const ctx: Ctx = { store, projectRoot: dir, drain: () => void drained++, admit };
  const call = (method: string, p: string, body: Record<string, unknown> = {}) => dispatch(ctx, method, p, body) as Promise<any>;
  return { dir, store, ctx, call, drained: () => drained };
}

/** A render of the look's version on disk and in the store. */
async function addRender(dir: string, store: ReturnType<typeof createStore>, id: string, lookVersion: number, extra: Partial<Result> = {}) {
  const rel = `media/renders/${id}.png`;
  fs.mkdirSync(path.join(dir, 'media', 'renders'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), await png('#ffffff'));
  await store.mutate((db) => {
    db.jobs.push({ id: `J-${id}`, lookId: 'L-1', lookVersion, snapshot: { lookName: 'City day', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'done', origin: 'site', resultId: id, createdAt: at });
    db.results.push({ id, jobId: `J-${id}`, lookId: 'L-1', lookVersion, imagePath: rel, tool: 'test', model: 'test', prompt: 'p', sources: [], usedItemPhotos: true, review: 'accepted', favorite: false, createdAt: `2026-11-21T00:00:0${lookVersion}.000Z`, ...extra });
  });
}

const REVIEW = {
  status: 'done', reason: '',
  uk: { seen: 'Червоне поло тримає акцент між темними речами.', differences: [{ cause: 'outfit', text: 'Над кедами штани збираються у складки.' }, { cause: 'render', text: 'На рендері штани рівні.' }], adjust: 'Спробуй один вузький підворот.' },
  en: { seen: 'The red polo holds the accent between dark pieces.', differences: [{ cause: 'outfit', text: 'The trousers bunch above the sneakers.' }, { cause: 'render', text: 'The render shows them straight.' }], adjust: 'Try one narrow cuff.' },
};

function fakeEngine(reply: () => Record<string, unknown> | null) {
  const calls: { prompt: string; images: string[]; schema: object }[] = [];
  return {
    calls,
    engine: {
      label: 'text-model', imageLabel: 'image-model',
      json: async (req: { prompt: string; images?: string[]; schema: object }) => {
        calls.push({ prompt: req.prompt, images: req.images ?? [], schema: req.schema });
        const r = reply();
        return r ? { reply: r, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } : { reply: null, err: 'OpenAI 500: down' };
      },
      image: async () => ({ ok: false, err: 'not used' }),
    } as never,
  };
}

test('worn photos are stored once per file and never become a base, identity or garment source', async () => {
  const { ctx, store, call } = setup();
  const a = await png('#aa2222');
  const first = await upload(ctx, new URLSearchParams({ kind: 'worn', item: 'W-polo' }), a, 'IMG_1.HEIC');
  const again = await upload(ctx, new URLSearchParams({ kind: 'worn' }), a, 'IMG_1 copy.jpg');
  assert.equal(again.id, first.id, 'the same file chosen again is the same photo');
  let db = store.read();
  assert.equal(db.photos.length, 1);
  assert.equal(db.photos[0].kind, 'worn');
  assert.match(db.photos[0].sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(db.items[0].photoIds, [], 'a worn photo is not attached to a garment');
  await call('PATCH', '/api/profile', { basePhotoIds: [first.id] });
  await call('PATCH', '/api/items/W-polo', { photoIds: [first.id] });
  db = store.read();
  assert.deepEqual(db.profile.basePhotoIds, []);
  assert.deepEqual(db.items[0].photoIds, []);
  await assert.rejects(call('DELETE', `/api/photos/${first.id}`), /Оригінал збережено/, 'the original stays');
  const broken = structuredClone(db);
  broken.profile.basePhotoIds = [first.id];
  assert.match(validateDb(broken) ?? '', /фото образу не може бути базовим/);
});

test('one action saves one wear pinned to the current-version render; repeats and reload retries never duplicate it or its review', async () => {
  const { dir, store, ctx, call, drained } = setup();
  await addRender(dir, store, 'R-old', 1, { review: 'rework' });
  await addRender(dir, store, 'R-hidden', 1, { hiddenAt: at, createdAt: '2026-11-21T00:00:09.000Z' });
  await addRender(dir, store, 'R-1', 1);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'front.jpg');
  const p2 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#2222aa'), 'side.jpg');
  const out = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id, p2.id], key: 'k-1' });
  assert.equal(out.queued, true);
  assert.equal(out.wear.lookVersion, 1);
  assert.equal(out.wear.resultId, 'R-1', 'the visible, accepted render of this version; never a hidden or rejected one');
  assert.deepEqual(out.wear.photoIds, [p1.id, p2.id]);
  const same = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id, p2.id], key: 'k-1' });
  const reload = await call('POST', '/api/looks/L-1/wears', { photoIds: [p2.id, p1.id], key: 'k-after-reload' });
  assert.equal(same.wear.id, out.wear.id);
  assert.equal(reload.wear.id, out.wear.id, 'the same photos for the same version are the same wear');
  const db = store.read();
  assert.equal(db.wears?.length, 1);
  assert.equal(db.jobs.filter((j) => j.kind === 'wearreview').length, 1, 'one review job');
  assert.equal(drained(), 1);
  assert.equal(currentWear(db, db.looks[0])?.id, out.wear.id, 'the real photo becomes the cover');
  await assert.rejects(call('POST', '/api/looks/L-1/wears', { photoIds: ['P-nope'], key: 'k-2' }), /власні фото/);
  await assert.rejects(call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id] }), /ключа/);
});

test('the existing engine reads the photos and the pinned render once; feedback in both languages, separated by cause', async () => {
  const { dir, store, ctx, call } = setup();
  await addRender(dir, store, 'R-1', 1);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'front.jpg');
  const p2 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#2222aa'), 'side.jpg');
  const { wear } = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id, p2.id], key: 'k-1' });
  const { engine, calls } = fakeEngine(() => REVIEW);
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  assert.equal(calls.length, 1, 'one read');
  assert.equal(calls[0].images.length, 3, 'two real photos and the render');
  assert.match(calls[0].images[2], /render\.jpg$/);
  assert.match(calls[0].prompt, /LAST image is a generated try-on render/);
  assert.match(calls[0].prompt, /Red polo/);
  assert.match(calls[0].prompt, /No scores or numbers/);
  const db = store.read();
  const saved = db.wears!.find((w) => w.id === wear.id)!;
  assert.equal(db.jobs.find((j) => j.kind === 'wearreview')!.state, 'done');
  assert.equal(saved.review?.resultId, 'R-1');
  assert.deepEqual(saved.review?.uk.differences.map((d) => d.cause), ['outfit', 'render']);
  assert.equal(saved.review?.en.adjust, 'Try one narrow cuff.');
  assert.equal(JSON.stringify(saved.review).match(/\d+\/10|score/i), null, 'no numeric rating');
  // A finished review is never repeated: neither by the retry route nor by adding the same photos again.
  await assert.rejects(call('POST', `/api/wears/${wear.id}/review`), /Розбір уже є/);
  const again = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id, p2.id], key: 'k-3' });
  assert.equal(again.queued, false);
  assert.equal(store.read().jobs.filter((j) => j.kind === 'wearreview').length, 1);
  // «Одягну знову?» is the person's own answer.
  await call('PATCH', `/api/wears/${wear.id}`, { again: false });
  assert.equal(store.read().wears![0].again, false);
  await call('PATCH', `/api/wears/${wear.id}`, { again: null });
  assert.equal(store.read().wears![0].again, undefined);
});

test('a late render of a previous composition cannot mask a valid render of the current composition', async () => {
  const { dir, store, call } = setup();
  const look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, bottom: [{ kind: 'item', id: 'W-jeans' }] } });
  await addRender(dir, store, 'R-current', 2);
  await addRender(dir, store, 'R-late', 1, { createdAt: '2026-11-22T00:00:00.000Z' });
  const db = store.read();
  assert.equal(wearRender(db, db.looks[0])?.id, 'R-current');
});

test('a changed look version is a new wear without the old render; a failed read is retried once without a second wear', async () => {
  const { dir, store, ctx, call } = setup();
  await addRender(dir, store, 'R-1', 1);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'v1.jpg');
  const first = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id], key: 'k-1' });
  const look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, bottom: [{ kind: 'item', id: 'W-jeans' }] } });
  let db = store.read();
  assert.equal(currentWear(db, db.looks[0]), undefined, 'photos of version 1 never stand for version 2');
  assert.equal(wearRender(db, db.looks[0]), undefined, 'the version 1 render is not offered for version 2');
  const p2 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#22aa22'), 'v2.jpg');
  await assert.rejects(call('POST', '/api/looks/L-1/wears', { photoIds: [p2.id], key: 'k-stale', lookVersion: 1 }), /Склад образу змінився/);
  const second = await call('POST', '/api/looks/L-1/wears', { photoIds: [p2.id], key: 'k-2' });
  assert.equal(second.wear.lookVersion, 2);
  assert.equal(second.wear.resultId, undefined);
  assert.equal(store.read().wears!.find((w) => w.id === first.wear.id)!.resultId, 'R-1', 'the earlier comparison stays pinned');
  // Both reviews fail first (the engine is down), then the retry succeeds.
  let up = false;
  const { engine, calls } = fakeEngine(() => (up ? REVIEW : null));
  const runner = createRunner(store, dir, '/usr/bin/false', { engine });
  await runner.drain();
  db = store.read();
  const failed = db.jobs.filter((j) => j.kind === 'wearreview');
  assert.deepEqual(failed.map((j) => j.state), ['error', 'error']);
  assert.match(failed[0].stateNote ?? '', /OpenAI 500/);
  assert.equal((await call('POST', '/api/looks/L-1/wears', { photoIds: [p2.id], key: 'k-2' })).queued, false, 'a replay after failure waits for explicit retry');
  // Changing the look also queues the background advisor; only the photo reads matter here.
  const reads = calls.filter((c) => c.prompt.includes('read the attached photos once'));
  assert.equal(reads.length, 2);
  const v2call = reads.find((c) => !c.prompt.includes('LAST image'))!;
  assert.equal(v2call.images.length, 1, 'without a render only the real photo is read');
  assert.match(v2call.prompt, /There is no render to compare with/);
  up = true;
  const retry = await call('POST', `/api/wears/${second.wear.id}/review`);
  assert.equal(retry.retryOf, failed.find((j) => j.wearId === second.wear.id)!.id);
  await runner.drain();
  db = store.read();
  const v2 = db.wears!.find((w) => w.id === second.wear.id)!;
  assert.deepEqual(v2.review?.uk.differences.map((d) => d.cause), ['outfit'], 'no render difference without a render');
  assert.equal(v2.review?.resultId, undefined);
  assert.equal(db.wears!.length, 2);
  assert.equal(db.photos.length, 2, 'originals stay, nothing duplicated');
});

test('a hidden or deleted render leaves the wear: no preview, no link, no read; deleting the look keeps the originals', async () => {
  const { dir, store, ctx, call } = setup();
  await addRender(dir, store, 'R-1', 1);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'front.jpg');
  const { wear } = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id], key: 'k-1' });
  await store.mutate((db) => void (db.results[0].hiddenAt = at));
  const view = stateView(store.read()) as unknown as DB;
  assert.equal(view.wears![0].resultId, undefined, 'a hidden render is not named');
  assert.equal(wearRenderOf(view, view.wears![0]), undefined);
  const { engine, calls } = fakeEngine(() => REVIEW);
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  assert.equal(calls[0].images.length, 1, 'a hidden render is not read');
  assert.equal(store.read().wears![0].review?.resultId, undefined);
  await call('DELETE', '/api/results/R-1');
  assert.equal(store.read().wears![0].resultId, undefined, 'a deleted render is unpinned');
  assert.ok(store.read().wears![0].review, 'the review stays');
  await call('DELETE', '/api/looks/L-1');
  const db = store.read();
  assert.equal(db.wears!.length, 0);
  assert.equal(db.jobs.some((j) => j.wearId === wear.id), false);
  assert.equal(db.photos.length, 1, 'the original photo stays in «Мої фото»');
});

test('local Codex reads the same photos with the same schema', async () => {
  const { dir, store, ctx, call } = setup();
  await addRender(dir, store, 'R-1', 1);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'front.jpg');
  await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id], key: 'k-1' });
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(path.join(dir, 'reply.json'), JSON.stringify(REVIEW));
  fs.writeFileSync(fake, `#!/bin/sh\nn=0\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift;; -i) n=$((n+1)); shift;; --output-schema) s="$2"; shift;; esac; shift; done\ncat >/dev/null\necho "$n" > "${dir}/images.txt"\ncp "$s" "${dir}/schema-used.json"\ncp "${dir}/reply.json" "$o"\n`, { mode: 0o755 });
  await createRunner(store, dir, fake).drain();
  const db = store.read();
  const job = db.jobs.find((j) => j.kind === 'wearreview')!;
  assert.equal(job.state, 'done', job.stateNote ?? '');
  assert.equal(fs.readFileSync(path.join(dir, 'images.txt'), 'utf8').trim(), '2');
  assert.match(fs.readFileSync(path.join(dir, 'schema-used.json'), 'utf8'), /substitution/);
  assert.equal(db.wears![0].review?.resultId, 'R-1');
});

test('allowances: a refused review keeps the photos and the wear; the retry is refused until allowed', async () => {
  let allowed = false;
  const admit = () => {
    if (!allowed) throw new HttpError(429, 'Ліміт підборів на цей місяць вичерпано', { quota: 'styling' });
  };
  const { store, ctx, call } = setup(admit);
  const p1 = await upload(ctx, new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'front.jpg');
  const out = await call('POST', '/api/looks/L-1/wears', { photoIds: [p1.id], key: 'k-1' });
  assert.equal(out.queued, false);
  assert.match(out.note, /Ліміт підборів/);
  assert.equal(store.read().wears!.length, 1, 'the photos are saved');
  assert.equal(store.read().jobs.length, 0);
  await assert.rejects(call('POST', `/api/wears/${out.wear.id}/review`), /Ліміт підборів/);
  allowed = true;
  const job = await call('POST', `/api/wears/${out.wear.id}/review`);
  assert.equal(job.kind, 'wearreview');
  const twice = await call('POST', `/api/wears/${out.wear.id}/review`);
  assert.equal(twice.id, job.id, 'a waiting review is returned, not queued again');
});

test('each account reaches only its own wears and photos', async () => {
  const { createTenants, emptyDb } = await import('./tenants.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-wear-tenants-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb });
  const a = tenants.forUser('user-aaaaaa', true);
  const b = tenants.forUser('user-bbbbbb', true);
  a.runner.stop();
  b.runner.stop();
  await a.store.mutate((db) => {
    const f = fixture();
    db.items = f.items;
    db.capsules = f.capsules;
    db.looks = f.looks;
  });
  await b.store.mutate((db) => {
    const f = fixture();
    db.items = f.items;
    db.capsules = f.capsules;
    db.looks = f.looks;
  });
  const quiet = (ctx: Ctx): Ctx => ({ ...ctx, drain: () => undefined });
  const photo = await upload(quiet(a.ctx), new URLSearchParams({ kind: 'worn' }), await png('#aa2222'), 'a.jpg');
  const { wear } = (await dispatch(quiet(a.ctx), 'POST', '/api/looks/L-1/wears', { photoIds: [photo.id], key: 'k-a' })) as { wear: { id: string } };
  assert.ok(photo.path.startsWith('media/uploads/'), 'stored inside the account folder');
  assert.ok(fs.existsSync(path.join(a.root, photo.path)));
  await assert.rejects(dispatch(quiet(b.ctx), 'PATCH', `/api/wears/${wear.id}`, { again: true }), /не знайдено/);
  await assert.rejects(dispatch(quiet(b.ctx), 'POST', `/api/wears/${wear.id}/review`, {}), /не знайдено/);
  await assert.rejects(dispatch(quiet(b.ctx), 'DELETE', `/api/wears/${wear.id}`, {}), /не знайдено/);
  await assert.rejects(dispatch(quiet(b.ctx), 'POST', '/api/looks/L-1/wears', { photoIds: [photo.id], key: 'k-b' }), /власні фото/);
  assert.equal(b.store.read().wears?.length ?? 0, 0);
  assert.equal(b.store.read().photos.length, 0);
  // Deleting a wear removes the wear and its queued review job while preserving the original photo.
  await dispatch(quiet(a.ctx), 'DELETE', `/api/wears/${wear.id}`, {});
  assert.equal(a.store.read().wears?.length ?? 0, 0);
  assert.equal(a.store.read().jobs.some((j) => j.wearId === wear.id), false);
  assert.equal(a.store.read().photos.length, 1, 'uploaded original stays in the archive');
});
