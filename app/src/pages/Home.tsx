import { useRef, useState } from 'react';
import { Plus, ShoppingBag, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, uploadFile } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { Composer, LookArt, Missing, RenderPlaceholder } from '../components/ui.tsx';
import { capsuleLooks, capsuleRating, currentPeriod, distinctLooks, isAutoCapsule, lookRating, openSuggestions, periodLine, purchaseRanking, rankCapsules, readyLine, scoreLabel, WARDROBE_CAPSULE_ID } from '../lib.ts';
import { STYLE_CATALOGUE, stylePieces, type CatalogueStyle } from '../style-catalogue.ts';
import { LOOKS, currentLanguage, plural, t } from '../i18n.ts';
import type { DB, Look } from '../api.ts';
import { isCapsuleHidden, type CapsuleView } from '../rating.ts';

/** A tile's looks: a hidden capsule still shows its looks (never empty); the automatic ones keep their own order. */
const tileLooks = (db: DB, c: CapsuleView) => (isCapsuleHidden(db, c) || isAutoCapsule(c.id) ? capsuleLooks(db, c.lookIds) : distinctLooks(db, capsuleLooks(db, c.lookIds)));

/**
 * Covers for a row of tiles (owner, 19.11): one look that shows the capsule's style — its best scored, liked first —
 * and never a look already on an earlier tile, unless a capsule has nothing else.
 */
export function tileCovers(db: DB, list: CapsuleView[]) {
  const used = new Set<string>();
  return new Map(list.map((c) => {
    const looks = isAutoCapsule(c.id) ? tileLooks(db, c) : [...tileLooks(db, c)].sort((a, b) => (lookRating(b) ?? 0) - (lookRating(a) ?? 0) || Number(b.favorite) - Number(a.favorite));
    const fresh = looks.filter((l) => !used.has(l.id));
    const cover = (fresh.length ? fresh : looks).slice(0, 1);
    for (const l of cover) used.add(l.id);
    return [c.id, cover] as const;
  }));
}

/** A capsule is a set of looks: its tile shows up to four of them, each with its own try-on. */
export function CapsuleTile({ c, cover }: { c: CapsuleView; cover?: Look[] }) {
  const db = useDb();
  const looks = tileLooks(db, c);
  const shownLooks = cover ?? looks.slice(0, 4);
  const score = capsuleRating(db, c);
  return (
    <a href={`/capsules/${c.id}`} className="capsule-card">
      <div className={`cover mosaic n${Math.max(1, shownLooks.length)}`}>
        {shownLooks.length === 0 ? <RenderPlaceholder lookIds={c.lookIds} /> : shownLooks.map((l) => (
          <span key={l.id} className="cell"><LookArt look={l} w={shownLooks.length === 1 ? 900 : 480} max={shownLooks.length === 1 ? 5 : 3} /></span>
        ))}
        {c.favorite && <span className="corner-r liked-mark" aria-label={t('Подобається')}><ThumbsUp size={14} fill="currentColor" /></span>}
        {c.disliked && <span className="corner-r liked-mark" aria-label={t('Не подобається')}><ThumbsDown size={14} fill="currentColor" /></span>}
      </div>
      <div>
        {c.periods?.length ? <span className="eyebrow-sm tile-period">{periodLine(c)}</span> : null}
        <h3>{c.name}</h3>
        <div className="meta">{(c.id !== WARDROBE_CAPSULE_ID && readyLine(db, c)) || plural(looks.length, LOOKS)}{score !== null && ` · ${scoreLabel(score)}`}</div>
      </div>
    </a>
  );
}

/**
 * «Капсули для тебе»: while there are fewer than three capsules, styles from the catalogue that are not
 * added yet — the current weather period first. «Додати» starts the capsule; «Нові» then finds its looks.
 */
function catalogueStyles(db: DB, have: number): CatalogueStyle[] {
  const taken = new Set(db.capsules.map((c) => c.name));
  const now = currentPeriod(new Date(), db.profile.hemisphere);
  const free = STYLE_CATALOGUE.filter((s) => !taken.has(s.name));
  return [...free.filter((s) => s.periods.includes(now)), ...free.filter((s) => !s.periods.includes(now))].slice(0, Math.max(0, 3 - have));
}

function StyleTile({ s }: { s: CatalogueStyle }) {
  const db = useDb();
  const { act } = useApp();
  const lang = currentLanguage();
  return (
    <div className="capsule-card style-card">
      <div>
        <span className="eyebrow-sm tile-period">{periodLine({ periods: s.periods })}</span>
        <h3>{s.name}</h3>
        <p className="style-idea">{s.idea[lang]}</p>
        <p className="style-pieces">{stylePieces(s, db.profile.wardrobeFocus).slice(0, 6).map((x) => x[lang]).join(' · ')}</p>
      </div>
      <button className="icon-btn style-add" aria-label={t('Додати капсулу')} title={t('Додати капсулу')} onClick={() => void act(() => api('POST', '/api/capsules/from-style', { styleId: s.id }), t('Капсулу додано'))}><Plus size={15} /></button>
    </div>
  );
}

/** Starts photo intake with the intent of the upload surface. */
export function useIntake(intent: 'garments' | 'person' | 'auto' = 'garments') {
  const { act } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = () => input.current?.click();
  const field = (
    <input
      ref={input}
      type="file"
      accept="image/*,.heic,.heif"
      multiple
      hidden
      onChange={async (e) => {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setBusy(true);
        await act(async () => {
          // Every photo of a batch is queued before the runner starts, so the burst ends with one advisor run.
          let sent = 0;
          try {
            for (const [i, f] of files.entries()) {
              await uploadFile(f, { kind: 'intake', intent, ...(files.length > 1 ? { batch: '1' } : {}), ...(i < files.length - 1 ? { run: '0' } : {}) });
              sent += 1;
            }
          } finally {
            // A failed upload partway: the photos already queued still get processed.
            if (sent > 0 && sent < files.length) await api('POST', '/api/runner/run').catch(() => undefined);
          }
        }, files.length > 1 ? t('Додано фото: {n}', { n: files.length }) : t('Фото додано'));
        setBusy(false);
        if (input.current) input.current.value = '';
      }}
    />
  );
  return { pick, busy, field };
}

export function HomePage() {
  const db = useDb();
  const { act } = useApp();
  const [text, setText] = useState('');
  const shown = db.capsules.filter((c) => !isCapsuleHidden(db, c));
  // Only the fashion capsules, the best rated first, left to right (owner, 20.11); ties keep the current period first.
  // «З моїх речей» and «Найкращі» are filters, not capsules (20.11).
  const capsules = [...rankCapsules(db, shown.filter((c) => c.kind !== 'selection'))].sort((a, b) => (capsuleRating(db, b) ?? -1) - (capsuleRating(db, a) ?? -1));
  const covers = tileCovers(db, capsules);
  const analyzeJob = db.jobs.find((j) => j.kind === 'discover' && j.state === 'running') ?? db.jobs.find((j) => j.kind === 'discover' && j.state === 'queued');
  const analyzing = Boolean(analyzeJob);

  const analyze = async () => {
    // The same search as «Капсули → Нові» (owner, 19.11): results come there as cards «Ні / Додати».
    const ok = await act(() => api('POST', '/api/discover', { prompt: text }), t('Шукаю — нові образи зʼявляться в «Нових»'));
    if (ok) setText('');
  };

  const fresh = openSuggestions(db).length;
  const next = purchaseRanking(db)[0];
  const needsSetup = !db.onboarding?.completedAt && (!db.profile.identity || capsules.length === 0);
  // Capsula is about capsules (owner, 20.11): the question and the composer in the centre, two small chips,
  // then the capsules as tiles, the best rated first, left to right — like app.fashn.ai.
  return (
    <div className="page home">
      <section className="home-top">
        <h1 className="home-title">{t('Що одягнемо сьогодні?')}</h1>
        <Composer className="home-ask" value={text} onChange={setText} onSend={() => void analyze()} busy={analyzing} label={t('Підібрати')} placeholder={t('Уточни: вечеря, довга прогулянка, буду в приміщенні')} />
        {(needsSetup || fresh > 0 || (next && next.looksIn > 0)) && (
          <div className="home-chips">
            {needsSetup && <a href="/setup" className="home-chip"><span className="chip-ic"><Sparkles size={14} /></span>{t('Налаштувати гардероб')}</a>}
            {fresh > 0 && <a href="/capsules?tab=new" className="home-chip"><span className="chip-ic"><Sparkles size={14} /></span>{t('Нові образи')}<span className="chip-n">{fresh}</span></a>}
            {next && next.looksIn > 0 && <a href={`/shopping?need=${next.need.id}`} className="home-chip"><span className="chip-ic"><ShoppingBag size={14} /></span>{t('Наступна покупка')}</a>}
          </div>
        )}
      </section>
      <div className="home-caps">
        {capsules.map((c) => <CapsuleTile key={c.id} c={c} cover={covers.get(c.id)} />)}
        {catalogueStyles(db, capsules.length).map((s) => <StyleTile key={s.id} s={s} />)}
      </div>
    </div>
  );
}
