import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { DB, Job, Look } from './schema.ts';
import { SCHEMA_VERSION, emptySlots, validateDb } from './schema.ts';
import { createStore, HttpError } from './store.ts';
import { stateView } from './state-view.ts';
import { createJob, dispatch, packshotJob, queueMissingRenders, snapshotSlots, upload } from './routes.ts';
import { sameIdentity, verifyReferenceFiles } from './identity.ts';
import { MAX_IMAGE_REFS, buildPackshotPrompt, buildPrompt, createRunner, pickRefs } from './runner.ts';
import { ANALYZE_SCHEMA, INTAKE_SCHEMA, VISUAL_DEDUP_SCHEMA, analyzePrompt, applyAnalyze, applyIntake, intakeComparisonCandidates, intakePrompt, type IntakeReply } from './analysis.ts';
import { hiddenLookIds, isCapsuleHidden, sameLook } from '../src/rating.ts';
import { createHash } from 'node:crypto';
import { distinctLooks, itemArt, lookVariants } from '../src/lib.ts';
import { changedCoreSlots, groupLookVariations } from '../src/look-variation.ts';
import { looksNeedingRender } from '../src/render-need.ts';
import { coverForLook, currentCover, currentPeriod, indoorOnly, purchasePlan, todayLooks, openSuggestions, storeKey, capsuleCount, capsuleRating, isComplete, itemPlacements, itemRating, itemVerdict, lookRating, missingInfo, sharedAdvice, purchaseRanking, scoreLabel, usageLabel, wardrobeCapsule } from '../src/lib.ts';
import { applyShopSearch, applyStoreFind, shopSearchPrompt, storeFindPrompt, storesToFind } from './shop-search.ts';
import { MAX_OPEN_REPLACEMENTS, SCORE_SCALE, sameTitle, adviceDue, advisePrompt, applyAdvice, itemsToRate, looksToScore, seenRevs } from './advisor.ts';
import { refusedPieces, tooClose } from '../src/look-memory.ts';
import { applyDiscover, discoverPrompt } from './discover.ts';
import { stylistContext } from './stylist-context.ts';
import { CAPSULE_LIMITS, capsuleCombinations, capsuleSet, combinationGains } from '../src/capsule-pieces.ts';
import { capsuleSetsReport } from './capsule-sets.ts';

const at = '2026-11-17T00:00:00.000Z';
const SAMPLE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FuoAAAAASUVORK5CYII=', 'base64');

function sourceCropFixture(dir: string) {
  const source = 'assets/photos/a.jpeg', crop = 'media/fixture-crop.png';
  for (const file of [source, crop]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), SAMPLE_PNG);
  }
  const sha256 = createHash('sha256').update(SAMPLE_PNG).digest('hex');
  return { path: crop, sha256, source: { path: source, sha256 } };
}

test('hidden personal attempts stay in history but never reach site covers, gallery or result links', () => {
  const db = fixture();
  const result = { id: 'R-hide', jobId: 'J-hide', lookId: 'L-1', lookVersion: 1, imagePath: 'bad.png', tool: 'test', model: 'test', prompt: 'private prompt', sources: [], usedItemPhotos: true, review: 'rework' as const, favorite: false, createdAt: at, hiddenAt: at };
  db.results.push(result, { ...result, id: 'R-show', hiddenAt: undefined });
  db.jobs.push({ id: 'J-hide', lookId: 'L-1', resultId: 'R-hide', lookVersion: 1, snapshot: { lookName: 'Look', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'done', origin: 'import', createdAt: at });
  db.comparisons.push({ id: 'CMP-hide', resultA: 'R-hide', resultB: 'R-show', note: '', favorite: false, createdAt: at });
  const view = stateView(db);
  assert.deepEqual(view.results.map((r) => r.id), ['R-show']);
  assert.equal(view.jobs[0].resultId, undefined);
  assert.equal(view.comparisons.length, 0);
  assert.equal('prompt' in view.results[0], false);
  assert.equal(db.results.length, 2, 'retained local history is not deleted');
  assert.equal(db.jobs[0].resultId, 'R-hide', 'the stored attempt link remains');
  assert.equal(db.comparisons.length, 1);
});

function fixture(): DB {
  const slots = { ...emptySlots(), bottom: [{ kind: 'item' as const, id: 'W-1' }], top: [{ kind: 'need' as const, id: 'N-1' }] };
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    updatedAt: at,
    photos: [
      { id: 'P-1', kind: 'source', path: 'assets/photos/a.jpeg', originalName: 'a.jpeg', source: 'chat-2026-11-14', createdAt: at },
      { id: 'P-2', kind: 'source', path: 'assets/photos/b.jpeg', originalName: 'b.jpeg', source: 'chat-2026-11-14', createdAt: at },
    ],
    items: [
      { id: 'W-1', rev: 1, category: 'trousers', title: 'Navy chinos', status: 'needs_confirmation', photoIds: ['P-1', 'P-2'], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-2', rev: 1, category: 'trousers', title: 'Navy chinos (дубль)', status: 'needs_confirmation', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
    ],
    needs: [{ id: 'N-1', rev: 1, title: 'Молочна футболка', category: 'tees', priority: 'core', description: 'однотонна', why: '', fitCheck: '', status: 'open', origin: 'source', createdAt: at, updatedAt: at }],
    products: [],
    looks: [{ id: 'L-1', rev: 1, capsuleId: 'C-1', name: 'Look', slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'source', createdAt: at, updatedAt: at }],
    capsules: [{ id: 'C-1', rev: 1, name: 'Urban', season: 'all', description: '', situations: [], favorite: false, lookIds: ['L-1'], origin: 'source', createdAt: at, updatedAt: at }],
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

test('chat stylist sees current catalogue roles and owner decisions without personal media or profile records', () => {
  const db = fixture();
  db.items[1].status = 'inactive';
  db.looks[0].favorite = true;
  db.capsules.push({ ...db.capsules[0], id: 'C-old', redirectCapsuleIds: ['C-1'] });
  db.items[0].rating = { score: 5, note: '', kept: true, rev: 1, at };
  db.profile.measurements.height.value = 184;
  db.settings.tailscaleLogin = 'private-login';
  const before = JSON.stringify(db);
  const brief = stylistContext(db);
  assert.deepEqual(brief.capsules.map(c => c.id), ['C-1']);
  assert.deepEqual(brief.items.map(i => [i.id, i.status, i.ownerKeeps]), [['W-1', 'needs_confirmation', true]]);
  assert.equal(brief.looks[0].ownerLiked, true);
  assert.equal(brief.looks[0].slots.top[0].kind, 'need');
  assert.equal(brief.needs[0].status, 'open');
  assert.deepEqual(brief.repeatedlyRefusedItems, []); // Older catalogues have no refusal memory.
  assert.deepEqual(brief.seenCompositions[0], db.looks[0].slots);
  assert.doesNotMatch(JSON.stringify(brief), /private-login|assets\/photos|basePhoto|measurements|knownSizes|P-1/);
  assert.equal(JSON.stringify(db), before);
});

function setup(autoTryOn?: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-test-'));
  const store = createStore(dir, fixture);
  let drained = 0;
  const ctx = { store, projectRoot: dir, drain: () => void drained++, autoTryOn };
  const call = (method: string, p: string, body: Record<string, unknown> = {}) => dispatch(ctx, method, p, body) as Promise<any>;
  return { dir, store, call, drained: () => drained };
}

test('malformed route parameters return a bad request', async () => {
  const { call } = setup();
  await assert.rejects(call('PATCH', '/api/items/%ZZ'), { status: 400, message: 'Некоректний запит' });
});

test('outfit groups count core changes, ignore accessories and avoid similarity chains', () => {
  const a = fixture().looks[0];
  const withRef = (l: typeof a, slot: 'top' | 'shoes' | 'accessories', id: string) => ({ ...l, id: l.id + id, slots: { ...l.slots, [slot]: [{ kind: 'need' as const, id }] } });
  const belt = withRef(a, 'accessories', 'belt');
  const shoe = withRef(a, 'shoes', 'shoe');
  const topAndShoe = withRef(shoe, 'top', 'polo');
  assert.equal(changedCoreSlots(a, belt).length, 0);
  assert.equal(changedCoreSlots(a, shoe).length, 1);
  assert.equal(changedCoreSlots(a, topAndShoe).length, 2);
  const groups = groupLookVariations(fixture(), [a, belt, shoe, topAndShoe]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[1].primary.id, topAndShoe.id);
});

test('sportswear variants group by visual similarity and a curated family in the same capsule', () => {
  const db = fixture();
  const a = db.looks[0];
  const make = (id: string, colors: string[], categories: DB['items'][number]['category'][]) => {
    const slots = { ...a.slots, top: [], bottom: [], shoes: [], layer: [], accessories: [] } as DB['looks'][number]['slots'];
    for (const [index, slot] of (['top', 'bottom', 'shoes', 'layer'] as const).entries()) {
      if (!colors[index]) continue;
      const item = { ...db.items[0], id: `W-${id}-${slot}`, color: colors[index], category: categories[index] };
      db.items.push(item);
      slots[slot].push({ kind: 'item', id: item.id });
    }
    return { ...a, id, slots };
  };
  const base = make('gym', ['black', 'black', 'black'], ['tees', 'shorts', 'shoes']);
  const strength = make('strength', ['black', 'black', 'black'], ['tees', 'shorts', 'shoes']);
  const warmup = { ...make('warmup', ['blue', 'black', 'black', 'navy'], ['tees', 'shorts', 'shoes', 'knitwear']), variantOf: base.id };
  const cycle = make('cycle', ['green', 'black', 'black'], ['shirts', 'shorts', 'shoes']);
  assert.deepEqual(groupLookVariations(db, [base, strength, warmup, cycle]).map((g) => g.variants.map((l) => l.id)), [['strength', 'warmup'], []]);
  const curatedStrength = { ...strength, variantOf: base.id };
  assert.equal(groupLookVariations(db, [curatedStrength, base, warmup]).length, 1);
  assert.equal(groupLookVariations(db, [base, { ...warmup, capsuleId: 'C-other' }]).length, 2);
});

test('saved looks and completed drafts automatically request one try-on of their first composition', async () => {
  const { store, call } = setup();
  const item = (id: string, category: DB['items'][number]['category']) => ({ ...fixture().items[0], id, category });
  await store.mutate((db) => {
    db.items.push(item('W-T', 'tees'), item('W-S', 'shoes'), item('W-J', 'outerwear'));
    db.profile.basePhotoIds = ['P-2'];
  });
  const slots = { ...emptySlots(), top: [{ kind: 'item', id: 'W-T' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] };
  const create = (name: string, slots: unknown) => call('POST', '/api/looks', { capsuleId: 'C-1', name, slots });
  const jobs = (id: string) => store.read().jobs.filter((job) => job.lookId === id);
  const look = await create('Saved', slots);
  assert.equal(jobs(look.id)[0].state, 'queued');
  assert.equal((await create('Duplicate', slots)).id, look.id);
  const sameJob = await call('POST', '/api/jobs', { lookId: look.id, run: true });
  assert.equal(sameJob.id, jobs(look.id)[0].id);
  assert.equal(jobs(look.id).length, 1);

  const draft = await create('Draft', {});
  await call('PATCH', `/api/looks/${draft.id}`, { slots: { top: slots.top } });
  assert.equal(jobs(draft.id).length, 0);
  await assert.rejects(call('PATCH', `/api/looks/${draft.id}`, { slots }), /уже є в цій капсулі/);
  const filled = await call('PATCH', `/api/looks/${draft.id}`, { slots: { ...slots, layer: [{ kind: 'item', id: 'W-J' }] } });
  assert.equal(jobs(draft.id)[0].lookVersion, filled.version);
  await call('PATCH', `/api/looks/${draft.id}`, { name: 'Renamed' });
  assert.equal(jobs(draft.id).length, 1);

  const missing = await create('Missing garment', { ...slots, top: [{ kind: 'need', id: 'N-1' }] });
  assert.equal(jobs(missing.id)[0].state, 'needs_data');
  await store.mutate((db) => { db.profile.basePhotoIds = []; });
  const noReference = await create('Missing base', { ...slots, shoes: [] });
  assert.equal(jobs(noReference.id)[0].state, 'needs_data');
});

test('one-piece variants are unique, auto-linked and can represent their family', async () => {
  const { store, call } = setup();
  const ref = (id: string) => ({ kind: 'item' as const, id });
  const baseSlots = { ...emptySlots(), top: [ref('W-T1')], bottom: [ref('W-1')], shoes: [ref('W-S')] };
  await store.mutate((db) => {
    const item = (id: string, category: DB['items'][number]['category']) =>
      ({ ...db.items[0], id, title: id, category });
    db.items.push(item('W-T1', 'tees'), item('W-T2', 'tees'), item('W-S', 'shoes'), item('W-S2', 'shoes'),
      item('W-T3', 'shirts'), item('W-B3', 'shorts'), item('W-S3', 'shoes'));
    Object.assign(db.looks[0], { slots: baseSlots, versions: [{ version: 1, slots: baseSlots, at }], favorite: true });
    db.profile.basePhotoIds = ['P-1'];
    db.items[1].photoIds = ['P-2'];
    db.capsules[0].pieces = ['W-T1', 'W-T2', 'W-1', 'W-S', 'W-S2', 'W-T3', 'W-B3', 'W-S3'].map(ref);
  });
  const base = store.read().looks[0];
  const capsule = store.read().capsules[0];
  const request = { variant: { lookId: base.id, rev: base.rev, slot: 'bottom', from: ref('W-1'), to: ref('W-2') }, capsuleRev: capsule.rev };
  await assert.rejects(call('POST', '/api/looks', { ...request, capsuleRev: capsule.rev - 1 }), { status: 409 });
  await assert.rejects(call('POST', '/api/looks', { ...request, replaceCapsulePiece: 'item:W-1' }), { status: 409 });
  await assert.rejects(call('POST', '/api/looks', { ...request, variant: { ...request.variant, to: ref('W-S') } }), { status: 400 });
  const manual = await call('POST', '/api/looks', request);
  assert.equal(manual.variantOf, base.id);
  assert.equal(manual.version, 1);
  assert.equal((await call('POST', '/api/looks', request)).id, manual.id);
  const direct = await call('POST', '/api/looks', { capsuleId: 'C-1', name: 'Another tee', slots: { ...baseSlots, top: [ref('W-T2')] } });
  assert.equal(direct.variantOf, base.id);
  const draft = await call('POST', '/api/looks', { capsuleId: 'C-1', name: 'Other shoes' });
  await call('PATCH', `/api/looks/${draft.id}`, { slots: { top: baseSlots.top } });
  assert.equal(store.read().looks.find((look) => look.id === draft.id)?.variantOf, undefined);
  const assembled = await call('PATCH', `/api/looks/${draft.id}`, { slots: { ...baseSlots, shoes: [ref('W-S2')] } });
  assert.equal(assembled.variantOf, base.id);
  const other = await call('POST', '/api/capsules', { name: 'Other capsule' });
  const outside = await call('POST', '/api/looks', { capsuleId: other.id, name: 'Outside', slots: direct.slots });
  assert.equal(outside.variantOf, undefined);

  const before = store.read();
  assert.deepEqual(before.looks[0], base);
  assert.ok(before.jobs.some((job) => job.lookId === manual.id && job.lookVersion === 1 && job.state === 'queued'));
  await assert.rejects(call('POST', `/api/looks/${manual.id}/primary`, { rev: manual.rev - 1 }), { status: 409 });
  const primary = await call('POST', `/api/looks/${manual.id}/primary`, { rev: manual.rev });
  const after = store.read();
  assert.equal(primary.variantOf, undefined);
  assert.equal(primary.version, manual.version);
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.looks.filter((look) => look.variantOf === primary.id).map((look) => look.id), [base.id, direct.id, draft.id]);
  assert.deepEqual(distinctLooks(after, after.looks).map((look) => look.id), [primary.id, outside.id]);
  assert.deepEqual(new Set(lookVariants(after, primary).map((look) => look.id)), new Set([base.id, direct.id, draft.id]));

  const similarToSibling = await call('PATCH', `/api/looks/${direct.id}`, { slots: { ...direct.slots, shoes: [ref('W-S2')] } });
  assert.equal(similarToSibling.variantOf, primary.id, 'a match with a sibling keeps the family link');
  const unrelatedSlots = { ...emptySlots(), top: [ref('W-T3')], bottom: [ref('W-B3')], shoes: [ref('W-S3')] };
  const unrelated = await call('PATCH', `/api/looks/${direct.id}`, { slots: unrelatedSlots });
  assert.equal(unrelated.variantOf, undefined);
  const edited = store.read();
  assert.ok(distinctLooks(edited, edited.looks).some((look) => look.id === direct.id));
});

test('sports tagging preserves item categories and a multisport capsule can store four accessories', async () => {
  const { store, call } = setup();
  const refs: DB["looks"][number]["slots"]["accessories"] = [];
  for (const name of ['Helmet', 'Cycling glasses', 'Swim cap', 'Goggles']) {
    const item = await call('POST', '/api/items', { title: name, category: 'accessories', sport: true });
    assert.equal(item.category, 'accessories');
    assert.equal(item.sport, true);
    refs.push({ kind: 'item', id: item.id });
  }
  await call('PATCH', `/api/items/${refs[0].id}`, { sport: false });
  assert.equal(store.read().items.find((item) => item.id === refs[0].id)?.sport, false);
  const capsule = await call('POST', '/api/capsules', { name: 'Pool and road' });
  const url = `/api/capsules/${capsule.id}`;
  await assert.rejects(call('PATCH', url, { pieces: refs }), /до 3 аксесуарів/);
  assert.equal((await call('PATCH', url, { accessoryLimit: 4 })).accessoryLimit, 4);
  const saved = await call('PATCH', url, { pieces: refs });
  await assert.rejects(call('PATCH', url, { accessoryLimit: null }), { status: 422, message: /до 3 аксесуарів/ });
  const db = store.read();
  assert.deepEqual(db.capsules.find((c) => c.id === capsule.id), saved, 'the rejected shortcut changes neither the set nor its limit');
  assert.equal(capsuleSet(db, saved).counts.accessories, 4);
  assert.equal(validateDb(db), null);
  for (const accessoryLimit of [null, 3]) {
    const cleared = await call('PATCH', url, { accessoryLimit, pieces: refs.slice(0, 3) });
    assert.equal(cleared.accessoryLimit, undefined);
    await call('PATCH', url, { accessoryLimit: 4, pieces: refs });
  }
  assert.equal((await call('POST', '/api/capsules', { name: 'Triathlon', accessoryLimit: 4 })).accessoryLimit, 4);
});

test('fixture is valid and seeds an atomic file with a previous-valid backup', async () => {
  assert.equal(validateDb(fixture()), null);
  const { dir, store, call } = setup();
  store.read();
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));
  await call('PATCH', '/api/items/W-1', { rev: 1, color: 'navy' });
  assert.ok(fs.existsSync(path.join(dir, 'db.prev.json')), 'backup of last valid version');
  assert.equal(store.read().revision, 2);
});

test('corrupt db falls back to the last valid copy without destroying data (A11)', async () => {
  const { dir, store, call } = setup();
  await call('PATCH', '/api/items/W-1', { rev: 1, color: 'navy' });
  await call('PATCH', '/api/items/W-1', { rev: 2, brand: 'X' });
  fs.writeFileSync(path.join(dir, 'db.json'), '{ broken');
  const db = store.read();
  assert.equal(store.recovered(), true);
  assert.equal(db.items[0].color, 'navy');
});

test('stale revision is rejected instead of silently overwriting (A11)', async () => {
  const { call } = setup();
  await call('PATCH', '/api/items/W-1', { rev: 1, title: 'A' });
  await assert.rejects(call('PATCH', '/api/items/W-1', { rev: 1, title: 'B' }), (e: any) => e.status === 409);
});

test('confirm, edit and inactive status persist with history (A02)', async () => {
  const { store, call } = setup();
  await call('PATCH', '/api/items/W-1', { rev: 1, status: 'confirmed', size: 'W32 L32' });
  await call('PATCH', '/api/items/W-1', { rev: 2, status: 'inactive' });
  const item = store.read().items[0];
  assert.equal(item.status, 'inactive');
  assert.equal(item.size, 'W32 L32');
  assert.deepEqual(item.history.map((h) => h.action), ['status:confirmed', 'status:inactive']);
});

test('merge keeps sources and repoints looks; split moves photos (A02)', async () => {
  const { store, call } = setup();
  const merged = await call('POST', '/api/items/merge', { ids: ['W-1', 'W-2'], title: 'Navy chinos' });
  let db = store.read();
  assert.equal(db.items.find((i) => i.id === 'W-1')!.mergedInto, merged.id);
  assert.equal(db.items.find((i) => i.id === 'W-1')!.status, 'inactive');
  const look = db.looks[0];
  assert.deepEqual(look.slots.bottom, [{ kind: 'item', id: merged.id }]);
  assert.equal(look.version, 2, 'composition change creates a new look version');
  const part = await call('POST', `/api/items/${merged.id}/split`, { photoIds: ['P-2'] });
  db = store.read();
  assert.deepEqual(db.items.find((i) => i.id === merged.id)!.photoIds, ['P-1']);
  assert.equal(part.splitFrom, merged.id);
});

test('merged items keep an existing catalogue cover and allow safe changes to source and cover', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.photos.push(
      { ...db.photos[0], id: 'P-cover1', kind: 'packshot', path: 'media/packshots/one.png', source: 'generated' },
      { ...db.photos[1], id: 'P-cover2', kind: 'packshot', path: 'media/packshots/two.png', source: 'generated' },
    );
    db.items[0].packshotId = 'P-cover1';
    db.items[1].packshotId = 'P-cover2';
  });
  const merge = (options: Record<string, unknown> = {}) => call('POST', '/api/items/merge', { ids: ['W-1', 'W-2'], ...options });
  await assert.rejects(merge({ packshotId: 'P-1' }), /Вибери каталожне зображення/);
  await assert.rejects(merge({ primaryPhotoId: 'P-cover1' }), /Вибери основне фото/);
  const result = await merge({ primaryPhotoId: 'P-2' });
  assert.deepEqual(result.photoIds, ['P-2', 'P-1']);
  assert.equal(result.packshotId, 'P-cover1');
  assert.deepEqual(itemArt(store.read(), result.id), { art: 'media/packshots/one.png', photo: undefined });
  assert.ok(!store.read().jobs.some((job) => job.kind === 'packshot' && job.itemId === result.id));
  await assert.rejects(merge(), /вже обʼєднано/);
  await call('PATCH', `/api/items/${result.id}`, { packshotId: 'P-cover2' });
  await call('DELETE', '/api/items/W-2');
  assert.deepEqual(itemArt(store.read(), result.id), { art: 'media/packshots/two.png', photo: undefined });
  assert.equal(validateDb(store.read()), null);
});

test('a merge without catalogue art queues a packshot from the selected primary source', async () => {
  const { store, call } = setup();
  const { runningId, untouchedId } = await store.mutate((db) => {
    const running = packshotJob(db, { itemId: 'W-1' });
    running.state = 'running';
    packshotJob(db, { itemId: 'W-2' });
    return { runningId: running.id, untouchedId: packshotJob(db, { needId: 'N-1' }).id };
  });
  const merge = () => call('POST', '/api/items/merge', { ids: ['W-1', 'W-2'], primaryPhotoId: 'P-2' });
  const before = store.read();
  await assert.rejects(merge(), { status: 409 });
  assert.deepEqual(store.read(), before);
  await store.mutate((db) => { db.jobs.find((job) => job.id === runningId)!.state = 'queued'; });
  const result = await merge();
  const db = store.read();
  assert.deepEqual(itemArt(db, result.id), { art: undefined, photo: undefined });
  assert.equal(db.jobs.some((job) => job.kind === 'packshot' && (job.itemId === 'W-1' || job.itemId === 'W-2')), false);
  assert.equal(db.jobs.find((job) => job.id === untouchedId)?.state, 'queued');
  const job = db.jobs.find((job) => job.kind === 'packshot' && job.itemId === result.id)!;
  assert.equal(job.state, 'queued');
  assert.equal(job.snapshot.slots[0].photoPaths[0], 'assets/photos/b.jpeg');
});

test('manual merge retains the selected card and moves its duplicate’s capsule and look references', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.items[0].packshotId = testPackshot(db, 'P-removed-cover').id;
    Object.assign(db.items[1], { title: 'Joma shorts', brand: 'Joma', status: 'confirmed', packshotId: testPackshot(db, 'P-kept-cover').id });
    db.capsules[0].pieces = [{ kind: 'need', id: 'N-1' }, { kind: 'item', id: 'W-1' }];
    db.capsules[0].base = [{ kind: 'item', id: 'W-1' }];
    const prior = createJob(db, db.looks[0], [], '');
    Object.assign(prior, { state: 'done', resultId: 'R-before-merge' });
    db.results.push({ id: 'R-before-merge', jobId: prior.id, lookId: 'L-1', lookVersion: 1, imagePath: 'renders/before.png', tool: '', model: '', prompt: '', sources: [], usedItemPhotos: true, review: 'accepted', favorite: false, createdAt: at });
  });
  await assert.rejects(call('POST', '/api/items/merge', { ids: ['W-1', 'W-2'], keepId: 'W-other' }), { status: 400 });
  const item = await call('POST', '/api/items/merge', { ids: ['W-1', 'W-2'], keepId: 'W-2', primaryPhotoId: 'P-2' });
  assert.equal(item.id, 'W-2');
  assert.equal(item.title, 'Joma shorts');
  assert.equal(item.brand, 'Joma');
  assert.equal(item.packshotId, 'P-kept-cover');
  assert.deepEqual(item.photoIds, ['P-2', 'P-1']);
  assert.deepEqual(item.mergedFrom, ['W-1']);
  const db = store.read();
  assert.equal(db.items.length, 2);
  assert.equal(db.items[0].mergedInto, 'W-2');
  assert.deepEqual(db.looks[0].slots.bottom, [{ kind: 'item', id: 'W-2' }]);
  assert.equal(currentCover(db, db.looks[0])?.id, 'R-before-merge');
  assert.deepEqual(db.capsules[0].base, [{ kind: 'item', id: 'W-2' }]);
  assert.ok(db.capsules[0].pieces?.some((piece) => piece.id === 'W-2'));
  assert.equal(validateDb(db), null);
});

test('a look requires one capsule and moving it preserves its identity and versions (A04)', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.capsules.push({ ...db.capsules[0], id: 'C-2', name: 'Інша', lookIds: [] });
    db.capsules.push({ ...db.capsules[0], id: 'C-old', name: 'Перенесена', lookIds: [], redirectCapsuleIds: ['C-2'] });
  });
  await assert.rejects(call('POST', '/api/looks', { name: 'Мікс' }), /Вибери капсулу/);
  await assert.rejects(call('POST', '/api/looks', { capsuleId: 'C-old' }), /Капсулу вже перенесено/);
  const look = await call('POST', '/api/looks', { capsuleId: 'C-1', name: 'Мікс', slots: { bottom: [{ kind: 'item', id: 'W-2' }] } });
  assert.equal(look.capsuleId, 'C-1');
  await assert.rejects(call('PATCH', '/api/capsules/C-1', { lookIds: [] }), /Переносити образ/);
  const moved = await call('PATCH', `/api/looks/${look.id}`, { rev: 1, name: 'Мікс 2', capsuleId: 'C-2' });
  assert.equal(moved.version, 1);
  assert.deepEqual(moved.versions, look.versions);
  assert.deepEqual(store.read().capsules.filter((c) => c.lookIds.includes(look.id)).map((c) => c.id), ['C-2']);
  const changed = await call('PATCH', `/api/looks/${look.id}`, { rev: 2, slots: { bottom: [{ kind: 'item', id: 'W-1' }] } });
  assert.equal(changed.version, 2);
  assert.equal(changed.versions.length, 2);
});

test('wardrobe capsule follows readiness and item placement counts each look once', () => {
  const db = fixture();
  const look = db.looks[0];
  assert.deepEqual(wardrobeCapsule(db).lookIds, [], 'a purchase still needed');
  look.slots = { ...emptySlots(), bottom: [{ kind: 'item', id: 'W-1' }], top: [{ kind: 'item', id: 'W-2' }] };
  assert.deepEqual(wardrobeCapsule(db).lookIds, [look.id]);
  const usage = itemPlacements(db, 'W-2');
  assert.deepEqual(usage.capsules.map((c) => c.id), ['C-1', 'my-wardrobe']);
  assert.deepEqual(usage.looks.map((l) => l.id), [look.id]);
  db.items.find((i) => i.id === 'W-2')!.status = 'inactive';
  assert.deepEqual(wardrobeCapsule(db).lookIds, [], 'ready list follows changes to the wardrobe');
  db.items.find((i) => i.id === 'W-2')!.status = 'confirmed';
  db.looks = db.looks.map((l) => ({ ...l, disliked: true }));
  assert.deepEqual(wardrobeCapsule(db).lookIds, [], 'disliked looks stay out of the ready list');
});

test('job without base photo needs data; job snapshot is frozen; retry links (A05, A06)', async () => {
  const { store, call } = setup();
  const missing = await call('POST', '/api/jobs', { lookId: 'L-1' });
  assert.equal(missing.state, 'needs_data');
  const job = await call('POST', '/api/jobs', { lookId: 'L-1', basePhotoIds: ['P-1'], instructions: 'погляд у камеру' });
  assert.equal(job.state, 'queued');
  assert.equal(job.snapshot.slots.length, 2);
  assert.deepEqual(job.snapshot.basePhotoPaths, ['assets/photos/a.jpeg']);
  await call('PATCH', '/api/items/W-1', { rev: 1, title: 'Змінена назва' });
  const frozen = store.read().jobs.find((j) => j.id === job.id)!;
  assert.equal(frozen.snapshot.slots.find((s) => s.id === 'W-1')!.title, 'Navy chinos', 'snapshot does not follow later edits');
  await store.mutate((db) => {
    db.jobs.find((j) => j.id === job.id)!.state = 'error';
  });
  const retry = await call('POST', `/api/jobs/${job.id}/retry`, {});
  assert.equal(retry.retryOf, job.id);
  assert.ok(store.read().jobs.some((j) => j.id === job.id), 'previous attempt kept');
});

test('rework review creates a linked retry with the reason; accept clears it (A06, A07)', async () => {
  const { store, call } = setup();
  const job = await call('POST', '/api/jobs', { lookId: 'L-1', basePhotoIds: ['P-1'] });
  await store.mutate((db) => {
    const j = db.jobs.find((x) => x.id === job.id)!;
    j.state = 'done';
    j.resultId = 'R-1';
    db.results.push({ id: 'R-1', jobId: j.id, lookId: 'L-1', lookVersion: 1, imagePath: 'r.png', tool: 't', model: 'm', prompt: 'p', sources: [], usedItemPhotos: true, review: 'pending', favorite: false, createdAt: at });
  });
  await assert.rejects(call('POST', '/api/results/R-1/review', { decision: 'rework' }), (e: any) => e.status === 400);
  const out = await call('POST', '/api/results/R-1/review', { decision: 'rework', reason: 'proportions', note: 'плечі' });
  assert.equal(out.result.review, 'rework');
  assert.equal(out.retry.retryOf, job.id);
  assert.match(out.retry.instructions, /змінені пропорції тіла — плечі/);
  // «Це я? — Ні»: the face is hidden from the site and the same references are not re-run.
  const face = await call('POST', '/api/results/R-1/review', { decision: 'rework', reason: 'face' });
  assert.equal(face.retry, undefined);
  assert.ok(store.read().results[0].hiddenAt);
  await call('PATCH', '/api/results/R-1', { favorite: true, note: 'краща' });
  assert.equal(store.read().results[0].favorite, true);
});

test('purchase moves the product into the wardrobe and updates looks (A08, A09)', async () => {
  const { store, call } = setup();
  const p1 = await call('POST', '/api/products', { needId: 'N-1', store: 'Tower', brand: 'B', model: 'Tee', price: '19.9', currency: 'EUR' });
  await call('POST', '/api/products', { needId: 'N-1', store: 'Tower', brand: 'C', model: 'Tee 2' });
  let db = store.read();
  assert.equal(db.needs.length, 1, 'alternatives do not duplicate the need');
  assert.equal(db.products.filter((p) => p.status === 'purchased').length, 0);
  await store.mutate((draft) => {
    draft.photos.push({ id: 'P-shop', kind: 'product', path: 'media/products/tee.png', originalName: 'tee.png', source: 'generated', createdAt: at });
    draft.products.find((product) => product.id === p1.id)!.photoId = 'P-shop';
  });
  const item = await call('POST', `/api/products/${p1.id}/purchase`, { size: 'M' });
  db = store.read();
  assert.equal(item.status, 'confirmed');
  assert.equal(item.size, 'M');
  assert.equal(db.needs[0].status, 'covered');
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'item', id: item.id }]);
  const packshot = db.jobs.find((job) => job.kind === 'packshot' && job.itemId === item.id);
  assert.equal(packshot?.state, 'queued');
  assert.deepEqual(packshot?.snapshot.slots[0].photoPaths, ['media/products/tee.png']);
  assert.equal(db.products.find((p) => p.id !== p1.id)!.status, 'option', 'other alternative stays an option');
  const other = db.products.find((p) => p.id !== p1.id)!;
  await assert.rejects(call('POST', `/api/products/${other.id}/purchase`, {}), /уже закрито/, 'a closed purchase cannot be bought twice');
  // «Скасувати покупку»: the variant returns, the item leaves, the look gets the purchase back.
  await call('POST', `/api/products/${p1.id}/unpurchase`, {});
  db = store.read();
  assert.equal(db.products.find((p) => p.id === p1.id)!.status, 'option');
  assert.equal(db.items.some((i) => i.id === item.id), false);
  assert.ok(!db.jobs.some((job) => job.itemId === item.id));
  assert.equal(db.needs[0].status, 'open');
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'need', id: 'N-1' }]);
  assert.equal(validateDb(db), null);
});

test('prompt carries the frozen outfit and the image standard', () => {
  const db = fixture();
  const job = { id: 'J', lookId: 'L-1', lookVersion: 1, snapshot: { lookName: 'Look', slots: snapshotSlots(db, db.looks[0].slots), basePhotoIds: ['P-1'], basePhotoPaths: ['assets/photos/a.jpeg'] }, instructions: '', state: 'queued' as const, origin: 'site' as const, createdAt: at };
  const prompt = buildPrompt(job, '/tmp/x/result.png');
  assert.match(prompt, /\/tmp\/x\/result\.png/);
  assert.match(prompt, /#FFFFFF/);
  assert.match(prompt, /preserve the original head angle/);
  assert.match(prompt, /Navy chinos/);
});

test('runner processes packshot and try-on jobs in parallel without chat (A13)', async () => {
  const { dir, store, call } = setup();
  const crop = sourceCropFixture(dir);
  await store.mutate((db) => {
    db.items[0].tryonReference = crop;
    const look = db.looks[0];
    look.slots.top = [];
    look.versions[0].slots = look.slots;
  });
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(path.join(dir, 'fixture.png'), SAMPLE_PNG);
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -C) d="$2"; shift;; -o) o="$2"; shift;; esac; shift; done\ncat >/dev/null\nsleep 0.3\ncp "$d/../../fixture.png" "$d/result.png"\necho \'{"status":"done","notes":"fake"}\' > "$o"\n',
    { mode: 0o755 },
  );
  const runner = createRunner(store, dir, fake);
  const pk = await call('POST', '/api/packshots', { itemIds: ['W-1'] });
  assert.equal(pk.created, 1);
  const again = await call('POST', '/api/packshots', { itemIds: ['W-1'] });
  assert.equal(again.created, 0, 'no duplicate while one is queued');
  await call('POST', '/api/jobs', { lookId: 'L-1', basePhotoIds: ['P-1'] });
  await runner.drain();
  const db = store.read();
  const item = db.items.find((i) => i.id === 'W-1')!;
  const packshot = db.photos.find((p) => p.id === item.packshotId)!;
  assert.equal(packshot.kind, 'packshot');
  assert.deepEqual(item.photoIds, ['P-1', 'P-2'], 'originals untouched');
  assert.equal(db.results.length, 1);
  assert.equal(db.results[0].usedItemPhotos, true);
  assert.deepEqual(db.results[0].sources, ['assets/photos/a.jpeg', crop.path]);
  assert.ok(db.jobs.every((j) => j.state === 'done'));
  const prompt = fs.readFileSync(path.join(dir, 'jobs', pk.jobIds[0], 'prompt.txt'), 'utf8');
  assert.match(prompt, /packshot/);
  assert.match(prompt, /Navy chinos/);
});

test('failed Codex run becomes an explained error and retry links (A13, A06)', async () => {
  const { store, call } = setup();
  const runner = createRunner(store, store.dataDir, '/usr/bin/false');
  const pk = await call('POST', '/api/packshots', { itemIds: ['W-2'] });
  await runner.drain();
  const job = store.read().jobs.find((j) => j.id === pk.jobIds[0])!;
  assert.equal(job.state, 'error');
  assert.match(job.stateNote ?? '', /код/);
  const retry = await call('POST', `/api/jobs/${job.id}/retry`, {});
  assert.equal(retry.kind, 'packshot');
  assert.equal(retry.retryOf, job.id);
});

test('intake recognises garments into candidates and queues their packshots', async () => {
  const { dir, store } = setup();
  const fake = path.join(dir, 'fake-codex.sh');
  const style = path.join(dir, 'media', 'packshot-style', 'upper.png');
  fs.mkdirSync(path.dirname(style), { recursive: true });
  fs.writeFileSync(style, SAMPLE_PNG);
  fs.writeFileSync(path.join(dir, 'fixture.png'), SAMPLE_PNG);
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nschema=""\nwhile [ $# -gt 0 ]; do case "$1" in -C) d="$2"; shift;; -o) o="$2"; shift;; --output-schema) schema="$2"; shift;; esac; shift; done\ncat >/dev/null\nif [ -n "$schema" ]; then echo \'{"status":"done","reason":"","garments":[{"title":"Біла оксфорд-сорочка","category":"shirts","color":"білий","notes":"комір на ґудзиках","duplicateOf":""},{"title":"Темно-сині чіноси","category":"trousers","color":"темно-синій","notes":"","duplicateOf":"W-1"}]}\' > "$o"; else cp "$d/../../fixture.png" "$d/result.png"; echo \'{"status":"done"}\' > "$o"; fi\n',
    { mode: 0o755 },
  );
  await store.mutate((db) => {
    db.jobs.push({ id: 'J-in', kind: 'intake', inputPhotoIds: ['P-1'], lookVersion: 0, snapshot: { lookName: 'a.jpeg', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued', origin: 'site', createdAt: at });
  });
  await createRunner(store, dir, fake).drain();
  const db = store.read();
  const job = db.jobs.find((j) => j.id === 'J-in')!;
  assert.equal(job.state, 'done');
  assert.equal(job.createdItemIds?.length, 1, 'the duplicate of an unconfirmed candidate becomes extra evidence, not a new item');
  const shirt = db.items.find((i) => i.title === 'Біла оксфорд-сорочка')!;
  assert.equal(shirt.status, 'needs_confirmation');
  assert.deepEqual(shirt.photoIds, ['P-1']);
  assert.ok(!db.items.some((i) => i.title === 'Темно-сині чіноси'));
  assert.ok(db.items.find((i) => i.id === 'W-1')!.status !== 'confirmed', 'no automatic confirmation');
  assert.match(job.stateNote ?? '', /нових речей: 1/);
  assert.ok(job.createdItemIds!.every((id) => db.items.find((i) => i.id === id)!.packshotId), 'packshots generated for new items');
  const shirtJob = db.jobs.find((j) => j.itemId === shirt.id)!;
  const shirtPrompt = fs.readFileSync(path.join(dir, 'jobs', shirtJob.id, 'prompt.txt'), 'utf8');
  assert.ok(shirtPrompt.includes(JSON.stringify([path.join(dir, 'assets/photos/a.jpeg'), style])));
  assert.match(shirtPrompt, /LAST image is a studio style reference only/);
  assert.match(shirtPrompt, /rounded shoulders/);
  const chinosJob = db.jobs.find((j) => j.itemId === 'W-1')!;
  assert.equal(chinosJob.state, 'done', 'a matching upload fills a missing cover');
  assert.match(fs.readFileSync(path.join(dir, 'jobs', chinosJob.id, 'prompt.txt'), 'utf8'), /shaped waistband/);
});

test('item photo uploads fill a missing cover once and rejected outputs preserve the current cover', async () => {
  const { dir, store, call } = setup();
  const ctx = { store, projectRoot: dir, drain: () => {} };
  const params = new URLSearchParams({ kind: 'item', item: 'W-2' });
  await upload(ctx, params, SAMPLE_PNG, 'first.png');
  await upload(ctx, params, SAMPLE_PNG, 'second.png');
  assert.equal(store.read().jobs.filter((j) => j.itemId === 'W-2').length, 1);
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(path.join(dir, 'fixture.png'), SAMPLE_PNG);
  const script = (reply: string, save: string) => `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -C) d="$2"; shift;; -o) o="$2"; shift;; esac; shift; done\ncat >/dev/null\n${save}\nprintf '%s' '${reply}' > "$o"\n`;
  const copyPng = 'cp "$d/../../fixture.png" "$d/result.png"';
  fs.writeFileSync(fake, script('{"status":"done"}', copyPng), { mode: 0o755 });
  const runner = createRunner(store, dir, fake);
  await runner.drain();
  const packshotId = store.read().items.find((i) => i.id === 'W-2')!.packshotId;
  assert.ok(packshotId);
  await upload(ctx, params, SAMPLE_PNG, 'third.png');
  assert.equal(store.read().jobs.filter((j) => j.itemId === 'W-2').length, 1, 'evidence does not replace an existing cover');

  for (const [reply, save] of [['{"status":"error","reason":"Still flat"}', copyPng], ['{"status":"done"}', 'printf "not an image" > "$d/result.png"']]) {
    fs.writeFileSync(fake, script(reply, save));
    const retry = await call('POST', '/api/packshots', { itemIds: ['W-2'] });
    await runner.drain();
    const db = store.read();
    assert.equal(db.jobs.find((j) => j.id === retry.jobIds[0])!.state, 'error');
    assert.equal(db.items.find((i) => i.id === 'W-2')!.packshotId, packshotId);
  }
});

test('analyzer keeps only owned items and complete looks (selection)', async () => {
  const { store } = setup();
  await store.mutate((db) => {
    db.items.push({ id: 'W-S', rev: 1, category: 'shoes', title: 'Stan Smith', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.items.push({ id: 'W-X', rev: 1, category: 'shoes', title: 'Old shoes', status: 'inactive', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.items.push({ id: 'W-J', rev: 1, category: 'outerwear', title: 'Jacket', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    const job = { id: 'J-an', kind: 'analyze' as const, lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: 'на вихідні', state: 'running' as const, origin: 'site' as const, createdAt: at };
    db.jobs.push(job);
    const id = applyAnalyze(db, job, {
      status: 'done', reason: '', name: 'Вихідні', description: 'Легко',
      looks: [
        { name: 'A', occasion: 'прогулянка', season: 'warm', top: ['N-1'], layer: ['W-J'], bottom: ['W-1'], shoes: ['W-S'], accessories: [], why: 'спокійно' },
        { name: 'Bad shoes', occasion: '', season: 'warm', top: [], layer: [], bottom: ['W-1'], shoes: ['W-X'], accessories: [], why: '' },
        { name: 'Ghost', occasion: '', season: 'warm', top: [], layer: [], bottom: ['W-404'], shoes: ['W-S'], accessories: [], why: '' },
      ],
    });
    assert.ok(id);
    const cap = db.capsules.find((c) => c.id === id)!;
    assert.equal(cap.kind, 'selection');
    assert.equal(cap.lookIds.length, 1);
    const look = db.looks.find((l) => l.id === cap.lookIds[0])!;
    assert.deepEqual(look.slots.top, [], 'needs (not owned) are dropped');
    assert.deepEqual(look.slots.shoes, [{ kind: 'item', id: 'W-S' }]);
  });
});

test('one upload control: owner photo becomes a base photo, label fills only empty fields', async () => {
  const { store } = setup();
  await store.mutate((db) => {
    db.photos.push({ id: 'P-up', kind: 'item', path: 'assets/photos/up.jpeg', originalName: 'up.jpeg', source: 'upload', createdAt: at });
    db.photos.push({ ...db.photos.at(-1)!, id: 'P-outfit', path: 'assets/photos/outfit.jpeg' });
    db.photos.push({ ...db.photos.at(-1)!, id: 'P-face', path: 'assets/photos/face.jpeg' });
    db.photos.push({ id: 'P-tag', kind: 'item', path: 'assets/photos/tag.jpeg', originalName: 'tag.jpeg', source: 'upload', createdAt: at });
    Object.assign(db.items.find((i) => i.id === 'W-2')!, { status: 'confirmed', brand: 'Known', composition: 'Owner composition' });
    db.items.push({ id: 'W-C', rev: 1, category: 'shoes', title: 'Stan Smith', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    const base = { id: 'J-b', kind: 'intake' as const, inputPhotoIds: ['P-up'], lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
    const reply: IntakeReply = {
      status: 'done', reason: '', photoType: 'person_full_body', singlePerson: true, baseSuitable: false, baseIssues: 'окуляри',
      label: { itemId: '', brand: '', size: '', composition: '' },
      garments: [{ title: 'Білі кеди', category: 'shoes', color: 'білий', notes: '', duplicateOf: 'W-C', sport: true }],
    };
    const personal = { ...base, intakeIntent: 'person' as const };
    assert.match(intakePrompt(db, personal, ['up.jpeg']), /Always return garments: \[\]/);
    assert.doesNotMatch(intakePrompt(db, personal, ['up.jpeg']), /Existing wardrobe/);
    const o1 = applyIntake(db, personal, reply);
    assert.equal(o1.base, 'added_nonstandard');
    assert.deepEqual(db.profile.basePhotoIds, ['P-up']);
    const up = db.photos.find((p) => p.id === 'P-up')!;
    assert.equal(up.kind, 'base');
    assert.equal(up.meetsStandard, false);
    assert.deepEqual(up.baseCandidate, { suitable: false, issues: 'окуляри' });
    assert.deepEqual(o1.created, []);

    const outfit = { ...base, inputPhotoIds: ['P-outfit'], intakeIntent: 'garments' as const };
    const oGarment = applyIntake(db, outfit, reply);
    assert.equal(oGarment.base, null);
    assert.deepEqual(db.profile.basePhotoIds, ['P-up']);
    assert.equal(db.photos.find((p) => p.id === 'P-outfit')!.kind, 'item');
    const candidate = db.items.find((i) => i.id === oGarment.created[0])!;
    assert.equal(candidate.possibleDuplicateOf, 'W-C');
    assert.equal(candidate.sport, true);
    assert.deepEqual(db.items.find((i) => i.id === 'W-C')!.photoIds, []);
    applyIntake(db, outfit, { ...reply, garments: [{ ...reply.garments[0], duplicateOf: candidate.id }] });
    assert.deepEqual(candidate.photoIds, ['P-outfit']);

    const autoFace = applyIntake(db, { ...base, inputPhotoIds: ['P-face'] }, { ...reply, photoType: 'person_face', baseSuitable: true, baseIssues: '' });
    assert.equal(autoFace.base, 'added');
    assert.deepEqual(autoFace.created, []);
    assert.equal(db.photos.find((p) => p.id === 'P-face')!.referenceRole, 'face');
    assert.deepEqual(db.profile.basePhotoIds, ['P-up', 'P-face']);
    const tag = { ...base, id: 'J-t', inputPhotoIds: ['P-tag'] };
    const o2 = applyIntake(db, tag, {
      status: 'done', reason: '', photoType: 'label', singlePerson: false, baseSuitable: false, baseIssues: '',
      label: { itemId: 'W-2', brand: 'Other', size: 'W32 L32', composition: '98% cotton' }, garments: [],
    });
    assert.equal(o2.labelFor, 'W-2');
    const w2 = db.items.find((i) => i.id === 'W-2')!;
    assert.equal(w2.brand, 'Known', 'existing values are not overwritten');
    assert.equal(w2.size, 'W32 L32');
    assert.equal(w2.composition, 'Owner composition');
    assert.ok(w2.photoIds.includes('P-tag'));
    assert.equal(db.photos.find((p) => p.id === 'P-tag')!.kind, 'label');
  });
});

function pinFixtureIdentity(db: DB) {
  const file = (path: string) => ({ path, sha256: 'a'.repeat(64) });
  db.profile.identity = {
    sourcePhotoId: 'P-1', original: file(db.photos[0].path), bodyOriginal: file(db.photos[1].path),
    face: file('media/face.png'), body: file('media/body.png'), preserveHeadAngle: true, confirmedAt: at,
  };
}

test('auto intake selects suitable body photos only when identity is unpinned, and updates a pending candidate sport flag', () => {
  const db = fixture();
  const photo = { ...db.photos[0], id: 'P-upload', source: 'upload' as const, kind: 'item' as const };
  db.photos.push(photo);
  const job: Job = {
    id: 'J-intake', kind: 'intake', inputPhotoIds: [photo.id], lookVersion: 0,
    snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running', origin: 'site', createdAt: at,
  };
  const reply: IntakeReply = {
    status: 'done', reason: '', photoType: 'person_full_body', singlePerson: true, baseSuitable: true,
    garments: [{ title: 'Training pants', sport: true, category: 'trousers', color: 'navy', notes: '', duplicateOf: 'W-1' }],
  };
  pinFixtureIdentity(db);
  const outcome = applyIntake(db, job, reply);
  assert.deepEqual(outcome.attachedTo, ['W-1']);
  assert.equal(db.items[0].sport, true);
  assert.deepEqual(db.items[0].photoIds, ['P-1', 'P-2', photo.id]);
  assert.deepEqual(photo.baseCandidate, { suitable: true });
  assert.deepEqual(db.profile.basePhotoIds, []);
  assert.equal(photo.kind, 'item');
  delete db.profile.identity;
  assert.equal(applyIntake(db, job, reply).base, 'added');
  assert.deepEqual(db.profile.basePhotoIds, [photo.id]);
  assert.equal(photo.kind, 'base');
});

test('photo and intake schema validate archive dates, duplicate links and intents', () => {
  const db = fixture();
  db.jobs.push({ id: 'J-intake', kind: 'intake', inputPhotoIds: ['P-1'], intakeIntent: 'auto', lookVersion: 0,
    snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued', origin: 'site', createdAt: at });
  db.items[0].possibleDuplicateOf = 'W-2';
  db.photos[0].archivedAt = at;
  assert.equal(validateDb(db), null);
  for (const invalid of ['W-1', 'missing', 123]) {
    db.items[0].possibleDuplicateOf = invalid as string;
    assert.match(validateDb(db)!, /дублікат/);
  }
  delete db.items[0].possibleDuplicateOf;
  db.photos[0].archivedAt = 1 as unknown as string;
  assert.match(validateDb(db)!, /архівування/);
  delete db.photos[0].archivedAt;
  db.jobs[0].intakeIntent = 'unknown' as Job['intakeIntent'];
  assert.match(validateDb(db)!, /намір/);
});

test('identical uploads reuse one non-generated original and one intake job across roles', async () => {
  const { dir, store, call, drained } = setup();
  const product = await call('POST', '/api/products', { needId: 'N-1', store: 'Shop', model: 'Tee' });
  let admissions = 0;
  const ctx = { store, projectRoot: dir, drain: () => {}, admit: () => void admissions++ };
  const sha256 = createHash('sha256').update(SAMPLE_PNG).digest('hex');
  await store.mutate((db) => db.photos.push({ ...db.photos[0], id: 'P-generated', kind: 'packshot', source: 'generated', sha256 }));
  const send = (query: Record<string, string>) => upload(ctx, new URLSearchParams(query), SAMPLE_PNG, 'original.png');
  const [first, second] = await Promise.all([
    send({ kind: 'intake', intent: 'person' }), send({ kind: 'intake', intent: 'garments' }),
  ]);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, 'P-generated');
  assert.equal(first.sha256, sha256);
  assert.equal(admissions, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'media/uploads')), [`${first.id}.png`]);
  await call('PATCH', `/api/photos/${first.id}`, { archived: true });
  const attached = await send({ kind: 'item', item: 'W-2', product: product.id });
  assert.equal(attached.id, first.id);
  assert.equal(attached.archivedAt, undefined);
  assert.equal(store.read().products[0].photoId, first.id);
  assert.deepEqual(store.read().items[1].photoIds, [first.id]);
  assert.ok(store.read().jobs.some((j) => j.kind === 'packshot' && j.itemId === 'W-2'));
  await send({ kind: 'base', role: 'face' });
  await send({ kind: 'base', role: 'face', item: 'W-2' });
  let db = store.read();
  assert.deepEqual(db.items[1].photoIds, [first.id]);
  assert.deepEqual(db.profile.basePhotoIds, [first.id]);
  assert.equal(db.photos.find((p) => p.id === first.id)!.referenceRole, 'face');
  assert.equal(db.jobs.find((j) => j.kind === 'intake')!.intakeIntent, 'person');
  await store.mutate((draft) => { draft.jobs.find((j) => j.kind === 'intake')!.state = 'done'; });
  await send({ kind: 'intake' });
  assert.equal(admissions, 1, 'a completed intake also suppresses an automatic repeat');
  await send({ kind: 'intake', intent: 'garments', reanalyze: '1' });
  db = store.read();
  assert.deepEqual(db.jobs.filter((j) => j.kind === 'intake').map((j) => j.intakeIntent), ['person', 'garments']);
  assert.equal(admissions, 2);
  const worn = await send({ kind: 'worn' });
  assert.notEqual(worn.id, first.id);
  assert.equal(worn.sha256, sha256);
  assert.equal((await send({ kind: 'worn', item: 'W-2' })).id, worn.id);
  assert.equal(fs.readdirSync(path.join(dir, 'media/uploads')).length, 2);
  assert.equal(drained(), 0);
});

function testPackshot(db: DB, id: string) {
  const photo = { id, kind: 'packshot' as const, path: `media/${id}.png`, originalName: `${id}.png`, source: 'generated' as const, createdAt: at };
  db.photos.push(photo);
  return photo;
}

test('visual intake compares a matching branded tee before plain tees in the exact shade', () => {
  const db = fixture();
  const source = { ...db.items[0], category: 'tees' as const, status: 'confirmed' as const };
  db.items.push(
    ...Array.from({ length: 6 }, (_, index) => ({ ...source, id: `W-plain-${index}`, title: 'Футболка без принту', color: 'темно-синій' })),
    { ...source, id: 'W-sport', title: 'Синя спортивна футболка', color: 'синій', brand: 'adidas' },
  );
  const garment = { title: 'Темно-синя спортивна футболка adidas', color: 'темно-синій', category: 'tees', notes: 'білий логотип', duplicateOf: '' };
  assert.equal(intakeComparisonCandidates(db, [garment])[0]?.id, 'W-sport');
});

test('visual intake checks matching wardrobe images, defers packshots and supports lossless absorb', async () => {
  const { dir, store, call } = setup();
  const crop = sourceCropFixture(dir);
  const validPng = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#22334a' } }).png().toBuffer();
  const product = await call('POST', '/api/products', { needId: 'N-1', store: 'Shop', model: 'Chinos' });
  await store.mutate((db) => {
    const target = db.items[0];
    Object.assign(target, { status: 'confirmed', brand: 'Owner brand', color: 'Navy', packshotId: testPackshot(db, 'P-cover').id, tryonReference: crop });
    // The packshot wins over the photo on the same item.
    fs.writeFileSync(path.join(dir, 'media/P-cover.png'), validPng);
    db.items[1].status = 'inactive';
  });
  const before = store.read().items[0];
  const uploaded = await upload({ store, projectRoot: dir, drain: () => {} }, new URLSearchParams({ kind: 'intake', intent: 'garments', batch: '1' }), validPng, 'new-angle.png');
  const observed: string[] = [];
  const garment = { title: 'Pleated chinos', category: 'trousers', color: 'navy', notes: 'Distinct pocket seam', duplicateOf: '', sport: true };
  let checks = 0;
  const engine = {
    label: 'test', imageLabel: 'test',
    json: async ({ schema, prompt, images }: { schema: object; prompt: string; images: string[] }) => {
      if (schema === INTAKE_SCHEMA) {
        observed.push('primary');
        return { reply: { status: 'done', photoType: 'garments_only', garments: [{ ...garment, title: checks ? 'Second garment' : garment.title }] } };
      }
      assert.equal(schema, VISUAL_DEDUP_SCHEMA);
      observed.push('visual');
      assert.equal(images[0], path.join(dir, uploaded.path));
      assert.ok((await sharp(images[1]).metadata()).width);
      assert.match(prompt, /1 \| W-1 \| trousers/);
      assert.doesNotMatch(prompt, /W-2/);
      if (checks++ > 0) return { reply: { status: 'done', matches: null } };
      return { reply: { matches: [
        { garmentIndex: 0, itemId: 'W-2', confidence: 'high', reason: 'Unavailable candidate' },
        { garmentIndex: 2, itemId: 'W-1', confidence: 'high', reason: 'Invalid index' },
        { garmentIndex: 0, itemId: 'W-1', confidence: 'possible', reason: 'Same seam' },
      ] } };
    },
    image: async () => { throw new Error('No image generation expected'); },
  };
  const runner = createRunner(store, dir, '/usr/bin/false', { engine: engine as never, canStart: (j) => j.kind === 'intake' });
  await runner.drain();
  assert.deepEqual(observed, ['primary', 'visual']);
  let db = store.read();
  const candidate = db.items.find((i) => i.title === garment.title)!;
  assert.equal(candidate.possibleDuplicateOf, 'W-1');
  assert.deepEqual(db.items[0], before);
  assert.ok(!db.jobs.some((j) => j.kind === 'packshot' && j.itemId === candidate.id));

  const repeat = await call('POST', `/api/photos/${uploaded.id}/reanalyze`, { intent: 'garments' });
  await runner.drain();
  db = store.read();
  const noVisualMatch = db.items.find((i) => i.id === db.jobs.find((j) => j.id === repeat.id)!.createdItemIds![0])!;
  assert.equal(noVisualMatch.possibleDuplicateOf, undefined);
  assert.ok(db.jobs.some((j) => j.kind === 'packshot' && j.itemId === noVisualMatch.id));

  await call('POST', '/api/packshots', { itemIds: [candidate.id] });
  const worn = await upload({ store, projectRoot: dir, drain: () => {} }, new URLSearchParams({ kind: 'worn' }), validPng, 'worn.png');
  await store.mutate((draft) => {
    const source = draft.items.find((i) => i.id === candidate.id)!;
    Object.assign(source, { brand: 'Candidate brand', model: 'Model', size: 'M', fit: 'Straight', composition: 'Cotton', confirmedFact: 'Receipt', packshotId: testPackshot(draft, 'P-source-cover').id });
    source.photoIds.push(worn.id);
    draft.items[0].possibleDuplicateOf = source.id;
    const other = draft.items.find((i) => i.id === noVisualMatch.id)!;
    other.possibleDuplicateOf = source.id;
    const ref = { kind: 'item' as const, id: source.id };
    const look = draft.looks[0];
    look.slots.bottom = [ref];
    draft.capsules[0].pieces = [...look.slots.top, ref];
    draft.capsules[0].base = [ref];
    Object.assign(draft.needs[0], { coveredByItem: source.id, status: 'covered' });
    Object.assign(draft.products.find((p) => p.id === product.id)!, { purchasedItemId: source.id, status: 'purchased' });
    const job = draft.jobs.find((j) => j.itemId === source.id)!;
    draft.jobs.push({ ...job, id: 'J-finished-cover', state: 'done', photoId: source.packshotId });
    job.state = 'running';
  });
  const absorb = (sourceId: string) => call('POST', '/api/items/W-1/absorb', { sourceId });
  await assert.rejects(absorb('W-1'), { status: 400 });
  await assert.rejects(absorb(candidate.id), { status: 409 });
  await store.mutate((draft) => { draft.jobs.find((j) => j.itemId === candidate.id && j.state === 'running')!.state = 'queued'; });
  const target = await absorb(candidate.id);
  assert.equal(target.id, 'W-1');
  assert.equal(target.status, 'confirmed');
  assert.deepEqual(target.photoIds, ['P-1', 'P-2', uploaded.id]);
  assert.equal(target.brand, 'Owner brand');
  assert.equal(target.color, 'Navy');
  assert.equal(target.model, 'Model');
  assert.equal(target.size, 'M');
  assert.equal(target.fit, 'Straight');
  assert.equal(target.composition, 'Cotton');
  assert.equal(target.confirmedFact, 'Receipt');
  assert.equal(target.sport, true);
  assert.equal(target.packshotId, 'P-cover');
  assert.deepEqual(target.tryonReference, crop);
  assert.equal(target.possibleDuplicateOf, undefined);
  assert.equal(target.history.at(-1).action, 'merged');
  db = store.read();
  const source = db.items.find((i) => i.id === candidate.id)!;
  assert.equal(source.status, 'inactive');
  assert.equal(source.mergedInto, target.id);
  assert.equal(source.possibleDuplicateOf, undefined);
  assert.equal(source.history.at(-1)?.action, 'merged_into');
  assert.equal(db.items.find((i) => i.id === noVisualMatch.id)!.possibleDuplicateOf, target.id);
  assert.deepEqual(db.looks[0].slots.bottom, [{ kind: 'item', id: target.id }]);
  assert.deepEqual(db.capsules[0].base, [{ kind: 'item', id: target.id }]);
  assert.equal(db.needs[0].coveredByItem, target.id);
  assert.equal(db.products[0].purchasedItemId, target.id);
  assert.ok(!db.jobs.some((j) => j.itemId === source.id && j.state === 'queued'));
  assert.ok(!db.photos.some((p) => p.id === 'P-source-cover'));
  assert.equal(db.jobs.find((j) => j.id === 'J-finished-cover')!.photoId, undefined);
  await assert.rejects(absorb(candidate.id), { status: 409 });
  assert.equal(validateDb(db), null);
  await call('POST', `/api/products/${product.id}/unpurchase`);
  db = store.read();
  assert.equal(db.needs[0].status, 'open');
  assert.equal(db.items[0].status, 'confirmed');
  assert.deepEqual(db.items[0].photoIds, target.photoIds);
});

test('clearing a probable duplicate queues a missing cover and deleting its match clears the link', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.items[1].photoIds = ['P-1'];
    db.items[1].possibleDuplicateOf = 'W-1';
  });
  const confirmed = await call('PATCH', '/api/items/W-2', { status: 'confirmed', clearDuplicate: true });
  assert.equal(confirmed.possibleDuplicateOf, undefined);
  assert.equal(store.read().jobs.filter((j) => j.kind === 'packshot' && j.itemId === 'W-2').length, 1);
  await store.mutate((db) => { db.items[1].possibleDuplicateOf = 'W-1'; });
  await call('DELETE', '/api/items/W-1');
  assert.equal(store.read().items[0].possibleDuplicateOf, undefined);
});

test('merge preserves owner metadata, selected covers, garment crops and purchased product links', async () => {
  for (const explicit of [false, true]) {
    const { dir, store, call } = setup();
    const crop = sourceCropFixture(dir);
    const product = await call('POST', '/api/products', { needId: 'N-1', store: 'Shop', model: 'Chinos' });
    await store.mutate((db) => {
      const [confirmed, pending] = db.items;
      Object.assign(confirmed, { status: 'confirmed', brand: 'Owner', model: 'Classic', color: 'Navy', size: '32', tryonReference: crop, packshotId: testPackshot(db, 'P-primary-cover').id });
      Object.assign(pending, { brand: 'Candidate', fit: 'Straight', composition: 'Cotton', purchasedFromProduct: product.id, possibleDuplicateOf: confirmed.id, packshotId: testPackshot(db, 'P-alt-cover').id });
      db.items.push({ ...pending, id: 'W-external', possibleDuplicateOf: pending.id });
      Object.assign(db.products[0], { purchasedItemId: pending.id, status: 'purchased' });
    });
    const data = explicit ? { targetId: 'W-2', coverPhotoId: 'P-alt-cover' } : {};
    const item = await call('POST', '/api/items/merge', { ids: ['W-2', 'W-1'], primaryPhotoId: 'P-2', ...data });
    assert.ok(!['W-1', 'W-2'].includes(item.id));
    assert.equal(item.status, 'confirmed');
    assert.equal(item.brand, explicit ? 'Candidate' : 'Owner');
    assert.equal(item.model, 'Classic');
    assert.equal(item.color, 'Navy');
    assert.equal(item.size, '32');
    assert.equal(item.fit, 'Straight');
    assert.equal(item.composition, 'Cotton');
    assert.equal(item.packshotId, explicit ? 'P-alt-cover' : 'P-primary-cover');
    assert.deepEqual(item.tryonReference, crop);
    assert.deepEqual(item.photoIds, ['P-2', 'P-1']);
    assert.equal(item.purchasedFromProduct, product.id);
    assert.equal(item.possibleDuplicateOf, undefined);
    const db = store.read();
    assert.equal(db.items.find((i) => i.id === 'W-external')!.possibleDuplicateOf, item.id);
    assert.equal(db.items.find((i) => i.id === 'W-2')!.possibleDuplicateOf, undefined);
    assert.equal(db.products[0].purchasedItemId, item.id);
    assert.ok(db.photos.some((p) => p.id === 'P-alt-cover'));
    assert.equal(validateDb(db), null);
  }
});

test('photo management protects identity and wear originals and updates item evidence', async () => {
  const { dir, store, call } = setup();
  const crop = sourceCropFixture(dir);
  await store.mutate((db) => {
    pinFixtureIdentity(db);
    db.items[0].tryonReference = crop;
    db.photos.push({ ...db.photos[1], id: 'P-inspiration', inspiration: { title: 'Reference', sourceUrl: 'https://example.test', sourceNote: '', tags: [], sha256: 'a'.repeat(64) } });
    testPackshot(db, 'P-generated');
  });
  const ctx = { store, projectRoot: dir, drain: () => {} };
  const photo = await upload(ctx, new URLSearchParams({ kind: 'item' }), SAMPLE_PNG, 'original.png');
  const worn = await upload(ctx, new URLSearchParams({ kind: 'worn' }), SAMPLE_PNG, 'worn.png');
  await store.mutate((db) => {
    db.wears = [{ id: 'wear-test', key: 'test', lookId: 'L-1', lookVersion: 1, photoIds: [worn.id], createdAt: at }];
  });
  const patch = (id: string, body: Record<string, unknown>) => call('PATCH', `/api/photos/${id}`, body);
  for (const id of ['P-1', 'P-2']) {
    for (const role of ['item', 'label']) await assert.rejects(patch(id, { role }), { status: 409 });
    await assert.rejects(patch(id, { archived: true }), { status: 409 });
  }
  for (const id of [worn.id, 'P-generated', 'P-inspiration']) {
    await assert.rejects(patch(id, { role: 'face' }), { status: 409 });
    await assert.rejects(patch(id, { attachItemId: 'W-2' }), { status: 409 });
    await assert.rejects(call('POST', `/api/photos/${id}/reanalyze`), { status: 409 });
  }
  await assert.rejects(patch(worn.id, { archived: true }), { status: 409 });

  const face = await patch(photo.id, { role: 'face', meetsStandard: true, note: 'Owner check' });
  assert.equal(face.kind, 'base');
  assert.equal(face.referenceRole, 'face');
  assert.equal(face.meetsStandard, true);
  assert.equal(face.note, 'Owner check');
  assert.deepEqual(store.read().profile.basePhotoIds, [photo.id]);
  assert.equal((await patch(photo.id, { role: 'base' })).referenceRole, undefined);
  assert.equal((await patch(photo.id, { role: 'label' })).kind, 'label');
  assert.deepEqual(store.read().profile.basePhotoIds, []);
  assert.equal((await patch(photo.id, { role: 'item' })).kind, 'item');
  assert.equal((await patch(photo.id, { role: 'base' })).kind, 'base');
  const archived = await patch(photo.id, { archived: true });
  assert.ok(archived.archivedAt);
  assert.deepEqual(store.read().profile.basePhotoIds, []);
  assert.equal(archived.preserveAsReference, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, photo.path)), SAMPLE_PNG);
  assert.deepEqual((await call('PATCH', '/api/profile', { basePhotoIds: [photo.id] })).basePhotoIds, []);
  await assert.rejects(call('DELETE', `/api/photos/${photo.id}`), { status: 409 });
  assert.equal((await patch(photo.id, { archived: false })).archivedAt, undefined);
  await patch(photo.id, { archived: true });
  assert.equal((await patch(photo.id, { attachItemId: 'W-1' })).archivedAt, undefined);
  assert.equal(store.read().items[0].tryonReference, undefined);
  assert.ok(store.read().jobs.some((j) => j.kind === 'packshot' && j.itemId === 'W-1'));
  await assert.rejects(patch(photo.id, { archived: true }), { status: 409 });
  await store.mutate((db) => { db.items[0].tryonReference = { ...crop, source: { ...crop.source, path: photo.path } }; });
  assert.ok((await patch(photo.id, { detachItemId: 'W-1', archived: true })).archivedAt);
  assert.ok(!store.read().items[0].photoIds.includes(photo.id));
  assert.equal(store.read().items[0].tryonReference, undefined);
});

test('direct own item upload replaces a stale shop crop and retains the catalogue cover', async () => {
  const { dir, store } = setup();
  const crop = sourceCropFixture(dir);
  await store.mutate((db) => {
    db.photos.push({ ...db.photos[0], id: 'P-shop-crop', kind: 'product', path: 'media/shop.png' });
    const item = db.items[1];
    item.photoIds = ['P-shop-crop'];
    item.tryonReference = { ...crop, source: { ...crop.source, path: 'media/shop.png' } };
    item.packshotId = testPackshot(db, 'P-current-cover').id;
  });
  const photo = await upload({ store, projectRoot: dir, drain: () => {} }, new URLSearchParams({ kind: 'item', item: 'W-2' }), SAMPLE_PNG, 'own.png');
  const db = store.read();
  assert.deepEqual(db.items[1].photoIds, ['P-shop-crop', photo.id]);
  assert.equal(db.items[1].tryonReference, undefined);
  assert.equal(db.items[1].packshotId, 'P-current-cover');
  assert.deepEqual(db.jobs, []);
});

test('reanalyze applies admission, unarchives and starts only one active intake for the photo', async () => {
  const { dir, store, call } = setup();
  const photo = await upload({ store, projectRoot: dir, drain: () => {} }, new URLSearchParams({ kind: 'item' }), SAMPLE_PNG, 'own.png');
  const endpoint = `/api/photos/${photo.id}/reanalyze`;
  await call('PATCH', `/api/photos/${photo.id}`, { archived: true });
  let drains = 0;
  let allowed = false;
  const admissions: string[] = [];
  const ctx = { store, projectRoot: dir, drain: () => void drains++, admit: (kind: string) => {
    admissions.push(kind);
    if (!allowed) throw new HttpError(429, 'Test quota');
  } };
  const run = (body: Record<string, unknown> = {}) => dispatch(ctx, 'POST', endpoint, body) as Promise<Job>;
  await assert.rejects(run({ intent: 'wrong' }), { status: 400 });
  await assert.rejects(run(), { status: 429 });
  assert.ok(store.read().photos.find((p) => p.id === photo.id)!.archivedAt);
  allowed = true;
  const job = await run({ intent: 'person', note: '  New reference  ' });
  assert.equal(job.intakeIntent, 'person');
  assert.equal(job.instructions, 'New reference');
  assert.deepEqual(job.inputPhotoIds, [photo.id]);
  assert.equal(job.state, 'queued');
  assert.equal(store.read().photos.find((p) => p.id === photo.id)!.archivedAt, undefined);
  await assert.rejects(run(), { status: 409 });
  await store.mutate((db) => { db.jobs[0].state = 'running'; });
  await assert.rejects(run(), { status: 409 });
  await store.mutate((db) => { db.jobs[0].state = 'done'; });
  const fresh = await run();
  assert.notEqual(fresh.id, job.id);
  assert.equal(fresh.intakeIntent, 'auto');
  assert.deepEqual(admissions, ['intake', 'intake', 'intake']);
  assert.equal(drains, 2);
});

test('intake leaves a photo archived if the owner archives it during analysis', async () => {
  const { dir, store, call } = setup();
  const photo = await upload({ store, projectRoot: dir, drain: () => {} }, new URLSearchParams({ kind: 'intake', intent: 'person' }), SAMPLE_PNG, 'reference.png');
  const engine = {
    label: 'test', imageLabel: 'test',
    json: async ({ schema }: { schema: object }) => {
      assert.equal(schema, INTAKE_SCHEMA);
      await call('PATCH', `/api/photos/${photo.id}`, { archived: true });
      return { reply: { status: 'done', photoType: 'person_full_body', singlePerson: true, baseSuitable: true, garments: [] } };
    },
  };
  await createRunner(store, dir, '/usr/bin/false', { engine: engine as never }).drain();
  const db = store.read();
  assert.equal(db.jobs[0].state, 'needs_data');
  assert.ok(db.photos.find((p) => p.id === photo.id)!.archivedAt);
  assert.deepEqual(db.profile.basePhotoIds, []);
});

test('photo management, reanalysis, absorb and upload dedup are tenant isolated', async () => {
  const { createTenants, emptyDb } = await import('./tenants.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-photo-tenants-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false' });
  const a = tenants.forUser('photo-tenant-a');
  const b = tenants.forUser('photo-tenant-b');
  a.runner.stop();
  b.runner.stop();
  const params = new URLSearchParams({ kind: 'item' });
  const aPhoto = await upload(a.ctx, params, SAMPLE_PNG, 'same.png');
  const bPhoto = await upload(b.ctx, params, SAMPLE_PNG, 'same.png');
  assert.notEqual(aPhoto.id, bPhoto.id);
  assert.deepEqual(a.store.read().photos.map((p) => p.id), [aPhoto.id]);
  assert.deepEqual(b.store.read().photos.map((p) => p.id), [bPhoto.id]);
  const make = (ctx: typeof a.ctx, title: string) => dispatch(ctx, 'POST', '/api/items', { category: 'shirts', title }) as Promise<DB['items'][number]>;
  const [aItem, aCandidate, bItem] = await Promise.all([make(a.ctx, 'A'), make(a.ctx, 'Candidate A'), make(b.ctx, 'B')]);
  const beforeA = a.store.read();
  const beforeB = b.store.read();
  await assert.rejects(dispatch(b.ctx, 'POST', `/api/photos/${aPhoto.id}/reanalyze`, {}), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'PATCH', `/api/photos/${aPhoto.id}`, { archived: true }), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'PATCH', `/api/photos/${bPhoto.id}`, { attachItemId: aItem.id }), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'PATCH', `/api/photos/${bPhoto.id}`, { detachItemId: aItem.id }), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'POST', `/api/items/${aItem.id}/absorb`, { sourceId: bItem.id }), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'POST', `/api/items/${bItem.id}/absorb`, { sourceId: aCandidate.id }), { status: 404 });
  await assert.rejects(dispatch(b.ctx, 'POST', '/api/items/merge', { ids: [bItem.id, aItem.id] }), { status: 404 });
  assert.deepEqual(a.store.read(), beforeA);
  assert.deepEqual(b.store.read(), beforeB);
});

test('deleting capsule, look, item and photo cascades without dangling references', async () => {
  const { store, call } = setup();
  const job = await call('POST', '/api/jobs', { lookId: 'L-1', basePhotoIds: ['P-1'] });
  await store.mutate((db) => {
    const j = db.jobs.find((x) => x.id === job.id)!;
    j.state = 'done';
    j.resultId = 'R-1';
    db.results.push({ id: 'R-1', jobId: j.id, lookId: 'L-1', lookVersion: 1, imagePath: 'r.png', tool: 't', model: 'm', prompt: 'p', sources: [], usedItemPhotos: true, review: 'pending', favorite: false, createdAt: at });
  });
  await call('POST', '/api/packshots', { itemIds: ['W-2'] });
  await call('DELETE', '/api/items/W-1');
  let db = store.read();
  assert.ok(!db.items.some((i) => i.id === 'W-1'));
  assert.deepEqual(db.looks[0].slots.bottom, [], 'item removed from the look');
  assert.equal(db.looks[0].version, 2, 'look gets a new version');
  await call('DELETE', '/api/items/W-2');
  db = store.read();
  assert.ok(!db.jobs.some((j) => j.kind === 'packshot'), 'packshot job of deleted item removed');
  await call('DELETE', '/api/capsules/C-1');
  db = store.read();
  assert.equal(db.capsules.length, 0);
  assert.equal(db.looks.length, 0);
  assert.equal(db.results.length, 0, 'renders of deleted looks removed');
  assert.equal(db.jobs.filter((j) => j.kind !== 'advise').length, 0, 'only the advisor run queued by the deletes is left');
  await call('PATCH', '/api/profile', { rev: db.profile.rev, basePhotoIds: ['P-2'] });
  await store.mutate((d) => {
    d.photos.find((p) => p.id === 'P-2')!.kind = 'base';
  });
  await call('DELETE', '/api/photos/P-2');
  db = store.read();
  assert.deepEqual(db.profile.basePhotoIds, []);
  await assert.rejects(call('DELETE', '/api/photos/P-1'), (e: any) => e.status === 409, 'chat originals are protected');
});

test('a new selection gets a try-on for every look; missing renders are queued once', async () => {
  const { dir, store, call } = setup();
  const crop = sourceCropFixture(dir);
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(path.join(dir, 'fixture.png'), SAMPLE_PNG);
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nschema=""\nwhile [ $# -gt 0 ]; do case "$1" in -C) d="$2"; shift;; -o) o="$2"; shift;; --output-schema) schema="$2"; shift;; esac; shift; done\ncat >/dev/null\nif [ -n "$schema" ]; then echo \'{"status":"done","reason":"","name":"Вихідні","description":"","looks":[{"name":"A","occasion":"","season":"all","top":[],"layer":["W-J"],"bottom":["W-1"],"shoes":["W-S"],"accessories":[],"why":""},{"name":"B","occasion":"","season":"all","top":["W-T"],"layer":[],"bottom":["W-2"],"shoes":["W-S"],"accessories":[],"why":""}]}\' > "$o"; else cp "$d/../../fixture.png" "$d/result.png"; echo \'{"status":"done"}\' > "$o"; fi\n',
    { mode: 0o755 },
  );
  await store.mutate((db) => {
    db.items.push({ id: 'W-S', rev: 1, category: 'shoes', title: 'Stan Smith', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.items.push({ id: 'W-J', rev: 1, category: 'outerwear', title: 'Jacket', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.items.push({ id: 'W-T', rev: 1, category: 'tees', title: 'Tee', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.profile.basePhotoIds = ['P-1'];
    for (const item of db.items) {
      item.photoIds = [...new Set(['P-1', ...item.photoIds])];
      item.tryonReference = crop;
    }
  });
  const job = await call('POST', '/api/analyze', {});
  assert.match(job.instructions, /^Тема: /, 'an empty request gets a theme for variety');
  await createRunner(store, dir, fake).drain();
  const db = store.read();
  const sel = db.capsules.find((c) => c.kind === 'selection')!;
  assert.equal(sel.lookIds.length, 2);
  for (const id of sel.lookIds) assert.ok(db.results.some((r) => r.lookId === id), `look ${id} has a render`);
  assert.ok(!db.results.some((r) => r.lookId === 'L-1'), 'no automatic batch: other looks are not rendered unasked');
  const again = await call('POST', '/api/renders/missing', {});
  assert.equal(again.queued, 1, 'only the seed look L-1 still lacked a render');
  await createRunner(store, dir, fake).drain();
  const blocked = store.read();
  assert.equal(blocked.jobs.find((j) => j.lookId === 'L-1')?.state, 'needs_data');
  assert.match(blocked.jobs.find((j) => j.lookId === 'L-1')?.stateNote ?? '', /Потрібні окремі фото речей: Молочна футболка/);
  assert.ok(!blocked.results.some((r) => r.lookId === 'L-1'), 'a concept without a photo never reaches image generation');
  await store.mutate((d) => {
    const l = d.looks.find((x) => x.id === 'L-1')!;
    l.version += 1;
    l.versions.push({ version: l.version, slots: l.slots, at });
  });
  assert.equal((await call('POST', '/api/renders/missing', {})).queued, 1, 'a changed composition needs a new try-on');
  assert.equal((await call('POST', '/api/renders/missing', {})).queued, 0, 'no duplicate jobs while one is queued');
});

test('analyzer drops near-copies of existing looks and keeps names unique', async () => {
  const { store } = setup();
  await store.mutate((db) => {
    db.items.push(
      { id: 'W-S', rev: 1, category: 'shoes', title: 'Stan Smith', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-T', rev: 1, category: 'tees', title: 'Tee', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-J', rev: 1, category: 'outerwear', title: 'Jacket', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
    );
    const slots = { ...emptySlots(), top: [{ kind: 'item' as const, id: 'W-T' }], bottom: [{ kind: 'item' as const, id: 'W-1' }], shoes: [{ kind: 'item' as const, id: 'W-S' }] };
    db.looks.push({ id: 'L-old', rev: 1, capsuleId: null, name: 'old', slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'agent', createdAt: at, updatedAt: at });
    db.capsules.push({ id: 'C-s', rev: 1, kind: 'selection', name: 'Вихідні', season: 'all', description: '', situations: [], favorite: false, lookIds: [], origin: 'agent', createdAt: at, updatedAt: at });
    const job = { id: 'J-a', kind: 'analyze' as const, lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
    const id = applyAnalyze(db, job, {
      status: 'done', reason: '', name: 'Вихідні', description: '',
      looks: [
        { name: 'copy', occasion: '', season: 'all', top: ['W-T'], layer: ['W-J'], bottom: ['W-1'], shoes: ['W-S'], accessories: [], why: '' },
        { name: 'new', occasion: '', season: 'all', top: [], layer: ['W-J'], bottom: ['W-2'], shoes: ['W-S'], accessories: [], why: '' },
      ],
    })!;
    const cap = db.capsules.find((c) => c.id === id)!;
    assert.equal(cap.name, 'Вихідні · 2');
    assert.deepEqual(cap.lookIds.map((l) => db.looks.find((x) => x.id === l)!.name), ['new']);
  });
});

test('complete-the-look: every look keeps the picked items and adds different pieces', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.items.push(
      { id: 'W-S', rev: 1, category: 'shoes', title: 'Stan Smith', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-B', rev: 1, category: 'shoes', title: 'Boots', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-T', rev: 1, category: 'tees', title: 'Tee', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
      { id: 'W-J', rev: 1, category: 'outerwear', title: 'Jacket', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at },
    );
  });
  const job = await call('POST', '/api/analyze', { itemIds: ['W-1'] });
  assert.deepEqual(job.requiredItemIds, ['W-1']);
  assert.match(job.instructions, /Доповнити: Navy chinos/);
  await store.mutate((db) => {
    const j = db.jobs.find((x) => x.id === job.id)!;
    const id = applyAnalyze(db, j, {
      status: 'done', reason: '', name: 'Доповнення: chinos', description: '',
      looks: [
        { name: 'a', occasion: '', season: 'all', top: ['W-T'], layer: [], bottom: ['W-1'], shoes: ['W-S'], accessories: [], why: '' },
        { name: 'missing pick', occasion: '', season: 'all', top: ['W-T'], layer: [], bottom: ['W-2'], shoes: ['W-B'], accessories: [], why: '' },
        { name: 'b', occasion: '', season: 'all', top: [], layer: ['W-J'], bottom: ['W-1'], shoes: ['W-B'], accessories: [], why: '' },
      ],
    })!;
    const names = db.capsules.find((c) => c.id === id)!.lookIds.map((l) => db.looks.find((x) => x.id === l)!.name);
    assert.deepEqual(names, ['a', 'b'], 'looks without the picked item are dropped');
  });
  await call('DELETE', '/api/items/W-1');
  assert.ok(!store.read().jobs.find((x) => x.id === job.id)!.requiredItemIds?.length, 'deleting a picked item keeps the store valid');
});

test('try-on prompt sends original base photos to the image tool before garments, never renders', () => {
  const db = fixture();
  const job = { id: 'J', lookId: 'L-1', lookVersion: 1, snapshot: { lookName: 'Look', slots: snapshotSlots(db, db.looks[0].slots), basePhotoIds: ['P-1'], basePhotoPaths: ['assets/photos/a.jpeg'] }, instructions: '', state: 'queued' as const, origin: 'site' as const, createdAt: at };
  const prompt = buildPrompt(job, '/tmp/x/result.png', { identity: ['/abs/assets/photos/a.jpeg'], garments: ['/abs/assets/photos/b.jpeg'] });
  assert.match(prompt, /referenced_image_paths/);
  const list = JSON.parse(prompt.match(/parameter \(in this order\): (\[[^\]]*\])/)![1]);
  assert.deepEqual(list, ['/abs/assets/photos/a.jpeg', '/abs/assets/photos/b.jpeg'], 'identity first, then garments');
  assert.ok(!/renders\//.test(prompt), 'no generated render is used as a reference');
  assert.match(prompt, /exact facial features/);
  assert.match(prompt, /No shoes, socks or other footwear are permitted/);
  job.snapshot.slots.push({ ...job.snapshot.slots[0], slot: 'shoes' });
  assert.match(buildPrompt(job, '/tmp/x/result.png'), /full length from head to shoes/);
});

test('image references never exceed the tool limit and keep identity first', () => {
  const db = fixture();
  const slots = snapshotSlots(db, db.looks[0].slots).map((s, i) => ({ ...s, photoPaths: [`assets/photos/g${i}a.jpeg`, `assets/photos/g${i}b.jpeg`] }));
  const job = { id: 'J', lookId: 'L-1', lookVersion: 1, snapshot: { lookName: 'Look', slots, basePhotoIds: ['P-1'], basePhotoPaths: ['assets/photos/a.jpeg', 'assets/photos/b.jpeg', 'assets/photos/c.jpeg', 'assets/photos/d.jpeg'] }, instructions: '', state: 'queued' as const, origin: 'site' as const, createdAt: at };
  const refs = pickRefs(job, false, (p) => `/abs/${p}`);
  assert.equal(refs.identity.length, 3);
  assert.ok(refs.identity.length + refs.garments.length <= MAX_IMAGE_REFS);
  assert.ok(refs.garments.length >= 1, 'at least one garment reference fits');
  const packshot = pickRefs(job, true, (p) => `/abs/${p}`);
  assert.equal(packshot.identity.length, 0);
  assert.ok(packshot.garments.length <= MAX_IMAGE_REFS);
});

test('pinned original freezes face/body crops and excludes faces from garment photos', () => {
  const db = fixture();
  const file = (p: string) => ({ path: p, sha256: 'a'.repeat(64) });
  db.profile.identity = { sourcePhotoId: 'P-1', original: file('assets/photos/a.jpeg'), face: file('.local/media/face.png'), body: file('.local/media/body.png'), preserveHeadAngle: true, confirmedAt: at };
  db.items[0].tryonReference = { ...file('.local/media/trousers.png'), source: file('assets/photos/b.jpeg') };
  const job = createJob(db, db.looks[0], ['P-2'], '');
  assert.deepEqual(job.snapshot.basePhotoIds, ['P-1']);
  const refs = pickRefs(job, false, (p) => '/abs/' + p);
  assert.deepEqual(refs.identity, ['/abs/.local/media/face.png', '/abs/.local/media/body.png']);
  assert.deepEqual(refs.garments, ['/abs/.local/media/trousers.png']);
  const prompt = buildPrompt(job, '/tmp/result.png', refs);
  assert.match(prompt, /KEEP the original head tilt, rotation, gaze direction/);
  assert.doesNotMatch(prompt, /head level|eyes looking into the camera|Ignore their pose/);
  db.profile.identity.face.path = '.local/media/other-face.png';
  assert.equal(job.snapshot.identity!.face.path, '.local/media/face.png', 'profile edits cannot rewrite past attempts');
  delete db.items[0].tryonReference;
  assert.deepEqual(snapshotSlots(db, db.looks[0].slots)[1].photoPaths, [], 'unreviewed full-person garment images stay out');
  assert.equal(validateDb(db), null);
  db.photos[0].source = 'generated';
  assert.match(validateDb(db)!, /власного оригіналу/);
});

test('a bought item without its own photo offers its shop photo to the try-on, never a packshot', () => {
  const db = fixture();
  db.photos.push(
    { id: 'P-shop', kind: 'product', path: 'media/products/S-1.png', originalName: 'S-1.png', source: 'generated', createdAt: at },
    { id: 'P-pack', kind: 'packshot', path: 'media/packshots/J-1.png', originalName: 'J-1.png', source: 'generated', createdAt: at },
  );
  db.items[1].photoIds = ['P-shop', 'P-pack'];
  db.looks[0].slots.bottom = [{ kind: 'item', id: 'W-2' }];
  const bottom = () => snapshotSlots(db, db.looks[0].slots).find((s) => s.slot === 'bottom')!;
  assert.deepEqual(bottom().originalPhotoPaths, ['media/products/S-1.png']);
  db.items[1].photoIds = ['P-shop', 'P-2'];
  assert.deepEqual(bottom().originalPhotoPaths, ['assets/photos/b.jpeg'], 'the owner’s own photo wins over the shop photo');
});

test('shoe packshots show the pair from the front, like the rest of the wardrobe', () => {
  const job = { id: 'J', kind: 'packshot', itemId: 'W-S', lookVersion: 0, snapshot: { lookName: 'Vans', slots: [{ slot: 'shoes', kind: 'item', id: 'W-S', title: 'Vans', description: '', owned: true, photoPaths: ['assets/photos/a.jpeg'] }], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued', origin: 'site', createdAt: at } as Parameters<typeof buildPackshotPrompt>[0];
  const prompt = buildPackshotPrompt(job, '/tmp/result.png');
  assert.match(prompt, /from the front and slightly above, toes pointing at the camera/);
  assert.match(prompt, /invisible shoe trees/);
  assert.match(prompt, /Lift the collapsed vamp and toe box/);
  assert.match(prompt, /Inspect the actual returned image/);
  assert.doesNotMatch(prompt, /three-quarter/);
});

test('pinned reference integrity fails before generation when a file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-identity-'));
  try {
    const file = (p: string) => { fs.writeFileSync(path.join(dir, p), p); return { path: p, sha256: createHash('sha256').update(p).digest('hex') }; };
    const db = fixture();
    db.profile.identity = { sourcePhotoId: 'P-1', original: file('original.png'), face: file('face.png'), body: file('body.png'), preserveHeadAngle: true, confirmedAt: at };
    const job = createJob(db, db.looks[0], [], '');
    verifyReferenceFiles(job, (p) => path.join(dir, p));
    fs.writeFileSync(path.join(dir, 'face.png'), 'changed');
    assert.throws(() => verifyReferenceFiles(job, (p) => path.join(dir, p)), /Змінено закріплений файл: face.png/);
    fs.unlinkSync(path.join(dir, 'face.png'));
    assert.throws(() => verifyReferenceFiles(job, (p) => path.join(dir, p)), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('front gaze, hair-only styling and no glasses freeze with original identity sources', () => {
  const db = fixture();
  const file = (p: string) => ({ path: p, sha256: 'b'.repeat(64) });
  db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('.local/media/face.png'), body: file('.local/media/body.png'), bodyOriginal: file(db.photos[1].path), hair: { sourcePhotoId: 'P-2', original: file(db.photos[1].path), crop: file('.local/media/hair.png') }, preserveHeadAngle: false, hairstyle: 'Same length and colour, neatly swept back and slightly sideways', noGlasses: true, confirmedAt: at };
  const job = createJob(db, db.looks[0], ['P-2'], '');
  const refs = pickRefs(job, false, (p) => p);
  assert.deepEqual(refs.identity, ['.local/media/face.png', '.local/media/body.png', '.local/media/hair.png']);
  assert.deepEqual(job.snapshot.basePhotoPaths, refs.identity);
  const prompt = buildPrompt(job, '/tmp/control.png', refs);
  assert.match(prompt, /head upright and facing directly forward/);
  assert.match(prompt, /both eyes open and looking straight into the camera/);
  assert.match(prompt, /ORIGINAL HAIR-ONLY crop/);
  assert.match(prompt, /ABSOLUTELY NO GLASSES/);
  assert.doesNotMatch(prompt, /KEEP the original head tilt/);
  assert.equal(validateDb(db), null);
  db.profile.identity.noGlasses = false;
  assert.equal(job.snapshot.identity!.noGlasses, true);
  db.photos[1].source = 'generated';
  assert.match(validateDb(db)!, /статура.*власного оригіналу/);
  delete db.profile.identity.bodyOriginal;
  assert.match(validateDb(db)!, /зачіска.*власного оригіналу/);
});

test('face archive permits only original owner photos and rejected identity cannot start a new or frozen retry', async () => {
  const { store, call, dir } = setup();
  const file = (p: string) => ({ path: p, sha256: 'b'.repeat(64) });
  await store.mutate((db) => {
    db.photos[0].referenceRole = 'face';
    db.photos[0].preserveAsReference = true;
    db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('.local/face.png'), body: file('.local/body.png'), preserveHeadAngle: false, disabledReason: 'Обличчя відхилено власником', confirmedAt: at };
  });
  const job = await call('POST', '/api/jobs', { lookId: 'L-1' });
  assert.equal(job.state, 'needs_data');
  assert.match(job.stateNote, /відхилено/);
  const retry = await call('POST', `/api/jobs/${job.id}/retry`);
  assert.equal(retry.state, 'needs_data');
  await store.mutate((db) => { db.jobs.find((j) => j.id === job.id)!.state = 'queued'; });
  const fake = path.join(dir, 'must-not-run.sh'), marker = path.join(dir, 'ran');
  fs.writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await createRunner(store, dir, fake).drain();
  assert.equal(fs.existsSync(marker), false, 'even an older queued job must not run the rejected setup');
  assert.equal(store.read().results.length, 0);
  const db = store.read();
  db.photos[0].source = 'generated';
  assert.match(validateDb(db)!, /референс обличчя.*власним оригіналом/);
});

test('owner-approved portrait is the sole face and hair source; physique keeps original provenance', () => {
  const db = fixture();
  const file = (p: string) => ({ path: p, sha256: 'b'.repeat(64) });
  db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('.local/approved-portrait.png'), approvedPortrait: { approvedAt: at, provisional: true }, body: file('.local/body.png'), bodyOriginal: file(db.photos[1].path), preserveHeadAngle: false, noGlasses: true, confirmedAt: at };
  const job = createJob(db, db.looks[0], ['P-2'], '');
  const refs = pickRefs(job, false, (p) => p);
  assert.deepEqual(refs.identity, ['.local/approved-portrait.png', '.local/body.png']);
  assert.match(buildPrompt(job, '/tmp/control.png', refs), /OWNER-APPROVED PORTRAIT.*ONLY source for facial identity AND hairstyle/);
  assert.doesNotMatch(buildPrompt(job, '/tmp/control.png', refs), /Image 1 is an exact-pixel FACE crop/);
  assert.equal(validateDb(db), null);
  db.profile.identity.approvedPortrait!.approvedAt = '';
  assert.notEqual(validateDb(db), null, 'approval must have a valid date');
  db.profile.identity.approvedPortrait!.approvedAt = at;
  delete db.profile.identity.bodyOriginal;
  assert.notEqual(validateDb(db), null, 'an approved face never waives original physique provenance');
});

test('a no-glasses identity omits eyewear from new and retried try-ons', () => {
  const db = fixture();
  const file = (path: string) => ({ path, sha256: 'b'.repeat(64) });
  db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('.local/face.png'), body: file('.local/body.png'), preserveHeadAngle: false, noGlasses: true, confirmedAt: at };
  const eyewear = { ...db.items[0], id: 'W-G', title: 'Велоокуляри', category: 'accessories' as const, photoIds: [] };
  db.items.push(eyewear);
  const look = db.looks[0];
  look.slots.accessories = [{ kind: 'item', id: eyewear.id }];
  const withoutGlasses = createJob(db, look, ['P-1'], '');
  assert.equal(withoutGlasses.state, 'queued');
  assert.ok(!withoutGlasses.snapshot.slots.some((slot) => slot.id === eyewear.id));
  const previous = { ...withoutGlasses.snapshot, slots: snapshotSlots(db, look.slots) };
  const retry = createJob(db, look, ['P-1'], '', withoutGlasses.id, previous);
  assert.deepEqual(retry.snapshot.slots, withoutGlasses.snapshot.slots);
  assert.ok(previous.slots.some((slot) => slot.id === eyewear.id), 'the previous snapshot is unchanged');
  assert.deepEqual(look.slots.accessories.map((ref) => ref.id), [eyewear.id], 'the outfit still includes its equipment');
  const eyewearOnly = { ...look, slots: { ...emptySlots(), accessories: look.slots.accessories } };
  assert.equal(createJob(db, eyewearOnly, ['P-1'], '').state, 'needs_data');
  db.profile.identity.noGlasses = false;
  assert.ok(createJob(db, look, ['P-1'], '').snapshot.slots.some((slot) => slot.id === eyewear.id));
});

test('superseded face or physique blocks frozen retries and already queued jobs', async () => {
  const { store, call, dir } = setup();
  const file = (p: string) => ({ path: p, sha256: 'b'.repeat(64) });
  await store.mutate((db) => {
    db.profile.basePhotoIds = ['P-1'];
    db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('.local/old-face.png'), body: file('.local/body.png'), preserveHeadAngle: false, confirmedAt: at };
  });
  const old = await call('POST', '/api/jobs', { lookId: 'L-1' });
  await store.mutate((db) => {
    db.profile.identity!.face = file('.local/approved-portrait.png');
    db.jobs.find((j) => j.id === old.id)!.state = 'error';
  });
  const db = store.read();
  assert.equal(sameIdentity(db.profile.identity, old.snapshot.identity), false);
  const retry = await call('POST', `/api/jobs/${old.id}/retry`);
  assert.equal(retry.state, 'needs_data');
  assert.match(retry.stateNote, /обличчя або статури змінилася/);
  const current = createJob(db, db.looks[0], [], '');
  assert.equal(sameIdentity(db.profile.identity, current.snapshot.identity), true);
  db.profile.identity!.body.sha256 = 'c'.repeat(64);
  assert.equal(sameIdentity(db.profile.identity, current.snapshot.identity), false, 'physique changes also invalidate frozen attempts');
  const fake = path.join(dir, 'must-not-run.sh'), marker = path.join(dir, 'ran');
  fs.writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await store.mutate((d) => { d.jobs.find((j) => j.id === old.id)!.state = 'queued'; });
  await createRunner(store, dir, fake).drain();
  assert.equal(fs.existsSync(marker), false, 'queued attempts with the old face never reach the generator');
  assert.match(store.read().jobs.find((j) => j.id === old.id)!.stateNote!, /обличчя або статури змінилася/);
});

test('retained uploaded originals survive attempted deletion independently of base selection', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.photos.push({ id: 'P-selfie', kind: 'base', path: '.local/media/selfie.jpg', originalName: 'selfie.jpg', source: 'upload', preserveAsReference: true, createdAt: at });
    db.profile.basePhotoIds = [];
  });
  await assert.rejects(call('DELETE', '/api/photos/P-selfie'), (e: any) => e.status === 409);
  assert.ok(store.read().photos.some((p) => p.id === 'P-selfie'));
});

test('detaching or splitting a garment source clears its stale crop and keeps the original archive', async () => {
  const { store, call } = setup();
  const crop = { path: '.local/media/trousers.png', sha256: 'a'.repeat(64), source: { path: 'assets/photos/a.jpeg', sha256: 'b'.repeat(64) } };
  await store.mutate((db) => { db.items[0].tryonReference = crop; });
  await call('PATCH', '/api/items/W-1', { photoIds: ['P-2'] });
  assert.equal(store.read().items[0].tryonReference, undefined);
  await store.mutate((db) => { db.items[0].photoIds = ['P-1', 'P-2']; db.items[0].tryonReference = crop; });
  await call('POST', '/api/items/W-1/split', { photoIds: ['P-1'] });
  const db = store.read();
  assert.equal(db.items[0].tryonReference, undefined);
  assert.equal(db.photos.length, 2, 'both originals remain references');
  assert.equal(validateDb(db), null);
});

test('restart re-queues only jobs this runner started, never a job running elsewhere', async () => {
  const { store } = setup();
  const snap = { lookName: 'Look', slots: [], basePhotoIds: ['P-1'], basePhotoPaths: ['assets/photos/a.jpeg'] };
  await store.mutate((db) => {
    db.jobs.push({ id: 'J-own', lookId: 'L-1', lookVersion: 1, snapshot: snap, instructions: '', state: 'running', origin: 'site', createdAt: at, logPath: 'x/jobs/J-own/codex.jsonl' });
    db.jobs.push({ id: 'J-chat', lookId: 'L-1', lookVersion: 1, snapshot: snap, instructions: '', state: 'running', origin: 'site', createdAt: at, stateNote: 'attended elsewhere' });
  });
  const n = await createRunner(store, store.dataDir, '/usr/bin/false').recover();
  assert.equal(n, 1);
  const db = store.read();
  assert.equal(db.jobs.find((j) => j.id === 'J-own')!.state, 'queued');
  assert.equal(db.jobs.find((j) => j.id === 'J-chat')!.state, 'running');
});

const lookWith = (id: string, refs: Partial<Record<'top' | 'layer' | 'bottom' | 'shoes' | 'accessories', string[]>>, extra: Partial<{ favorite: boolean; disliked: boolean; capsuleId: string | null }> = {}) => {
  const slots = emptySlots();
  for (const [k, ids] of Object.entries(refs)) slots[k as 'top'] = ids!.map((x) => ({ kind: 'item' as const, id: x }));
  return { id, rev: 1, capsuleId: null, name: id, slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'agent' as const, createdAt: at, updatedAt: at, ...extra };
};

test("owner's same-look rule: identical or one piece different is the same look; two pieces (accessories too) is a different look", () => {
  const base = lookWith('a', { top: ['T'], bottom: ['B'], shoes: ['S'] });
  assert.ok(sameLook(base, lookWith('b', { top: ['T'], bottom: ['B'], shoes: ['S'] })), 'identical');
  assert.ok(sameLook(base, lookWith('b', { top: ['T'], bottom: ['B'], shoes: ['S2'] })), 'one swap');
  assert.ok(sameLook(base, lookWith('b', { top: ['T'], bottom: ['B'], shoes: ['S'], accessories: ['belt'] })), 'one accessory added');
  assert.ok(!sameLook(base, lookWith('b', { top: ['T'], bottom: ['B'], shoes: ['S2'], accessories: ['belt'] })), 'swap + accessory = two pieces');
  assert.ok(!sameLook(base, lookWith('b', { top: ['T2'], bottom: ['B'], shoes: ['S2'] })), 'two swaps');
});

test('dislike hides the look, its near-copies and a disliked capsule\'s looks; a liked look stays visible', () => {
  const db = fixture();
  db.looks.push(
    lookWith('L-x', { top: ['W-1'], bottom: ['W-2'], shoes: ['W-1'] }, { disliked: true }),
    lookWith('L-near', { top: ['W-1'], bottom: ['W-2'], shoes: ['W-1'], accessories: ['W-2'] }),
    lookWith('L-liked', { top: ['W-1'], bottom: ['W-2'] }, { favorite: true }),
  );
  db.capsules[0].disliked = true;
  const hidden = hiddenLookIds(db);
  assert.deepEqual([...hidden].sort(), ['L-1', 'L-near', 'L-x']);
  assert.ok(isCapsuleHidden(db, db.capsules[0]));
});

test('a hidden capsule hides all its looks, liked ones too (owner, 20.11)', () => {
  const db = fixture();
  const liked = lookWith('L-fav', { top: ['W-1'], bottom: ['W-2'], shoes: ['W-1'] }, { favorite: true });
  db.looks.push(liked);
  db.capsules[0].lookIds.push('L-fav');
  assert.ok(!hiddenLookIds(db).has('L-fav'), 'visible while the capsule is shown');
  db.capsules[0].disliked = true;
  db.looks = [...db.looks];
  assert.ok(hiddenLookIds(db).has('L-fav'), 'hidden with its capsule');
});

test('rating route: like, dislike and clear are exclusive; invalid values are refused', async () => {
  const { store, call } = setup();
  const liked = await call('POST', '/api/looks/L-1/rating', { rating: 'like' });
  assert.equal(liked.favorite, true);
  const disliked = await call('POST', '/api/looks/L-1/rating', { rating: 'dislike' });
  assert.equal(disliked.favorite, false);
  assert.equal(disliked.disliked, true);
  const cleared = await call('POST', '/api/capsules/C-1/rating', { rating: null });
  assert.equal(cleared.disliked, undefined);
  await assert.rejects(call('POST', '/api/looks/L-1/rating', { rating: 'meh' }), /Оцінка/);
  const bad = store.read();
  bad.looks[0].favorite = true;
  assert.match(validateDb(bad) ?? '', /лайк і дизлайк/);
});

test('regeneration is checked against liked and disliked looks; hidden looks get no new renders', async () => {
  const { store } = setup();
  await store.mutate((db) => {
    for (const [id, category] of [['W-S', 'shoes'], ['W-T', 'tees'], ['W-J', 'outerwear'], ['W-K', 'knitwear'], ['W-B', 'shoes']] as const)
      db.items.push({ id, rev: 1, category, title: id, status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    db.looks.push(lookWith('L-no', { top: ['W-T'], layer: ['W-J'], bottom: ['W-1'], shoes: ['W-S'] }, { disliked: true }));
    db.looks.push(lookWith('L-yes', { top: ['W-K'], bottom: ['W-2'], shoes: ['W-B'] }, { favorite: true }));
    const job = { id: 'J-r', kind: 'analyze' as const, lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
    const prompt = analyzePrompt(db, job, []);
    assert.match(prompt, /REJECTED[^\n]*\n- W-T, W-J, W-1, W-S/);
    assert.match(prompt, /LIKED[^\n]*\n- W-K, W-2, W-B/);
    const id = applyAnalyze(db, job, {
      status: 'done', reason: '', name: 'Нове', description: '',
      looks: [
        { name: 'rejected again', occasion: '', season: 'all', top: ['W-T'], layer: ['W-J'], bottom: ['W-1'], shoes: ['W-B'], accessories: [], why: '' },
        { name: 'liked again + belt', occasion: '', season: 'all', top: ['W-K'], layer: [], bottom: ['W-2'], shoes: ['W-B'], accessories: ['W-T'], why: '' },
        { name: 'fresh', occasion: '', season: 'all', top: ['W-T'], layer: [], bottom: ['W-2'], shoes: ['W-S'], accessories: [], why: '' },
      ],
    })!;
    assert.deepEqual(db.capsules.find((c) => c.id === id)!.lookIds.map((l) => db.looks.find((x) => x.id === l)!.name), ['fresh']);
    db.profile.basePhotoIds = ['P-1'];
    const queued = queueMissingRenders(db);
    assert.ok(!queued.some((j) => j.lookId === 'L-no'), 'a disliked look is not rendered');
  });
});

test('an upload joined to an existing item names it; the duplicate rule needs matching details, not just type and colour', async () => {
  const { store } = setup();
  await store.mutate((db) => {
    db.photos.push({ id: 'P-belt', kind: 'item', path: 'assets/photos/belt.jpeg', originalName: 'belt.jpeg', source: 'upload', createdAt: at });
    const job = { id: 'J-belt', kind: 'intake' as const, inputPhotoIds: ['P-belt'], lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
    assert.match(intakePrompt(db, job, ['belt.jpeg']), /same type and colour alone is NOT enough/);
    const out = applyIntake(db, job, {
      status: 'done', reason: '', photoType: 'garments_only', singlePerson: false, baseSuitable: false, baseIssues: '',
      label: { itemId: '', brand: '', size: '', composition: '' },
      garments: [{ title: 'Штани', category: 'trousers', color: 'синій', notes: '', duplicateOf: 'W-1' }],
    });
    assert.deepEqual(out.attachedTo, ['W-1']);
    assert.match(out.note, /«Navy chinos»/);
    db.jobs.push({ ...job, state: 'done', attachedItemIds: out.attachedTo });
  });
  assert.equal(validateDb(store.read()), null);
});

test('an upload that is an open recommendation leaves the shopping list, replaces the stand-in in looks and re-renders them; undo restores', async () => {
  const { store, call } = setup();
  await store.mutate((db) => {
    db.profile.basePhotoIds = ['P-1'];
    db.photos.push({ id: 'P-tee', kind: 'item', path: 'assets/photos/tee.jpeg', originalName: 'tee.jpeg', source: 'upload', createdAt: at });
    const job = { id: 'J-tee', kind: 'intake' as const, inputPhotoIds: ['P-tee'], lookVersion: 0, snapshot: { lookName: '', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
    const prompt = intakePrompt(db, job, ['tee.jpeg']);
    assert.match(prompt, /N-1 \| футболки \| Молочна футболка/, 'open recommendations are listed for matching');
    assert.match(prompt, /coversNeed/);
    const reply = {
      status: 'done', reason: '', photoType: 'garments_only', singlePerson: false, baseSuitable: false, baseIssues: '',
      label: { itemId: '', brand: '', size: '', composition: '' },
      garments: [
        { title: 'Молочна футболка з емблемою', category: 'tees', color: 'молочний', notes: '', duplicateOf: '', coversNeed: 'N-1' },
        { title: 'Сині штани', category: 'trousers', color: 'синій', notes: '', duplicateOf: '', coversNeed: 'N-1' },
      ],
    };
    const out = applyIntake(db, job, reply);
    const tee = db.items.find((i) => i.title === 'Молочна футболка з емблемою')!;
    assert.deepEqual(out.covers, [{ itemId: tee.id, needId: 'N-1' }], 'only a garment of the same category covers the need');
    db.jobs.push({ ...job, state: 'done', createdItemIds: out.created });
  });
  const tee = store.read().items.find((i) => i.title === 'Молочна футболка з емблемою')!;
  const r = await call('POST', '/api/needs/N-1/cover', { itemId: tee.id });
  let db = store.read();
  assert.deepEqual(r, { looks: 1, queued: 0, waiting: 0 }, 'pictures update only when the owner asks');
  assert.equal(db.needs[0].status, 'covered');
  assert.equal(db.needs[0].coveredByItem, tee.id);
  assert.deepEqual(db.needs[0].coveredLookIds, ['L-1']);
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'item', id: tee.id }]);
  assert.equal(db.looks[0].version, 2);
  assert.ok(!db.jobs.some((j) => j.lookId === 'L-1'), 'no automatic try-on');
  await assert.rejects(call('POST', '/api/needs/N-1/cover', { itemId: tee.id }), /уже закрито/);
  assert.equal(validateDb(db), null);

  await call('POST', '/api/needs/N-1/uncover');
  db = store.read();
  assert.equal(db.needs[0].status, 'open');
  assert.equal(db.needs[0].coveredByItem, undefined);
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'need', id: 'N-1' }]);

  await call('POST', '/api/needs/N-1/cover', { itemId: tee.id });
  await call('DELETE', `/api/items/${tee.id}`);
  db = store.read();
  assert.equal(db.needs[0].status, 'open', 'deleting the item puts the recommendation back');
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'need', id: 'N-1' }], 'its looks get the stand-in back instead of a hole');
  assert.equal(validateDb(db), null);
});

test('already own can add a new item with an optional photo, match it, and undo without duplicating it', async () => {
  const { store, call } = setup();
  const original = store.read();
  const need = original.needs[0];
  const cover = (newItem: Record<string, unknown>) => call('POST', `/api/needs/${need.id}/cover`, { newItem });
  const ref = { kind: 'need', id: need.id };
  await call('PATCH', '/api/capsules/C-1', { pieces: [ref, { kind: 'item', id: 'W-1' }] });
  await assert.rejects(cover({ title: '  ' }), /Назва не може бути порожньою/);
  await assert.rejects(cover({ title: 'New tee', photoId: 'P-1' }), /Додай власне фото речі/);
  await assert.rejects(cover({ title: 'New tee', photoId: 'P-missing' }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(store.read().items.length, original.items.length, 'invalid requests do not leave a manual item behind');
  assert.equal(store.read().needs[0].status, 'open');

  await store.mutate((db) => db.photos.push({ id: 'P-own', kind: 'item', path: 'media/items/own.png', originalName: 'own.png', source: 'upload', createdAt: at }));
  const reply = await cover({ title: 'New tee', photoId: 'P-own', sport: true });
  assert.deepEqual(reply, { looks: 1, queued: 0, waiting: 0 });
  const linked = store.read();
  const item = linked.items.at(-1)!;
  assert.equal(item.category, need.category);
  assert.equal(item.sport, true);
  assert.deepEqual(item.photoIds, ['P-own']);
  assert.equal(linked.needs[0].coveredByItem, item.id);
  assert.deepEqual(linked.looks[0].slots.top[0], { kind: 'item', id: item.id });
  assert.ok(linked.capsules[0].pieces?.some((piece) => piece.kind === 'item' && piece.id === item.id));
  assert.equal(linked.jobs.find((job) => job.itemId === item.id)?.kind, 'packshot');
  await assert.rejects(cover({ title: 'New tee', photoId: 'P-own' }), /уже закрито/);
  assert.equal(store.read().items.length, original.items.length + 1);

  await call('POST', `/api/needs/${need.id}/uncover`);
  const undone = store.read();
  assert.ok(undone.items.some((saved) => saved.id === item.id));
  assert.deepEqual(undone.looks[0].slots.top[0], ref);
  assert.ok(undone.capsules[0].pieces?.some((piece) => piece.kind === 'need' && piece.id === need.id));
  await cover({ title: 'Tee without photo' });
  const withoutPhoto = store.read().items.at(-1)!;
  assert.deepEqual(withoutPhoto.photoIds, []);
  assert.equal(store.read().needs[0].coveredByItem, withoutPhoto.id);
  assert.equal(validateDb(store.read()), null);
});

test('the runner applies a recommendation match from intake and names it in the status', async () => {
  const { dir, store } = setup();
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift;; esac; shift; done\ncat >/dev/null\necho \'{"status":"done","reason":"","photoType":"garments_only","singlePerson":false,"baseSuitable":false,"baseIssues":"","label":{"itemId":"","brand":"","size":"","composition":""},"garments":[{"title":"Молочна футболка","category":"tees","color":"молочний","notes":"","duplicateOf":"","coversNeed":"N-1"}]}\' > "$o"\n',
    { mode: 0o755 },
  );
  await store.mutate((db) => {
    db.jobs.push({ id: 'J-in', kind: 'intake', inputPhotoIds: ['P-1'], lookVersion: 0, snapshot: { lookName: 'a.jpeg', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued', origin: 'site', createdAt: at });
  });
  await createRunner(store, dir, fake).drain();
  const db = store.read();
  const job = db.jobs.find((j) => j.id === 'J-in')!;
  assert.equal(job.state, 'done');
  assert.match(job.stateNote ?? '', /закриває покупку «Молочна футболка», образів оновлено: 1/);
  assert.equal(db.needs[0].status, 'covered');
  assert.deepEqual(db.looks[0].slots.top, [{ kind: 'item', id: job.createdItemIds![0] }]);
});

test('a try-on waiting on a pause blocks duplicates only while the pause holds', () => {
  const db = fixture();
  db.jobs.push({ id: 'J-wait', lookId: 'L-1', lookVersion: 1, snapshot: { lookName: 'Look', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'needs_data', origin: 'site', createdAt: at });
  assert.deepEqual(looksNeedingRender(db).map((l) => l.id), [], 'still paused (no base photo): the waiting job stands');
  db.profile.basePhotoIds = ['P-1'];
  assert.deepEqual(looksNeedingRender(db).map((l) => l.id), ['L-1'], 'pause lifted: the look needs a fresh try-on');
  db.results.push({ id: 'R-1', jobId: 'J-wait', lookId: 'L-1', lookVersion: 1, imagePath: 'renders/r.png', tool: '', model: '', prompt: '', sources: [], usedItemPhotos: false, review: 'pending', favorite: false, createdAt: at });
  assert.deepEqual(looksNeedingRender(db).map((l) => l.id), [], 'a render of the current composition is enough');
});

test('piece edits automatically request a try-on of the latest composition', async () => {
  const { store, call, drained } = setup();
  await store.mutate((db) => {
    db.profile.basePhotoIds = ['P-1'];
    db.items.push({ ...db.items[0], id: 'W-T', category: 'tees', title: 'Tee' }, { ...db.items[0], id: 'W-T2', category: 'tees', title: 'Second tee' });
  });
  let look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [{ kind: 'item', id: 'W-T' }] } });
  let db = store.read();
  const first = db.jobs.find((job) => job.lookId === 'L-1')!;
  assert.equal(first.lookVersion, 2);
  assert.equal(first.state, 'queued');
  assert.equal(first.snapshot.slots.find((slot) => slot.slot === 'top')?.id, 'W-T');
  look = db.looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [{ kind: 'item', id: 'W-T2' }] } });
  const second = store.read().jobs.find((job) => job.lookId === 'L-1')!;
  const job = await call('POST', '/api/jobs', { lookId: 'L-1', run: true });
  db = store.read();
  assert.equal(second.lookVersion, 3);
  assert.equal(second.snapshot.slots.find((slot) => slot.slot === 'top')?.id, 'W-T2');
  assert.equal(job.id, second.id, 'a manual request reuses the current queued job');
  assert.ok(!db.jobs.some((job) => job.id === first.id), 'the superseded queued job is dropped');
  assert.ok(drained() >= 2, 'both composition edits wake the runner');
  await call('PATCH', '/api/looks/L-1', { rev: db.looks[0].rev, name: 'Renamed' });
  assert.equal(store.read().jobs.filter((j) => j.lookId === 'L-1').length, 1, 'renaming does not re-render');
  look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, keptVersion: look.version });
  look = store.read().looks[0];
  assert.equal(look.keptVersion, 3);
  assert.equal(look.version, 3, 'keeping the picture is not a new version');
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [{ kind: 'item', id: 'W-T' }] } });
  look = store.read().looks[0];
  assert.notEqual(look.keptVersion, look.version, 'keeping an old image is scoped to its composition');
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: emptySlots() });
  assert.equal(store.read().jobs.filter((j) => j.lookId === 'L-1').length, 0, 'an empty look has nothing to render');
});

test('a composition save respects an account that starts try-ons explicitly', async () => {
  const { store, call } = setup(false);
  await store.mutate((db) => { db.profile.basePhotoIds = ['P-1']; });
  const look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [] } });
  assert.equal(store.read().jobs.filter((job) => job.lookId === look.id).length, 0);
  assert.equal((await call('POST', '/api/jobs', { lookId: look.id, run: true })).lookVersion, 2);
});
test('complete looks, the quiet missing line and the next-purchase rating follow the wardrobe', async () => {
  const { store, call } = setup();
  let db = store.read();
  const look = () => store.read().looks[0];
  assert.equal(isComplete(db, look()), false);
  assert.deepEqual(missingInfo(db, look()), { text: 'бракує: молочна футболка', more: 0 });
  assert.equal(purchaseRanking(db)[0].need.id, 'N-1');
  assert.equal(purchaseRanking(db)[0].completes, 1);
  await store.mutate((d) => { d.items.push({ id: 'W-T', rev: 1, category: 'tees', title: 'Молочна футболка', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at }); });
  await call('POST', '/api/needs/N-1/cover', { itemId: 'W-T' });
  db = store.read();
  assert.equal(isComplete(db, look()), true, 'the owned tee completes the look');
  assert.equal(purchaseRanking(db).length, 0, 'nothing left to buy');
  await call('PATCH', '/api/items/W-T', { rev: db.items.find((i) => i.id === 'W-T')!.rev, status: 'inactive' });
  db = store.read();
  assert.equal(db.needs[0].status, 'open', '«не моя річ» puts the recommendation back');
  assert.equal(isComplete(db, look()), false);
});

test('an inactive item makes a look incomplete; measurements accept a comma and keep their date', async () => {
  const { store, call } = setup();
  await store.mutate((d) => {
    d.looks[0].slots.top = [{ kind: 'item', id: 'W-2' }];
    d.items.find((i) => i.id === 'W-2')!.status = 'inactive';
  });
  const db = store.read();
  assert.equal(isComplete(db, db.looks[0]), false);
  assert.match(missingInfo(db, db.looks[0])!.text, /navy chinos \(дубль\)/i);
  const prof = await call('PATCH', '/api/profile', { rev: store.read().profile.rev, measurements: { chest: { value: '82,5' } } });
  assert.equal(prof.measurements.chest.value, 82.5);
  await store.mutate((d) => { d.profile.measurements.chest.date = '2026-01-01'; });
  const again = await call('PATCH', '/api/profile', { rev: store.read().profile.rev, measurements: { chest: { value: '82.5' } } });
  assert.equal(again.measurements.chest.date, '2026-01-01', 'an unchanged value keeps the day it was measured');
  await assert.rejects(call('PATCH', '/api/profile', { rev: store.read().profile.rev, measurements: { chest: { value: 'abc' } } }), /груди/);
});
test('«Знайти» searches the shops for a recommendation and saves dated variants with a match score; «Мої бренди» saves a clean list', async () => {
  const { dir, store, call } = setup();
  const prof = await call('PATCH', '/api/profile', { rev: store.read().profile.rev, brands: ['Levi’s', ' Tom Tailor ', 'Levi’s', ''] });
  assert.deepEqual(prof.brands, ['Levi’s', 'Tom Tailor']);
  const shops = await call('PATCH', '/api/profile', { rev: prof.rev, location: ' Arkadia Warsaw ', stores: ['Buzz Sneakers', ' Buzz Sneakers ', ''] });
  assert.equal(shops.location, 'Arkadia Warsaw');
  assert.deepEqual(shops.stores, ['Buzz Sneakers']);
  const job = await call('POST', '/api/needs/N-1/search', {});
  const prompt = shopSearchPrompt(store.read(), job);
  assert.match(prompt, /«Arkadia Warsaw»/);
  assert.match(prompt, /Owner's stores \(check these first\): Buzz Sneakers/);
  assert.match(prompt, /Levi’s, Tom Tailor/);
  // Article numbers leave the name the owner sees and go to sku.
  const scratch = fixture();
  const coded = applyShopSearch(scratch, { ...job, needId: 'N-1' }, { status: 'done', reason: '', products: [{ store: 'Buzz', brand: 'Adidas', model: 'Handball Spezial Shadow Brown (JQ1740)', url: 'https://example.com/a', imageUrl: '', price: '109.99', currency: 'EUR', inTower: true, size: '', matchScore: 10, matchNote: '' }] });
  const cp = scratch.products.find((x) => x.id === coded.created[0])!;
  assert.equal(cp.model, 'Handball Spezial Shadow Brown');
  assert.equal(cp.sku, 'JQ1740');
  assert.equal(job.kind, 'shopsearch');
  await assert.rejects(call('POST', '/api/needs/N-1/search', {}), /Пошук уже йде/);
  const fake = path.join(dir, 'fake-codex.sh');
  const reply = { status: 'done', reason: '', products: [
    { store: 'Tom Tailor', brand: 'Tom Tailor', model: 'Basic T-shirt off-white', url: 'https://www.tom-tailor.eu/p/1', imageUrl: '', price: '19,99', currency: 'EUR', inTower: true, size: 'M', matchScore: 8.6, matchNote: 'Молочний колір і щільна бавовна, як просили.' },
    { store: 'Somewhere', brand: 'X', model: 'Tee', url: 'http://insecure.example/p', imageUrl: '', price: '', currency: '', inTower: false, size: '', matchScore: 5, matchNote: '' },
  ] };
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--search" ] && touch "${dir}/searched"; done\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift;; esac; shift; done\ncat >/dev/null\necho '${JSON.stringify(reply)}' > "$o"\n`, { mode: 0o755 });
  await createRunner(store, dir, fake).drain();
  const db = store.read();
  assert.ok(fs.existsSync(path.join(dir, 'searched')), 'the shop search runs with live web search');
  assert.equal(db.jobs.find((j) => j.id === job.id)!.stateNote, 'Знайдено варіантів: 1', 'an insecure link is not saved');
  const p = db.products.find((x) => x.needId === 'N-1')!;
  assert.equal(p.price, 19.99);
  assert.equal(p.matchScore, 9);
  assert.equal(p.towerAvailability, 'confirmed');
  assert.equal(p.recommendedSize, 'M');
  assert.match(p.checkedAt ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(validateDb(db), null);
});

test('the advisor rates items and looks, proposes looks only on «Додати», turns a replacement into a purchase; runs after changes, once at a time, and weekly', async () => {
  const { dir, store, call } = setup();
  await store.mutate((db) => {
    const add = (id: string, category: 'tees' | 'shoes', title: string) => db.items.push({ id, rev: 1, category, title, status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    add('W-S', 'shoes', 'Brown suede sneakers');
    add('W-T', 'tees', 'White tee');
    add('W-T2', 'tees', 'Milk tee');
    add('W-LOGO', 'tees', 'Big logo tee');
    db.items.push({ id: 'W-G', rev: 1, category: 'accessories', title: 'Окуляри в черепаховій оправі', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
    db.looks[0].slots = { ...emptySlots(), top: [{ kind: 'item', id: 'W-T' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] };
  });
  // A rating queues one advice; more changes share it.
  await call('POST', '/api/looks/L-1/rating', { rating: 'like' });
  await call('POST', '/api/capsules/C-1/rating', { rating: 'like' });
  let db = store.read();
  assert.equal(db.jobs.filter((j) => j.kind === 'advise').length, 1);
  assert.equal(adviceDue(db), false, 'one is already waiting');
  const job = db.jobs.find((j) => j.kind === 'advise')!;
  assert.match(advisePrompt(db, job, []), /rate ONLY these ids now: .*W-LOGO/);
  const reply = {
    status: 'done', reason: '',
    items: [
      { id: 'W-T', score: 8.4, note: 'Чиста база.', replace: '', replaceWith: '' },
      { id: 'W-LOGO', score: 4, note: 'Логотип кричить.', replace: 'великий логотип', replaceWith: 'Однотонна темно-синя футболка' },
    ],
    looks: [{ id: 'L-1', score: 7, weakItem: 'W-T', swapTo: 'W-T2', why: 'Молочна тепліша.' }],
    newLooks: [
      { name: 'Без капсули', capsuleId: '', top: ['W-LOGO'], layer: [], bottom: ['W-2'], shoes: ['W-S'], accessories: [], why: '' },
      { name: 'Майже той самий', capsuleId: 'C-1', top: ['W-T2'], layer: [], bottom: ['W-1'], shoes: ['W-S'], accessories: [], why: '' },
      { name: 'Новий', capsuleId: 'C-1', top: ['W-T2'], layer: [], bottom: ['W-2'], shoes: ['W-S'], accessories: ['W-G'], why: 'Вводить дубль чиносів.' },
    ],
    newCapsules: [],
    newNeeds: [
      { capsuleId: 'C-1', title: 'Тепла куртка', category: 'outerwear', why: 'Капсулі бракує теплого шару.' },
      { capsuleId: 'C-1', title: 'Молочна футболка', category: 'tees', why: 'Повтор відкритої покупки.' },
    ],
  };
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift;; esac; shift; done\ncat >/dev/null\necho '${JSON.stringify(reply)}' > "$o"\n`, { mode: 0o755 });
  await createRunner(store, dir, fake).drain();
  db = store.read();
  assert.equal(db.jobs.find((j) => j.id === job.id)!.state, 'done');
  assert.equal(db.items.find((i) => i.id === 'W-T')!.rating!.score, 8);
  const logo = db.items.find((i) => i.id === 'W-LOGO')!;
  assert.equal(logo.rating!.replace, 'великий логотип');
  const replacement = db.needs.find((n) => n.replaces === 'W-LOGO')!;
  assert.equal(replacement.status, 'open');
  assert.equal(replacement.category, 'tees');
  assert.deepEqual(db.looks[0].advice!.swap, { from: 'W-T', to: 'W-T2' });
  const gaps = db.needs.filter((n) => n.forCapsule === 'C-1');
  assert.deepEqual(gaps.map((n) => n.title), ['Тепла куртка'], 'a capsule gap becomes one purchase; an open purchase is not repeated');
  const open = db.suggestions!.filter((s) => s.status === 'open');
  assert.deepEqual(open.map((s) => s.name), ['Новий'], 'near-copies and looks without a capsule are skipped');
  assert.equal(db.looks.length, 1, 'nothing enters a capsule before «Додати»');
  assert.equal(validateDb(db), null);
  // «Додати» puts the look into its capsule; «Ні» on a swap never offers it again.
  const added = await call('POST', `/api/suggestions/${open[0].id}/accept`, {});
  db = store.read();
  const newLook = db.looks.find((l) => `/looks/${l.id}` === added.href)!;
  assert.equal(newLook.capsuleId, 'C-1');
  assert.equal(Object.values(newLook.slots).flat().some((r) => r.id === 'W-G'), false, 'never eyewear in a look');
  assert.ok(db.capsules[0].lookIds.includes(newLook.id));
  await assert.rejects(call('POST', `/api/suggestions/${open[0].id}/reject`, {}), /вже розглянуто/);
  await call('POST', '/api/looks/L-1/advice', { accept: false });
  db = store.read();
  assert.equal(db.looks[0].advice!.swap, undefined);
  assert.deepEqual(db.looks[0].advice!.rejected, ['W-T>W-T2']);
  // Declining the replacement keeps the item for good.
  await call('DELETE', `/api/needs/${replacement.id}`);
  assert.equal(store.read().items.find((i) => i.id === 'W-LOGO')!.rating!.kept, true);
  // «Додати» queued a fresh rating for the new look; the weekly review is due seven days after the last one.
  assert.ok(store.read().jobs.some((j) => j.kind === 'advise' && j.state === 'queued'));
  await store.mutate((d) => void (d.jobs = d.jobs.filter((j) => !(j.kind === 'advise' && j.state === 'queued'))));
  db = store.read();
  assert.equal(adviceDue(db), false);
  assert.equal(adviceDue(db, Date.now() + 8 * 24 * 60 * 60 * 1000), true);
  assert.equal(validateDb(db), null);
});

test('round 5: eyewear stays out of «Підібрати»; advice is stamped with what it saw, never replaces the owner\'s own picks, fills free places, and undo brings a retired item back', async () => {
  const { store, call } = setup();
  const item = (id: string, category: 'tees' | 'shoes' | 'accessories' | 'shirts', title: string, origin: 'candidate' | 'manual' = 'candidate') =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin, history: [], createdAt: at, updatedAt: at });
  await store.mutate((db) => {
    db.items.push(item('W-S', 'shoes', 'White sneakers'), item('W-G', 'accessories', 'Окуляри в черепаховій оправі'), item('W-POLO', 'shirts', 'Червоне поло', 'manual'));
    db.items.push(item('W-A', 'tees', 'Logo tee A'), item('W-B', 'tees', 'Logo tee B'), item('W-C', 'tees', 'Logo tee C'), item('W-D', 'tees', 'Logo tee D'), item('W-NEW', 'tees', 'Plain tee'));
  });
  // «Підібрати» never lists or uses glasses.
  let db = store.read();
  const job = { id: 'J-an', kind: 'analyze' as const, lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  assert.doesNotMatch(analyzePrompt(db, job, []), /W-G/);
  await store.mutate((d) => {
    const id = applyAnalyze(d, job, { status: 'done', reason: '', name: 'Тест', description: '', looks: [{ name: 'З окулярами', occasion: '', season: 'all', why: '', top: ['W-A'], layer: [], bottom: ['W-1'], shoes: ['W-S'], accessories: ['W-G'] }] });
    const look = d.looks.find((l) => l.capsuleId === id)!;
    assert.equal(Object.values(look.slots).flat().some((r) => r.id === 'W-G'), false);
  });
  // Ratings carry the revision the advisor saw: an edit made meanwhile is rated again.
  db = store.read();
  const seen = seenRevs(db);
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  const logo = (id: string, score: number) => ({ id, score, note: 'Логотип.', replace: 'великий логотип', replaceWith: `Однотонна футболка ${id}` });
  await store.mutate((d) => {
    d.items.find((i) => i.id === 'W-S')!.rev += 1;
    applyAdvice(d, advise, {
      status: 'done', reason: '',
      items: [{ id: 'W-S', score: 8, note: 'База.', replace: '', replaceWith: '' }, { id: 'W-POLO', score: 5, note: 'Яскраве.', replace: 'червоний домінує', replaceWith: 'Бордове поло' }, logo('W-A', 3), logo('W-B', 4), logo('W-C', 5), logo('W-D', 6)],
      looks: [{ id: 'L-1', score: 9.46, weakItem: '', swapTo: '', why: 'Гармонійно.' }], newLooks: [], newCapsules: [], newNeeds: [],
    }, seen);
  });
  db = store.read();
  assert.ok(itemsToRate(db).some((i) => i.id === 'W-S'), 'edited during the run → rated again');
  const polo = db.items.find((i) => i.id === 'W-POLO')!;
  assert.equal(polo.rating!.replace, undefined, 'a piece the owner added himself is never «варто замінити»');
  assert.equal(db.looks[0].advice!.score, 8, 'a look with a piece to buy is at most 8 (honest scale, 19.11)');
  const open = () => store.read().needs.filter((n) => n.replaces && n.status === 'open');
  assert.equal(open().length, MAX_OPEN_REPLACEMENTS);
  assert.deepEqual(open().map((n) => n.replaces), ['W-A', 'W-B', 'W-C'], 'lowest scores take the places');
  // Declining one frees a place for W-D on the next run, even though W-D is not rated again; the declined title never returns.
  const declined = open()[0];
  await call('DELETE', `/api/needs/${declined.id}`);
  assert.deepEqual(store.read().declinedNeeds, [declined.title]);
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [], newLooks: [], newCapsules: [], newNeeds: [{ capsuleId: 'C-1', title: declined.title, category: 'tees', why: 'x' }] }));
  assert.deepEqual(open().map((n) => n.replaces), ['W-B', 'W-C', 'W-D']);
  assert.ok(!store.read().needs.some((n) => n.forCapsule && n.title === declined.title), 'a declined purchase is not proposed again');
  // «Ні» on «варто замінити»: kept, its purchase withdrawn (with its finished search), rated again, advice queued.
  await store.mutate((d) => {
    const n = d.needs.find((x) => x.replaces === 'W-B')!;
    d.jobs.push({ id: 'J-search-B', kind: 'shopsearch', needId: n.id, lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'done', origin: 'site', createdAt: at });
  });
  await call('POST', '/api/items/W-B/keep');
  assert.ok(!store.read().jobs.some((j) => j.id === 'J-search-B'));
  db = store.read();
  assert.equal(db.items.find((i) => i.id === 'W-B')!.rating!.kept, true);
  assert.ok(!db.needs.some((n) => n.replaces === 'W-B'));
  assert.ok(itemsToRate(db).some((i) => i.id === 'W-B'));
  assert.equal(db.jobs.filter((j) => j.kind === 'advise' && j.state === 'queued').length, 1);
  // «Вже маю» with «Прибрати стару річ», then «Повернути в покупки»: the old item returns to the wardrobe and its looks.
  const need = open().find((n) => n.replaces === 'W-C')!;
  await store.mutate((d) => {
    d.looks[0].slots.top = [{ kind: 'item', id: 'W-C' }];
    d.looks[0].slots.shoes = [{ kind: 'item', id: 'W-S' }];
  });
  await call('POST', `/api/needs/${need.id}/cover`, { itemId: 'W-NEW', retire: true });
  assert.equal(store.read().items.find((i) => i.id === 'W-C')!.status, 'inactive');
  await call('POST', `/api/needs/${need.id}/uncover`);
  db = store.read();
  assert.equal(db.items.find((i) => i.id === 'W-C')!.status, 'confirmed', 'undo brings the retired item back');
  assert.equal(db.needs.find((n) => n.id === need.id)!.retired, undefined);
  // «Це моя річ? — Ні» frees the replacement purchase made for that item.
  const forD = open().find((n) => n.replaces === 'W-D')!;
  await call('PATCH', '/api/items/W-D', { rev: db.items.find((i) => i.id === 'W-D')!.rev, status: 'inactive' });
  assert.ok(!store.read().needs.some((n) => n.id === forD.id));
  // New, edited and merged items queue the advisor too.
  await store.mutate((d) => void (d.jobs = d.jobs.filter((j) => j.kind !== 'advise')));
  await call('POST', '/api/items', { category: 'tees', title: 'Нова футболка' });
  assert.equal(store.read().jobs.filter((j) => j.kind === 'advise').length, 1);
  assert.equal(validateDb(store.read()), null);
});

test('round 5: a dropped shop variant never comes back; open proposals stay until answered; a failed advisor run waits a day', async () => {
  const { store, call } = setup();
  const product = await call('POST', '/api/products', { needId: 'N-1', store: 'Zara', model: 'Milk tee', url: 'https://example.com/tee' });
  await call('DELETE', `/api/products/${product.id}`);
  let db = store.read();
  assert.deepEqual(db.needs[0].droppedUrls, ['https://example.com/tee']);
  const search = { id: 'J-s', kind: 'shopsearch' as const, needId: 'N-1', lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  assert.match(shopSearchPrompt(db, search), /Already found.*https:\/\/example\.com\/tee/);
  await store.mutate((d) => void applyShopSearch(d, search, { status: 'done', reason: '', products: [{ store: 'Zara', model: 'Milk tee', sku: '', url: 'https://example.com/tee', imageUrl: '', price: '', currency: 'EUR', inTower: false, size: '', matchScore: 8, matchNote: 'x' }] } as never));
  assert.equal(store.read().products.length, 0, 'the dropped link is not saved again');
  // An unanswered proposal survives the next run while its pieces are owned.
  await store.mutate((d) => {
    d.items.push({ id: 'W-S', rev: 1, category: 'shoes', title: 'Sneakers', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    d.suggestions = [{ id: 'A-1', kind: 'look', status: 'open', name: 'Старий', why: '', capsuleId: 'C-1', looks: [{ name: 'Старий', why: '', slots: { ...emptySlots(), top: [{ kind: 'item', id: 'W-2' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] } }], jobId: 'J-0', createdAt: at }];
  });
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [], newLooks: [], newCapsules: [], newNeeds: [] }));
  assert.deepEqual(store.read().suggestions!.map((s) => s.id), ['A-1']);
  // With the places full, a proposal for a piece that has no look yet replaces the oldest unanswered one.
  await store.mutate((d) => {
    d.items.push({ id: 'W-NEW', rev: 1, category: 'tees', title: 'Нове поло', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
    d.items.push({ id: 'W-S2', rev: 1, category: 'shoes', title: 'Loafers', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    const old = d.suggestions![0];
    d.suggestions!.push({ ...old, id: 'A-2', createdAt: '2026-11-17T01:00:00.000Z' }, { ...old, id: 'A-3', createdAt: '2026-11-17T02:00:00.000Z' });
  });
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [], newCapsules: [], newNeeds: [], newLooks: [{ name: 'З новим', capsuleId: 'C-1', top: ['W-NEW'], layer: [], bottom: ['W-1'], shoes: ['W-S2'], accessories: [], why: 'Нова річ.' }] }));
  assert.deepEqual(store.read().suggestions!.filter((s) => s.status === 'open').map((s) => s.name).sort(), ['З новим', 'Старий', 'Старий']);
  assert.ok(!store.read().suggestions!.some((s) => s.id === 'A-1'), 'the oldest unanswered proposal made room');
  // After a failed run the weekly check waits a day instead of retrying every hour.
  await store.mutate((d) => void d.jobs.push({ ...advise, id: 'J-fail', state: 'error', finishedAt: new Date().toISOString() }));
  db = store.read();
  assert.equal(adviceDue(db), false);
  assert.equal(adviceDue(db, Date.now() + 25 * 60 * 60 * 1000), true);
});

test('round 6: a found replacement is not proposed again; stale replacements go; a new piece\'s proposal comes first; outfits are checked; look edits re-rate; «Ні» survives a merge', async () => {
  const { store, call } = setup();
  const item = (id: string, category: 'tees' | 'shoes' | 'accessories' | 'shirts' | 'outerwear', title: string, origin: 'candidate' | 'manual' = 'candidate') =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin, history: [], createdAt: at, updatedAt: at });
  await store.mutate((d) => {
    d.items.push(item('W-S', 'shoes', 'Sneakers'), item('W-A', 'tees', 'Logo tee A'), item('W-NEW', 'tees', 'Plain tee'), item('W-J', 'outerwear', 'Jacket'), item('W-G', 'accessories', 'Окуляри'));
  });
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  const empty = { status: 'done', reason: '', items: [], looks: [], newLooks: [], newCapsules: [], newNeeds: [] };
  const logoA = { id: 'W-A', score: 3, note: 'Логотип.', replace: 'великий логотип', replaceWith: 'Однотонна футболка' };
  await store.mutate((d) => void applyAdvice(d, advise, { ...empty, items: [logoA] }));
  const needA = store.read().needs.find((n) => n.replaces === 'W-A')!;
  // «Вже маю» without retiring the old piece: the next run does not make the same purchase again; undo leaves one open.
  await call('POST', `/api/needs/${needA.id}/cover`, { itemId: 'W-NEW' });
  await store.mutate((d) => void applyAdvice(d, advise, { ...empty, items: [logoA] }));
  assert.equal(store.read().needs.filter((n) => n.replaces === 'W-A').length, 1);
  await call('POST', `/api/needs/${needA.id}/uncover`);
  assert.equal(store.read().needs.filter((n) => n.replaces === 'W-A' && n.status === 'open').length, 1);
  // A piece never closes the purchase that replaces it.
  await assert.rejects(call('POST', `/api/needs/${needA.id}/cover`, { itemId: 'W-A' }), /та сама річ/);
  // «Ні» while its search runs: the purchase waits; the next run withdraws it and gives its look a new version.
  await store.mutate((d) => {
    d.jobs.push({ id: 'J-search-A', kind: 'shopsearch', needId: needA.id, lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running', origin: 'site', createdAt: at });
    d.looks[0].slots.top = [{ kind: 'need', id: needA.id }];
  });
  await call('POST', '/api/items/W-A/keep');
  assert.ok(store.read().needs.some((n) => n.id === needA.id), 'kept while its search runs');
  await store.mutate((d) => void (d.jobs.find((j) => j.id === 'J-search-A')!.state = 'done'));
  const before = store.read().looks[0].version;
  await store.mutate((d) => void applyAdvice(d, advise, empty));
  let db = store.read();
  assert.ok(!db.needs.some((n) => n.id === needA.id), 'withdrawn on the next run');
  assert.equal(db.looks[0].version, before + 1, 'the look that used it gets a new version');
  assert.deepEqual(db.looks[0].slots.top, []);
  // A proposal for a piece with no look comes before the older ones (Home shows two); bad outfits are rejected, glasses dropped.
  await store.mutate((d) => {
    d.items.push(item('W-FRESH', 'shirts', 'Linen shirt', 'manual'));
    // (not W-A: its honest score 3 makes it a so-so piece that proposals never use)
    d.suggestions = [{ id: 'A-1', kind: 'look', status: 'open', name: 'Старий', why: '', capsuleId: 'C-1', looks: [{ name: 'Старий', why: '', slots: { ...emptySlots(), top: [{ kind: 'item', id: 'W-NEW' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] } }], jobId: 'J-0', createdAt: at }];
  });
  await store.mutate((d) => void applyAdvice(d, advise, { ...empty, newLooks: [
    { name: 'З новою', capsuleId: 'C-1', top: ['W-FRESH'], layer: [], bottom: ['W-2'], shoes: ['W-S'], accessories: ['W-G'], why: '' },
    { name: 'Куртка внизу', capsuleId: 'C-1', top: ['W-NEW'], layer: [], bottom: ['W-J'], shoes: ['W-S'], accessories: [], why: '' },
    { name: 'Зникла річ', capsuleId: 'C-1', top: ['W-GONE'], layer: [], bottom: ['W-1'], shoes: ['W-S'], accessories: [], why: '' },
  ] }));
  db = store.read();
  assert.deepEqual(db.suggestions!.filter((s) => s.status === 'open').map((s) => s.name), ['З новою', 'Старий']);
  assert.deepEqual(db.suggestions![0].looks[0].slots.accessories, [], 'glasses are left out, the outfit stays');
  // Changing a look's pieces queues the advisor; a score for the version it saw is not current.
  await store.mutate((d) => void (d.jobs = d.jobs.filter((j) => j.kind !== 'advise')));
  const seen = seenRevs(store.read());
  const look = store.read().looks[0];
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { top: [{ kind: 'item', id: 'W-NEW' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] } });
  assert.equal(store.read().jobs.filter((j) => j.kind === 'advise').length, 1);
  await store.mutate((d) => void applyAdvice(d, advise, { ...empty, looks: [{ id: 'L-1', score: 9.2, weakItem: '', swapTo: '', why: 'x' }] }, seen));
  db = store.read();
  assert.notEqual(db.looks[0].advice!.version, db.looks[0].version, 'a look edited during the run is scored again');
  // «Так» on the advisor's swap queues it too.
  await store.mutate((d) => {
    d.jobs = d.jobs.filter((j) => j.kind !== 'advise');
    const l = d.looks[0];
    l.advice = { score: 8, why: 'x', version: l.version, swap: { from: 'W-1', to: 'W-2' } };
  });
  await call('POST', '/api/looks/L-1/advice', { accept: true });
  assert.equal(store.read().jobs.filter((j) => j.kind === 'advise').length, 1);
  const afterSwap = store.read();
  assert.ok(afterSwap.jobs.some((job) => job.lookId === 'L-1' && job.lookVersion === afterSwap.looks[0].version && job.snapshot.slots.some((slot) => slot.id === 'W-2')));
  // «Ні» on «варто замінити» survives a merge; glasses never go into «Ще образ».
  const merged = await call('POST', '/api/items/merge', { ids: ['W-A', 'W-NEW'] });
  assert.equal(store.read().items.find((i) => i.id === merged.id)!.rating!.kept, true);
  await assert.rejects(call('POST', '/api/analyze', { itemIds: ['W-G'] }), /Окуляри/);
  // The item line: no verdict for glasses; the reason reads as part of the sentence.
  await store.mutate((d) => {
    d.items.find((i) => i.id === 'W-G')!.rating = { score: 9, note: 'x', rev: 1, at };
    d.items.find((i) => i.id === 'W-J')!.rating = { score: 4, note: 'x', replace: 'Великий логотип на спині.', replaceWith: 'Однотонна куртка', rev: 1, at };
  });
  db = store.read();
  assert.equal(itemVerdict(db, db.items.find((i) => i.id === 'W-G')!), null);
  assert.equal(itemVerdict(db, db.items.find((i) => i.id === 'W-J')!)!.line, '4/10 · варто замінити: великий логотип на спині');
  assert.equal(validateDb(db), null);
});

test('round 6: a dropped product stays dropped under another link or with tracking parameters', async () => {
  const { store, call } = setup();
  const product = await call('POST', '/api/products', { needId: 'N-1', store: 'Zara', model: 'Milk tee', url: 'https://example.com/tee?utm_source=x' });
  await call('DELETE', `/api/products/${product.id}`);
  const search = { id: 'J-s', kind: 'shopsearch' as const, needId: 'N-1', lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  const found = (store: string, model: string, url: string) => ({ store, brand: '', model, sku: '', url, imageUrl: '', price: '', currency: 'EUR', inTower: false, size: '', matchScore: 8, matchNote: 'x' });
  await store.mutate((d) => void applyShopSearch(d, search, { status: 'done', reason: '', products: [
    found('Zara', 'Milk tee', 'https://www.example.com/tee/?color=2'),
    found('Zara', 'Milk tee', 'https://zara.com/milk-tee-123'),
    found('Mango', 'Ecru tee', 'https://mango.com/ecru'),
  ] } as never));
  assert.deepEqual(store.read().products.map((p) => p.model), ['Ecru tee']);
});

test('an item counts only in real capsules, not in «З моїх речей» or «Найкращі»', async () => {
  const { store } = setup();
  await store.mutate((d) => {
    d.items.push({ id: 'W-T', rev: 1, category: 'tees', title: 'White tee', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at });
    d.looks[0].slots.top = [{ kind: 'item', id: 'W-T' }];
  });
  const db = store.read();
  const { looks, capsules } = itemPlacements(db, 'W-T');
  assert.deepEqual(capsules.map((c) => c.id).sort(), ['C-1', 'my-wardrobe'], 'the ready look also shows under «З моїх речей»');
  assert.equal(capsuleCount(capsules), 1);
  assert.equal(usageLabel(capsuleCount(capsules), looks.length), 'у 1 капсулі · 1 образ');
});

test('scores on cards: a look\'s only while current, a capsule\'s is the mean of its looks, written «8,6/10»', async () => {
  const { store } = setup();
  await store.mutate((d) => {
    d.items.push({ id: 'W-T', rev: 1, category: 'tees', title: 'White tee', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at, rating: { score: 8, note: 'x', rev: 1, at } });
    d.items.push({ id: 'W-G', rev: 1, category: 'accessories', title: 'Окуляри', status: 'confirmed', photoIds: [], origin: 'candidate', history: [], createdAt: at, updatedAt: at, rating: { score: 9, note: 'x', rev: 1, at } });
    const l = d.looks[0];
    l.slots.top = [{ kind: 'item', id: 'W-T' }];
    l.advice = { score: 8.6, why: 'x', version: l.version };
  });
  let db = store.read();
  assert.equal(lookRating(db.looks[0]), 8.6);
  assert.equal(capsuleRating(db, db.capsules[0]), 8.6);
  assert.equal(scoreLabel(8.6), '8,6/10');
  assert.equal(scoreLabel(9), '9/10');
  assert.equal(itemRating(db.items.find((i) => i.id === 'W-T')!), 8);
  assert.equal(itemRating(db.items.find((i) => i.id === 'W-G')!), null, 'glasses get no score');
  await store.mutate((d) => {
    const l = d.looks[0];
    l.version += 1;
    l.versions.push({ version: l.version, slots: l.slots, at });
  });
  db = store.read();
  assert.equal(lookRating(db.looks[0]), null, 'a stale score is not shown');
  assert.equal(capsuleRating(db, db.capsules[0]), null);
});

test('a look and its variants share one score: the main look\'s, even when a variant\'s own is stale or missing', () => {
  const look = (id: string, extra: Partial<Look> = {}): Look => ({ id, rev: 1, capsuleId: 'C-1', name: id, note: '', slots: { layer: [], top: [], bottom: [], shoes: [], accessories: [] }, version: 2, versions: [], favorite: false, origin: 'owner', createdAt: at, updatedAt: at, ...extra });
  const main = look('L-main', { advice: { score: 7.6, why: 'main', version: 2 } });
  const stale = look('L-stale', { variantOf: 'L-main', advice: { score: 5, why: 'old', version: 1 } });
  const bare = look('L-bare', { variantOf: 'L-main' });
  const other = look('L-other', { advice: { score: 9, why: 'other', version: 2 } });
  const db = { looks: [main, stale, bare, other] } as unknown as DB;
  for (const l of [main, stale, bare]) assert.equal(sharedAdvice(db, l)?.score, 7.6);
  assert.equal(sharedAdvice(db, other)?.score, 9, 'an unrelated look keeps its own');
  const unrated = { looks: [{ ...main, advice: undefined }, { ...bare, advice: { score: 6.5, why: 'v', version: 2 } }] } as unknown as DB;
  assert.equal(sharedAdvice(unrated, unrated.looks[0])?.score, 6.5, 'without a main score the first current variant score is shared');
});

test('round 7: look memory keeps deleted and refused compositions, closeness catches near-copies and twins; honest scale scores only what changed', async () => {
  const { store, call } = setup();
  const item = (id: string, category: 'tees' | 'shoes' | 'trousers' | 'accessories', title: string) =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin: 'candidate' as const, history: [], createdAt: at, updatedAt: at });
  await store.mutate((d) => {
    d.items.push(item('W-T', 'tees', 'Біла футболка'), item('W-T9', 'tees', 'Біла футболка без принту'), item('W-T3', 'tees', 'Чорна футболка'), item('W-S', 'shoes', 'Білі кеди'), item('W-S2', 'shoes', 'Коричневі лофери'), item('W-P', 'trousers', 'Темно-сині чиноси'), item('W-BAG', 'accessories', 'Червона сумка'));
  });
  const slots = (top: string, bottom: string, shoes: string, acc: string[] = []) => ({ ...emptySlots(), top: [{ kind: 'item' as const, id: top }], bottom: [{ kind: 'item' as const, id: bottom }], shoes: [{ kind: 'item' as const, id: shoes }], accessories: acc.map((id) => ({ kind: 'item' as const, id })) });
  let db = store.read();
  // Closeness: one core piece different (shoes) counts as the same look; twin items by kind and colour too.
  assert.equal(tooClose(db, slots('W-T', 'W-P', 'W-S'), slots('W-T', 'W-P', 'W-S2')), true);
  assert.equal(tooClose(db, slots('W-T', 'W-P', 'W-S'), slots('W-T9', 'W-P', 'W-S', ['W-BAG'])), true, 'a twin white tee plus a bag is the same look');
  assert.equal(tooClose(db, slots('W-T', 'W-P', 'W-S'), slots('W-T3', 'W-1', 'W-S2')), false);
  // A deleted look is remembered; «Підібрати» never brings it, or a near-copy, back.
  const look = await call('POST', '/api/looks', { capsuleId: 'C-1', name: 'Видалити', slots: slots('W-T', 'W-P', 'W-S') });
  await call('DELETE', `/api/looks/${look.id}`);
  db = store.read();
  assert.equal(db.lookMemory!.length, 1);
  const job = { id: 'J-an', kind: 'analyze' as const, lookVersion: 0, snapshot: { lookName: 'x', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  assert.match(analyzePrompt(db, job, []), /REJECTED[\s\S]*W-T/);
  await store.mutate((d) => {
    const id = applyAnalyze(d, job, { status: 'done', reason: '', name: 'Тест', description: '', looks: [
      { name: 'Знову', occasion: '', season: 'all', why: '', top: ['W-T'], layer: [], bottom: ['W-P'], shoes: ['W-S2'], accessories: [] },
      { name: 'Нове', occasion: '', season: 'all', why: '', top: ['W-T3'], layer: [], bottom: ['W-1'], shoes: ['W-S2'], accessories: [] },
    ] });
    assert.deepEqual(d.looks.filter((l) => l.capsuleId === id).map((l) => l.name), ['Нове']);
  });
  // A piece in two refused proposals and in no kept look is not built around again.
  await store.mutate((d) => {
    const s = (sid: string, top: string) => ({ id: sid, kind: 'look' as const, status: 'rejected' as const, name: sid, why: '', capsuleId: 'C-1', looks: [{ name: sid, why: '', slots: slots(top, 'W-2', 'W-S', ['W-BAG']) }], jobId: 'J-0', createdAt: at });
    d.suggestions = [s('A-1', 'W-T'), s('A-2', 'W-T3')];
  });
  db = store.read();
  assert.deepEqual([...refusedPieces(db, new Set())].sort(), ['W-2', 'W-BAG', 'W-S'], 'in both refused proposals and in no kept look');
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [], newCapsules: [], newNeeds: [], newLooks: [
    { name: 'Із сумкою', capsuleId: 'C-1', top: ['W-T9'], layer: [], bottom: ['W-1'], shoes: ['W-S2'], accessories: ['W-BAG'], why: '' },
  ] }));
  assert.equal(store.read().suggestions!.filter((s) => s.status === 'open').length, 0, 'never around a refused piece');
  // Honest scale: a look scored on the current scale is not re-scored; a look with a piece to buy is at most 8.
  await store.mutate((d) => {
    const l = d.looks[0];
    l.advice = { score: 7.2, why: 'x', version: l.version, scale: SCORE_SCALE };
  });
  db = store.read();
  assert.ok(!looksToScore(db).some((l) => l.id === 'L-1'));
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [{ id: 'L-1', score: 9.8, weakItem: '', swapTo: '', why: 'y' }], newLooks: [], newCapsules: [], newNeeds: [] }));
  assert.equal(store.read().looks[0].advice!.score, 7.2, 'a current score does not jump');
  await store.mutate((d) => void delete d.looks[0].advice!.scale);
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [{ id: 'L-1', score: 9.8, weakItem: '', swapTo: '', why: 'y' }], newLooks: [], newCapsules: [], newNeeds: [] }));
  assert.equal(store.read().looks[0].advice!.score, 8, 'an older-scale score is redone; to-buy looks stop at 8');
  assert.ok(itemsToRate(store.read()).some((i) => i.id === 'W-T'), 'unrated items are rated');
  assert.equal(validateDb(store.read()), null);
});

test('«Магазини»: one row per shop, a shop at the owner\'s place is known, one search fills the rest', async () => {
  const { store, call } = setup();
  await call('POST', '/api/products', { needId: 'N-1', store: 'Levi’s Poland', model: 'Tee', url: 'https://www.levi.com/PL/a' });
  await call('POST', '/api/products', { needId: 'N-1', store: 'Levi’s Polska', model: 'Tee 2', url: 'https://www.levi.com/PL/b' });
  await call('POST', '/api/products', { needId: 'N-1', store: 'Zara', model: 'Shirt', url: 'https://www.zara.com/hr/c' });
  await store.mutate((d) => {
    const p = d.products.find((x) => x.store === 'Zara')!;
    p.towerAvailability = 'confirmed';
  });
  let db = store.read();
  assert.equal(storeKey('Levi’s Poland'), storeKey('Levi’s Polska'));
  assert.deepEqual(storesToFind(db).map((s) => s.key), [storeKey('Levi’s Poland')], 'Zara is at the owner\'s place');
  assert.match(storeFindPrompt(db), /Use live web search/, 'the worker may search the web');
  assert.deepEqual(await call('POST', '/api/stores/find'), { queued: true });
  assert.deepEqual(await call('POST', '/api/stores/find'), { queued: false }, 'one search at a time');
  await store.mutate((d) => void applyStoreFind(d, { status: 'done', reason: '', stores: [{ key: storeKey('Levi’s Poland'), place: 'Galeria Krakowska, Kraków', km: 163.4, online: false, url: 'https://www.levi.com/PL/stores' }] }));
  db = store.read();
  assert.deepEqual(db.stores!.map((s) => [s.place, s.km]), [['Galeria Krakowska, Kraków', 163]]);
  assert.equal(storesToFind(db).length, 0);
  assert.equal(validateDb(db), null);
});

test('so-so pieces (honest score under 6 or «варто замінити») are not used in new looks or shown proposals', async () => {
  const { store } = setup();
  const item = (id: string, category: 'tees' | 'shoes', title: string, score: number) =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin: 'candidate' as const, history: [], createdAt: at, updatedAt: at, rating: { score, note: 'x', rev: 1, at, scale: SCORE_SCALE } });
  await store.mutate((d) => void d.items.push(item('W-WEAK', 'tees', 'Футболка з принтом', 4), item('W-OK', 'tees', 'Молочна футболка', 7), item('W-S', 'shoes', 'Білі кеди', 8), item('W-S2', 'shoes', 'Лофери', 7)));
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  await store.mutate((d) => void applyAdvice(d, advise, { status: 'done', reason: '', items: [], looks: [], newCapsules: [], newNeeds: [], newLooks: [
    { name: 'Зі слабкою', capsuleId: 'C-1', top: ['W-WEAK'], layer: [], bottom: ['W-2'], shoes: ['W-S'], accessories: [], why: '' },
    { name: 'Нормальна', capsuleId: 'C-1', top: ['W-OK'], layer: [], bottom: ['W-2'], shoes: ['W-S2'], accessories: [], why: '' },
  ] }));
  let db = store.read();
  assert.deepEqual(db.suggestions!.filter((s) => s.status === 'open').map((s) => s.name), ['Нормальна']);
  assert.match(advisePrompt(db, advise, []), /So-so pieces — never use them in new outfits: W-WEAK/);
  // A shown proposal hides once one of its pieces turns so-so.
  await store.mutate((d) => void (d.items.find((i) => i.id === 'W-OK')!.rating!.score = 5));
  db = store.read();
  assert.equal(openSuggestions(db).length, 0);
});

test('look detail reviews a newer try-on while the capsule keeps the approved picture', () => {
  const db = fixture();
  const look = db.looks[0];
  db.profile.basePhotoIds = ['P-1'];
  const make = (id: string, review: 'accepted' | 'pending', createdAt: string) => {
    const job = createJob(db, look, db.profile.basePhotoIds, '');
    db.results.push({ id, jobId: job.id, lookId: look.id, lookVersion: look.version, imagePath: `${id}.png`, tool: '', model: '', prompt: '', sources: [], usedItemPhotos: true, review, favorite: false, createdAt });
    return db.results.at(-1)!;
  };
  const pending = make('R-refresh', 'pending', '2026-11-24T12:02:00Z');
  const view = stateView(db);
  assert.deepEqual(view.jobs[0].snapshot.basePhotoIds, ['P-1']);
  assert.deepEqual(view.jobs[0].snapshot.basePhotoPaths, []);
  assert.deepEqual(view.jobs[0].snapshot.slots, []);
  assert.equal(coverForLook(view, look)?.id, pending.id);
  assert.equal(currentCover(view, look, true)?.id, pending.id);
  db.profile.basePhotoIds = ['P-2'];
  assert.equal(coverForLook(stateView(db), look), undefined);
  assert.equal(currentCover(stateView(db), look, true), undefined);
  db.profile.basePhotoIds = ['P-1'];
  const approved = make('R-approved', 'accepted', '2026-11-24T12:00:00Z');
  assert.equal(currentCover(db, look)?.id, approved.id);
  assert.equal(currentCover(db, look, true)?.id, pending.id);
  assert.equal(coverForLook(stateView(db), look)?.id, approved.id);
  assert.equal(currentCover(stateView(db), look, true)?.id, pending.id);
  db.profile.basePhotoIds = ['P-2'];
  assert.equal(currentCover(db, look, true)?.id, approved.id);
  assert.equal(currentCover(stateView(db), look, true)?.id, approved.id);
  db.profile.basePhotoIds = ['P-1'];
  pending.review = 'rework';
  assert.equal(currentCover(db, look, true)?.id, approved.id);
});

test('a fresh picture, «у приміщенні», today\'s looks and what a purchase gives (owner, 19.11)', async () => {
  const { store } = setup();
  const item = (id: string, category: 'tees' | 'shoes' | 'outerwear' | 'trousers', title: string) =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin: 'candidate' as const, history: [], createdAt: at, updatedAt: at });
  await store.mutate((d) => {
    d.items.push(item('W-T', 'tees', 'Молочна футболка'), item('W-S', 'shoes', 'Черевики'), item('W-C', 'outerwear', 'Пальто'), item('W-P', 'trousers', 'Вовняні штани'));
    d.capsules[0].periods = ['late-autumn', 'winter'];
    const l = d.looks[0];
    l.slots = { ...emptySlots(), top: [{ kind: 'item', id: 'W-T' }], bottom: [{ kind: 'item', id: 'W-P' }], shoes: [{ kind: 'item', id: 'W-S' }] };
    l.version = 2;
    l.versions.push({ version: 2, slots: l.slots, at });
    d.jobs.push({ id: 'J-x', lookId: 'L-1', resultId: 'R-old', lookVersion: 1, snapshot: { lookName: 'Look', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'done', origin: 'import', createdAt: at });
    d.results.push({ id: 'R-old', jobId: 'J-x', lookId: 'L-1', lookVersion: 1, imagePath: 'old.png', tool: 't', model: 'm', prompt: '', sources: [], usedItemPhotos: true, review: 'accepted', favorite: false, createdAt: at });
  });
  let db = store.read();
  // A try-on of the older pieces is not shown; «Ні» on «Речі змінено» brings it back.
  assert.equal(coverForLook(db, db.looks[0])?.id, 'R-old');
  assert.equal(currentCover(db, db.looks[0]), undefined);
  await store.mutate((d) => void (d.looks[0].keptVersion = 2));
  assert.equal(currentCover(store.read(), store.read().looks[0])?.id, 'R-old');
  // A cold-period look without any outer layer is for indoors.
  db = store.read();
  assert.equal(indoorOnly(db, db.looks[0]), true);
  await store.mutate((d) => void (d.looks[0].slots.layer = [{ kind: 'item', id: 'W-C' }]));
  assert.equal(indoorOnly(store.read(), store.read().looks[0]), false);
  // Today's looks: complete looks of the current period's capsules (November → late autumn).
  db = store.read();
  if (currentPeriod() === 'late-autumn' || currentPeriod() === 'winter') assert.deepEqual(todayLooks(db).map((l) => l.id), ['L-1']);
  // What a purchase gives: fits / completes / the rest of the smallest set.
  await store.mutate((d) => {
    d.needs.push({ id: 'N-2', rev: 1, title: 'Шарф', category: 'accessories', priority: 'optional', description: '', why: '', fitCheck: '', status: 'open', origin: 'owner', createdAt: at, updatedAt: at });
    d.looks[0].slots.top = [{ kind: 'need', id: 'N-1' }];
    d.looks[0].slots.accessories = [{ kind: 'need', id: 'N-2' }];
  });
  db = store.read();
  const plan = purchasePlan(db, 'N-1');
  assert.equal(plan.fits, 1);
  assert.equal(plan.completes, 0);
  assert.deepEqual(plan.with?.others, ['Шарф']);
});

test('«Нові»: a search gives cards in a capsule\'s style, may add up to two pieces to buy, passes the look memory; «Додати» makes the purchases', async () => {
  const { store, call } = setup();
  const item = (id: string, category: 'tees' | 'shoes' | 'trousers' | 'knitwear', title: string, score = 7) =>
    ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin: 'candidate' as const, history: [], createdAt: at, updatedAt: at, rating: { score, note: 'x', rev: 1, at, scale: SCORE_SCALE } });
  await store.mutate((d) => {
    d.items.push(item('W-K', 'knitwear', 'Бордовий джемпер'), item('W-P', 'trousers', 'Вовняні штани'), item('W-S', 'shoes', 'Черевики'), item('W-WEAK', 'tees', 'Футболка з принтом', 4));
    d.capsules[0].periods = ['late-autumn', 'winter'];
  });
  const job = await call('POST', '/api/discover', { prompt: 'пальто на прогулянку', capsuleId: 'C-1' });
  await assert.rejects(call('POST', '/api/discover', {}), /Пошук уже йде/);
  let db = store.read();
  assert.match(discoverPrompt(db, db.jobs.find((j) => j.id === job.id)!), /The owner asks: пальто на прогулянку[\s\S]*C-1 \| Urban/);
  const o = (name: string, top: string[], bottom: string[], shoes: string[], buy: { slot: string; title: string; category: string }[] = []) => ({ capsuleId: 'C-1', name, why: 'x', top, layer: [], bottom, shoes, accessories: [], buy });
  await store.mutate((d) => void applyDiscover(d, d.jobs.find((j) => j.id === job.id)!, { status: 'done', reason: '', looks: [
    o('Пальто й джемпер', ['W-K'], ['W-P'], ['W-S'], [{ slot: 'layer', title: 'Вовняне пальто кемел', category: 'outerwear' }]),
    o('Зі слабкою', ['W-WEAK'], ['W-P'], ['W-S']),
    o('Без низу', ['W-K'], [], ['W-S']),
    o('Не та категорія', ['W-K'], ['W-S'], ['W-S']),
    o('Майже те саме', ['W-K'], ['W-P'], ['W-S'], [{ slot: 'layer', title: 'Вовняне пальто кемел', category: 'outerwear' }, { slot: 'accessories', title: 'Шарф', category: 'accessories' }]),
    o('Покупка не в той слот', ['W-K'], ['W-P'], ['W-S'], [{ slot: 'shoes', title: 'Пальто', category: 'outerwear' }]),
  ] }));
  db = store.read();
  const open = db.suggestions!.filter((s) => s.status === 'open');
  assert.deepEqual(open.map((s) => s.name), ['Пальто й джемпер'], 'weak pieces, missing bottom, wrong slots and near-copies are dropped');
  assert.equal(open[0].source, 'search');
  assert.deepEqual(open[0].looks[0].buy, [{ slot: 'layer', title: 'Вовняне пальто кемел', category: 'outerwear' }]);
  // «Додати»: the piece to buy becomes a purchase and stands in the new look.
  const before = db.needs.length;
  const added = await call('POST', `/api/suggestions/${open[0].id}/accept`, {});
  db = store.read();
  const look = db.looks.find((l) => `/looks/${l.id}` === added.href)!;
  const need = db.needs.find((n) => n.title === 'Вовняне пальто кемел')!;
  assert.equal(db.needs.length, before + 1);
  assert.deepEqual(look.slots.layer, [{ kind: 'need', id: need.id }]);
  assert.equal(validateDb(db), null);
});

test('a piece to buy reuses an open purchase with nearly the same name', () => {
  assert.equal(sameTitle('Пряме вовняне пальто кольору кемел', 'Вовняне пальто кольору кемел'), true);
  assert.equal(sameTitle('Темно-коричневі челсі із зернистої шкіри', 'Шкіряні черевики челсі'), false);
  assert.equal(sameTitle('Прямі лляні штани кольору екрю', 'Бежеві / пісочні чіноси'), false);
});

// ── Capsule as a closed set of 10 garments (owner, 20.11; spec 2026-11-20-capsule-system-design.md, stage 1) ──

test('capsule combinations follow (tops × bottoms + dresses) × (layers + 1) × shoes', () => {
  assert.equal(capsuleCombinations({ top: 4, bottom: 3, layer: 2, shoes: 2 }), 72);
  assert.equal(capsuleCombinations({ top: 3, bottom: 3, layer: 0, shoes: 3 }), 27);
  assert.equal(capsuleCombinations({ top: 2, bottom: 1, layer: 0, shoes: 1, dresses: 2 }), 4);
  assert.equal(capsuleCombinations({ top: 5, bottom: 2, layer: 1, shoes: 0 }), 0);
});

test('an unsaved capsule set is read from its visible looks; roles come from the slots, a product stands for its purchase', () => {
  const db = fixture();
  db.items.push({ id: 'W-3', rev: 1, category: 'shoes', title: 'White sneakers', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
  db.items.push({ id: 'W-4', rev: 1, category: 'knitwear', title: 'Navy cardigan', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
  db.products.push({ id: 'PR-1', needId: 'N-1', store: 'Shop', brand: 'B', model: 'Tee', url: 'https://example.test/tee', status: 'option', createdAt: at, updatedAt: at } as DB['products'][number]);
  const slots = { ...emptySlots(), top: [{ kind: 'product' as const, id: 'PR-1' }], layer: [{ kind: 'item' as const, id: 'W-4' }], bottom: [{ kind: 'item' as const, id: 'W-1' }], shoes: [{ kind: 'item' as const, id: 'W-3' }] };
  db.looks.push({ ...db.looks[0], id: 'L-2', slots, versions: [{ version: 1, slots, at }] });
  db.capsules[0].lookIds.push('L-2');
  const set = capsuleSet(db, db.capsules[0]);
  assert.equal(set.saved, false);
  assert.deepEqual(set.counts, { garments: 3, shoes: 1, accessories: 0 });
  assert.deepEqual(set.pieces.map((p) => `${p.ref.kind}:${p.ref.id}`).sort(), ['item:W-1', 'item:W-3', 'item:W-4', 'need:N-1']);
  const byId = Object.fromEntries(set.pieces.map((p) => [p.ref.id, p]));
  assert.equal(byId['W-4'].role, 'layer');
  assert.equal(byId['N-1'].role, 'top');
  assert.equal(byId['N-1'].looks, 2, 'the purchase counts in the look with its product too');
  assert.equal(byId['N-1'].owned, false);
  assert.equal(set.combinations, 1 * 1 * 2 * 1);
  const later = structuredClone(db); // hidden looks are cached per looks array, as each store read is a fresh copy
  later.looks[1].disliked = true;
  assert.equal(capsuleSet(later, later.capsules[0]).counts.garments, 2, 'a hidden look is history, not part of the set');
});

test('a look can explicitly add its chosen piece to the set in the same revision-guarded operation', async () => {
  const { store, call } = setup();
  const ref = (id: string) => ({ kind: 'item' as const, id });
  await call('PATCH', '/api/capsules/C-1', { pieces: [ref('W-1'), { kind: 'need', id: 'N-1' }] });
  const before = store.read();
  const look = before.looks[0];
  const capsule = before.capsules[0];
  const slots = { ...look.slots, bottom: [...look.slots.bottom, ref('W-2')] };
  await assert.rejects(call('PATCH', '/api/looks/L-1', { rev: look.rev, slots, capsuleRev: capsule.rev - 1 }), (err: HttpError) => err.status === 409);
  assert.deepEqual(store.read().looks[0], look);
  await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots, capsuleRev: capsule.rev });
  const added = store.read();
  assert.deepEqual(added.looks[0].slots.bottom, slots.bottom);
  assert.deepEqual(added.capsules[0].pieces?.at(-1), ref('W-2'));
  assert.ok(added.jobs.some((job) => job.lookId === look.id && job.lookVersion === added.looks[0].version && job.snapshot.slots.some((slot) => slot.id === 'W-2')));
  await store.mutate((db) => {
    const fillers = Array.from({ length: CAPSULE_LIMITS.garments - 3 }, (_, index) => ({ ...db.items[0], id: `W-filler-${index}` }));
    db.items.push(...fillers, { ...db.items[0], id: 'W-outside' });
    db.capsules[0].pieces!.push(...fillers.map((item) => ref(item.id)));
  });
  const full = store.read();
  const request = { rev: full.looks[0].rev, capsuleRev: full.capsules[0].rev, slots: { ...slots, bottom: [...slots.bottom, ref('W-outside')] } };
  await assert.rejects(call('PATCH', '/api/looks/L-1', request), (err: HttpError) => err.status === 422);
  await assert.rejects(call('PATCH', '/api/looks/L-1', { ...request, replaceCapsulePiece: 'item:W-1' }), (err: HttpError) => err.status === 409);
  assert.deepEqual(store.read().capsules[0], full.capsules[0]);
  assert.deepEqual(store.read().looks[0], full.looks[0]);
  await call('PATCH', '/api/looks/L-1', { ...request, replaceCapsulePiece: 'item:W-filler-0' });
  assert.deepEqual(store.read().looks[0].slots, request.slots);
  assert.equal(store.read().capsules[0].pieces?.length, CAPSULE_LIMITS.garments);
  assert.deepEqual(store.read().capsules[0].pieces?.at(-1), ref('W-outside'));
});

test('a saved set keeps its limits, its base and its looks: nothing outside the set enters the capsule', async () => {
  const { call, store } = setup();
  await store.mutate((db) => {
    for (let i = 0; i < 11; i++) db.items.push({ id: `G-${i}`, rev: 1, category: 'tees', title: `Tee ${i}`, status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
  });
  const ten = Array.from({ length: 9 }, (_, i) => ({ kind: 'item', id: `G-${i}` }));
  await assert.rejects(call('PATCH', '/api/capsules/C-1', { pieces: [...ten, { kind: 'item', id: 'G-9' }, { kind: 'item', id: 'G-10' }, { kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }] }), /до 10 речей одягу/);
  await assert.rejects(call('PATCH', '/api/capsules/C-1', { pieces: [{ kind: 'item', id: 'W-1' }] }), /Образів поза набором: 1 \(Молочна футболка\)/, 'a visible look still uses a piece left out');
  await assert.rejects(call('PATCH', '/api/capsules/C-1', { pieces: [{ kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }], base: [{ kind: 'item', id: 'W-2' }] }), /База капсули має бути з її набору/);
  const saved = await call('PATCH', '/api/capsules/C-1', { pieces: [{ kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }, { kind: 'item', id: 'G-0' }], base: [{ kind: 'item', id: 'W-1' }] });
  assert.deepEqual(saved.base, [{ kind: 'item', id: 'W-1' }]);
  assert.equal(capsuleSet(store.read(), store.read().capsules[0]).saved, true);
  // Looks: a piece outside the set is refused in edits and new looks; a piece inside passes.
  const look = store.read().looks[0];
  await assert.rejects(call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [{ kind: 'item', id: 'G-5' }] } }), /Поза набором капсули «Urban»: Tee 5/);
  const edited = await call('PATCH', '/api/looks/L-1', { rev: look.rev, slots: { ...look.slots, top: [{ kind: 'item', id: 'G-0' }] } });
  assert.equal(edited.version, 2);
  await assert.rejects(call('POST', '/api/looks', { capsuleId: 'C-1', name: 'New', slots: { ...emptySlots(), top: [{ kind: 'item', id: 'G-7' }] } }), /Поза набором/);
  assert.equal(store.read().looks.length, 1, 'a refused look is not saved');
  // Saving keeps the base inside the set; null clears set and base.
  const trimmed = await call('PATCH', '/api/capsules/C-1', { pieces: [{ kind: 'item', id: 'G-0' }, { kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }] });
  assert.deepEqual(trimmed.base, [{ kind: 'item', id: 'W-1' }]);
  const cleared = await call('PATCH', '/api/capsules/C-1', { pieces: null });
  assert.equal(cleared.pieces, undefined);
  assert.equal(cleared.base, undefined);
});

test('capsule sets follow merges and deletions, and the stored set is validated', async () => {
  const { call, store } = setup();
  await call('PATCH', '/api/capsules/C-1', { pieces: [{ kind: 'item', id: 'W-1' }, { kind: 'item', id: 'W-2' }, { kind: 'need', id: 'N-1' }], base: [{ kind: 'item', id: 'W-2' }] });
  await call('DELETE', '/api/items/W-2');
  let c = store.read().capsules[0];
  assert.deepEqual(c.pieces, [{ kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }]);
  assert.equal(c.base, undefined, 'the base left with the deleted piece');
  await store.mutate((db) => {
    db.items.push({ id: 'W-5', rev: 1, category: 'trousers', title: 'Navy chinos (photo 2)', status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
  });
  const merged = await call('POST', '/api/items/merge', { ids: ['W-1', 'W-5'] });
  c = store.read().capsules[0];
  assert.deepEqual(c.pieces, [{ kind: 'item', id: merged.id }, { kind: 'need', id: 'N-1' }]);
  assert.ok(store.read().looks[0].slots.bottom.some((r) => r.id === merged.id), 'the look and the set name the same merged piece');
  const db = fixture();
  db.capsules[0].base = [{ kind: 'item', id: 'W-1' }];
  assert.match(validateDb(db) ?? '', /база без набору/);
  db.capsules[0].pieces = [{ kind: 'product', id: 'PR-x' }];
  assert.match(validateDb(db) ?? '', /лише речі й покупки/);
  db.capsules[0].pieces = [{ kind: 'item', id: 'W-1' }, { kind: 'item', id: 'W-1' }];
  delete db.capsules[0].base;
  assert.match(validateDb(db) ?? '', /повторюється/);
});

test('the capsule sets report reads every fashion capsule, flags limits and never writes', () => {
  const db = fixture();
  for (let i = 0; i < 4; i++) db.items.push({ id: `A-${i}`, rev: 1, category: 'accessories', title: `Belt ${i}`, status: 'confirmed', photoIds: [], origin: 'manual', history: [], createdAt: at, updatedAt: at });
  db.looks[0].slots.accessories = [0, 1, 2, 3].map((i) => ({ kind: 'item' as const, id: `A-${i}` }));
  db.capsules.push({ ...db.capsules[0], id: 'C-sel', kind: 'selection', name: 'Selection', lookIds: [] });
  const before = JSON.stringify(db);
  const report = capsuleSetsReport(db);
  assert.equal(JSON.stringify(db), before);
  assert.deepEqual(report.capsules.map((c) => c.name), ['Urban'], 'selections are not fashion capsules');
  assert.deepEqual(report.capsules[0].over, ['accessories']);
  assert.equal(report.capsules[0].limits.garments, CAPSULE_LIMITS.garments);
  assert.equal(report.capsules[0].toBuy, 1);
});

// ── Stage 3: the next purchase, «Нові» and the advisor follow the closed sets (owner, 20.11) ──

const owned = (id: string, category: DB['items'][number]['category'], title: string) =>
  ({ id, rev: 1, category, title, status: 'confirmed' as const, photoIds: [], origin: 'manual' as const, history: [], createdAt: at, updatedAt: at, rating: { score: 7, note: 'x', rev: 1, at, scale: SCORE_SCALE } });

test('picked boots restrict discovery to capsules that can use them, even in another period', async () => {
  const { store, call, drained } = setup();
  const boots = { kind: 'item' as const, id: 'W-B' };
  await store.mutate((db) => {
    db.items.push(owned(boots.id, 'shoes', 'Winter boots'));
    db.capsules[0].pieces = Object.values(db.looks[0].slots).flat();
    db.capsules[0].periods = ['late-autumn'];
  });
  await assert.rejects(call('POST', '/api/discover', { itemIds: [boots.id] }), /Жодна капсула не містить/);
  assert.equal(store.read().jobs.length, 0);
  assert.equal(drained(), 0);
  await store.mutate((db) => {
    db.capsules.push({ ...db.capsules[0], id: 'C-WINTER', name: 'Winter outdoor', lookIds: [], periods: ['winter'], pieces: [boots] });
  });
  await assert.rejects(call('POST', '/api/discover', { capsuleId: 'C-1', itemIds: [boots.id] }), /У наборі цієї капсули бракує/);
  await assert.rejects(call('POST', '/api/discover', { itemIds: [boots.id, 'W-1'] }), /Жодна капсула не містить/, 'all picked pieces must fit the same capsule');
  const job = await call('POST', '/api/discover', { itemIds: [boots.id] });
  const db = store.read();
  const prompt = discoverPrompt(db, job);
  assert.match(prompt, /C-WINTER \| Winter outdoor/);
  assert.doesNotMatch(prompt, /C-1 \| Urban/);
  assert.match(prompt, /A capsule for another period is valid/);
  assert.equal(drained(), 1);
  db.capsules[1].pieces = [];
  assert.throws(() => discoverPrompt(db, job), /Жодна капсула не містить/, 'a queued job also checks the current capsule sets');
});

test('the next purchase is one of a capsule set; on an equal score the one adding more combinations comes first', () => {
  const db = fixture();
  db.items[0].status = 'confirmed';
  db.items.push(owned('W-3', 'shoes', 'Sneakers'), owned('W-4', 'tees', 'Tee'));
  db.needs.push({ ...db.needs[0], id: 'N-2', title: 'Сорочка', category: 'shirts' }, { ...db.needs[0], id: 'N-3', title: 'Шорти поза набором', category: 'shorts' });
  db.looks[0].slots.shoes = [{ kind: 'item', id: 'W-3' }];
  db.capsules[0].pieces = [{ kind: 'item', id: 'W-1' }, { kind: 'item', id: 'W-3' }, { kind: 'item', id: 'W-4' }, { kind: 'need', id: 'N-1' }, { kind: 'need', id: 'N-2' }];
  const gains = combinationGains(db);
  assert.equal(gains.get('N-1'), 1, 'one more top with one bottom and one pair of shoes: one more combination');
  assert.equal(gains.get('N-3'), undefined);
  const ranking = purchaseRanking(db);
  assert.equal(ranking[0].need.id, 'N-1', 'the purchase that completes a look comes first');
  assert.deepEqual(ranking.map((r) => r.inSet), [true, true, false], 'a purchase outside every set comes last');
});

test('«Нові» for a closed set: only its pieces, new purchases into free places or replacing a named piece; «Додати» updates the set and its looks', async () => {
  const { store, call } = setup();
  await store.mutate((d) => {
    d.items.push(owned('W-K', 'knitwear', 'Бордовий джемпер'), owned('W-P', 'trousers', 'Вовняні штани'), owned('W-P2', 'trousers', 'Чіноси'), owned('W-S', 'shoes', 'Черевики'), owned('W-OUT', 'tees', 'Футболка поза набором'));
    for (let i = 0; i < 7; i++) d.items.push(owned(`G-${i}`, 'tees', `Tee ${i}`));
    d.looks[0].slots = { ...emptySlots(), top: [{ kind: 'item', id: 'W-K' }], bottom: [{ kind: 'item', id: 'W-P' }], shoes: [{ kind: 'item', id: 'W-S' }] };
    d.capsules[0].pieces = [{ kind: 'item', id: 'W-K' }, { kind: 'item', id: 'W-P' }, { kind: 'item', id: 'W-P2' }, { kind: 'item', id: 'W-S' }, ...Array.from({ length: 7 }, (_, i) => ({ kind: 'item' as const, id: `G-${i}` }))];
  });
  assert.equal(validateDb(store.read()), null, 'ten garments: the set is full');
  const job = await call('POST', '/api/discover', { capsuleId: 'C-1' });
  let db = store.read();
  assert.match(discoverPrompt(db, db.jobs.find((j) => j.id === job.id)!), /C-1 set — owned: W-K, W-P, W-P2, W-S[\s\S]*free places: garments 0, shoes 2, accessories 3/);
  const o = (name: string, top: string[], bottom: string[], buy: { slot: string; title: string; category: string; replaces: string }[] = []) => ({ capsuleId: 'C-1', name, why: 'x', top, layer: [], bottom, shoes: ['W-S'], accessories: [], buy });
  await store.mutate((d) => void applyDiscover(d, d.jobs.find((j) => j.id === job.id)!, { status: 'done', reason: '', looks: [
    o('Річ поза набором', ['W-OUT'], ['W-P']),
    o('Нова покупка без місця', ['G-1'], [], [{ slot: 'bottom', title: 'Лляні штани', category: 'trousers', replaces: '' }]),
    o('Пальто замість футболки', ['G-2'], ['W-P'], [{ slot: 'layer', title: 'Вовняне пальто кемел', category: 'outerwear', replaces: 'item:G-0' }]),
    o('Замінює річ, яка в образі', ['G-3'], ['W-P'], [{ slot: 'layer', title: 'Куртка', category: 'outerwear', replaces: 'item:G-3' }]),
    o('Ремінь на вільне місце', ['G-4'], ['W-P2'], [{ slot: 'accessories', title: 'Плетений ремінь', category: 'accessories', replaces: '' }]),
  ] }));
  db = store.read();
  const open = db.suggestions!.filter((s) => s.status === 'open');
  assert.deepEqual(open.map((s) => s.name), ['Пальто замість футболки', 'Ремінь на вільне місце']);
  assert.deepEqual(open[0].looks[0].buy, [{ slot: 'layer', title: 'Вовняне пальто кемел', category: 'outerwear', replaces: 'item:G-0' }]);
  // A look using the replaced piece gets the purchase in its place.
  await store.mutate((d) => {
    const slots = { ...emptySlots(), top: [{ kind: 'item' as const, id: 'G-0' }], bottom: [{ kind: 'item' as const, id: 'W-P' }], shoes: [{ kind: 'item' as const, id: 'W-S' }] };
    d.looks.push({ ...d.looks[0], id: 'L-G0', name: 'Tee look', slots, versions: [{ version: 1, slots, at }] });
    d.capsules[0].lookIds.push('L-G0');
  });
  await call('POST', `/api/suggestions/${open[0].id}/accept`, {});
  db = store.read();
  const coat = db.needs.find((n) => n.title === 'Вовняне пальто кемел')!;
  const c = db.capsules[0];
  assert.ok(c.pieces!.some((r) => r.kind === 'need' && r.id === coat.id) && !c.pieces!.some((r) => r.id === 'G-0'), 'the coat took the tee\'s place in the set');
  const teeLook = db.looks.find((l) => l.id === 'L-G0')!;
  assert.deepEqual(teeLook.slots.top, [{ kind: 'need', id: coat.id }]);
  assert.equal(teeLook.version, 2);
  await call('POST', `/api/suggestions/${open[1].id}/accept`, {});
  db = store.read();
  assert.ok(db.capsules[0].pieces!.some((r) => r.kind === 'need' && db.needs.find((n) => n.id === r.id)?.title === 'Плетений ремінь'), 'the belt filled a free place');
  assert.equal(validateDb(db), null);
});

test('the advisor keeps new looks, swaps and capsule purchases inside a closed set; stale proposals outside it are hidden', async () => {
  const { store } = setup();
  await store.mutate((d) => {
    d.items[0].status = 'confirmed';
    d.items.push(owned('W-T', 'tees', 'Tee in set'), owned('W-X', 'tees', 'Tee outside'), owned('W-S', 'shoes', 'Shoes'));
    d.looks[0].slots = { ...emptySlots(), top: [{ kind: 'item', id: 'W-T' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] };
    for (let i = 0; i < 2; i++) d.items.push(owned(`SH-${i}`, 'shoes', `Shoes ${i}`));
    d.capsules[0].pieces = (['W-T', 'W-1', 'W-S', 'SH-0', 'SH-1'] as const).map((id) => ({ kind: 'item' as const, id }));
    d.suggestions = [{ id: 'A-old', kind: 'look', status: 'open', name: 'Old', why: '', capsuleId: 'C-1', looks: [{ name: 'Old', why: '', slots: { ...emptySlots(), top: [{ kind: 'item', id: 'W-X' }], bottom: [{ kind: 'item', id: 'W-1' }], shoes: [{ kind: 'item', id: 'W-S' }] } }], jobId: 'J-x', createdAt: at }];
  });
  assert.equal(openSuggestions(store.read()).length, 0, 'a proposal with a piece outside the set is not shown');
  const advise = { id: 'J-adv', kind: 'advise' as const, lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'running' as const, origin: 'site' as const, createdAt: at };
  const db0 = store.read();
  assert.match(advisePrompt(db0, advise as never, []), /C-1 set: item:W-T \(top/);
  await store.mutate((d) => void applyAdvice(d, advise as never, {
    status: 'done', reason: '', items: [],
    looks: [{ id: 'L-1', score: 7, weakItem: 'W-T', swapTo: 'W-X', why: 'x' }],
    newLooks: [{ capsuleId: 'C-1', name: 'Outside', why: 'x', top: ['W-X'], layer: [], bottom: ['W-1'], shoes: ['SH-0'], accessories: [] }],
    newCapsules: [],
    newNeeds: [{ capsuleId: 'C-1', title: 'Ще одні кеди', category: 'shoes', why: 'x' }, { capsuleId: 'C-1', title: 'Ремінь', category: 'accessories', why: 'x' }],
  }));
  const db = store.read();
  assert.equal(db.looks[0].advice?.swap, undefined, 'a swap to a piece outside the set is not offered');
  assert.ok(!db.suggestions!.some((s) => s.name === 'Outside'), 'a new look outside the set is dropped');
  assert.ok(!db.needs.some((n) => n.title === 'Ще одні кеди'), 'no free place for shoes: no purchase');
  assert.ok(db.needs.some((n) => n.title === 'Ремінь' && n.forCapsule === 'C-1'), 'a free accessory place takes a purchase');
});

test('a proposal is shown only while its purchases fit the closed set: planned, replacing a piece, or into a free place', () => {
  const db = fixture();
  db.items[0].status = 'confirmed';
  db.items.push(owned('W-S', 'shoes', 'Shoes'), owned('SH-1', 'shoes', 'Shoes 1'), owned('SH-2', 'shoes', 'Shoes 2'));
  db.capsules[0].pieces = [{ kind: 'item', id: 'W-1' }, { kind: 'need', id: 'N-1' }, { kind: 'item', id: 'W-S' }, { kind: 'item', id: 'SH-1' }, { kind: 'item', id: 'SH-2' }];
  const slots = { ...emptySlots(), bottom: [{ kind: 'item' as const, id: 'W-1' }], shoes: [{ kind: 'item' as const, id: 'W-S' }] };
  const card = (id: string, buy: NonNullable<DB['suggestions']>[number]['looks'][number]['buy']) => ({ id, kind: 'look' as const, status: 'open' as const, name: id, why: '', capsuleId: 'C-1', looks: [{ name: id, why: '', slots, buy }], jobId: 'J', createdAt: at });
  db.suggestions = [
    card('planned', [{ slot: 'top', title: 'Молочна футболка', category: 'tees' }]),
    card('no-place', [{ slot: 'top', title: 'Футболка', category: 'tees' }, { slot: 'shoes', title: 'Челсі', category: 'shoes' }]),
    card('replaces', [{ slot: 'shoes', title: 'Челсі', category: 'shoes', replaces: 'item:SH-2' }]),
    card('free', [{ slot: 'accessories', title: 'Ремінь', category: 'accessories' }]),
  ];
  assert.deepEqual(openSuggestions(db).map((s) => s.id).sort(), ['free', 'planned', 'replaces']);
});

// ── Production stage 1: accounts and per-account wardrobes ──

test('automatic try-ons are queued only for the local and owner tenants', async (t) => {
  const { createTenants, emptyDb } = await import('./tenants.ts');
  const { createUsage, quotaConfigFromEnv, quotaKind } = await import('./quota.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-auto-tryon-'));
  const usage = createUsage(path.join(dir, 'usage.sqlite'));
  const engine = {
    label: 'test', imageLabel: 'test',
    json: async ({ schema }: { schema: object }) => ({ reply: schema === ANALYZE_SCHEMA ? {
      name: 'Selection', looks: [{ name: 'Analyzed look', top: ['W-T'], bottom: ['W-1'], shoes: ['W-S'] }],
    } : {} }),
    image: async () => ({ ok: false, err: 'Test engine does not render' }),
  };
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, engine, quota: { cfg: quotaConfigFromEnv({}), usage } });
  t.after(() => {
    tenants.stopAll();
    usage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cases = [
    { name: 'local', tenant: tenants.local(), auto: true },
    { name: 'owner', tenant: tenants.forUser('owner-account', true), auto: true },
    { name: 'invited', tenant: tenants.forUser('invited-account'), auto: false },
    { name: 'test', tenant: tenants.forUser('test-account', false, true), auto: false },
  ];
  for (const { name, tenant, auto } of cases) {
    await t.test(name, async () => {
      const { store, ctx, runner } = tenant;
      assert.equal(ctx.autoTryOn, auto);
      const call = (url: string, body: Record<string, unknown> = {}) => dispatch({ ...ctx, drain: () => {} }, 'POST', url, body);
      const tryons = () => store.read().jobs.filter((job) => quotaKind(job) === 'tryon');
      const manualSlots = { ...emptySlots(), top: [{ kind: 'item' as const, id: 'W-T' }] };
      const suggestedSlots = { ...emptySlots(), layer: [{ kind: 'item' as const, id: 'W-J' }], bottom: [{ kind: 'item' as const, id: 'W-1' }] };
      await store.mutate((db) => {
        db.photos = fixture().photos;
        db.profile.basePhotoIds = ['P-2'];
        db.items.push(owned('W-T', 'tees', 'Tee'), owned('W-1', 'trousers', 'Chinos'), owned('W-S', 'shoes', 'Sneakers'), owned('W-J', 'outerwear', 'Jacket'));
        for (const item of db.items) item.photoIds = ['P-1'];
        db.capsules.push({ ...fixture().capsules[0], lookIds: [] });
        db.suggestions = [{ id: 'S-1', kind: 'look', status: 'open', name: 'Proposed', why: '', capsuleId: 'C-1', looks: [{ name: 'Proposed', why: '', slots: suggestedSlots }], jobId: 'J-proposal', createdAt: at }];
      });
      const manual = await call('/api/looks', { capsuleId: 'C-1', name: 'Manual', slots: manualSlots }) as DB['looks'][number];
      assert.deepEqual(tryons().map((job) => job.lookId), auto ? [manual.id] : []);
      const accepted = await call('/api/suggestions/S-1/accept') as { href: string };
      const proposedId = accepted.href.split('/').at(-1);
      assert.deepEqual(tryons().map((job) => job.lookId), auto ? [manual.id, proposedId] : []);
      assert.ok(tryons().every((job) => job.state === 'queued'));

      await call('/api/analyze');
      await runner.drain();
      const selection = store.read().capsules.find((c) => c.kind === 'selection');
      assert.ok(selection);
      assert.equal(selection.lookIds.length, 1);
      assert.deepEqual(tryons().map((job) => job.lookId), auto ? [manual.id, proposedId, selection.lookIds[0]] : []);
      if (!auto) {
        assert.deepEqual(tenant.quota!.status(store.read()).kinds.tryon, { used: 0, limit: 10 });
        await call('/api/jobs', { lookId: manual.id });
        assert.deepEqual(tryons().map((job) => job.state), ['queued']);
      }
    });
  }
});

test('creating a look wakes the queue only when its try-on survives quota trimming', async () => {
  const { accountQuota, createUsage, meteredStore, quotaConfigFromEnv } = await import('./quota.ts');
  const { dir, store } = setup();
  const usage = createUsage(path.join(dir, 'usage.sqlite'));
  try {
    const quota = accountQuota(quotaConfigFromEnv({ QUOTA_TRYON_QUEUE: '1' }), usage, 'test-account', false);
    let drains = 0;
    const ctx = { store: meteredStore(store, quota), projectRoot: dir, admit: () => {}, drain: () => void drains++ };
    await store.mutate((db) => {
      db.items[1].photoIds = ['P-1'];
      db.profile.basePhotoIds = ['P-2'];
    });
    const create = (id: string) => dispatch(ctx, 'POST', '/api/looks', { capsuleId: 'C-1', slots: { bottom: [{ kind: 'item', id }] } }) as Promise<DB['looks'][number]>;
    const first = await create('W-1');
    assert.equal(drains, 1);
    assert.equal((await create('W-1')).id, first.id);
    const second = await create('W-2');
    const db = store.read();
    assert.ok(db.looks.some((look) => look.id === second.id));
    assert.deepEqual(db.jobs.map((job) => [job.lookId, job.state]), [[first.id, 'queued']]);
    assert.equal(drains, 1, 'neither the duplicate nor the trimmed try-on wakes the runner');
  } finally {
    usage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every account gets its own empty, valid wardrobe folder; deleting the account removes it and stops its queue', async () => {
  const { createTenants, emptyDb } = await import('./tenants.ts');
  assert.equal(validateDb(emptyDb()), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-tenants-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb });
  const a = tenants.forUser('user-aaaaaa');
  const b = tenants.forUser('user-bbbbbb');
  await a.store.mutate((d) => void d.needs.push({ id: 'N-a', rev: 1, title: 'Only A', category: 'tees', priority: 'core', description: '', why: '', fitCheck: '', status: 'open', origin: 'owner', createdAt: at, updatedAt: at }));
  assert.equal(a.store.read().needs.length, 1);
  assert.equal(b.store.read().needs.length, 0, 'accounts never share data');
  assert.equal(a.root, path.join(dir, 'users', 'user-aaaaaa'));
  assert.equal(tenants.forUser('user-aaaaaa'), a, 'an open account is reused');
  assert.throws(() => tenants.forUser('../escape'), /Unsafe account id/);
  tenants.remove('user-aaaaaa');
  assert.equal(fs.existsSync(path.join(dir, 'users', 'user-aaaaaa')), false);
  assert.equal(tenants.forUser('user-aaaaaa').store.read().needs.length, 0, 'a new sign-up after deletion starts empty');
  b.runner.stop();
  tenants.forUser('user-aaaaaa').runner.stop();
});

test('the shared job limiter runs at most N jobs at once across queues', async () => {
  const { createLimiter } = await import('./runner.ts');
  const limiter = createLimiter(2);
  let running = 0, peak = 0;
  const job = () => limiter.run(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

test('accounts: config needs both Google keys and a strong secret in production; invites are single-use and expire', async () => {
  const { authConfigFromEnv, createAuth } = await import('./auth.ts');
  assert.equal(authConfigFromEnv({}, '/tmp'), null, 'no Google keys: the local single-user site');
  assert.throws(() => authConfigFromEnv({ GOOGLE_CLIENT_ID: 'x' }, '/tmp'), /both/);
  assert.throws(() => authConfigFromEnv({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', NODE_ENV: 'production' }, '/tmp'), /BETTER_AUTH_SECRET/);
  const cfg = authConfigFromEnv({ GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'y', OWNER_EMAIL: 'Owner@Example.test', BETTER_AUTH_URL: 'https://capsula.example/path' }, fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-auth-')))!;
  assert.equal(cfg.baseURL, 'https://capsula.example');
  assert.equal(cfg.ownerEmail, 'owner@example.test');
  assert.equal(cfg.openSignup, false);
  const auth = await createAuth({ ...cfg, secret: 'k'.repeat(48) });
  const invite = auth.invites.create();
  assert.ok(auth.validInvite(invite.code));
  assert.equal(auth.validInvite('unknown'), null);
  auth.invites.disable(invite.code);
  assert.equal(auth.validInvite(invite.code), null, 'a cancelled invite no longer admits anyone');
  assert.equal(await auth.userOf({ headers: {} } as never), null);
  auth.close();
});

test('owner-only accounts: only the owner signs up, invites admit no one, and other accounts get no AI', async () => {
  const { authConfigFromEnv, createAuth, mayCreateAccount } = await import('./auth.ts');
  const { createTenants, emptyDb, AI_OWNER_ONLY } = await import('./tenants.ts');
  assert.equal(mayCreateAccount({ owner: true, ownerOnly: true, openSignup: false, validInvite: false }), true);
  assert.equal(mayCreateAccount({ owner: false, ownerOnly: true, openSignup: true, validInvite: true }), false, 'neither open sign-up nor an invite admits anyone else');
  assert.equal(mayCreateAccount({ owner: false, openSignup: false, validInvite: true }), true);
  assert.equal(mayCreateAccount({ owner: false, openSignup: false, validInvite: false }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-owner-only-'));
  const cfg = authConfigFromEnv({ GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'y', OWNER_EMAIL: 'owner@example.test' }, dir)!;
  const auth = await createAuth({ ...cfg, secret: 'k'.repeat(48), ownerOnly: true });
  assert.equal(auth.validInvite(auth.invites.create().code), null, 'an invite link opens nothing');
  auth.close();
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false', aiOwnerOnly: true });
  const guest = tenants.forUser('user-gggggg');
  assert.throws(() => guest.ctx.admit!('tryon'), (e: { status?: number; message: string }) => e.status === 403 && e.message === AI_OWNER_ONLY);
  const owner = tenants.forUser('owner-oooooo', true);
  assert.equal(owner.ctx.admit, undefined, "the owner's AI is not gated");
  guest.runner.stop();
  owner.runner.stop();
});

test('private alias: Google returns to the registered address, which relays the browser to the alias once', async () => {
  const { authConfigFromEnv, callbackRelay, RELAY_MARK } = await import('./auth.ts');
  const env = { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'y', BETTER_AUTH_URL: 'https://capsula.home.arpa', GOOGLE_REDIRECT_URI: 'https://stage.capsula.example/api/auth/callback/google', BETTER_AUTH_TRUSTED_ORIGINS: 'https://stage.capsula.example/, https://other.example' };
  const cfg = authConfigFromEnv(env, '/tmp')!;
  assert.deepEqual(cfg.trustedOrigins, ['https://stage.capsula.example', 'https://other.example']);
  assert.throws(() => authConfigFromEnv({ ...env, GOOGLE_REDIRECT_URI: 'http://stage.capsula.example/cb' }, '/tmp'), /GOOGLE_REDIRECT_URI/);
  const back = new URL('https://stage.capsula.example/api/auth/callback/google?code=c1&state=s1');
  const relay = callbackRelay(cfg, back)!;
  assert.equal(relay, `https://capsula.home.arpa/api/auth/callback/google?code=c1&state=s1&${RELAY_MARK}=1`, 'code and state go to the alias, where the state cookie is');
  assert.equal(callbackRelay(cfg, new URL(relay)), null, 'a relayed callback is handled, not relayed again (the gateway presents the registered host)');
  assert.equal(callbackRelay(cfg, new URL('https://stage.capsula.example/api/auth/get-session')), null, 'only the callback is relayed');
  assert.equal(callbackRelay({ baseURL: 'https://capsula.fit' }, new URL('https://capsula.fit/api/auth/callback/google?code=c')), null, 'no relay without a separate registered address');
});

test("Codex without commands (servers): shell tools off, read-only, the app collects the image from Codex's folder, no server secrets", async () => {
  const { dir, store, call } = setup();
  const home = path.join(dir, 'codex-home');
  const thread = '01a1fca0-193a-7bd3-8911-8e8103738880';
  const fake = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(path.join(dir, 'fixture.png'), SAMPLE_PNG);
  fs.writeFileSync(
    fake,
    `#!/bin/sh\necho "$@" >> "${dir}/args.txt"\nenv > "${dir}/env.txt"\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift;; esac; shift; done\ncat >> "${dir}/stdin.txt"\necho '{"type":"thread.started","thread_id":"${thread}"}'\nmkdir -p "$CODEX_HOME/generated_images/${thread}"\ncp "${dir}/fixture.png" "$CODEX_HOME/generated_images/${thread}/exec-1.png"\necho '{"status":"done","notes":"fake"}' > "$o"\n`,
    { mode: 0o755 },
  );
  process.env.BETTER_AUTH_SECRET = 'not-for-codex';
  try {
    const runner = createRunner(store, dir, fake, { codexShell: false, codexHome: home });
    const pk = await call('POST', '/api/packshots', { itemIds: ['W-1'] });
    assert.equal(pk.created, 1);
    await runner.drain();
  } finally {
    delete process.env.BETTER_AUTH_SECRET;
  }
  const item = store.read().items.find((i) => i.id === 'W-1')!;
  assert.ok(item.packshotId, 'the collected image became the packshot');
  const calls = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split('\n');
  assert.ok(calls.every((c) => c.includes('features.shell_tool=false') && c.includes('-s read-only') && !c.includes('workspace-write')), 'every Codex call runs without commands');
  const prompt = fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8');
  assert.doesNotMatch(prompt, /save it as a PNG/);
  assert.match(prompt, /the app collects the generated image itself/);
  assert.equal(fs.existsSync(path.join(home, 'generated_images', thread)), false, "Codex's own copy is removed");
  const env = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8');
  assert.doesNotMatch(env, /BETTER_AUTH_SECRET/);
  assert.match(env, new RegExp(`^CODEX_HOME=${home}$`, 'm'));
});

test('OpenAI engine: structured JSON with attached images and web search, PNG edits from references, honest errors, no guessed models', async () => {
  const { createOpenAIEngine, openAIConfigFromEnv, apiImagePrompt, responseText } = await import('./openai-engine.ts');
  assert.equal(openAIConfigFromEnv({}), null);
  assert.throws(() => openAIConfigFromEnv({ OPENAI_API_KEY: 'k' }), /OPENAI_TEXT_MODEL/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-openai-'));
  const img = path.join(dir, 'face.png');
  fs.writeFileSync(img, SAMPLE_PNG);
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let next: Response = reply(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"done","looks":[]}' }] }], usage: { input_tokens: 120, output_tokens: 30 } });
  const engine = createOpenAIEngine({ ...openAIConfigFromEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_TEXT_MODEL: 'text-model', OPENAI_IMAGE_MODEL: 'image-model' })!, fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return next; }) as never });
  const log = path.join(dir, 'log.jsonl');
  const out = await engine.json({ prompt: 'Find', schema: { type: 'object' }, images: [img], webSearch: true, logFile: log });
  assert.deepEqual(out.reply, { status: 'done', looks: [] });
  assert.deepEqual(out.usage, { inputTokens: 120, outputTokens: 30, costUsd: 0 }, 'without prices nothing is costed');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(body.model, 'text-model');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.store, false, 'responses are not stored for later turns');
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.ok(!fs.readFileSync(log, 'utf8').includes('base64'), 'the log never holds image data');
  next = reply(429, { error: { message: 'Rate limit' } });
  assert.deepEqual(await engine.json({ prompt: 'x', schema: {} }), { reply: null, err: 'OpenAI 429: Rate limit' });
  // Images: an edit with the references in order writes the PNG; a fresh generation when there are none.
  next = reply(200, { data: [{ b64_json: SAMPLE_PNG.toString('base64') }], usage: { input_tokens: 900, output_tokens: 4000 } });
  const result = path.join(dir, 'result.png');
  const edit = await engine.image({ prompt: 'Look', images: [img], resultFile: result, packshot: false });
  assert.equal(edit.ok, true);
  assert.equal(calls.at(-1)!.url, 'https://api.openai.com/v1/images/edits');
  const form = calls.at(-1)!.init.body as FormData;
  assert.equal(form.get('size'), '1024x1536');
  assert.equal(form.get('quality'), 'high');
  assert.equal(form.getAll('image[]').length, 1);
  assert.deepEqual(fs.readFileSync(result), SAMPLE_PNG);
  next = reply(200, { data: [{ b64_json: SAMPLE_PNG.toString('base64') }] });
  await engine.image({ prompt: 'Concept', images: [], resultFile: result, packshot: true });
  assert.equal(calls.at(-1)!.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).quality, 'medium');
  next = reply(200, { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
  assert.equal((await engine.image({ prompt: 'x', images: [img], resultFile: path.join(dir, 'bad.png'), packshot: true })).ok, false);
  // The worker prompt loses its Codex-only instructions and names the attached images in order.
  const prompt = apiImagePrompt(['You are the Capsula render worker running unattended.', 'Task: create ONE photorealistic image with your built-in image generation tool and save it as a PNG file at this exact path: /x/result.png', 'When you call the image generation tool, you MUST pass…', 'Outfit: tee', 'When the PNG is saved at the path above, reply with JSON only', 'If image generation is unavailable or fails, reply'].join('\n'), ['/a/face.png', '/a/tee.png']);
  assert.equal(prompt, 'Attached images, in order: 1) face.png; 2) tee.png.\nTask: create ONE photorealistic image.\nOutfit: tee');
  assert.equal(responseText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }), 'ab');
});

test('the runner uses the OpenAI engine when one is configured: a search for new looks runs through it', async () => {
  const { store, call } = setup();
  const prompts: string[] = [];
  const engine = {
    label: 'text-model', imageLabel: 'image-model',
    json: async (req: { prompt: string }) => { prompts.push(req.prompt); return { reply: { status: 'done', reason: '', looks: [] }, usage: { inputTokens: 1, outputTokens: 1 } }; },
    image: async () => ({ ok: false, err: 'not used' }),
  };
  const job = await call('POST', '/api/discover', { capsuleId: 'C-1' });
  await createRunner(store, store.dataDir, '/usr/bin/false', { engine: engine as never }).drain();
  const done = store.read().jobs.find((j) => j.id === job.id)!;
  assert.equal(done.state, 'done', done.stateNote ?? '');
  assert.match(prompts[0], /Capsula stylist worker/);
});

test('without macOS Vision: upright previews, crops kept only when the face check finds no face, numbered sheets', async () => {
  const sharp = (await import('sharp')).default;
  const { sharpImaging } = await import('./garment-references.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-sharp-'));
  const src = path.join(dir, 'photo.png');
  await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335577' } }).png().toFile(src);
  assert.deepEqual(await sharpImaging('preview', [{ key: 0, source: src, destination: path.join(dir, 'p.jpg') }]), [0]);
  assert.ok(fs.existsSync(path.join(dir, 'p.jpg')));
  const entry = (key: number) => ({ key, source: src, destination: path.join(dir, `c${key}.png`), box: { x: 0.1, y: 0.4, width: 0.5, height: 0.4 } });
  assert.deepEqual(await sharpImaging('crop', [entry(0)]), [], 'no face check: no crop is trusted');
  assert.equal(fs.existsSync(path.join(dir, 'c0.png')), false);
  assert.deepEqual(await sharpImaging('crop', [entry(1)], async () => [true]), [], 'a crop with a face is dropped');
  assert.deepEqual(await sharpImaging('crop', [entry(2)], async () => [false]), [2]);
  const meta = await sharp(path.join(dir, 'c2.png')).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 240);
  assert.deepEqual(await sharpImaging('crop', [{ ...entry(3), box: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 } }], async () => [false]), [], 'a tiny rectangle is skipped');
  await sharpImaging('sheet', { sources: [path.join(dir, 'c2.png'), src, src], destination: path.join(dir, 'sheet.png') });
  assert.equal((await sharp(path.join(dir, 'sheet.png')).metadata()).width, 1024);
});

test('OpenAI prices: read only from OPENAI_PRICES, every call costed from its real tokens and searches', async () => {
  const { createOpenAIEngine, openAIConfigFromEnv, pricesFromEnv } = await import('./openai-engine.ts');
  assert.equal(pricesFromEnv(undefined), undefined);
  assert.throws(() => pricesFromEnv('text_in:1'), /missing text_out/);
  assert.throws(() => pricesFromEnv('text_in:abc,text_out:1,image_in:1,image_out:1,search_call:1'), /cannot read/);
  const env = { OPENAI_API_KEY: 'sk-test', OPENAI_TEXT_MODEL: 't', OPENAI_IMAGE_MODEL: 'i', OPENAI_PRICES: 'text_in:2, text_out:8, image_in:10, image_out:40, search_call:0.01' };
  const cfg = openAIConfigFromEnv(env)!;
  assert.deepEqual(cfg.prices, { textIn: 2, textOut: 8, imageIn: 10, imageOut: 40, searchCall: 0.01 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-prices-'));
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  let next = reply({ output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 1_000_000, output_tokens: 500_000 } });
  const engine = createOpenAIEngine({ ...cfg, fetch: (async () => next) as never });
  const text = await engine.json({ prompt: 'x', schema: {}, webSearch: true });
  assert.ok(Math.abs(text.usage!.costUsd - (2 + 4 + 0.02)) < 1e-9, String(text.usage!.costUsd));
  next = reply({ data: [{ b64_json: SAMPLE_PNG.toString('base64') }], usage: { input_tokens: 100_000, output_tokens: 50_000 } });
  const image = await engine.image({ prompt: 'x', images: [], resultFile: path.join(dir, 'r.png'), packshot: true });
  assert.ok(Math.abs(image.usage!.costUsd - (1 + 2)) < 1e-9, String(image.usage!.costUsd));
});

test('quotas: allowances per account and month, background work trimmed, finished jobs counted once, the budget pauses everyone but the owner', async () => {
  const { createTenants, emptyDb, meteredEngine } = await import('./tenants.ts');
  const { createUsage, quotaConfigFromEnv, quotaKind, monthOf } = await import('./quota.ts');
  const defaults = quotaConfigFromEnv({});
  assert.deepEqual(defaults.limits, { tryon: 10, packshot: 60, intake: 100, styling: 30, advice: 30 });
  assert.equal(defaults.budgetUsd, null);
  assert.throws(() => quotaConfigFromEnv({ QUOTA_TRYON: '-1' }), /whole numbers/);
  assert.throws(() => quotaConfigFromEnv({ MONTHLY_BUDGET_USD: 'lots' }), /MONTHLY_BUDGET_USD/);
  assert.equal(quotaKind({}), 'tryon', 'a job without a kind is a try-on');
  assert.equal(quotaKind({ kind: 'shopsearch' }), 'styling');
  assert.equal(quotaKind({ kind: 'advise' }), 'advice');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-quota-'));
  const usage = createUsage(path.join(dir, 'usage.sqlite'));
  const cfg = quotaConfigFromEnv({ QUOTA_STYLING: '1', QUOTA_ADVICE: '1', MONTHLY_BUDGET_USD: '1' });
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb, codexBin: '/usr/bin/false', quota: { cfg, usage } });
  const user = tenants.forUser('user-qqqqqq');
  const job = (id: string, kind: 'analyze' | 'advise') => ({ id, kind, lookVersion: 0, snapshot: { lookName: kind, slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued' as const, origin: 'site' as const, createdAt: at });

  user.ctx.admit!('styling');
  await user.store.mutate((d) => void d.jobs.push(job('J-a1', 'analyze')));
  assert.throws(() => user.ctx.admit!('styling'), (e: { status?: number; message: string }) => e.status === 429 && /Ліміт підборів/.test(e.message));
  // What slips past a request (the advisor, covers after a photo) is dropped inside the write.
  await user.store.mutate((d) => void d.jobs.push(job('J-a2', 'analyze'), job('J-v1', 'advise'), job('J-v2', 'advise')));
  assert.deepEqual(user.store.read().jobs.map((j) => j.id), ['J-a1', 'J-v1']);
  // A finished job is counted in the ledger; deleting it from the wardrobe does not give the allowance back.
  await user.store.mutate((d) => { const j = d.jobs.find((x) => x.id === 'J-a1')!; j.state = 'done'; j.finishedAt = at; });
  await user.store.mutate((d) => { d.jobs[0].stateNote = 'touched again'; });
  assert.equal(usage.done('user-qqqqqq').styling, 1, 'counted once');
  await user.store.mutate((d) => { d.jobs = d.jobs.filter((j) => j.id !== 'J-a1'); });
  assert.throws(() => user.ctx.admit!('styling'), /Ліміт підборів/);
  assert.deepEqual(usage.done('user-qqqqqq', '2099-01'), { tryon: 0, packshot: 0, intake: 0, styling: 0, advice: 0 }, 'a new month starts fresh');
  assert.deepEqual(user.quota!.status(user.store.read()).kinds.styling, { used: 1, limit: 1 });

  // Every API call's cost goes to the ledger; the accounts' total reaching the budget pauses them.
  const fake = { label: 't', imageLabel: 'i', json: async () => ({ reply: {}, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }), image: async () => ({ ok: true, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }) };
  const metered = meteredEngine(fake as never, user.quota!.cost);
  await metered.json({ prompt: 'x', schema: {} });
  assert.equal(user.quota!.paused(), false);
  await metered.image({ prompt: 'x', images: [], resultFile: path.join(dir, 'x.png'), packshot: true });
  assert.ok(Math.abs(usage.budgetSpent() - 1.2) < 1e-9);
  assert.equal(user.quota!.paused(), true);
  assert.throws(() => user.ctx.admit!('intake'), /призупинено до 1-го числа/);
  assert.equal(user.quota!.status(user.store.read()).paused, true);
  // While paused a queued job waits instead of running.
  await user.runner.drain();
  assert.equal(user.store.read().jobs.find((j) => j.id === 'J-v1')!.state, 'queued');

  // The owner has no allowance, is never paused, and their spending stays out of the budget.
  const owner = tenants.forUser('owner-oooooo', true);
  owner.ctx.admit!('styling', 50);
  owner.quota!.cost(5);
  assert.ok(Math.abs(usage.budgetSpent() - 1.2) < 1e-9);
  const ownerView = owner.quota!.status(owner.store.read());
  assert.equal(ownerView.owner, true);
  assert.equal(ownerView.kinds.tryon.limit, null);
  assert.equal(ownerView.ownSpentUsd, 5);
  assert.equal(ownerView.spentUsd, 1.2);
  assert.equal(ownerView.month, monthOf());

  // A deleted account loses its counts; its spending stays in the month's total.
  tenants.remove('user-qqqqqq');
  assert.equal(usage.done('user-qqqqqq').styling, 0);
  assert.ok(Math.abs(usage.budgetSpent() - 1.2) < 1e-9);
  owner.runner.stop();
  tenants.forUser('user-qqqqqq').runner.stop();
  usage.close();
});

test('prompts read the reply language, wardrobe focus, place and hemisphere from the profile, with no fixed personal values', async () => {
  const { store, call } = setup();
  const discover = await call('POST', '/api/discover', { capsuleId: 'C-1' });
  const db = store.read();
  const job = db.jobs.find((j) => j.id === discover.id)!;
  const advise = { ...job, kind: 'advise' as const };
  const prompts = () => [discoverPrompt(store.read(), job), advisePrompt(store.read(), advise, []), analyzePrompt(store.read(), { ...job, kind: 'analyze' as const }, []), intakePrompt(store.read(), job, [])].join('\n');
  // Nothing about one person's city, country or style is written into the prompts.
  await store.mutate((d) => { delete d.profile.location; });
  assert.doesNotMatch(prompts(), /remote-work|relaxed smart casual/);
  assert.match(prompts(), /Write every text in Ukrainian/);
  assert.match(prompts(), /clothes of any gender/);
  await store.mutate((d) => { d.profile.language = 'en'; d.profile.wardrobeFocus = 'women'; d.profile.location = 'Old Town, Lisbon, Portugal'; });
  const english = prompts();
  assert.doesNotMatch(english, /Ukrainian/);
  assert.match(english, /Write every text in English/);
  assert.match(english, /womenswear/);
  assert.match(english, /near Old Town, Lisbon, Portugal/);
  // The southern hemisphere has the same weather periods six months later.
  assert.equal(currentPeriod(new Date('2026-07-10T12:00:00Z'), 'north'), 'summer');
  assert.equal(currentPeriod(new Date('2026-07-10T12:00:00Z'), 'south'), 'winter');
  assert.equal(currentPeriod(new Date('2026-01-10T12:00:00Z'), 'south'), 'summer');
});

test('profile: language, wardrobe focus, consent and hemisphere are validated and saved; dresses fill a whole outfit', async () => {
  const { store, call } = setup();
  const rev = () => store.read().profile.rev;
  await assert.rejects(call('PATCH', '/api/profile', { rev: rev(), language: 'de' }), /Невідома мова/);
  await assert.rejects(call('PATCH', '/api/profile', { rev: rev(), wardrobeFocus: 'kids' }), /Невідомий гардероб/);
  await call('PATCH', '/api/profile', { rev: rev(), language: 'en', wardrobeFocus: 'women', consent: true, hemisphere: 'south' });
  const p = store.read().profile;
  assert.equal(p.language, 'en');
  assert.equal(p.wardrobeFocus, 'women');
  assert.equal(p.hemisphere, 'south');
  assert.ok(p.consentAt);
  const first = p.consentAt;
  await call('PATCH', '/api/profile', { rev: rev(), consent: true });
  assert.equal(store.read().profile.consentAt, first, 'the consent keeps its first date');
  // A dress counts on its own in the combinations: (tops × bottoms + dresses) × (layers + 1) × shoes.
  await store.mutate((d) => {
    d.items.push({ ...d.items[0], id: 'W-DRESS', title: 'Сукня-сорочка', category: 'dresses', history: [] });
    const c = d.capsules[0];
    const look = d.looks.find((l) => c.lookIds.includes(l.id))!;
    look.slots.top = [{ kind: 'item', id: 'W-DRESS' }];
    look.slots.bottom = [];
  });
  const db = store.read();
  const set = capsuleSet(db, db.capsules[0]);
  const dress = set.pieces.find((x) => x.ref.id === 'W-DRESS')!;
  assert.equal(dress.role, 'top');
  assert.equal(set.combinations, capsuleCombinations({ top: set.roles.top - 1, layer: set.roles.layer, bottom: set.roles.bottom, shoes: set.roles.shoes, dresses: 1 }));
});

test('a new account starts a capsule from the style catalogue, its brief in the person\'s language and wardrobe', async () => {
  const { STYLE_CATALOGUE, stylePieces } = await import('../src/style-catalogue.ts');
  assert.equal(new Set(STYLE_CATALOGUE.map((s) => s.name)).size, STYLE_CATALOGUE.length, 'style names are distinct');
  for (const s of STYLE_CATALOGUE) {
    assert.equal(s.pieces.men.length, 6);
    assert.equal(s.pieces.women.length, 6);
    assert.ok(s.periods.length > 0);
    assert.doesNotMatch(s.name, /refined modern/i);
  }
  const both = stylePieces(STYLE_CATALOGUE[0], 'any');
  assert.equal(new Set(both.map((x) => x.en)).size, both.length, '«Будь-який» shows no piece twice');
  const { store, call } = setup();
  await store.mutate((d) => { d.profile.language = 'en'; d.profile.wardrobeFocus = 'women'; });
  const style = STYLE_CATALOGUE.find((s) => s.id === 'mediterranean-casual')!;
  const capsule = await call('POST', '/api/capsules/from-style', { styleId: style.id });
  assert.equal(capsule.name, 'Mediterranean Casual');
  assert.deepEqual(capsule.periods, style.periods);
  assert.match(capsule.description, /Key pieces: .*midi shirt dress/);
  assert.doesNotMatch(capsule.description, /Ключові|Опорні/);
  assert.equal(capsule.lookIds.length, 0);
  await assert.rejects(call('POST', '/api/capsules/from-style', { styleId: style.id }), /Така капсула вже є/);
  await assert.rejects(call('POST', '/api/capsules/from-style', { styleId: 'nope' }), /Стиль не знайдено/);
});

test('rate limits: fixed windows per key, Retry-After seconds, Cloudflare\'s address trusted only from the local tunnel', async () => {
  const { createRateLimiter, clientAddress } = await import('./rate-limit.ts');
  let at = 0;
  const limiter = createRateLimiter(() => at);
  const rule = { limit: 2, windowMs: 60_000 };
  assert.equal(limiter.take('sign-in:1.2.3.4', rule), 0);
  assert.equal(limiter.take('sign-in:1.2.3.4', rule), 0);
  assert.equal(limiter.take('sign-in:1.2.3.4', rule), 60);
  assert.equal(limiter.take('sign-in:5.6.7.8', rule), 0, 'another address has its own window');
  at = 45_000;
  assert.equal(limiter.take('sign-in:1.2.3.4', rule), 15);
  at = 60_000;
  assert.equal(limiter.take('sign-in:1.2.3.4', rule), 0, 'a new window starts after the old one ends');
  const req = (peer: string, cf?: string) => ({ socket: { remoteAddress: peer }, headers: cf ? { 'cf-connecting-ip': cf } : {} }) as never;
  assert.equal(clientAddress(req('::ffff:172.18.0.1', '203.0.113.9'), true), '203.0.113.9');
  assert.equal(clientAddress(req('::ffff:172.18.0.1', '203.0.113.9'), false), '172.18.0.1', 'without TRUST_PROXY the header is ignored');
  assert.equal(clientAddress(req('198.51.100.7', '203.0.113.9'), true), '198.51.100.7', 'a public peer cannot pick its address');
  assert.equal(clientAddress(req('127.0.0.1', 'not-an-ip'), true), '127.0.0.1');
});

test('accounts: uploads stop at the beta\'s photo size, photo count and folder size', async () => {
  const { store, dir } = setup();
  const small = { fileBytes: SAMPLE_PNG.length + 10, photos: 1_000, storageBytes: 1024 ** 3 };
  const ctx = (limits: typeof small) => ({ store, projectRoot: dir, drain: () => {}, limits });
  const params = new URLSearchParams({ kind: 'item' });
  await assert.rejects(upload(ctx({ ...small, fileBytes: 10 }), params, SAMPLE_PNG, 'a.png'), /Фото більше за 0 МБ/);
  const uploads = store.read().photos.filter((p) => p.source === 'upload').length;
  await assert.rejects(upload(ctx({ ...small, photos: uploads }), params, SAMPLE_PNG, 'a.png'), new RegExp(`Уже ${uploads} фото`));
  await assert.rejects(upload(ctx({ ...small, storageBytes: 1 }), params, SAMPLE_PNG, 'a.png'), /Місце закінчилося/);
  const before = store.read().photos.length;
  await upload(ctx(small), params, SAMPLE_PNG, 'a.png');
  assert.equal(store.read().photos.length, before + 1, 'within the limits the photo is saved');
  const { setLanguage, t } = await import('../src/i18n.ts');
  setLanguage('en');
  assert.equal(t('Фото більше за 15 МБ'), 'The photo is larger than 15 MB');
  assert.equal(t('Місце закінчилося: 2 ГБ на акаунт'), 'Out of space: 2 GB per account');
  setLanguage('uk');
});

test('garment cards create missing sheet folder, crops cap resolution, and try-on cleans temp files and validates PNG', async () => {
  const { fitGarmentCards, sharpImaging } = await import('./garment-references.ts');
  const sharp = (await import('sharp')).default;
  const { dir, store, call } = setup();
  // fitGarmentCards creates the sheet parent directory even when every crop was already cached.
  const imgA = path.join(dir, 'a.png');
  const imgB = path.join(dir, 'b.png');
  const imgC = path.join(dir, 'c.png');
  for (const p of [imgA, imgB, imgC]) fs.writeFileSync(p, await sharp({ create: { width: 80, height: 80, channels: 3, background: '#335577' } }).png().toBuffer());
  const slots = [
    { slot: 'layer' as const, kind: 'item' as const, id: '1', title: 'Coat', description: '', owned: true, photoPaths: ['a.png'] },
    { slot: 'top' as const, kind: 'item' as const, id: '2', title: 'Tee', description: '', owned: true, photoPaths: ['b.png'] },
    { slot: 'bottom' as const, kind: 'item' as const, id: '3', title: 'Pants', description: '', owned: true, photoPaths: ['c.png'] },
  ];
  const sheetPath = path.join(dir, 'missing-parent', 'nested', 'garments.png');
  const cards = await fitGarmentCards(slots, 2, dir, sheetPath, (p) => path.join(dir, p));
  assert.ok(fs.existsSync(sheetPath), 'missing sheet parent directory is created');
  assert.equal(cards.filter((c) => c.file === sheetPath).length, 2);

  // Oversized crops are capped at 1536 px on the longest side.
  const huge = path.join(dir, 'huge.png');
  const cropped = path.join(dir, 'cropped.png');
  await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#224466' } }).png().toFile(huge);
  const okKeys = (await sharpImaging('crop', [{ key: 0, source: huge, destination: cropped, box: { x: 0, y: 0, width: 1, height: 1 } }], async () => [false])) as number[];
  assert.deepEqual(okKeys, [0]);
  const meta = await sharp(cropped).metadata();
  assert.equal(meta.width, 1536);
  assert.equal(meta.height, 1152);

  // Try-on via OpenAI engine records its real tool name and cleans up jobDir/result.png.
  const crop = sourceCropFixture(dir);
  await store.mutate((db) => {
    db.items[0].tryonReference = crop;
    db.looks[0].slots.top = [];
    db.looks[0].versions[0].slots = db.looks[0].slots;
  });
  const engine = {
    label: 'gpt-test', imageLabel: 'gpt-image-test',
    json: async () => ({ reply: { faces: [false] } }),
    image: async (req: { resultFile: string }) => {
      fs.writeFileSync(req.resultFile, SAMPLE_PNG);
      return { ok: true };
    },
  } as never;
  const job = await call('POST', '/api/jobs', { lookId: 'L-1', basePhotoIds: ['P-1'] });
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  const db = store.read();
  const res = db.results.find((r) => r.jobId === job.id)!;
  assert.equal(res.tool, 'OpenAI Images API');
  assert.equal(fs.existsSync(path.join(dir, 'jobs', job.id, 'result.png')), false, 'duplicate result.png cleaned from job dir');
  assert.equal(fs.existsSync(path.join(dir, res.imagePath)), true, 'final render kept in media/renders');
  // stateView strips heavy try-on slot snapshots while keeping identity for currentCover.
  const view = stateView(db);
  assert.deepEqual(view.jobs.find((j) => j.id === job.id)!.snapshot.slots, []);
});

test('eyewear preference: blocked by default, allowed when enabled in profile', async () => {
  const { store, call } = setup(false);
  const ref = (id: string) => ({ kind: 'item' as const, id });
  await store.mutate((db) => {
    const file = (path: string) => ({ path, sha256: 'b'.repeat(64) });
    db.profile.identity = { sourcePhotoId: 'P-1', original: file(db.photos[0].path), face: file('media/face.png'), body: file('media/body.png'), preserveHeadAngle: false, noGlasses: true, confirmedAt: at };
    db.items.push({ id: 'W-G', rev: 1, category: 'accessories', title: 'Tortoise sunglasses', status: 'confirmed', photoIds: [], origin: 'manual', rating: { score: 8, note: 'Sharp.', rev: 1, at, scale: 2 }, history: [], createdAt: at, updatedAt: at });
    db.items.push({ ...db.items.at(-1)!, id: 'W-Belt', title: 'Belt' });
    const look = db.looks[0];
    look.slots.accessories = [ref('W-Belt')];
    look.versions[0].slots = look.slots;
  });
  const look = store.read().looks[0];
  const variant = { variant: { lookId: look.id, rev: look.rev, slot: 'accessories', from: ref('W-Belt'), to: ref('W-G') } };
  const blocked = { status: 400, message: 'Окуляри в образи не беру' };
  assert.equal(itemRating(store.read().items.find((i) => i.id === 'W-G')!, store.read()), null);
  await assert.rejects(call('POST', '/api/analyze', { itemIds: ['W-G'] }), /Окуляри/);
  await assert.rejects(call('POST', '/api/looks', variant), blocked);
  await call('PATCH', '/api/profile', { rev: store.read().profile.rev, allowEyewear: true });
  const db = store.read();
  assert.equal(db.profile.allowEyewear, true);
  assert.equal(db.profile.identity?.noGlasses, false);
  assert.equal(itemRating(db.items.find((i) => i.id === 'W-G')!, db), 8);
  assert.ok(itemVerdict(db, db.items.find((i) => i.id === 'W-G')!));
  const job = await call('POST', '/api/analyze', { itemIds: ['W-G'] });
  assert.equal(job.kind, 'analyze');
  const withEyewear = await call('POST', '/api/looks', variant);
  const tryOn = await call('POST', '/api/jobs', { lookId: withEyewear.id }) as Job;
  assert.ok(tryOn.snapshot.slots.some((slot) => slot.id === 'W-G'));
  assert.match(buildPrompt(tryOn, 'result.png'), /No glasses unless explicitly listed/);
  await call('DELETE', `/api/jobs/${tryOn.id}`);
  await call('PATCH', '/api/profile', { rev: db.profile.rev, allowEyewear: false });
  assert.equal(store.read().profile.identity?.noGlasses, true);
  await assert.rejects(call('POST', '/api/looks', variant), blocked);
  const withoutEyewear = await call('POST', '/api/jobs', { lookId: withEyewear.id }) as Job;
  assert.equal(withoutEyewear.snapshot.slots.some((slot) => slot.id === 'W-G'), false);
  assert.match(buildPrompt(withoutEyewear, 'result.png'), /ABSOLUTELY NO GLASSES/);
});

test('readCapped stops reading chunked responses once they exceed the byte limit', async () => {
  const { readCapped } = await import('./shop-search.ts');
  let pulls = 0;
  const big = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulls += 1;
      ctrl.enqueue(new Uint8Array(64));
      if (pulls > 100) ctrl.close();
    },
  });
  assert.equal(await readCapped(new Response(big), 100), null);
  assert.ok(pulls <= 3, `expected early abort, got ${pulls} pulls`);
  const ok = await readCapped(new Response(Buffer.from('hello')), 100);
  assert.equal(ok?.toString('utf8'), 'hello');
});

test('deleting a look frees its variants: no variantOf points at a look that is gone', async () => {
  const { deleteLook } = await import('./routes.ts');
  const db = fixture();
  const base = db.looks[0];
  const other = { ...structuredClone(base), id: 'L-2', variantOf: base.id };
  db.looks.push(other);
  assert.equal(validateDb(db), null);
  for (const variantOf of ['L-missing', other.id, 42]) {
    const invalid = { ...db, looks: [base, { ...other, variantOf }] };
    assert.match(validateDb(invalid) ?? '', /основний образ/);
  }
  deleteLook(db, base.id);
  assert.equal(db.looks.find((l) => l.id === 'L-2')?.variantOf, undefined);
  assert.equal(validateDb(db), null);
});
