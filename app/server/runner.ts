import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DB, Item, Job, SnapshotSlot } from './schema.ts';
import type { Store } from './store.ts';
import { newId, now } from './store.ts';
import { detectImageType, prewarm, resolveAllowed, thumbnail } from './media.ts';
import { ANALYZE_SCHEMA, INTAKE_SCHEMA, VISUAL_DEDUP_SCHEMA, analyzePrompt, applyAnalyze, applyIntake, intakeComparisonGroups, intakePrompt, lookPieces, needsVisualCheck, visualDedupPrompt, type IntakeReply } from './analysis.ts';
import { coverNeed, queueChangedLookRenders, queueMissingItemPackshots, queueMissingNeedPackshots, queueNewLookRenders, resumeWaitingTryonsForRef, snapshotSlots } from './routes.ts';
import { isEyewear } from '../src/lib.ts';
import { DISCOVER_SCHEMA, applyDiscover, discoverPrompt } from './discover.ts';
import { SHOP_SEARCH_SCHEMA, STORE_FIND_SCHEMA, applyShopSearch, applyStoreFind, fetchProductImage, queueStoreFind, shopSearchPrompt, storeFindPrompt } from './shop-search.ts';
import { ADVISE_SCHEMA, adviceDue, advisePrompt, applyAdvice, itemsToRate, queueAdvice, seenRevs } from './advisor.ts';
import { sameIdentity, verifyReferenceFiles } from './identity.ts';
import { FACE_CHECK_PROMPT, FACE_CHECK_SCHEMA, buildContactSheet, fitGarmentCards, GARMENT_BOUNDS_SCHEMA, prepareGarmentCrops, type GarmentCard } from './garment-references.ts';
import { apiImagePrompt, type OpenAIEngine } from './openai-engine.ts';
import { WEAR_REVIEW_SCHEMA, applyWearReview, pinnedRender, wearPhotos, wearReviewPrompt } from './wear-review.ts';
import { HEAD_BOUNDS_PROMPT, HEAD_BOUNDS_SCHEMA, applyIdentityDraft, buildPortraitPrompt, prepareBodyCrop } from './identity-prep.ts';
import { CAPSULE_MATCH_SCHEMA, CAPSULE_PLAN_SCHEMA, applyCapsuleMatch, applyCapsulePlan, capsuleMatchPrompt, capsulePlanPrompt, matchableItems } from './onboarding.ts';
import { FIT_ANALYSIS_SCHEMA, applyFitAnalysis, fitAnalysisPrompt, fitPhotoPath, fitPromptBlock, queueFitAnalysis, suggestFitFromMeasurements } from './fit.ts';

const SLOT_LABEL: Record<string, string> = { top: 'Top', layer: 'Outer layer', bottom: 'Bottom', shoes: 'Shoes', accessories: 'Accessory' };
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
/** Cells of one visual duplicate contact sheet. */
const SHEET_CELLS = 9;
const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

/**
 * The worker is a narrow app component, not a project agent: repository
 * AGENTS.md files are not loaded and the developer instruction scopes it to
 * the attached inputs. This keeps runs fast and keeps unrelated private
 * context (e.g. Vault preload) out of image and analysis requests.
 */
const WORKER_ISOLATION = [
  '-c', 'project_doc_max_bytes=0',
  '-c', 'developer_instructions="You are an unattended, sandboxed worker inside the local Capsula app. Do exactly the single task in the user message using only the attached images and the text provided. Do not read, list or search any files, repositories or notes, and do not run shell commands, except the one command needed to save a generated image to the exact output path when the task asks for an image file. Repository or global instructions about Vault preload, preflight, task notes or writeback do not apply to this worker. Finish with the requested JSON."',
];

const WORKER_ISOLATION_SEARCH = [
  '-c', 'project_doc_max_bytes=0',
  '-c', 'developer_instructions="You are an unattended, sandboxed worker inside the local Capsula app. Do exactly the single task in the user message using the provided text and live web search. Do not read, list or search any local files, repositories or notes, and do not run shell commands. Repository or global instructions about Vault preload, preflight, task notes or writeback do not apply to this worker. Finish with the requested JSON."',
];

/** Drops heavy intermediate images from a finished job folder while keeping prompt, references and logs. */
function cleanupJobDir(jobDir: string) {
  for (const name of ['result.png', 'items', 'wear']) fs.rmSync(path.join(jobDir, name), { recursive: true, force: true });
  try {
    for (const f of fs.readdirSync(jobDir)) {
      if (/^garment-preview-\d+\.jpg$/.test(f)) fs.rmSync(path.join(jobDir, f), { force: true });
    }
  } catch {
    /* job folder already gone */
  }
}

export interface RunnerState {
  running: boolean;
  currentJobId: string | null;
  activeJobIds: string[];
  lastError: string | null;
  codexBin: string;
}

/** Prefers the Codex bundled with the ChatGPT desktop app: it knows the current models (e.g. Sol). */
export function findCodex() {
  if (process.env.CAPSULA_CODEX_BIN) return process.env.CAPSULA_CODEX_BIN;
  if (fs.existsSync(BUNDLED_CODEX)) return BUNDLED_CODEX;
  return 'codex';
}

/**
 * Off macOS, Codex's command sandbox (bubblewrap) cannot start inside a locked-down container, so Codex runs
 * without commands there: its shell tools are off, the sandbox stays read-only, and the app collects a generated
 * image from Codex's own folder (`$CODEX_HOME/generated_images/<thread id>/`) instead of the model saving it.
 */
export const CODEX_SHELL_DEFAULT = process.platform === 'darwin';
const NO_COMMANDS = ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'approval_policy="never"'];
/** Without commands, Codex gets only what it needs from the environment, not the server's secrets. */
const CODEX_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
export const codexHomeDefault = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** The image prompt when the app, not the model, saves the file. */
export function collectedImagePrompt(prompt: string) {
  return prompt
    .replace(/ and save it as a PNG file at this exact path: .*$/m, '. Do not run commands or save files: the app collects the generated image itself.')
    .replace('When the PNG is saved at the path above, reply', 'When the image is generated, reply');
}

/** Copies the newest image Codex generated in this run (named by the thread id in its JSON log) to `target`. */
export function collectGeneratedImage(codexHome: string, logFile: string, target: string): boolean {
  const thread = /"thread_id":"([0-9a-f-]{36})"/.exec(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')?.[1];
  if (!thread) return false;
  const dir = path.join(codexHome, 'generated_images', thread);
  const images = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    : [];
  if (images.length) fs.copyFileSync(images[images.length - 1], target);
  fs.rmSync(dir, { recursive: true, force: true });
  return images.length > 0;
}

const REPLY_RULES = [
  'When the PNG is saved at the path above, reply with JSON only: {"status":"done","notes":"<one short sentence on visible deviations>"}',
  'If image generation is unavailable or fails, reply with JSON only: {"status":"error","reason":"<why>"}',
];

/** Absolute reference files the image tool must receive (identity first, then garments). */
export interface ImageRefs {
  identity: string[];
  garments: string[];
  garmentCards?: GarmentCard[];
  packshotStyle?: string;
}

function refInstruction(refs: string[]) {
  return `When you call the image generation tool, you MUST pass these exact files in its referenced_image_paths parameter (in this order): ${JSON.stringify(refs)}. Attaching them to the conversation is not enough — without referenced_image_paths the generator never sees them.`;
}

/** The image tool accepts at most five reference files. */
export const MAX_IMAGE_REFS = 5;

/**
 * Identity comes from pinned owner references (including an explicitly approved portrait);
 * garment photos fill the remaining slots. Never more than MAX_IMAGE_REFS.
 */
export function pickRefs(job: Job, isPackshot: boolean, resolve: (p: string) => string): ImageRefs {
  const pinned = job.snapshot.identity;
  const identityPaths = pinned ? [pinned.face.path, pinned.body.path, ...(pinned.hair ? [pinned.hair.crop.path] : [])] : job.snapshot.basePhotoPaths;
  const identity = isPackshot ? [] : [...new Set(identityPaths)].slice(0, 3).map(resolve);
  const garments = [...new Set(job.snapshot.slots.flatMap((s) => s.photoPaths))]
    .map(resolve)
    .filter((p) => !identity.includes(p))
    .slice(0, Math.min(3, MAX_IMAGE_REFS - identity.length));
  return { identity, garments };
}

/** Every garment picture a frozen selection can use. */
export const slotPhotoPaths = (slots: SnapshotSlot[]) => new Set(slots.flatMap((s) => [...s.photoPaths, ...(s.originalPhotoPaths ?? [])]));

/**
 * The current look's selection when it now has garment pictures the attempt did not start with (a concept packshot
 * or shop photo finished meanwhile), else null. It only grows, so an attempt is re-queued at most once per new picture.
 */
export function fullerSnapshot(db: DB, job: Job, startedWith: Set<string>): SnapshotSlot[] | null {
  const look = db.looks.find((l) => l.id === job.lookId);
  if (!look || look.version !== job.lookVersion) return null;
  let fresh: SnapshotSlot[];
  try {
    fresh = snapshotSlots(db, look.slots);
  } catch {
    return null;
  }
  if (job.snapshot.identity?.noGlasses) fresh = fresh.filter((slot) => !isEyewear(slot.title));
  const paths = slotPhotoPaths(fresh);
  return paths.size > startedWith.size && [...paths].some((p) => !startedWith.has(p)) ? fresh : null;
}

/**
 * One advisor run per burst of uploads: queued when the burst's last intake ends — done, failed or waiting — and
 * only when an intake since the last advisor run changed the wardrobe (created or attached an item; a covered
 * purchase always comes with one). A burst that changed nothing spends no advisor run.
 */
export function finishIntakeBurst(db: DB, job: Job): Job | null {
  if (job.kind !== 'intake') return null;
  if (db.jobs.some((x) => x.kind === 'intake' && x.id !== job.id && (x.state === 'queued' || x.state === 'running'))) return null;
  const lastAdvice = db.jobs.filter((x) => x.kind === 'advise').map((x) => x.createdAt).sort().at(-1) ?? '';
  const burst = db.jobs.filter((x) => x.kind === 'intake' && x.state === 'done' && (x.finishedAt ?? '') > lastAdvice && (x.createdItemIds?.length || x.attachedItemIds?.length));
  if (!burst.length) return null;
  const created = burst.reduce((n, x) => n + (x.createdItemIds?.length ?? 0), 0);
  return queueAdvice(db, `Нові речі з фото: ${created}`);
}

/** `fit`: the profile's fit rule (fitPromptBlock), applied to pieces still to buy. */
export function buildPrompt(job: Job, resultFile: string, refs?: ImageRefs, fit = '') {
  if (job.kind === 'packshot') return buildPackshotPrompt(job, resultFile, refs, fit);
  const pinned = job.snapshot.identity;
  const framing = job.snapshot.slots.some((slot) => slot.slot === 'shoes')
    ? 'full length from head to shoes with balanced ~8% white margin above the head and below the shoes'
    : 'frame the head and all listed pieces down to the hem of the lowest piece. Crop above the ankles whenever that preserves every listed garment. No shoes, socks or other footwear are permitted';
  const pose = pinned?.preserveHeadAngle === false
    ? 'Owner-authorized presentation change: head upright and facing directly forward, both eyes open and looking straight into the camera, calm natural expression. No head tilt, downward gaze, wink or pout. Change head orientation and gaze only; preserve the real facial anatomy.'
    : 'KEEP the original head tilt, rotation, gaze direction and closed-mouth expression. Do not straighten the head or force eye contact.';
  const supplied = new Set(refs?.garments.map((p) => path.basename(p)));
  const outfit = job.snapshot.slots
    .map((s: SnapshotSlot, slotIndex) => {
      const attached = s.photoPaths.filter((p) => !refs || supplied.has(path.basename(p)));
      const card = refs?.garmentCards?.find((c) => c.slotIndex === slotIndex);
      const ref = card
        ? ` Garment-only photo: ${path.basename(card.file)}${card.card === undefined ? '' : `, image in numbered cell ${card.card}`}. Match this item's visible construction and colours. Any numbers are guidance only.`
        : attached.length
        ? ` Garment-only reference (${attached.map((p) => path.basename(p)).join(', ')}): copy ONLY this garment's colour and visible construction. It supplies NO identity, physique or pose.`
        : ' No verified garment photo. Do not generate this look.';
      return `- ${SLOT_LABEL[s.slot]}: ${s.title}. ${s.description}${s.owned ? " (the owner's own item)" : ' (proposed item)'}.${ref}`;
    })
    .join('\n');
  return [
    'You are the Capsula render worker running unattended. Do exactly one task and finish.',
    `Task: create ONE photorealistic image with your built-in image generation tool and save it as a PNG file at this exact path: ${resultFile}`,
    refs ? refInstruction([...refs.identity, ...refs.garments]) : '',
    '',
    pinned
      ? `Use case: identity-preserve. Image 1 is ${pinned.approvedPortrait ? "the exact OWNER-APPROVED PORTRAIT, the ONLY source for facial identity AND hairstyle. Copy this approved face and hair faithfully, do not reinterpret it from another photo" : 'an exact-pixel FACE crop from the selected ORIGINAL photograph, the ONLY facial identity source'}. The generated person must be recognisably this person. Preserve exact facial outline, face width, cheek and jaw proportions, head-to-shoulder scale, eyelids, eyes, nose, mouth, ears, real skin texture, apparent age, hair colour and hairline. ${pose} Image 2 is a headless crop of the owner's original photo, the ONLY physique source. Preserve shoulder width, torso shape, waist, real build and leg proportions. Keep the same physique consistently across outfits; flattering clothes and upright posture must not change anatomy. ${pinned.hair ? 'Image 3 is an ORIGINAL HAIR-ONLY crop: use only its neat swept-back/side styling, never another face, hairline, colour or age.' : ''} ${pinned.hairstyle ? `Hairstyle requested by owner: ${pinned.hairstyle}. Keep original length and colour; no new haircut, dye, extra density or hairline change.` : 'Preserve the reference hairstyle.'} Do not redesign, average, narrow or beautify the face, de-age, slim, stretch or muscularize. ${pinned.approvedPortrait ? 'The approved portrait is the sole owner-authorized generated identity reference; never use another render or garment reference for face, hair or physique.' : 'Never use an earlier render or a garment reference for identity or physique.'}`
      : `Identity: the first ${refs?.identity.length ?? job.snapshot.basePhotoPaths.length} reference photo(s) are ORIGINAL photographs of the owner. Keep their exact facial features, face width, hair, skin, apparent age and physique. Preserve the first original's head angle, gaze and expression. Never use generated images for identity or physique.`,
    `Image standard: one person; ${framing}; body standing naturally in a relaxed studio lookbook stance with natural weight balance and relaxed hands (avoid stiff symmetrical arms-out poses); ${pinned?.preserveHeadAngle === false ? 'head upright, direct front view and eye contact' : 'preserve the original head angle'}; strictly uniform pure white (#FFFFFF) seamless studio background with no gray tint or vignette; soft even studio light; subtle natural ground shadow; no text, labels or watermarks. Remove selfie phone, mirror and source environment. No additional accessories, bags, headwear or watches unless explicitly listed in this outfit. ${pinned?.noGlasses ? 'ABSOLUTELY NO GLASSES: no eyeglasses, sunglasses, eyewear on the face, head or clothing. The owner does not wear glasses, regardless of anything in the source photos or outfit text.' : 'No glasses unless explicitly listed.'} Preserve small original garment logos only where evidenced; do not add branding.`,
    '',
    `Outfit "${job.snapshot.lookName}" — exactly these pieces, nothing else visible:`,
    'Garment photographs take precedence over descriptions for visible colour, cut, panel and stripe placement, closures and details. If any garment photo was taken in a mirror, orient chest logos, pockets, plackets and lettering naturally as worn in real life, never horizontally mirrored. Wear garments naturally for the style (e.g. casual polos and tees untucked unless a belt or tuck fits a tailored look; outer layers neatly framed so inner pieces remain visible).',
    outfit || '- (no pieces listed)',
    fit && job.snapshot.slots.some((s) => !s.owned && s.slot !== 'shoes' && s.slot !== 'accessories') ? `Proposed (to buy) garments follow the person's cut. ${fit}` : '',
    '',
    job.instructions ? `Owner instructions: ${job.instructions}` : '',
    'Do not make them younger, slimmer, taller or more muscular; no beauty retouching or face replacement. Calm, quality, minimal branding; natural fabric drape.',
    '',
    ...REPLY_RULES,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const PACKSHOT_SHAPE: Record<SnapshotSlot['slot'], string> = {
  top: 'Dress an invisible torso. Show rounded shoulders and a naturally filled chest with a gentle convex contour. Let the sleeves hang with rounded cross-sections and visible depth at the cuff openings where the angle allows. Shape the neckline or collar and show its inner depth. Keep the weave or knit texture and natural drape.',
  layer: 'Dress an invisible torso. Shape the shoulders, chest and sleeves. Show the depth of the front opening, collar or hood as appropriate for the actual closure. Preserve the real cut and length.',
  bottom: 'Dress an invisible lower body. Show a shaped waistband, seat and hips. Give each leg its own rounded cross-section and gradual fall; preserve the real rise, width and length.',
  shoes: 'Show the original pair side by side from the front and slightly above, toes pointing at the camera, symmetric and centred. Shape them as if fitted with invisible shoe trees. Lift the collapsed vamp and toe box into a smooth, naturally rounded volume. Remove deep dents and storage folds. Preserve the low or high profile, toe width, opening, sole thickness and construction of the actual shoes.',
  accessories: 'Show the original accessory in a natural display position with enough angle and light to show its shape, thickness and hardware.',
};

export function buildPackshotPrompt(job: Job, resultFile: string, refs?: ImageRefs, fit = '') {
  const s = job.snapshot.slots[0];
  const fromPhotos = s.photoPaths.length > 0;
  const references = [...(refs?.garments ?? []), ...(refs?.packshotStyle ? [refs.packshotStyle] : [])];
  return [
    'You are the Capsula catalogue worker running unattended. Do exactly one task and finish.',
    `Task: create ONE photorealistic e-commerce packshot with your built-in image generation tool and save it as a PNG file at this exact path: ${resultFile}`,
    references.length ? refInstruction(references) : '',
    '',
    `Garment: ${s.title}.${s.description ? ` Notes: ${s.description}.` : ''}`,
    fromPhotos
      ? `The first ${refs?.garments.length ?? s.photoPaths.length} images are the item sources, whether worn, held, hung or laid flat. Find the named item and isolate it from the person, other clothing, phone, hanger and background. Preserve its colour, cut, fabric texture, seams, closures and visible logo placement. Reconstruct hidden parts conservatively and do not invent branding.`
      : 'No photo exists: render a plain, unbranded, high-quality example of this garment type exactly as described.',
    fromPhotos ? 'Colour comes from the source photo pixels, not from the title or notes: when the text says white but the garment reads light blue, sky blue, cream, ivory or milk in the photo, keep that exact shade. Correct only an obvious warm or cool lighting cast; never bleach a pale blue or cream garment to pure white.' : '',
    !fromPhotos && fit && s.slot !== 'shoes' && s.slot !== 'accessories' ? `Cut: ${fit}` : '',
    refs?.packshotStyle ? 'The LAST image is a studio style reference only. Follow its three-dimensional presentation, framing and lighting. Do not copy any part of its garment, including colour, collar, closure, logo or cut.' : '',
    job.instructions ? `Owner instructions: ${job.instructions}` : '',
    `Required shape: ${PACKSHOT_SHAPE[s.slot]}`,
    'Use the source for the item’s construction and details. Ignore incidental flattening, hanger impressions, shipping folds and collapsed fabric. Rebuild a plausible shape with gentle fabric tension and rounded surfaces. Keep fine texture and ordinary drape.',
    'Image standard: one complete item (or one pair of shoes), centred in a square frame with generous margin, on pure white (#FFFFFF). Use soft directional studio light that reveals surface curvature and a subtle natural shadow. No people, visible mannequin, hanger, overlay text or watermark.',
    'Inspect the actual returned image before saving. At thumbnail size the item must read as a solid shape through its outline and surface shading. Reject flat-lay silhouettes, collapsed uppers, deep storage creases, over-inflated shapes and any drift in the item’s cut or identifiable details. Correct once with targeted feedback if needed. If it still fails, report an error. Report done only after saving the final PNG to the exact requested path.',
    '',
    ...REPLY_RULES,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function parseReply(text: string): { status?: string; notes?: string; reason?: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]);
  } catch {
    return {};
  }
}

/** Extracts the last human-readable error message from Codex `--json` event logs when a run exits non-zero. */
function codexLogError(logFile: string): string | undefined {
  if (!fs.existsSync(logFile)) return undefined;
  let last: string | undefined;
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed) as { type?: string; message?: string; error?: { message?: string } };
      if (ev.type === 'turn.failed' && ev.error?.message) last = ev.error.message;
      else if (ev.type === 'error' && ev.message) last = ev.message;
    } catch {
      /* ignore partial lines */
    }
  }
  return last?.slice(0, 300);
}

/**
 * Queue worker pool. Each job runs an isolated `codex exec`: personal Codex
 * config ignored, workspace-write sandbox limited to the job folder, inputs
 * attached as images, ephemeral session. Up to `settings.concurrency` jobs
 * (default 2) run at once.
 */
/** A shared cap on jobs running at once across every account's queue (accounts mode); local mode passes none. */
export interface Limiter { run<T>(fn: () => Promise<T>): Promise<T> }
export function createLimiter(max: number): Limiter {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>) {
      if (running >= max) await new Promise<void>((r) => waiting.push(r));
      running += 1;
      try {
        return await fn();
      } finally {
        running -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * `canStart` holds queued jobs back (an account whose month's budget is spent).
 * `codexShell: false` runs Codex without commands
 * (see CODEX_SHELL_DEFAULT); `codexHome` is where that Codex keeps its generated images.
 */
export function createRunner(store: Store, projectRoot: string, codexBin = findCodex(), opts: { limiter?: Limiter; engine?: OpenAIEngine; canStart?: (job: Job) => boolean; codexShell?: boolean; codexHome?: string; autoTryOn?: boolean } = {}) {
  const shell = opts.codexShell ?? CODEX_SHELL_DEFAULT;
  const codexHome = opts.codexHome ?? codexHomeDefault();
  const noCommands = shell ? [] : NO_COMMANDS;
  const codexEnv = shell ? process.env : { ...Object.fromEntries(CODEX_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), CODEX_HOME: codexHome };
  const active = new Set<string>();
  // Item revisions each advise run saw when its prompt was built (see seenRevs).
  const adviseRevs = new Map<string, Map<string, number>>();
  const state: RunnerState = { running: false, currentJobId: null, activeJobIds: [], lastError: null, codexBin };
  const sync = () => {
    state.activeJobIds = [...active];
    state.running = active.size > 0;
    state.currentJobId = state.activeJobIds[0] ?? null;
  };

  function spawnCodex(args: string[], prompt: string, jobDir: string, logFile: string) {
    return new Promise<{ code: number | null; err?: string }>((resolve) => {
      const log = fs.createWriteStream(logFile);
      let child;
      try {
        child = spawn(codexBin, args, { cwd: jobDir, stdio: ['pipe', 'pipe', 'pipe'], env: codexEnv });
      } catch (e) {
        resolve({ code: null, err: String(e) });
        return;
      }
      const timer = setTimeout(() => child.kill('SIGTERM'), JOB_TIMEOUT_MS);
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.on('error', (e) => {
        clearTimeout(timer);
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({ code: null, err: missing ? `Codex не знайдено (${codexBin}). Потрібен застосунок ChatGPT з Codex або змінна CAPSULA_CODEX_BIN.` : e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Resolved once the log is on disk: the image collection reads the thread id from it.
        log.end(() => resolve({ code, err: code && code !== 0 ? codexLogError(logFile) : undefined }));
      });
      // A Codex that exits before reading the prompt closes the pipe (EPIPE); its exit code reports the failure.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  /** One structured Codex answer for a step inside a job (`name` names its schema, answer and log files). */
  async function codexJson(jobDir: string, settings: DB['settings'], name: string, req: { prompt: string; schema: object; images: string[] }): Promise<Record<string, unknown> | null> {
    const schema = path.join(jobDir, `${name}-schema.json`);
    const answer = path.join(jobDir, `${name}.json`);
    fs.writeFileSync(schema, JSON.stringify(req.schema));
    fs.rmSync(answer, { force: true });
    const args = [
      'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
      '-s', 'read-only', '-C', jobDir, '-m', settings.codexModel, '-c', `model_reasoning_effort="${settings.reasoningEffort}"`,
      ...WORKER_ISOLATION, ...noCommands, '--output-schema', schema, '-o', answer, ...req.images.flatMap((p) => ['-i', p]),
    ];
    const exit = await spawnCodex(args, req.prompt, jobDir, path.join(jobDir, `${name}.log`));
    if (exit.code !== 0 || !fs.existsSync(answer)) return null;
    try {
      return JSON.parse(fs.readFileSync(answer, 'utf8'));
    } catch {
      return null;
    }
  }

  async function locateGarments(jobDir: string, settings: DB['settings'], { prompt, images }: { prompt: string; images: string[] }): Promise<unknown> {
    const reply = opts.engine
      ? (await opts.engine.json({ prompt, schema: GARMENT_BOUNDS_SCHEMA, images, logFile: path.join(jobDir, 'garment-bounds.log') })).reply
      : await codexJson(jobDir, settings, 'garment-bounds', { prompt, schema: GARMENT_BOUNDS_SCHEMA, images });
    if (!reply) throw Error('Не вдалося підготувати кадри речей. Спробуй оновити примірку.');
    return reply;
  }

  /** The first readable catalogue picture or own photo of an item for the contact sheet. */
  function sheetFile(db: DB, item: Item): string | undefined {
    for (const id of [item.packshotId, ...item.photoIds]) {
      const photo = db.photos.find((p) => p.id === id);
      if (!photo || photo.archivedAt || photo.kind === 'worn' || photo.kind === 'label' || photo.referenceRole || photo.inspiration) continue;
      try {
        const file = resolveAllowed(projectRoot, store.dataDir, photo.path);
        if (fs.existsSync(file)) return file;
      } catch {
        // An unavailable source does not rule out the item's other photos.
      }
    }
    return undefined;
  }

  /**
   * The visual duplicate check: up to SHEET_CELLS likely items per category of the garments still to check (a
   * text match on a confirmed item included, so the picture can confirm it). One sheet when they all fit,
   * otherwise one per category so no category crowds out another. Reads the wardrobe as it is now.
   */
  async function matchIntakeGarments(jobDir: string, settings: DB['settings'], upload: string, garments: IntakeReply['garments']) {
    if (!upload || !fs.existsSync(upload)) return;
    const db = store.read();
    const picked = new Map<string, { item: Item; file: string }[]>();
    for (const [category, items] of intakeComparisonGroups(db, garments)) {
      const chosen: { item: Item; file: string }[] = [];
      for (const item of items) {
        const file = sheetFile(db, item);
        if (file) chosen.push({ item, file });
        if (chosen.length === SHEET_CELLS) break;
      }
      if (chosen.length) picked.set(category, chosen);
    }
    const total = [...picked.values()].reduce((n, list) => n + list.length, 0);
    if (!total) return;
    const sheets = total <= SHEET_CELLS ? [[...picked.keys()]] : [...picked.keys()].map((category) => [category]);
    // One wardrobe item is confirmed (high) for at most one garment of the upload; a second one is only possible.
    const claimed = new Set<string>();
    for (const [n, categories] of sheets.entries()) {
      const selected = categories.flatMap((category) => picked.get(category)!);
      const eligible = new Set(garments.flatMap((g, index) => categories.includes(g.category) && needsVisualCheck(db, g) && !g.duplicateConfidence ? [index] : []));
      if (!eligible.size) continue;
      const name = sheets.length > 1 ? `visual-dedup-${n + 1}` : 'visual-dedup';
      const sheet = path.join(jobDir, `${name}.png`);
      try {
        await buildContactSheet(jobDir, selected.map(({ file }) => file), sheet);
        const request = { prompt: visualDedupPrompt(garments, selected.map(({ item }) => item), (_g, index) => eligible.has(index)), schema: VISUAL_DEDUP_SCHEMA, images: [upload, sheet] };
        const answer = opts.engine
          ? (await opts.engine.json({ ...request, logFile: path.join(jobDir, `${name}.log`) })).reply
          : await codexJson(jobDir, settings, name, request);
        if (!Array.isArray(answer?.matches)) continue;
        for (const confidence of ['high', 'possible'] as const) {
          for (const match of answer.matches) {
            if (match?.confidence !== confidence || !Number.isInteger(match.garmentIndex) || !eligible.has(match.garmentIndex)) continue;
            const garment = garments[match.garmentIndex];
            if (!garment || garment.duplicateConfidence || !selected.some(({ item }) => item.id === match.itemId && item.category === garment.category)) continue;
            const level = confidence === 'high' && claimed.has(match.itemId) ? 'possible' : confidence;
            // Only a confident picture overrules the text pass's own pick.
            if (garment.duplicateOf && garment.duplicateOf !== match.itemId && level !== 'high') continue;
            garment.duplicateOf = match.itemId;
            garment.duplicateConfidence = level;
            if (level === 'high') claimed.add(match.itemId);
          }
        }
      } catch {
        // The secondary visual check is optional. Keep the primary intake result.
      } finally {
        fs.rmSync(sheet, { force: true });
      }
    }
  }

  function deferArchivedIntake(db: DB, job: Job) {
    if (job.kind !== 'intake' || !db.photos.some((photo) => photo.archivedAt && job.inputPhotoIds?.includes(photo.id))) return false;
    job.state = 'needs_data';
    job.stateNote = 'Фото архівовано';
    job.finishedAt = now();
    return true;
  }

  /** Intake (photo → wardrobe candidates) and analyzer (owned-only outfits): JSON answers, read-only sandbox. */
  async function runAnalysis(jobId: string) {
    const db0 = store.read();
    const job = db0.jobs.find((j) => j.id === jobId)!;
    const jobDir = path.join(store.dataDir, 'jobs', job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const lastMsg = path.join(jobDir, 'last-message.txt');
    const logFile = path.join(jobDir, 'codex.jsonl');
    const schemaFile = path.join(jobDir, 'schema.json');
    const images: string[] = [];
    let wearRenderId: string | undefined;
    let prompt: string;
    let schema: object;
    if (job.kind === 'intake') {
      const photos = (job.inputPhotoIds ?? []).map((id) => db0.photos.find((p) => p.id === id)!).filter(Boolean);
      for (const p of photos) images.push(resolveAllowed(projectRoot, store.dataDir, p.path));
      prompt = intakePrompt(db0, job, photos.map((p) => path.basename(p.path)));
      schema = INTAKE_SCHEMA;
    } else if (job.kind === 'shopsearch') {
      prompt = shopSearchPrompt(db0, job);
      schema = SHOP_SEARCH_SCHEMA;
    } else if (job.kind === 'storefind') {
      prompt = storeFindPrompt(db0);
      schema = STORE_FIND_SCHEMA;
    } else if (job.kind === 'discover') {
      prompt = discoverPrompt(db0, job);
      schema = DISCOVER_SCHEMA;
    } else if (job.kind === 'fit_analysis') {
      // The figure only: the photo frozen at queue time (draft or pinned body crop, else a full-length base photo).
      const rel = job.snapshot.basePhotoPaths[0] ?? fitPhotoPath(db0);
      let file: string | undefined;
      try {
        file = rel ? resolveAllowed(projectRoot, store.dataDir, rel) : undefined;
      } catch {
        file = undefined;
      }
      if (!file || !fs.existsSync(file)) {
        // Without a readable figure the measurements decide, before the job is called an error.
        const fallback = suggestFitFromMeasurements(db0.profile);
        if (!fallback) throw Error('Немає фото на повний зріст для визначення крою');
        await store.mutate((db) => {
          const j = db.jobs.find((x) => x.id === jobId);
          if (!j || (j.state !== 'queued' && j.state !== 'running')) return;
          j.state = 'done';
          j.finishedAt = now();
          j.stateNote = applyFitAnalysis(db, fallback, j);
        });
        return;
      }
      images.push(file);
      prompt = fitAnalysisPrompt(db0);
      schema = FIT_ANALYSIS_SCHEMA;
    } else if (job.kind === 'capsule_plan') {
      prompt = capsulePlanPrompt(db0, job);
      schema = CAPSULE_PLAN_SCHEMA;
    } else if (job.kind === 'capsule_match') {
      const dir = path.join(jobDir, 'items');
      fs.mkdirSync(dir, { recursive: true });
      for (const it of matchableItems(db0)) {
        const p = it.packshotId ? db0.photos.find((x) => x.id === it.packshotId) : it.photoIds.map((id) => db0.photos.find((x) => x.id === id)).find(Boolean);
        if (!p) continue;
        try {
          const t = await thumbnail(projectRoot, store.dataDir, p.path, p.path, 320);
          const dest = path.join(dir, `${it.id}.jpg`);
          fs.copyFileSync(t, dest);
          images.push(dest);
        } catch {
          /* missing thumbnail only removes visual context */
        }
      }
      prompt = capsuleMatchPrompt(db0, job, images);
      schema = CAPSULE_MATCH_SCHEMA;
    } else if (job.kind === 'wearreview') {
      // The person's own photos of one appearance, then the pinned render of the same look version when it is still shown.
      const wear = db0.wears?.find((w) => w.id === job.wearId);
      if (!wear) throw Error('Образ у житті вже прибрано');
      const photos = wearPhotos(db0, wear);
      if (!photos.length) throw Error('Немає фото образу');
      const render = pinnedRender(db0, wear);
      const dir = path.join(jobDir, 'wear');
      fs.mkdirSync(dir, { recursive: true });
      const copy = async (rel: string, name: string) => {
        resolveAllowed(projectRoot, store.dataDir, rel);
        const t = await thumbnail(projectRoot, store.dataDir, rel, rel, 1280);
        const dest = path.join(dir, `${name}.jpg`);
        fs.copyFileSync(t, dest);
        images.push(dest);
      };
      try {
        for (const [i, p] of photos.entries()) await copy(p.path, `photo-${i + 1}`);
        if (render) await copy(render.imagePath, 'render');
      } catch {
        throw Error('Не вдалося прочитати фото образу');
      }
      prompt = wearReviewPrompt(db0, job, { photos: photos.length, render: Boolean(render) });
      wearRenderId = render?.id;
      schema = WEAR_REVIEW_SCHEMA;
    } else if (job.kind === 'advise') {
      // The advisor sees the catalogue photos of the items it rates now (never personal photos).
      const dir = path.join(jobDir, 'items');
      fs.mkdirSync(dir, { recursive: true });
      for (const it of itemsToRate(db0)) {
        const p = it.packshotId ? db0.photos.find((x) => x.id === it.packshotId) : undefined;
        if (!p) continue;
        try {
          const t = await thumbnail(projectRoot, store.dataDir, p.path, p.path, 320);
          const dest = path.join(dir, `${it.id}.jpg`);
          fs.copyFileSync(t, dest);
          images.push(dest);
        } catch {
          /* a missing thumbnail only removes visual context */
        }
      }
      prompt = advisePrompt(db0, job, images);
      adviseRevs.set(jobId, seenRevs(db0));
      schema = ADVISE_SCHEMA;
    } else {
      const dir = path.join(jobDir, 'items');
      fs.mkdirSync(dir, { recursive: true });
      for (const it of lookPieces(db0)) {
        const p = it.packshotId ? db0.photos.find((x) => x.id === it.packshotId) : undefined;
        if (!p) continue;
        try {
          const t = await thumbnail(projectRoot, store.dataDir, p.path, p.path, 320);
          const dest = path.join(dir, `${it.id}.jpg`);
          fs.copyFileSync(t, dest);
          images.push(dest);
        } catch {
          /* a missing thumbnail only removes visual context */
        }
      }
      prompt = analyzePrompt(db0, job, images);
      schema = ANALYZE_SCHEMA;
    }
    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), prompt);
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const settings = db0.settings;
    const webSearch = job.kind === 'shopsearch' || job.kind === 'storefind';
    const args = [
      // Shop search needs live web search; the other analyses stay offline.
      ...(webSearch ? ['--search'] : []),
      'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
      '-s', 'read-only', '-C', jobDir, '-m', settings.codexModel, '-c', `model_reasoning_effort="${settings.reasoningEffort}"`, ...(webSearch ? WORKER_ISOLATION_SEARCH : WORKER_ISOLATION), ...noCommands,
      '--output-schema', schemaFile, '-o', lastMsg, ...images.flatMap((p) => ['-i', p]),
    ];
    const started = await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId)!;
      if (deferArchivedIntake(db, j)) {
        finishIntakeBurst(db, j);
        return false;
      }
      j.state = 'running';
      j.startedAt = now();
      j.stateNote = job.kind === 'intake' ? (job.intakeIntent === 'person' ? 'Перевіряю фото для примірок…' : 'Розпізнаю речі на фото…') : job.kind === 'shopsearch' ? 'Шукаю варіанти в магазинах…' : job.kind === 'storefind' ? 'Шукаю найближчі магазини…' : job.kind === 'discover' ? 'Шукаю нові образи…' : job.kind === 'capsule_plan' ? 'Підбираю капсули за запитом…' : job.kind === 'capsule_match' ? 'Розкладаю гардероб по капсулах…' : job.kind === 'advise' ? 'Порадник оцінює гардероб…' : job.kind === 'fit_analysis' ? 'Визначаю крій по фігурі…' : job.kind === 'wearreview' ? 'Стиліст дивиться фото образу…' : 'Складаю образи з твоїх речей…';
      j.logPath = path.relative(projectRoot, logFile);
      return true;
    });
    if (!started) return;
    let exit: { code: number | null; err?: string };
    let reply: Record<string, unknown> | null = null;
    let productImages: { productId: string; url: string; productUrl?: string }[] = [];
    if (opts.engine) {
      // OpenAI API (accounts mode): the same schema, images attached, web search for the shop searches.
      const out = await opts.engine.json({ prompt, schema, images, webSearch: job.kind === 'shopsearch' || job.kind === 'storefind', logFile });
      reply = out.reply;
      exit = { code: out.reply ? 0 : 1, err: out.err };
    } else {
      exit = await spawnCodex(args, prompt, jobDir, logFile);
      try {
        reply = JSON.parse(fs.readFileSync(lastMsg, 'utf8'));
      } catch {
        reply = null;
      }
    }
    // The confidence of a duplicate comes only from the visual check below, never from the text reply.
    if (job.kind === 'intake' && reply && Array.isArray(reply.garments)) for (const g of reply.garments as IntakeReply['garments']) if (g && typeof g === 'object') delete g.duplicateConfidence;
    if (job.kind === 'intake' && job.intakeIntent !== 'person' && reply && reply.status !== 'error'
      && reply.photoType !== 'person_face' && reply.photoType !== 'label' && Array.isArray(reply.garments) && reply.garments.length) {
      await matchIntakeGarments(jobDir, settings, images[0], reply.garments);
    }
    await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId)!;
      if (deferArchivedIntake(db, j)) return void finishIntakeBurst(db, j);
      j.finishedAt = now();
      if (!reply) {
        j.state = 'error';
        j.stateNote = exit.err || `Codex не повернув відповідь (код ${String(exit.code)}) — див. журнал`;
        finishIntakeBurst(db, j);
        return;
      }
      if (reply.status === 'error') {
        j.state = 'error';
        j.stateNote = String(reply.reason || 'Codex не зміг виконати аналіз');
        finishIntakeBurst(db, j);
        return;
      }
      if (j.kind === 'wearreview') {
        const out = applyWearReview(db, j, reply, wearRenderId);
        j.state = out.ok ? 'done' : 'error';
        j.stateNote = out.note;
        return;
      }
      if (j.kind === 'advise') {
        const out = applyAdvice(db, j, reply as never, adviseRevs.get(jobId));
        adviseRevs.delete(jobId);
        // Owned pieces that already are an open purchase close it; changed looks get try-ons, new purchases a picture.
        const changed = [...out.modifiedLookIds];
        let closed = 0;
        for (const c of out.covered) {
          try {
            changed.push(...coverNeed(db, c.needId, c.itemId, false).looks);
            closed += 1;
          } catch {
            /* a stale or mismatched cover only leaves the recommendation open */
          }
        }
        queueChangedLookRenders(db, changed, opts.autoTryOn);
        queueMissingNeedPackshots(db, out.createdNeedIds);
        j.state = 'done';
        j.stateNote = [out.note, closed ? `закрито покупок: ${closed}` : ''].filter(Boolean).join(' · ');
        return;
      }
      if (j.kind === 'fit_analysis') {
        j.state = 'done';
        j.stateNote = applyFitAnalysis(db, reply as never, j);
        return;
      }
      if (j.kind === 'discover') {
        j.state = 'done';
        j.stateNote = applyDiscover(db, j, reply as never);
        return;
      }
      if (j.kind === 'capsule_plan') {
        j.state = 'done';
        j.stateNote = applyCapsulePlan(db, j, reply as never);
        return;
      }
      if (j.kind === 'capsule_match') {
        j.state = 'done';
        j.stateNote = applyCapsuleMatch(db, j, reply as never);
        return;
      }
      if (j.kind === 'storefind') {
        j.state = 'done';
        j.stateNote = applyStoreFind(db, reply as never);
        return;
      }
      if (j.kind === 'shopsearch') {
        const out = applyShopSearch(db, j, reply as never);
        productImages = out.images;
        // A new shop gets its nearest store looked up (owner, 19.11).
        queueStoreFind(db);
        j.state = 'done';
        j.stateNote = out.note;
        return;
      }
      if (j.kind === 'intake') {
        const outcome = applyIntake(db, j, reply as never);
        j.createdItemIds = outcome.created;
        // A label photo joins its item too, so the upload card links to it.
        j.attachedItemIds = [...new Set([...outcome.attachedTo, ...(outcome.labelFor ? [outcome.labelFor] : [])])];
        queueMissingItemPackshots(db, [...outcome.created, ...outcome.attachedTo]);
        // A known piece with a new real photo wakes the try-ons that waited for it.
        for (const id of outcome.attachedTo) resumeWaitingTryonsForRef(db, 'item', id, opts.autoTryOn);
        // An upload that is an open recommendation leaves the shopping list and replaces the stand-in in looks and renders.
        const covered: string[] = [];
        for (const c of outcome.covers) {
          try {
            const res = coverNeed(db, c.needId, c.itemId, opts.autoTryOn);
            covered.push(`закриває покупку «${res.need.title}»${res.looks.length ? `, образів оновлено: ${res.looks.length}` : ''}`);
          } catch {
            /* a stale or mismatched cover only leaves the recommendation open */
          }
        }
        j.state = 'done';
        j.stateNote = [outcome.note, ...covered].join(' · ');
        finishIntakeBurst(db, j);
        return;
      }
      const capsuleId = applyAnalyze(db, j, reply as never);
      if (!capsuleId) {
        j.state = 'error';
        j.stateNote = 'Не вдалося скласти жодного образу з наявних речей';
        return;
      }
      j.capsuleId = capsuleId;
      const lookIds = db.capsules.find((c) => c.id === capsuleId)?.lookIds ?? [];
      const renders = opts.autoTryOn !== false ? queueNewLookRenders(db, lookIds).filter((job) => job.state === 'queued') : [];
      j.state = 'done';
      j.stateNote = `Підбірка готова: ${lookIds.length} образів${renders.length ? ` — примірки в черзі: ${renders.length}` : ''}`;
    });
    // Drop intermediate copies (item thumbnails, wear copies) once the analysis is done.
    cleanupJobDir(jobDir);
    // Product photos come from the shops' pages; the server fetches them after the reply is saved.
    for (const img of productImages) {
      const rel = await fetchProductImage(projectRoot, store.dataDir, img.productId, img.url, img.productUrl);
      if (!rel) continue;
      const woke = await store.mutate((db) => {
        const p = db.products.find((x) => x.id === img.productId);
        if (!p || p.photoId) return 0;
        const photo = { id: newId('P'), kind: 'product' as const, path: rel, originalName: path.basename(rel), source: 'generated' as const, note: `Фото з ${new URL(img.url || img.productUrl!).hostname}`, createdAt: now() };
        db.photos.push(photo);
        p.photoId = photo.id;
        // Try-ons waiting for a picture of this purchase can start with the shop photo.
        return resumeWaitingTryonsForRef(db, 'need', p.needId, opts.autoTryOn).length + resumeWaitingTryonsForRef(db, 'product', p.id, opts.autoTryOn).length;
      });
      if (woke) nudge();
    }
  }

  /** Step 1 of onboarding: headless body crop + clean studio base portrait saved to onboarding.identityDraft for «Це я?» review. */
  async function runIdentityPrep(jobId: string) {
    const db0 = store.read();
    const job = db0.jobs.find((j) => j.id === jobId)!;
    const inp = job.identityInput;
    if (!inp) throw Error('Не вказано фото для опори зовнішності');
    const facePhoto = db0.photos.find((p) => p.id === inp.facePhotoId);
    const bodyPhoto = db0.photos.find((p) => p.id === inp.bodyPhotoId);
    if (!facePhoto || !bodyPhoto) throw Error('Не знайдено вихідні фото для опори зовнішності');
    const resolve = (p: string) => resolveAllowed(projectRoot, store.dataDir, p);
    const faceAbs = resolve(facePhoto.path);
    const bodyAbs = resolve(bodyPhoto.path);
    const jobDir = path.join(store.dataDir, 'jobs', job.id);
    const mediaDir = path.join(store.dataDir, 'media', 'identity', job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    const bodyDest = path.join(mediaDir, 'body.png');
    const portraitDest = path.join(mediaDir, 'portrait.png');
    const resultFile = path.join(jobDir, 'result.png');
    const lastMsg = path.join(jobDir, 'last-message.txt');
    const logFile = path.join(jobDir, 'codex.jsonl');
    const settings = db0.settings;

    await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId)!;
      j.state = 'running';
      j.startedAt = now();
      j.stateNote = 'Готую опору статури…';
      j.logPath = path.relative(projectRoot, logFile);
    });

    const faceCheck = async (files: string[]) => {
      const reply = opts.engine
        ? (await opts.engine.json({ prompt: FACE_CHECK_PROMPT, schema: FACE_CHECK_SCHEMA, images: files, logFile: path.join(jobDir, 'face-check.log') })).reply
        : await codexJson(jobDir, settings, 'face-check', { prompt: FACE_CHECK_PROMPT, schema: FACE_CHECK_SCHEMA, images: files });
      return (reply?.faces as boolean[] | undefined) ?? files.map(() => true);
    };
    const locateHead = async (previewFile: string) => {
      const reply = opts.engine
        ? (await opts.engine.json({ prompt: HEAD_BOUNDS_PROMPT, schema: HEAD_BOUNDS_SCHEMA, images: [previewFile], logFile: path.join(jobDir, 'head-bounds.log') })).reply
        : await codexJson(jobDir, settings, 'head-bounds', { prompt: HEAD_BOUNDS_PROMPT, schema: HEAD_BOUNDS_SCHEMA, images: [previewFile] });
      return reply as { hasPerson?: boolean; headBottom?: number } | null;
    };
    await prepareBodyCrop({ sourceAbs: bodyAbs, destAbs: bodyDest, jobDir, locateHead, faceCheck });

    const faceRefs = [faceAbs];
    const built = buildPortraitPrompt(job, resultFile, faceRefs);
    const prompt = shell || opts.engine ? built : collectedImagePrompt(built);
    fs.writeFileSync(path.join(jobDir, 'references.json'), JSON.stringify({ identity: faceRefs, bodySource: bodyAbs, bodyCrop: bodyDest }, null, 2));
    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), prompt);

    await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId);
      if (j && j.state === 'running') j.stateNote = 'Генерую базовий портрет…';
    });

    let exit: { code: number | null; err?: string };
    let reply: { status?: string; notes?: string; reason?: string };
    if (opts.engine) {
      const out = await opts.engine.image({ prompt: apiImagePrompt(prompt, faceRefs), images: faceRefs, resultFile, packshot: false, logFile });
      exit = { code: out.ok ? 0 : 1, err: out.err };
      reply = out.ok ? { status: 'done' } : { status: 'error', reason: out.err };
    } else {
      const args = [
        'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
        '-s', shell ? 'workspace-write' : 'read-only', '-C', jobDir, '-m', settings.codexModel,
        '-c', `model_reasoning_effort="${settings.reasoningEffort}"`, ...WORKER_ISOLATION, ...noCommands,
        '--enable', 'image_generation', '-o', lastMsg, ...faceRefs.flatMap((p) => ['-i', p]),
      ];
      exit = await spawnCodex(args, prompt, jobDir, logFile);
      reply = fs.existsSync(lastMsg) ? parseReply(fs.readFileSync(lastMsg, 'utf8')) : {};
      if (!shell && !fs.existsSync(resultFile)) collectGeneratedImage(codexHome, logFile, resultFile);
    }

    let image = fs.existsSync(resultFile) ? resultFile : null;
    if (image && detectImageType(fs.readFileSync(image)) !== 'png') image = null;

    await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId)!;
      if (j.state !== 'running') return;
      j.finishedAt = now();
      if (!image) {
        j.state = 'error';
        j.stateNote = reply.reason || exit.err || (exit.code === 0 ? 'Не вдалося згенерувати базовий портрет' : `Codex завершився з кодом ${String(exit.code)} — див. журнал`);
        return;
      }
      fs.copyFileSync(image, portraitDest);
      const faceRel = path.relative(projectRoot, portraitDest);
      const bodyRel = path.relative(projectRoot, bodyDest);
      prewarm(projectRoot, store.dataDir, [faceRel, bodyRel], [160, 480, 960]);
      applyIdentityDraft(db, j, { faceRel, bodyRel, projectRoot, dataDir: store.dataDir, notes: reply.notes });
      j.state = 'done';
      j.stateNote = 'Опора готова — перевір «Це я?»';
      // The new headless body crop shows the figure: its cut is read unless the owner chose the cuts.
      if (db.profile.fitProfile?.source !== 'owner') queueFitAnalysis(db, true);
    });
    if (image) cleanupJobDir(jobDir);
  }

  async function runOne(jobId: string) {
    const db0 = store.read();
    const job = db0.jobs.find((j) => j.id === jobId)!;
    if (job.kind === 'intake' || job.kind === 'analyze' || job.kind === 'shopsearch' || job.kind === 'advise' || job.kind === 'storefind' || job.kind === 'discover' || job.kind === 'wearreview' || job.kind === 'capsule_plan' || job.kind === 'capsule_match' || job.kind === 'fit_analysis') return runAnalysis(jobId);
    if (job.kind === 'identity_prep') return runIdentityPrep(jobId);
    const isPackshot = job.kind === 'packshot';
    if (!isPackshot && (db0.profile.identity?.disabledReason || job.snapshot.identity?.disabledReason)) throw Error(db0.profile.identity?.disabledReason || job.snapshot.identity!.disabledReason);
    const jobDir = path.join(store.dataDir, 'jobs', job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const resultFile = path.join(jobDir, 'result.png');
    const lastMsg = path.join(jobDir, 'last-message.txt');
    const logFile = path.join(jobDir, 'codex.jsonl');
    if (!isPackshot && db0.profile.identity && !job.snapshot.identity) throw Error('Стара спроба без закріпленого оригіналу. Створи нову примірку для поточної версії образу.');
    if (!isPackshot && !sameIdentity(db0.profile.identity, job.snapshot.identity)) throw Error('Опора обличчя або статури змінилася. Створи нову примірку з поточними референсами.');
    const resolve = (p: string) => resolveAllowed(projectRoot, store.dataDir, p);
    const settings = db0.settings;
    let refs: ImageRefs;
    if (isPackshot) {
      refs = pickRefs(job, true, resolve);
    } else {
      // The garment pictures this attempt starts with; a later one (packshot, shop photo) may arrive while it runs.
      const startedWith = slotPhotoPaths(job.snapshot.slots);
      const identityJob = { ...job, snapshot: { ...job.snapshot, slots: [] } };
      verifyReferenceFiles(identityJob, resolve);
      const { identity } = pickRefs(identityJob, false, resolve);
      if (!identity.length) throw Error('Немає оригінального фото зовнішності — генерацію зупинено');
      await store.mutate((db) => {
        const current = db.jobs.find((j) => j.id === jobId)!;
        current.state = 'running';
        current.startedAt = now();
        current.stateNote = 'Готую фото речей…';
        current.logPath = path.relative(projectRoot, logFile);
      });
      const mediaDir = path.join(store.dataDir, 'media', 'tryon-references', job.id);
      // Where macOS Vision is absent, the model checks each crop for a face; a crop with a face is never used.
      // Any failed or unclear answer counts as a face.
      const faceCheck = async (files: string[]) => {
        const reply = opts.engine
          ? (await opts.engine.json({ prompt: FACE_CHECK_PROMPT, schema: FACE_CHECK_SCHEMA, images: files, logFile: path.join(jobDir, 'face-check.log') })).reply
          : await codexJson(jobDir, settings, 'face-check', { prompt: FACE_CHECK_PROMPT, schema: FACE_CHECK_SCHEMA, images: files });
        return (reply?.faces as boolean[] | undefined) ?? files.map(() => true);
      };
      let requeued = false;
      const prepared = await prepareGarmentCrops({ slots: job.snapshot.slots, projectRoot, mediaDir, jobDir, resolve, locate: (request) => locateGarments(jobDir, settings, request), faceCheck });
      const canRender = await store.mutate((db) => {
        const current = db.jobs.find((j) => j.id === jobId);
        if (current?.state !== 'running') return false;
        if (!sameIdentity(db.profile.identity, job.snapshot.identity) || db.profile.identity?.disabledReason) {
          current.state = 'needs_data';
          current.finishedAt = now();
          current.stateNote = 'Змінилися референси зовнішності. Створи нову примірку.';
          return false;
        }
        current.snapshot.slots = prepared.slots;
        prepared.crops.forEach((crop, i) => {
          const slot = prepared.slots[i];
          if (!crop || slot.kind !== 'item') return;
          const item = db.items.find((candidate) => candidate.id === slot.id);
          if (item && db.photos.some((photo) => photo.path === crop.source.path && item.photoIds.includes(photo.id) && photo.source !== 'generated' && !photo.inspiration)) {
            if (!item.tryonReference) item.tryonReference = crop;
          }
        });
        if (!prepared.missing.length && prepared.slots.length) return true;
        // A picture that arrived while this attempt ran: start again with the fuller set instead of waiting.
        const fresh = prepared.missing.length ? fullerSnapshot(db, current, startedWith) : null;
        if (fresh) {
          current.snapshot.slots = fresh;
          current.state = 'queued';
          delete current.startedAt;
          current.stateNote = 'Нові фото речей — пробую ще раз';
          requeued = true;
          return false;
        }
        current.state = 'needs_data';
        current.finishedAt = now();
        current.stateNote = prepared.missing.length ? `Потрібні окремі фото речей: ${[...new Set(prepared.missing)].join(', ')}.` : 'Додай речі до образу.';
        return false;
      });
      if (!canRender) {
        if (requeued) nudge();
        return;
      }
      job.snapshot.slots = prepared.slots;
      verifyReferenceFiles(job, resolve);
      const garmentCards = await fitGarmentCards(prepared.slots, MAX_IMAGE_REFS - identity.length, jobDir, path.join(mediaDir, 'garments.png'), resolve);
      refs = { identity, garments: [...new Set(garmentCards.map((c) => c.file))], garmentCards };
    }
    const slot = job.snapshot.slots[0]?.slot;
    const upperStyle = path.join(store.dataDir, 'media', 'packshot-style', 'upper.png');
    if (isPackshot && refs.garments.length && (slot === 'top' || slot === 'layer') && fs.existsSync(upperStyle)) {
      refs.packshotStyle = upperStyle;
    }
    const uniqueImages = [...refs.identity, ...refs.garments, ...(refs.packshotStyle ? [refs.packshotStyle] : [])];
    const built = buildPrompt(job, resultFile, refs, fitPromptBlock(db0));
    const prompt = shell || opts.engine ? built : collectedImagePrompt(built);
    fs.writeFileSync(path.join(jobDir, 'references.json'), JSON.stringify({ ...refs, contract: job.snapshot.identity }, null, 2));
    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), prompt);
    const args = [
      'exec',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '--json',
      // With commands, the model saves the PNG into the job folder; without them it writes nothing.
      '-s', shell ? 'workspace-write' : 'read-only',
      '-C', jobDir,
      '-m', settings.codexModel,
      '-c', `model_reasoning_effort="${settings.reasoningEffort}"`,
      ...WORKER_ISOLATION,
      ...noCommands,
      '--enable', 'image_generation',
      '-o', lastMsg,
      ...uniqueImages.flatMap((p) => ['-i', p]),
    ];
    const startedJob = await store.mutate((db) => {
      const j = db.jobs.find((x) => x.id === jobId);
      if (!j || (!isPackshot && j.state !== 'running')) return false;
      if (!isPackshot && (!sameIdentity(db.profile.identity, job.snapshot.identity) || db.profile.identity?.disabledReason)) {
        j.state = 'needs_data';
        j.finishedAt = now();
        j.stateNote = 'Змінилися референси зовнішності. Створи нову примірку.';
        return false;
      }
      j.state = 'running';
      j.startedAt = now();
      j.stateNote = `${opts.engine ? opts.engine.imageLabel : `Codex ${settings.codexModel}`} генерує…`;
      j.logPath = path.relative(projectRoot, logFile);
      return true;
    });
    if (!startedJob) return;

    let exit: { code: number | null; err?: string };
    let reply: { status?: string; notes?: string; reason?: string };
    if (opts.engine) {
      const out = await opts.engine.image({ prompt: apiImagePrompt(prompt, uniqueImages), images: uniqueImages, resultFile, packshot: isPackshot, logFile });
      exit = { code: out.ok ? 0 : 1, err: out.err };
      reply = out.ok ? { status: 'done' } : { status: 'error', reason: out.err };
    } else {
      exit = await spawnCodex(args, prompt, jobDir, logFile);
      reply = fs.existsSync(lastMsg) ? parseReply(fs.readFileSync(lastMsg, 'utf8')) : {};
      if (!shell && !fs.existsSync(resultFile)) collectGeneratedImage(codexHome, logFile, resultFile);
    }
    let image = fs.existsSync(resultFile) ? resultFile : null;
    const note = reply.notes;
    if (image && detectImageType(fs.readFileSync(image)) !== 'png') image = null;
    if (isPackshot && (reply.status !== 'done' || exit.code !== 0)) {
      image = null;
    }

    await store.mutate((db: DB) => {
      const j = db.jobs.find((x) => x.id === jobId)!;
      if (j.state !== 'running') return; // Owner may have stopped or superseded this attempt.
      j.finishedAt = now();
      if (!image) {
        j.state = 'error';
        j.stateNote =
          reply.reason ||
          exit.err ||
          (exit.code === 0
            ? isPackshot ? 'Не отримано готового PNG для обкладинки' : 'Codex завершив роботу, але не зберіг зображення'
            : `Codex завершився з кодом ${String(exit.code)} — див. журнал`);
        return;
      }
      if (isPackshot) {
        const dir = path.join(store.dataDir, 'media', 'packshots');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `${j.id}.png`);
        fs.copyFileSync(image, target);
        const title = j.snapshot.slots[0]?.title ?? 'Річ';
        const photo = {
          id: newId('P'),
          kind: 'packshot' as const,
          path: path.relative(projectRoot, target),
          originalName: `${title} — packshot`,
          source: 'generated' as const,
          note: `Генеративна реконструкція (${opts.engine ? opts.engine.imageLabel : settings.codexModel}); не доказ складу, розміру чи прихованих деталей.${note ? ` ${note}` : ''}`,
          createdAt: now(),
        };
        db.photos.push(photo);
        prewarm(projectRoot, store.dataDir, [photo.path]);
        j.photoId = photo.id;
        const item = j.itemId ? db.items.find((i) => i.id === j.itemId) : undefined;
        if (item) {
          item.packshotId = photo.id;
          item.rev += 1;
          item.updatedAt = now();
          item.history.push({ at: now(), action: 'packshot', note: photo.id });
        }
        const need = j.needId ? db.needs.find((n) => n.id === j.needId) : undefined;
        if (need) {
          need.conceptPhotoId = photo.id;
          need.rev += 1;
          need.updatedAt = now();
          // Looks waiting for this purchase's picture can now be tried on.
          resumeWaitingTryonsForRef(db, 'need', need.id, opts.autoTryOn);
        }
        j.state = 'done';
        j.stateNote = 'Packshot готовий';
        return;
      }
      const rendersDir = path.join(store.dataDir, 'media', 'renders');
      fs.mkdirSync(rendersDir, { recursive: true });
      const target = path.join(rendersDir, `${j.id}.png`);
      fs.copyFileSync(image, target);
      const resultId = newId('R');
      prewarm(projectRoot, store.dataDir, [path.relative(projectRoot, target)], [160, 480, 960]);
      db.results.push({
        id: resultId,
        jobId: j.id,
        lookId: j.lookId!,
        lookVersion: j.lookVersion,
        imagePath: path.relative(projectRoot, target),
        tool: opts.engine ? 'OpenAI Images API' : 'Codex CLI exec · built-in image generation',
        model: opts.engine ? opts.engine.imageLabel : settings.codexModel,
        prompt,
        sources: uniqueImages.map((p) => path.relative(projectRoot, p)),
        usedItemPhotos: refs.garments.length > 0,
        notes: note,
        review: 'pending',
        favorite: false,
        createdAt: now(),
      });
      j.resultId = resultId;
      j.state = 'done';
      j.stateNote = 'Готово — чекає твоєї перевірки';
    });
    if (image) cleanupJobDir(jobDir);
  }

  async function runSafe(jobId: string) {
    try {
      await runOne(jobId);
    } catch (e) {
      state.lastError = (e as Error).message;
      await store
        .mutate((db) => {
          const j = db.jobs.find((x) => x.id === jobId);
          if (j && j.state !== 'done') {
            j.state = 'error';
            j.stateNote = (e as Error).message;
            j.finishedAt = now();
            finishIntakeBurst(db, j);
          }
        })
        .catch(() => undefined);
    }
  }

  let draining = false;
  let stopped = false;
  let wakeup: (() => void) | null = null;
  const nudge = () => {
    const fn = wakeup;
    wakeup = null;
    fn?.();
  };
  const waitForNudge = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      wakeup = null;
      resolve();
    }, ms);
    t.unref?.();
    wakeup = () => {
      clearTimeout(t);
      resolve();
    };
  });
  async function drain() {
    if (draining) {
      nudge();
      return;
    }
    draining = true;
    state.lastError = null;
    try {
      for (;;) {
        if (stopped) break;
        const db = store.read();
        const limit = Math.max(1, Math.min(4, db.settings.concurrency ?? 2));
        // What the owner starts by hand (photo intake, analyzer) goes first, then try-ons, then packshots.
        // Shop searches take minutes: they come after uploads and «Підібрати», one at a time, so a slot stays free.
        // The advisor is background text work: after try-ons, alongside packshots.
        const batch = (k?: string) => (k === 'intake' || k === 'analyze' || k === 'discover' || k === 'wearreview' || k === 'identity_prep' || k === 'capsule_plan' || k === 'capsule_match' || k === 'fit_analysis' ? 0 : k === 'shopsearch' || k === 'storefind' ? 0.5 : k === 'packshot' || k === 'advise' ? 2 : 1);
        const queued = db.jobs
          .filter((j) => j.state === 'queued' && !active.has(j.id) && (!opts.canStart || opts.canStart(j)))
          // Within try-ons the newest request goes first, so a picture the owner just asked for does not wait behind a batch.
          .sort((a, b) => batch(a.kind) - batch(b.kind) || (batch(a.kind) === 1 ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)));
        if (!queued.length && active.size === 0) break;
        while (active.size < limit && queued.length) {
          // Uploads are triaged one at a time so the same garment on several photos is recognised as one item.
          const activeKinds = [...active].map((id) => db.jobs.find((x) => x.id === id)?.kind);
          // The advisor rates items with their catalogue pictures, so it waits for uploads and pictures still being made.
          const photosPending = db.jobs.some((x) => (x.kind === 'packshot' || x.kind === 'intake') && (x.state === 'queued' || x.state === 'running'));
          const idx = queued.findIndex((j) => !(j.kind === 'intake' && activeKinds.includes('intake')) && !((j.kind === 'shopsearch' || j.kind === 'storefind') && (activeKinds.includes('shopsearch') || activeKinds.includes('storefind'))) && !(j.kind === 'advise' && (activeKinds.includes('advise') || photosPending)));
          if (idx < 0) break;
          const next = queued.splice(idx, 1)[0];
          active.add(next.id);
          sync();
          void (opts.limiter ? opts.limiter.run(() => runSafe(next.id)) : runSafe(next.id)).finally(() => {
            active.delete(next.id);
            sync();
            nudge();
          });
        }
        await waitForNudge(active.size > 0 ? 5000 : 1000);
      }
    } finally {
      draining = false;
      sync();
    }
  }

  /** Jobs left "running" by a restart go back to the queue; their snapshot is unchanged. */
  // Only jobs this runner started (it sets logPath when it marks them running) are
  // re-queued; a job someone is running elsewhere, e.g. attended in a chat, is left alone.
  const ownRunning = (j: Job) => j.state === 'running' && Boolean(j.logPath);
  async function recover(): Promise<number> {
    const interrupted = store.read().jobs.filter(ownRunning).length;
    if (!interrupted) return 0;
    await store.mutate((db) => {
      for (const j of db.jobs) if (ownRunning(j)) {
        j.state = 'queued';
        j.stateNote = 'Повернуто в чергу після перезапуску сервера';
      }
    });
    return interrupted;
  }

  // The weekly review (owner, 18.11): first checked two minutes after start, then hourly;
  // the timers never keep the process alive by themselves.
  const weeklyCheck = () => {
    if (!adviceDue(store.read())) return;
    void store
      .mutate((db) => {
        if (adviceDue(db)) queueAdvice(db, 'Тижневий перегляд');
      })
      .then(() => drain())
      .catch(() => undefined);
  };
  const timers = [setTimeout(weeklyCheck, 2 * 60 * 1000), setInterval(weeklyCheck, 60 * 60 * 1000)];
  for (const t of timers) t.unref?.();
  /** A deleted account's queue stops: no new jobs start and the weekly review ends. */
  const stop = () => {
    stopped = true;
    nudge();
    for (const t of timers) clearTimeout(t);
  };

  return { state, drain, recover, stop };
}
