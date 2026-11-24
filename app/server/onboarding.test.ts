// End-to-end automated tests for the 5-step human-in-the-loop onboarding pipeline:
// identity_prep → approve → capsule_plan → approve → batch intake & triage → capsule_match → approve sets → discover,
// plus quota enforcement and strict multi-tenant isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Capsule, CapsuleMatchDraft, DB, Item } from './schema.ts';
import { SCHEMA_VERSION, validateDb } from './schema.ts';
import { HttpError, createStore } from './store.ts';
import { dispatch, upload, type Ctx } from './routes.ts';
import { createRunner } from './runner.ts';
import { verifyReferenceFiles } from './identity.ts';
import { createTenants, emptyDb } from './tenants.ts';
import { resolveAllowed } from './media.ts';
import { INTAKE_SCHEMA } from './analysis.ts';

const at = '2026-11-22T00:00:00.000Z';

function seedEmpty(): DB {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    updatedAt: at,
    photos: [],
    items: [],
    needs: [],
    products: [],
    looks: [],
    capsules: [],
    jobs: [],
    results: [],
    comparisons: [],
    profile: {
      rev: 1,
      basePhotoIds: [],
      measurements: { height: { value: null }, chest: { value: null }, waist: { value: null }, hips: { value: null }, shoulders: { value: null }, sleeve: { value: null }, inseam: { value: null }, foot: { value: null } },
      knownSizes: [],
      preferences: { comfort: '', materials: '', fit: '', branding: '' },
      wardrobeFocus: 'women',
      language: 'uk',
    },
    settings: { codexModel: 'test-model', reasoningEffort: 'medium', tailscaleLogin: '' },
  };
}

const makePng = (w = 120, h = 160, background = '#d6c8b8') =>
  sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();

function setup(admit?: Ctx['admit']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-onboarding-'));
  const store = createStore(dir, seedEmpty);
  let drained = 0;
  const ctx: Ctx = { store, projectRoot: dir, drain: () => void drained++, admit };
  const call = (method: string, p: string, body: Record<string, unknown> = {}) => dispatch(ctx, method, p, body) as Promise<any>;
  return { dir, store, ctx, call, drained: () => drained };
}

test('Step 1 (identity_prep): headless body crop + studio portrait stay in draft until «Це я?» approval, verify hashes, and allow redo/discard', async () => {
  const prevNoSwift = process.env.CAPSULA_NO_SWIFT;
  process.env.CAPSULA_NO_SWIFT = '1';
  try {
  const { dir, store, ctx, call } = setup();
  const faceBuf = await makePng(240, 300, '#c8a890');
  const bodyBuf = await makePng(240, 480, '#8899aa');
  const facePhoto = await upload(ctx, new URLSearchParams({ kind: 'base', role: 'face' }), faceBuf, 'portrait.png');
  const bodyPhoto = await upload(ctx, new URLSearchParams({ kind: 'base' }), bodyBuf, 'fullbody.png');
  assert.equal(store.read().photos.find((p) => p.id === facePhoto.id)?.referenceRole, 'face');

  const portraitOut = await makePng(256, 320, '#f2f1ee');
  let headChecks = 0;
  let faceChecks = 0;
  const engine = {
    label: 'gpt-text',
    imageLabel: 'gpt-image',
    json: async (req: { prompt: string }) => {
      if (req.prompt.includes('headBottom')) { headChecks++; return { reply: { hasPerson: true, headBottom: 0.2 } }; }
      faceChecks++;
      return { reply: { faces: [false] } };
    },
    image: async (req: { resultFile: string; images: string[]; prompt: string }) => {
      assert.equal(req.images.length, 1, 'portrait generation receives only the original face reference');
      assert.match(req.prompt, /identity-preserve studio reference portrait/);
      fs.writeFileSync(req.resultFile, portraitOut);
      return { ok: true };
    },
  } as never;

  const job = await call('POST', '/api/identity/prepare', {
    facePhotoId: facePhoto.id,
    bodyPhotoId: bodyPhoto.id,
    noGlasses: true,
    hairstyle: 'natural waves',
  });
  assert.equal(job.kind, 'identity_prep');
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();

  let db = store.read();
  assert.equal(db.jobs.find((j) => j.id === job.id)?.state, 'done', db.jobs.find((j) => j.id === job.id)?.stateNote ?? '');
  assert.equal(headChecks, 1, 'head location ran once');
  assert.equal(faceChecks, 1, 'headless face check ran once');
  assert.equal(db.profile.identity, undefined, 'generated portrait never enters profile.identity before human approval');
  const draft = db.onboarding?.identityDraft;
  assert.ok(draft, 'candidate identity saved in onboarding.identityDraft');
  const bodyMeta = await sharp(resolveAllowed(dir, dir, draft.body.path)).metadata();
  assert.ok((bodyMeta.height ?? 0) < 480 && (bodyMeta.height ?? 0) > 300, 'headless body crop cut off the top head region');
  assert.equal(draft.sourcePhotoId, facePhoto.id);
  assert.equal(draft.bodyPhotoId, bodyPhoto.id);
  assert.equal(validateDb(db), null);

  // Tampering with the draft portrait on disk blocks approval until re-generated.
  const draftFaceAbs = resolveAllowed(dir, dir, draft.face.path);
  const savedBytes = fs.readFileSync(draftFaceAbs);
  fs.writeFileSync(draftFaceAbs, Buffer.from('tampered'));
  await assert.rejects(call('POST', '/api/identity/approve', {}), /змінився/);
  fs.writeFileSync(draftFaceAbs, savedBytes);

  // Human clicks «Це я — зберегти»: promotes draft → live profile.identity passing validateDb + verifyReferenceFiles.
  const approved = await call('POST', '/api/identity/approve', {});
  db = store.read();
  assert.equal(validateDb(db), null);
  assert.equal(db.onboarding?.identityDraft, undefined);
  assert.equal(db.onboarding?.step, 2);
  assert.equal(db.profile.identity?.sourcePhotoId, facePhoto.id);
  assert.equal(db.profile.identity?.approvedPortrait?.provisional, false);
  assert.equal(db.profile.allowEyewear, false);
  assert.equal(approved.face.path, draft.face.path);

  // Verify the pinned identity passes try-on integrity verification without error.
  verifyReferenceFiles(
    { id: 'J-check', lookVersion: 1, snapshot: { lookName: 'x', slots: [], basePhotoIds: [facePhoto.id], basePhotoPaths: [], identity: db.profile.identity }, instructions: '', state: 'queued', origin: 'site', createdAt: at },
    (p) => resolveAllowed(dir, dir, p),
  );

  // Discarding a draft never deletes uploaded originals.
  await call('POST', '/api/identity/prepare', { facePhotoId: facePhoto.id, bodyPhotoId: bodyPhoto.id, instructions: 'softer light' });
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  assert.ok(store.read().onboarding?.identityDraft);
  await call('DELETE', '/api/identity/draft', {});
  assert.equal(store.read().onboarding?.identityDraft, undefined);
  assert.equal(store.read().photos.length, 2, 'originals stay intact');
  } finally {
    if (prevNoSwift === undefined) delete process.env.CAPSULA_NO_SWIFT;
    else process.env.CAPSULA_NO_SWIFT = prevNoSwift;
  }
});

test('Steps 2–4: capsule_plan → approve → batch intake & triage → capsule_match (10+3+3 caps) → approve closed sets', async () => {
  const { dir, store, ctx, call } = setup();

  // Step 2: Plan capsules from user prompt.
  const planReply = {
    status: 'done',
    reason: '',
    capsules: [
      { name: 'Studio Minimal', season: 'all', periods: ['spring', 'early-autumn', 'late-autumn'], description: 'Clean architectural silhouettes in sand, charcoal and ivory wool/cotton.', situations: ['Студія', 'Місто'], keyPieces: ['Пісочний тренч', 'Біла сорочка', 'Прямі чорні штани'] },
      { name: 'Coastal Weekend', season: 'warm', periods: ['spring', 'summer'], description: 'Relaxed coastal linen and striped knits in navy, cream and tan.', situations: ['Вихідні', 'Прогулянка'], keyPieces: ['Смугастий джемпер', 'Прямі джинси', 'Лофери'] },
    ],
  };

  let callMode: 'plan' | 'intake' | 'match' = 'plan';
  let intakeCount = 0;
  const mockItems = [
    { title: 'Пісочний тренч', category: 'outerwear', color: 'пісочний', notes: 'двобортний', duplicateOf: '', coversNeed: '' },
    { title: 'Біла бавовняна сорочка', category: 'shirts', color: 'білий', notes: 'вільна', duplicateOf: '', coversNeed: '' },
    { title: 'Прямі чорні штани', category: 'trousers', color: 'чорний', notes: 'висока талія', duplicateOf: '', coversNeed: '' },
    { title: 'Чорні шкіряні лофери', category: 'shoes', color: 'чорний', notes: 'мінімалістичні', duplicateOf: '', coversNeed: '' },
    { title: 'Смугастий трикотажний джемпер', category: 'knitwear', color: 'темно-синій', notes: 'бретонська смужка', duplicateOf: '', coversNeed: '' },
    { title: 'Неонова спортивна майка', category: 'tees', color: 'неоново-зелений', notes: 'для залу', duplicateOf: '', coversNeed: '' },
  ];

  const engine = {
    label: 'gpt-text',
    imageLabel: 'gpt-image',
    json: async () => {
      if (callMode === 'plan') return { reply: planReply };
      if (callMode === 'intake') {
        const g = mockItems[intakeCount++];
        return { reply: { status: 'done', reason: '', photoType: 'garments_only', singlePerson: false, baseSuitable: false, baseIssues: '', label: { itemId: '', brand: '', size: '', composition: '' }, garments: g ? [g] : [] } };
      }
      const db = store.read();
      const cap1 = db.capsules[0].id;
      const cap2 = db.capsules[1].id;
      const byTitle = (t: string) => db.items.find((i) => i.title === t)!.id;
      return {
        reply: {
          status: 'done',
          reason: '',
          sets: [
            {
              capsuleId: cap1,
              ownedItemIds: [byTitle('Пісочний тренч'), byTitle('Біла бавовняна сорочка'), byTitle('Прямі чорні штани'), byTitle('Чорні шкіряні лофери')],
              baseItemIds: [byTitle('Пісочний тренч'), byTitle('Прямі чорні штани'), byTitle('Біла бавовняна сорочка')], // 3 proposed → capped to MAX_BASE_PIECES (2)
              missing: [{ title: 'Кремовий кашеміровий светр', category: 'knitwear', priority: 'core', why: 'Додає теплі шари під тренч.' }],
              note: 'Міцна база; бракує світлого трикотажу.',
            },
            {
              capsuleId: cap2,
              ownedItemIds: [byTitle('Смугастий трикотажний джемпер'), byTitle('Біла бавовняна сорочка'), byTitle('Чорні шкіряні лофери')],
              baseItemIds: [byTitle('Смугастий трикотажний джемпер')],
              missing: [{ title: 'Світлі прямі джинси', category: 'trousers', priority: 'core', why: 'Закриває низ для всіх верхів.' }],
              note: 'Потрібен базовий денім.',
            },
          ],
          unmatchedItemIds: [byTitle('Неонова спортивна майка')],
        },
      };
    },
    image: async (req: { resultFile: string }) => {
      fs.writeFileSync(req.resultFile, await makePng(128, 128, '#ffffff'));
      return { ok: true };
    },
  } as never;

  await call('POST', '/api/onboarding/plan-capsules', { prompt: 'Мінімалістична студія і спокійні вихідні біля моря' });
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  let db = store.read();
  assert.equal(db.capsules.length, 0, 'drafts do not enter db.capsules before approval');
  assert.equal(db.onboarding?.capsuleDrafts?.length, 2);

  // Human approves both capsules (editing one name) + creates a custom capsule via POST /api/capsules.
  const drafts = db.onboarding!.capsuleDrafts!;
  await call('POST', '/api/onboarding/approve-capsules', {
    capsules: drafts.map((d, i) => (i === 0 ? { ...d, name: 'Studio Minimalism' } : d)),
  });
  db = store.read();
  assert.equal(db.capsules.length, 2);
  assert.equal(db.capsules[0].name, 'Studio Minimalism');
  assert.equal(db.onboarding?.capsuleDrafts, undefined);
  assert.equal(db.onboarding?.step, 3);

  const custom = await call('POST', '/api/capsules', { name: 'Evening Clean', season: 'all', periods: ['spring', 'winter'], description: 'Quiet black tailoring.' });
  assert.equal(custom.name, 'Evening Clean');
  await assert.rejects(call('POST', '/api/capsules', { name: 'Evening Clean' }), /вже є/);

  // Step 3: Batch upload 6 garment photos (batch=1 defers background advise jobs).
  callMode = 'intake';
  for (let i = 0; i < mockItems.length; i++) {
    await upload(ctx, new URLSearchParams({ kind: 'intake', batch: '1', intent: 'garments', run: '0' }), await makePng(80, 80, `#${i}${i}${i}888`), `g-${i}.png`);
  }
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  db = store.read();
  assert.equal(db.items.length, 6);
  assert.equal(db.jobs.some((j) => j.kind === 'advise'), false, 'batch=1 intake defers per-photo advise runs');
  assert.equal(db.items.every((i) => i.status === 'needs_confirmation'), true);
  assert.equal(db.items.every((i) => Boolean(i.packshotId)), true, 'every recognized item got a packshot');

  // Inline batch triage: confirm 5 items and retire 1.
  const neon = db.items.find((i) => i.title === 'Неонова спортивна майка')!;
  const toConfirm = db.items.filter((i) => i.id !== neon.id).map((i) => i.id);
  const confirmed = await call('POST', '/api/items/batch-status', { ids: toConfirm, status: 'confirmed' });
  assert.equal(confirmed.updated, 5);
  await call('POST', '/api/items/batch-status', { ids: [neon.id], status: 'inactive' });

  // Step 4: Match confirmed wardrobe onto approved capsules.
  callMode = 'match';
  await call('POST', '/api/onboarding/match-capsules', { capsuleIds: [db.capsules[0].id, db.capsules[1].id] });
  await createRunner(store, dir, '/usr/bin/false', { engine }).drain();
  db = store.read();
  assert.equal(db.onboarding?.matchDrafts?.length, 2);
  assert.equal(db.onboarding!.matchDrafts![0].baseItemIds.length, 2, 'base pieces capped at MAX_BASE_PIECES = 2');
  assert.equal(db.capsules[0].pieces, undefined, 'sets stay in draft until human approval');

  // Human approves the matched sets → persists capsule.pieces + creates Shopping needs.
  const approvedSets = await call('POST', '/api/onboarding/approve-sets', {
    sets: db.onboarding!.matchDrafts!.map((m) => ({
      capsuleId: m.capsuleId,
      ownedItemIds: m.ownedItemIds,
      baseItemIds: m.baseItemIds,
      missing: m.missing.filter((x) => x.selected),
    })),
  });
  assert.equal(approvedSets.capsules, 2);
  assert.equal(approvedSets.needsCreated, 2);
  db = store.read();
  assert.equal(validateDb(db), null);
  assert.equal(db.capsules[0].pieces?.length, 5, '4 owned + 1 missing need');
  assert.equal(db.capsules[0].base?.length, 2);
  assert.equal(db.needs.length, 2);
  assert.equal(db.onboarding?.matchDrafts, undefined);
  assert.equal(db.onboarding?.step, 5);

  // Completing onboarding sets completedAt cleanly.
  await call('PATCH', '/api/onboarding', { complete: true });
  assert.ok(store.read().onboarding?.completedAt);
});

test('Step 3: garment batch intake flags a duplicate and absorb preserves the confirmed piece', async (t) => {
  const { dir, store, ctx, call } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const metadata = { title: 'Navy chinos', category: 'trousers', color: 'Navy', brand: 'Owner brand', size: '32' };
  const confirmed: Item = await call('POST', '/api/items', metadata);
  const original = await upload(ctx, new URLSearchParams({ kind: 'detail', item: confirmed.id }), await makePng(), 'original.png');
  const bytes = await makePng(140, 170, '#22334a');
  const photo = await upload(ctx, new URLSearchParams({ kind: 'intake', batch: '1', intent: 'garments' }), bytes, 'new-angle.png');
  const intake = store.read().jobs.find((j) => j.kind === 'intake')!;
  assert.equal(intake.intakeIntent, 'garments');
  assert.equal(intake.batch, true);

  const engine = {
    label: 'gpt-text',
    json: async ({ schema }: { schema: object }) => {
      assert.equal(schema, INTAKE_SCHEMA);
      return { reply: { status: 'done', photoType: 'garments_only', garments: [
        { title: 'Pleated trousers', category: 'trousers', color: 'navy', notes: 'Same pocket seam', duplicateOf: confirmed.id },
      ] } };
    },
  } as never;
  const runner = createRunner(store, dir, '/usr/bin/false', { engine, canStart: (j) => j.kind === 'intake' });
  await runner.drain();
  const before = store.read();
  const candidate = before.items.find((item) => item.id !== confirmed.id);
  assert.ok(candidate);
  assert.equal(candidate.status, 'needs_confirmation');
  assert.equal(candidate.possibleDuplicateOf, confirmed.id);
  assert.deepEqual(before.items.find((item) => item.id === confirmed.id)?.photoIds, [original.id]);
  assert.ok(!before.jobs.some((j) => j.kind === 'packshot' && j.itemId === candidate.id));

  const merged: Item = await call('POST', `/api/items/${confirmed.id}/absorb`, { sourceId: candidate.id });
  assert.equal(merged.id, confirmed.id);
  assert.equal(merged.status, 'confirmed');
  for (const key of ['title', 'category', 'color', 'brand', 'size'] as const) assert.equal(merged[key], metadata[key]);
  assert.deepEqual(merged.photoIds, [original.id, photo.id]);
  const after = store.read();
  const source = after.items.find((item) => item.id === candidate.id);
  assert.equal(source?.status, 'inactive');
  assert.equal(source?.mergedInto, confirmed.id);
  assert.ok(after.items.every((item) => !item.possibleDuplicateOf));
  assert.deepEqual(fs.readFileSync(resolveAllowed(dir, dir, photo.path)), bytes);
  assert.equal(validateDb(after), null);
});

test('Step 4: match and approve four accessories for multisport and three for standard capsules', async (t) => {
  const { dir, store, call } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const multisport: Capsule = await call('POST', '/api/capsules', { name: 'Multisport', accessoryLimit: 4 });
  const standard: Capsule = await call('POST', '/api/capsules', { name: 'Studio Minimal' });
  const accessories: Item[] = [];
  for (const title of ['Helmet', 'Gloves', 'Cap', 'Watch', 'Belt']) {
    accessories.push(await call('POST', '/api/items', { title, category: 'accessories' }));
  }
  const missing = ['Backpack', 'Scarf', 'Socks'].map((title) => ({ title, category: 'accessories', priority: 'core', why: '' }));
  const caps = [multisport, standard];
  let ownedItemIds: string[] = [];
  let prompt = '';
  const engine = {
    label: 'gpt-text',
    json: async (req: { prompt: string }) => {
      prompt = req.prompt;
      return { reply: { status: 'done', sets: caps.map((c) => ({ capsuleId: c.id, ownedItemIds, missing })) } };
    },
  } as never;
  const runner = createRunner(store, dir, '/usr/bin/false', { engine, canStart: (j) => j.kind === 'capsule_match' });
  for (const ownedCount of [5, 2]) {
    ownedItemIds = accessories.slice(0, ownedCount).map((item) => item.id);
    await call('POST', '/api/onboarding/match-capsules', { capsuleIds: caps.map((c) => c.id) });
    await runner.drain();
    const lines = prompt.split('\n');
    assert.ok(lines.some((line) => line.startsWith(`${multisport.id} | Multisport |`) && line.endsWith(' | limits: 10/3/4')));
    assert.ok(lines.some((line) => line.startsWith(`${standard.id} | Studio Minimal |`) && line.endsWith(' | limits: 10/3/3')));

    const drafts = store.read().onboarding?.matchDrafts;
    assert.ok(drafts);
    assert.equal(drafts.length, 2);
    for (const [cap, limit] of [[multisport, 4], [standard, 3]] as const) {
      const draft: CapsuleMatchDraft | undefined = drafts.find((d) => d.capsuleId === cap.id);
      assert.ok(draft);
      assert.deepEqual(draft.ownedItemIds, ownedItemIds.slice(0, limit));
      assert.deepEqual(draft.missing.map((m) => m.title), missing.slice(0, Math.max(0, limit - ownedCount)).map((m) => m.title));
    }
    await call('POST', '/api/onboarding/approve-sets', { sets: drafts });
    const db = store.read();
    assert.equal(validateDb(db), null);
    assert.equal(db.capsules.find((c) => c.id === multisport.id)?.pieces?.length, 4);
    assert.equal(db.capsules.find((c) => c.id === standard.id)?.pieces?.length, 3);
  }
});

test('Onboarding quotas and multi-tenant isolation: account B cannot access account A drafts or exceed allowances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-onb-tenants-'));
  const tenants = createTenants({ projectRoot: dir, dataDir: dir, seed: emptyDb });
  const a = tenants.forUser('user-onb-aaaa', true);
  const b = tenants.forUser('user-onb-bbbb', true);
  a.runner.stop();
  b.runner.stop();
  const quiet = (ctx: Ctx): Ctx => ({ ...ctx, drain: () => undefined });

  const photoA = await upload(quiet(a.ctx), new URLSearchParams({ kind: 'base', role: 'face' }), await makePng(80, 80, '#ccaa88'), 'a.png');
  await assert.rejects(
    dispatch(quiet(b.ctx), 'POST', '/api/identity/prepare', { facePhotoId: photoA.id, bodyPhotoId: photoA.id }),
    /не знайдено/,
    'account B cannot prepare identity from account A photo',
  );
  await assert.rejects(
    dispatch(quiet(b.ctx), 'POST', '/api/identity/approve', {}),
    /Немає підготовленої опори/,
  );

  // Quota denial blocks plan-capsules and identity/prepare cleanly with 429.
  const deniedCtx: Ctx = {
    ...quiet(a.ctx),
    admit: () => { throw new HttpError(429, 'Ліміт вичерпано'); },
  };
  await assert.rejects(dispatch(deniedCtx, 'POST', '/api/onboarding/plan-capsules', { prompt: 'Smart casual' }), /Ліміт/);
  await assert.rejects(dispatch(deniedCtx, 'POST', '/api/identity/prepare', { facePhotoId: photoA.id, bodyPhotoId: photoA.id }), /Ліміт/);
});
