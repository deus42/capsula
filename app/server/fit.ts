// Structured fit (owner, 28.11): the cuts to look for and the cuts never to buy. They come from the person's
// figure (a headless body crop or a full-length photo, tailoring proportions only), from the measurements, or
// from Profile → «Побажання». Shop searches, the stylist and try-ons follow them; shop results with an avoided
// cut are dropped by the server, not only by the prompt.
import type { Category, DB, FitProfile, FitType, Job, Profile } from './schema.ts';
import { FIT_TYPES } from './schema.ts';
import { newId, now } from './store.ts';
import { replyLanguage } from './person.ts';
import { FIT_LABEL } from '../src/lib.ts';

export { FIT_LABEL };
export const FIT_OPTIONS = FIT_TYPES.map((id) => ({ id, label: FIT_LABEL[id] }));

/** Shoes and accessories have no garment cut. */
const CUT_CATEGORIES = new Set<Category>(['outerwear', 'knitwear', 'shirts', 'tees', 'dresses', 'trousers', 'shorts', 'skirts']);

/** Keeps known cuts once each, with preferred and avoided disjoint (preferred wins). */
export function cleanFit(preferred: unknown, avoid: unknown): { preferred: FitType[]; avoid: FitType[] } {
  const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is FitType => FIT_TYPES.includes(x as FitType)))];
  const p = list(preferred);
  return { preferred: p, avoid: list(avoid).filter((x) => !p.includes(x)) };
}

const value = (profile: Pick<Profile, 'measurements'>, key: 'height' | 'chest' | 'waist' | 'hips' | 'shoulders') => {
  const v = profile.measurements[key]?.value;
  return typeof v === 'number' && v > 0 ? v : null;
};

/**
 * A deterministic first guess from body measurements: the chest-to-waist drop and how broad the frame is for the
 * height decide whether shaped (slim, tapered) or straighter cuts follow the figure. Null without chest and waist.
 */
export function suggestFitFromMeasurements(profile: Pick<Profile, 'measurements' | 'language'>): FitProfile | null {
  const chest = value(profile, 'chest');
  const waist = value(profile, 'waist');
  if (!chest || !waist) return null;
  const height = value(profile, 'height');
  const hips = value(profile, 'hips');
  const shoulders = value(profile, 'shoulders');
  const drop = chest - waist;
  // A narrow frame for the height: extra fabric swamps it.
  const narrow = height ? chest / height < 0.53 : false;
  let preferred: FitType[];
  let avoid: FitType[];
  if (drop >= 10) {
    preferred = ['slim', 'tapered', 'tailored'];
    avoid = narrow ? ['regular', 'relaxed', 'oversized'] : ['relaxed', 'oversized'];
  } else if (drop >= 4) {
    preferred = narrow ? ['slim', 'tapered'] : ['tapered', 'tailored', 'straight'];
    avoid = narrow ? ['relaxed', 'oversized'] : ['oversized', 'skinny'];
  } else {
    preferred = ['straight', 'regular', 'tailored'];
    avoid = ['skinny', 'slim'];
  }
  // Hips wider than the shoulders: straight legs balance the line better than tight ones.
  if (hips && shoulders && hips > shoulders * 2.3 && !avoid.includes('skinny')) avoid = [...avoid, 'skinny'];
  const en = profile.language === 'en';
  const shape = drop >= 10 ? (en ? 'a clear chest-to-waist drop' : 'помітна різниця грудей і талії') : drop >= 4 ? (en ? 'a moderate chest-to-waist drop' : 'помірна різниця грудей і талії') : (en ? 'a straight torso line' : 'пряма лінія торсу');
  const bodySummary = en
    ? `From measurements: chest ${chest}, waist ${waist} cm — ${shape}${narrow ? ', a narrow frame for the height' : ''}.`
    : `За мірками: груди ${chest}, талія ${waist} см — ${shape}${narrow ? ', вузька статура для зросту' : ''}.`;
  return { ...cleanFit(preferred, avoid), bodySummary, source: 'auto', updatedAt: now() };
}

/**
 * The picture of the figure a fit analysis reads: a fresh draft body crop (identity_prep just made it), else the
 * pinned headless body crop, else a full-length own base photo.
 */
export function fitPhotoPath(db: DB): string | undefined {
  if (db.onboarding?.identityDraft?.body.path) return db.onboarding.identityDraft.body.path;
  if (db.profile.identity?.body.path) return db.profile.identity.body.path;
  const full = db.profile.basePhotoIds
    .map((id) => db.photos.find((p) => p.id === id))
    .filter((p) => p && !p.archivedAt && p.kind === 'base' && p.referenceRole !== 'face' && p.source !== 'generated' && !p.inspiration);
  return (full.find((p) => p!.baseCandidate?.suitable || p!.meetsStandard) ?? full[0])?.path;
}

/** One fit analysis at a time; `auto` ones never override cuts the owner chose. */
export function queueFitAnalysis(db: DB, auto = false): Job | null {
  const photoPath = fitPhotoPath(db);
  if (!photoPath) return null;
  const pending = db.jobs.find((j) => j.kind === 'fit_analysis' && (j.state === 'queued' || j.state === 'running'));
  if (pending) return pending;
  if (auto && db.profile.fitProfile?.source === 'owner') return null;
  const job: Job = { id: newId('J'), kind: 'fit_analysis', lookVersion: 0, snapshot: { lookName: 'Крій', slots: [], basePhotoIds: [], basePhotoPaths: [photoPath] }, instructions: auto ? 'auto' : '', state: 'queued', origin: 'site', createdAt: now() };
  db.jobs.push(job);
  return job;
}

const fitEnum = { type: 'array', items: { type: 'string', enum: [...FIT_TYPES] } } as const;

export const FIT_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'preferred', 'avoid', 'bodySummary'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: { type: 'string' },
    preferred: fitEnum,
    avoid: fitEnum,
    bodySummary: { type: 'string' },
  },
};

export interface FitAnalysisReply {
  status: string;
  reason: string;
  preferred: string[];
  avoid: string[];
  bodySummary: string;
}

export function fitAnalysisPrompt(db: DB) {
  const m = db.profile.measurements;
  const measures = (['height', 'chest', 'waist', 'hips', 'shoulders', 'inseam'] as const).flatMap((k) => m[k]?.value ? [`${k} ${m[k].value} cm`] : []).join(', ');
  return [
    'You are the Capsula tailoring worker running unattended. Answer with JSON only (schema enforced).',
    'The attached image shows the person\'s figure (a headless body crop or a full-length photo). Read ONLY tailoring proportions: shoulder width against the hips, torso and leg length, how the chest, waist and hips line up, and how broad or narrow the frame is.',
    'Never comment on weight, body size judgements, health, attractiveness, age or the face. Do not identify the person. Describe the silhouette in neutral tailoring terms only.',
    `Choose garment cuts from this list: ${FIT_TYPES.join(', ')}. preferred: the 2–3 cuts that follow this figure best; avoid: the 1–3 cuts that would lose its line (too much fabric or too tight). The two lists never share a cut.`,
    measures ? `Measured (use with the image, never quote): ${measures}.` : '',
    db.profile.preferences.fit ? `The person's own note on fit: ${db.profile.preferences.fit}` : '',
    `bodySummary: one short neutral ${replyLanguage(db)} sentence about the tailoring proportions behind the choice (e.g. shoulders broader than hips, long legs).`,
    'Return status "error" with the reason only if no figure is visible.',
  ].filter(Boolean).join('\n');
}

/**
 * Saves a figure-based fit. An automatic run never replaces cuts the owner chose, and no run replaces cuts the
 * owner edited after it was queued (the owner's newer choice wins).
 */
export function applyFitAnalysis(db: DB, reply: { preferred: unknown; avoid: unknown; bodySummary?: string }, job?: Pick<Job, 'instructions' | 'createdAt'>): string {
  const { preferred, avoid } = cleanFit(reply.preferred, reply.avoid);
  if (!preferred.length && !avoid.length) return 'Крій не визначено';
  const owner = db.profile.fitProfile?.source === 'owner' ? db.profile.fitProfile : undefined;
  if (owner && (job?.instructions === 'auto' || (job?.createdAt && owner.updatedAt > job.createdAt))) return 'Крій уже вибрано власноруч';
  const bodySummary = String(reply.bodySummary ?? '').trim().slice(0, 240) || undefined;
  db.profile.fitProfile = { preferred, avoid, ...(bodySummary ? { bodySummary } : {}), source: 'auto', updatedAt: now() };
  db.profile.rev += 1;
  return `Крій: ${preferred.map((f) => FIT_LABEL[f]).join(', ')}`;
}

/** The fit rules for prompts: preferred and never-buy cuts, and the person's own words. Empty when nothing is set. */
export function fitPromptBlock(db: DB): string {
  const fit = db.profile.fitProfile;
  const note = db.profile.preferences.fit?.trim();
  if (!fit?.preferred.length && !fit?.avoid.length && !note) return '';
  return [
    'Fit (hard rule for clothing; shoes and accessories excepted):',
    fit?.preferred.length ? `preferred cuts — ${fit.preferred.map((f) => FIT_LABEL[f]).join(', ')};` : '',
    fit?.avoid.length ? `NEVER these cuts — ${fit.avoid.map((f) => FIT_LABEL[f]).join(', ')}.` : '',
    fit?.bodySummary ? `Figure: ${fit.bodySummary}` : '',
    note ? `Owner's note on fit: ${note}` : '',
  ].filter(Boolean).join(' ');
}

const WORDS: Record<FitType, string> = {
  slim: 'slim|extra[\\s-]?slim|слім|притален|schmal',
  tapered: 'tapered|taper|carrot|звужен|sužen|suzen|konisch',
  tailored: 'tailored',
  straight: 'straight|прям',
  regular: 'regular|classic|standard|регуляр|класичн|klasičn|klasicn|klassisch',
  relaxed: 'relaxed|loose|comfort|вільн|komotn|weit',
  oversized: 'over[\\s-]?sized?|boxy|оверсайз',
  skinny: 'skinny|super[\\s-]?slim|spray[\\s-]?on|скіні',
};
/** Local names that state the cut by themselves («ravni kroj», «Gerade Passform»). */
const PHRASES: Partial<Record<FitType, string>> = {
  straight: 'ravn[ia][\\s-]+kroj|gerade[\\s-]+passform|gerader?[\\s-]+schnitt',
  slim: 'usk[ia][\\s-]+kroj',
};
const words = (f: FitType) => [WORDS[f], PHRASES[f]].filter(Boolean).join('|');
const anyWord = (f: FitType) => new RegExp(`(?:^|[^\\p{L}])(?:${words(f)})`, 'iu');
/** «Regular fit», «Classic cut», «Gerade Passform»: the stated cut itself, not a word inside a model name. */
const statedCut = (f: FitType) => new RegExp(`(?:^|[^\\p{L}])(?:(?:${WORDS[f]})\\p{L}*[\\s-]*(?:fit|cut|leg|крій|посадк|kroj|passform|schnitt)${PHRASES[f] ? `|${PHRASES[f]}` : ''})`, 'iu');
const ALL_WORDS = FIT_TYPES.map(words).join('|');
/** Construction details, not the garment's cut: «Straight Hem», «прямий низ», «Relaxed Collar». */
const CONSTRUCTION = /(?:straight|relaxed)[\s-]+(?:hem|collar|bottom)|прям\p{L}*\s+(?:низ|поділ|комір)\p{L}*|вільн\p{L}*\s+комір\p{L}*/giu;
/** A negated cut («Non-Regular», «not slim», «без оверсайз», «не прямий») says what the garment is not. */
const NEGATED = new RegExp(`(?:^|(?<=[^\\p{L}]))(?:non|not|без|не)[\\s-]+(?:${ALL_WORDS})\\p{L}*`, 'giu');
const cutText = (text: string | undefined) => String(text ?? '').replace(CONSTRUCTION, ' ').replace(NEGATED, ' ');
// «Classic Oxford Shirt»: generic words count only in the cut field or as a stated cut in the name.
const GENERIC = new Set<FitType>(['regular', 'relaxed']);

/**
 * True when a clothing product states a cut the profile avoids. A preferred cut beside a loose word
 * («Regular Tapered») is allowed; a stated avoided cut («Regular Fit», «Classic Fit», «Oversized») never is.
 */
export function violatesAvoidedFit(fitText: string | undefined, modelText: string | undefined, category: Category, fitProfile: FitProfile | undefined): boolean {
  if (!fitProfile?.avoid.length || !CUT_CATEGORIES.has(category)) return false;
  const fit = cutText(fitText);
  const model = cutText(modelText);
  const mentions = (f: FitType) => anyWord(f).test(fit) || (GENERIC.has(f) ? statedCut(f).test(model) : anyWord(f).test(model));
  const avoided = fitProfile.avoid.filter(mentions);
  if (!avoided.length) return false;
  const stated = avoided.some((f) => statedCut(f).test(fit) || statedCut(f).test(model) || (!GENERIC.has(f) && f !== 'straight'));
  const preferred = fitProfile.preferred.some(mentions);
  return stated || !preferred;
}
