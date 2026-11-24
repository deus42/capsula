// Step 1 of onboarding (and Profile identity setup): turn the person's own face + full-body photos into a
// verified headless body crop and a clean studio base portrait draft awaiting «Це я?» approval on site.
// Generated portraits never enter profile.identity until the person explicitly approves them.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { DB, HashedFile, IdentityDraft, IdentityReference, Job, Photo } from './schema.ts';
import { HttpError, newId, now } from './store.ts';
import { resolveAllowed } from './media.ts';
import type { FaceCheck } from './garment-references.ts';

const exec = promisify(execFile);
const imageTool = fileURLToPath(new URL('./garment-imaging.swift', import.meta.url));
const hasSwift = process.platform === 'darwin' && fs.existsSync('/usr/bin/swift');

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const HEAD_BOUNDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasPerson', 'headBottom'],
  properties: {
    hasPerson: { type: 'boolean' },
    headBottom: { type: 'number' },
  },
} as const;

export const HEAD_BOUNDS_PROMPT = [
  'Analyze the attached photo of a person. Return JSON only: {"hasPerson": boolean, "headBottom": number}.',
  'headBottom is the vertical fraction (0.0 = top edge, 1.0 = bottom edge) of the upright image right below the person\'s chin and neck, so cropping from headBottom to 1.0 keeps shoulders, torso, arms and legs while excluding ALL of the face, chin, ears and head.',
  'If no face/head is visible (already headless), set headBottom to 0. If there is no person, set hasPerson to false and headBottom to 0. Analysis only.',
].join('\n');

async function bodyCropSwift(dir: string, source: string, destination: string): Promise<boolean> {
  const input = path.join(dir, `bodycrop-${Date.now().toString(36)}.json`);
  fs.writeFileSync(input, JSON.stringify({ source, destination }), { mode: 0o600 });
  try {
    const { stdout } = await exec('/usr/bin/swift', [imageTool, 'bodycrop', input], { timeout: 90_000 });
    return Boolean(stdout.trim() && (JSON.parse(stdout) as { ok?: boolean }).ok);
  } finally {
    fs.rmSync(input, { force: true });
  }
}

/**
 * Cuts a verified face-free headless crop from the person's full-body photo, capped at 1536 px.
 * Uses Apple Vision in a single Swift call on macOS, and model-assisted head location + mandatory faceCheck on Linux.
 */
export async function prepareBodyCrop(opts: {
  sourceAbs: string;
  destAbs: string;
  jobDir: string;
  locateHead?: (previewFile: string) => Promise<{ hasPerson?: boolean; headBottom?: number } | null>;
  faceCheck?: FaceCheck;
  preferSharp?: boolean;
}): Promise<void> {
  const { sourceAbs, destAbs, jobDir, locateHead, faceCheck, preferSharp } = opts;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 });

  if (hasSwift && !preferSharp && process.env.CAPSULA_NO_SWIFT !== '1') {
    const ok = await bodyCropSwift(jobDir, sourceAbs, destAbs);
    if (ok && fs.existsSync(destAbs)) return;
    fs.rmSync(destAbs, { force: true });
    throw new Error('Не вдалося вирізати фігуру без обличчя — завантаж чітке фото в повний зріст без дзеркала');
  }

  const { data, info } = await sharp(sourceAbs).rotate().toBuffer({ resolveWithObject: true });

  const extractAt = async (topFrac: number) => {
    const top = Math.max(0, Math.min(info.height - 64, Math.round(topFrac * info.height)));
    const height = info.height - top;
    if (height < 64 || info.width < 48) throw new Error('Фото занадто мале для опори статури');
    await sharp(data)
      .extract({ left: 0, top, width: info.width, height })
      .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toFile(destAbs);
  };

  let startY = 0.22;
  // Non-macOS path (Linux container): locate chin/neck on upright preview, crop, and require faceCheck === [false].
  if (locateHead) {
    const preview = path.join(jobDir, 'body-preview.jpg');
    await sharp(data).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(preview);
    const ans = await locateHead(preview);
    fs.rmSync(preview, { force: true });
    if (ans && ans.hasPerson === false) throw new Error('На фото статури не видно людину — завантаж фото в повний зріст');
    const hb = Number(ans?.headBottom);
    if (Number.isFinite(hb) && hb >= 0 && hb <= 0.65) startY = hb === 0 ? 0 : Math.min(0.65, hb + 0.03);
  }
  if (!faceCheck) throw new Error('Немає перевірки обличчя для опори статури');
  for (const shift of [0, 0.08, 0.16]) {
    const y = Math.min(0.68, startY + shift);
    await extractAt(y);
    const faces = await faceCheck([destAbs]).catch(() => [true]);
    if (faces.length === 1 && faces[0] === false) return;
  }
  fs.rmSync(destAbs, { force: true });
  throw new Error('Не вдалося вирізати фігуру без обличчя — завантаж чітке фото в повний зріст');
}

const REPLY_RULES = [
  'When the PNG is saved at the path above, reply with JSON only: {"status":"done","notes":"<one short sentence on visible deviations>"}',
  'If image generation is unavailable or fails, reply with JSON only: {"status":"error","reason":"<why>"}',
];

/**
 * Prompt for generating one clean, frontal studio base portrait from the person's own face photo(s).
 * Keeps the exact `Task: create ONE …` and `referenced_image_paths` phrasing so both Codex and OpenAI API engines work seamlessly.
 */
export function buildPortraitPrompt(job: Job, resultFile: string, faceRefs: string[]): string {
  const inp = job.identityInput!;
  const refLine = `When you call the image generation tool, you MUST pass these exact files in its referenced_image_paths parameter (in this order): ${JSON.stringify(faceRefs)}. Attaching them to the conversation is not enough — without referenced_image_paths the generator never sees them.`;
  return [
    'You are the Capsula identity worker running unattended. Do exactly one task and finish.',
    `Task: create ONE photorealistic studio portrait with your built-in image generation tool and save it as a PNG file at this exact path: ${resultFile}`,
    refLine,
    '',
    'Use case: identity-preserve studio reference portrait. The attached image(s) are ORIGINAL photographs of the owner and the ONLY source for facial identity, hair and age.',
    'Generate a clean, natural head-and-shoulders reference portrait of THIS exact person: head upright and facing directly forward, both eyes open and looking straight into the camera, calm natural relaxed expression (not a grimace or exaggerated smile).',
    'Preserve exact facial outline, face width, cheekbones, jaw, chin, eyelids, eyes, eyebrows, nose, lips, ears, real skin texture, freckles/moles, apparent age, hair colour, hair texture and hairline. Do not beautify, smooth skin, de-age, slim or reshape the face.',
    inp.hairstyle ? `Owner hairstyle note: ${inp.hairstyle}. Keep original hair colour and natural density.` : 'Keep the owner\'s natural hairstyle from the reference photo, neat and unobstructed.',
    inp.noGlasses ? 'ABSOLUTELY NO GLASSES: no eyeglasses, sunglasses or frames anywhere on the face or head.' : 'Include glasses only if worn in the reference photo.',
    'Framing & lighting: head and upper shoulders centred with balanced margin above the head; plain crisp white crew-neck cotton tee; soft, even, neutral studio light with no harsh shadows; clean neutral off-white studio wall (#F2F1EE); sharp natural photographic focus; no text, watermarks, accessories or background clutter.',
    job.instructions ? `Owner feedback on previous attempt: ${job.instructions}` : '',
    '',
    ...REPLY_RULES,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function assertOwnedOriginal(db: DB, photoId: string, label: string): Photo {
  const p = db.photos.find((x) => x.id === photoId);
  if (!p) throw new HttpError(404, `${label} не знайдено`);
  if (p.source === 'generated' || p.inspiration || p.kind === 'worn') {
    throw new HttpError(400, `${label} має бути твоїм власним оригінальним фото`);
  }
  return p;
}

/** Queues an identity_prep job from the person's chosen face + full-body original photos. */
export function queueIdentityPrep(
  db: DB,
  input: { facePhotoId: string; bodyPhotoId: string; noGlasses?: boolean; hairstyle?: string; instructions?: string },
): Job {
  const face = assertOwnedOriginal(db, input.facePhotoId, 'Фото обличчя');
  const body = assertOwnedOriginal(db, input.bodyPhotoId, 'Фото статури');
  if (db.jobs.some((j) => j.kind === 'identity_prep' && (j.state === 'queued' || j.state === 'running'))) {
    throw new HttpError(409, 'Опора зовнішності вже готується — зачекай трохи');
  }
  // Mark face photo as face reference (and both as base originals) so they appear cleanly in Profile/Gallery.
  if (face.kind !== 'base') face.kind = 'base';
  face.referenceRole = 'face';
  if (body.kind !== 'base') body.kind = 'base';
  const earlier = db.jobs.filter((j) => j.kind === 'identity_prep').at(-1);
  const noGlasses = input.noGlasses !== undefined ? Boolean(input.noGlasses) : !db.profile.allowEyewear;
  const hairstyle = input.hairstyle?.trim().slice(0, 200) || undefined;
  const job: Job = {
    id: newId('J'),
    kind: 'identity_prep',
    lookVersion: 0,
    identityInput: { facePhotoId: face.id, bodyPhotoId: body.id, noGlasses, ...(hairstyle ? { hairstyle } : {}) },
    snapshot: {
      lookName: 'Базова опора',
      slots: [],
      basePhotoIds: [...new Set([face.id, body.id])],
      basePhotoPaths: [...new Set([face.path, body.path])],
    },
    instructions: (input.instructions ?? '').trim().slice(0, 400),
    state: 'queued',
    origin: 'site',
    retryOf: earlier?.id,
    createdAt: now(),
  };
  db.jobs.push(job);
  return job;
}

/** Saves the generated candidate portrait + headless body crop into onboarding.identityDraft for human review. */
export function applyIdentityDraft(
  db: DB,
  job: Job,
  files: { faceRel: string; bodyRel: string; projectRoot: string; dataDir: string; notes?: string },
): IdentityDraft {
  const inp = job.identityInput!;
  const facePhoto = assertOwnedOriginal(db, inp.facePhotoId, 'Фото обличчя');
  const bodyPhoto = assertOwnedOriginal(db, inp.bodyPhotoId, 'Фото статури');
  const hashed = (rel: string): HashedFile => ({ path: rel, sha256: sha256(resolveAllowed(files.projectRoot, files.dataDir, rel)) });
  const draft: IdentityDraft = {
    jobId: job.id,
    sourcePhotoId: facePhoto.id,
    bodyPhotoId: bodyPhoto.id,
    original: hashed(facePhoto.path),
    bodyOriginal: hashed(bodyPhoto.path),
    body: hashed(files.bodyRel),
    face: hashed(files.faceRel),
    noGlasses: inp.noGlasses,
    ...(inp.hairstyle ? { hairstyle: inp.hairstyle } : {}),
    ...(files.notes ? { notes: files.notes } : {}),
    createdAt: now(),
  };
  db.onboarding ??= {};
  db.onboarding.identityDraft = draft;
  db.onboarding.step ??= 1;
  return draft;
}

/** Promotes the human-approved identityDraft into live profile.identity after re-verifying SHA-256 hashes on disk. */
export function approveIdentityDraft(db: DB, projectRoot: string, dataDir: string): IdentityReference {
  const draft = db.onboarding?.identityDraft;
  if (!draft) throw new HttpError(404, 'Немає підготовленої опори для підтвердження');
  const facePhoto = assertOwnedOriginal(db, draft.sourcePhotoId, 'Фото обличчя');
  const bodyPhoto = assertOwnedOriginal(db, draft.bodyPhotoId, 'Фото статури');
  for (const f of [draft.original, draft.bodyOriginal, draft.body, draft.face]) {
    const abs = resolveAllowed(projectRoot, dataDir, f.path);
    if (!fs.existsSync(abs) || sha256(abs) !== f.sha256) {
      throw new HttpError(409, 'Файл опори змінився або зник — підготуй опору ще раз');
    }
  }
  const at = now();
  const ref: IdentityReference = {
    sourcePhotoId: facePhoto.id,
    original: draft.original,
    face: draft.face,
    approvedPortrait: { approvedAt: at, provisional: false },
    body: draft.body,
    bodyOriginal: draft.bodyOriginal,
    preserveHeadAngle: false,
    noGlasses: draft.noGlasses,
    ...(draft.hairstyle ? { hairstyle: draft.hairstyle } : {}),
    confirmedAt: at,
  };
  db.profile.identity = ref;
  db.profile.allowEyewear = !draft.noGlasses;
  for (const id of [facePhoto.id, bodyPhoto.id]) {
    if (!db.profile.basePhotoIds.includes(id)) db.profile.basePhotoIds.push(id);
  }
  db.profile.rev += 1;
  if (db.onboarding) {
    delete db.onboarding.identityDraft;
    db.onboarding.step = Math.max(db.onboarding.step ?? 1, 2) as 1 | 2 | 3 | 4 | 5;
  }
  return ref;
}
