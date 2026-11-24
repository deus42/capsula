import { Fragment, useEffect, useState } from 'react';
import { ArrowLeftRight, ImageOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { DB, Job, Look, SlotKey, SlotRef } from '../api.ts';
import { api, media, quotaNote, thumb } from '../api.ts';
import { go, useApp, useDb } from '../store.tsx';
import { Badge, CategoryIcon, Empty, LookArt, Missing, Modal, RateButtons } from '../components/ui.tsx';
import type { ResolvedRef } from '../lib.ts';
import { SLOT_CATEGORIES, SLOT_LABEL, capsuleLooks, coverForLook, currentCover, currentWear, distinctLooks, eyewearBlocked, indoorOnly, itemArt, lookRating, lookVariants, resolveRef, scoreLabel } from '../lib.ts';
import { hiddenLookIds } from '../rating.ts';
import { freePlaces, inSavedSet, normalizePiece, pieceCategory, pieceGroup, pieceKey, visibleCapsuleLooks } from '../capsule-pieces.ts';
import { rendersPaused } from '../render-need.ts';
import { EditLook } from './Capsules.tsx';
import { AddWear, WearPair, WearReview } from '../components/Wear.tsx';
import { InfoMark, TermInfo } from './Glossary.tsx';
import { t } from '../i18n.ts';

const SLOTS: SlotKey[] = ['layer', 'top', 'bottom', 'shoes', 'accessories'];
const same = (a: SlotRef, b: SlotRef) => a.kind === b.kind && a.id === b.id;

/** Kind of accessory from its title (Ukrainian and English). */
const ACCESSORY_KINDS: [string, RegExp][] = [
  ['bag', /сумк|рюкзак|bag|backpack|tote|satchel|crossbody|pouch/i],
  ['watch', /годинник|watch|timepiece/i],
  ['cap', /кепк|шапк|панам|cap|beanie|hat|bucket|beret/i],
  ['glasses', /окуляр|оправ|glasses|sunglasses|eyewear|frames/i],
  ['belt', /ремін(?!ц)|ремен(?!ц)|пояс|belt/i],
];
const accessoryKind = (title: string) => ACCESSORY_KINDS.find(([, re]) => re.test(title))?.[0];

/**
 * Other accessories of the same kind the owner has, offered as one-tap swaps.
 * One different piece keeps it the same look (owner rule), so the rating stays.
 */
const COLOURS = ['коричнев', 'чорн', 'бежев', 'сір', 'синь', 'синій', 'біл', 'зелен', 'олив', 'taupe', 'коньяч', 'кремов', 'молочн', 'бордов', 'червон', 'brown', 'black', 'tan', 'beige', 'sand', 'grey', 'gray', 'navy', 'blue', 'white', 'cream', 'ivory', 'green', 'olive', 'khaki', 'burgundy', 'red', 'cognac', 'camel'];

function accessoryOptions(db: DB, look: Look) {
  const noGlasses = eyewearBlocked(db);
  const capsule = db.capsules.find((c) => c.id === look.capsuleId);
  const inLook = new Set(look.slots.accessories.map((r) => `${r.kind}:${r.id}`));
  return look.slots.accessories
    .map((current) => {
      const title = resolveRef(db, current).title;
      const kind = accessoryKind(title);
      if (!kind || (noGlasses && kind === 'glasses')) return null;
      // Closest first: shared words (colour, material), then owner-confirmed.
      const stems = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 5).map((w) => w.slice(0, 6)));
      const mine = stems(title);
      const close = (t: string) => [...stems(t)].filter((w) => mine.has(w)).length;
      // A belt keeps the colour of the one it replaces (it goes with the shoes): no black belt under brown suede.
      const colours = (t: string) => COLOURS.filter((c) => t.toLowerCase().includes(c));
      const mineColours = colours(title);
      const sameColour = (t: string) => kind !== 'belt' || !mineColours.length || colours(t).some((c) => mineColours.includes(c));
      const options = db.items
        .filter((i) => i.category === 'accessories' && i.status !== 'inactive' && !i.mergedInto && !inLook.has(`item:${i.id}`) && accessoryKind(i.title) === kind && sameColour(i.title)
          && (!capsule?.pieces || inSavedSet(db, capsule, { kind: 'item', id: i.id })))
        .sort((a, b) => close(b.title) - close(a.title) || Number(b.status === 'confirmed') - Number(a.status === 'confirmed'))
        .slice(0, 3);
      return options.length ? { current, title, options } : null;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

/**
 * The one screen of a look (owner, 17.11): its best picture, the owner's
 * "Це я?" check, its pieces (tap one to swap it), accessory options and the
 * other looks of the capsule. A look is its set of pieces; the rating
 * survives a new picture or a swapped piece, and a changed composition gets
 * a new try-on by itself.
 */
export function LookPage({ id }: { id: string }) {
  const db = useDb();
  const { act, toast, session } = useApp();
  const [editing, setEditing] = useState(false);
  const [swap, setSwap] = useState<{ slot?: SlotKey; current?: SlotRef; variant?: boolean } | null>(null);
  const [keptNow, setKeptNow] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  // The picture the owner asked for: one quiet word if it could not be made (the slider simply stops otherwise).
  const askedJob = asked ? db.jobs.find((j) => j.id === asked) : undefined;
  const askedState = askedJob?.state;
  useEffect(() => {
    if (askedState === 'error') toast(t(askedJob?.stateNote ?? 'Не вдалося оновити картинку'), true);
    if (askedState === 'error' || askedState === 'done' || askedState === 'needs_data') setAsked(null);
  }, [askedState, askedJob?.stateNote, toast]);
  const look = db.looks.find((l) => l.id === id);
  if (!look) return <div className="page"><Empty icon={<ImageOff />} title={t('Образ не знайдено')} /></div>;
  const capsule = db.capsules.find((c) => c.id === look.capsuleId);
  const isSelection = capsule?.kind === 'selection';
  const cover = coverForLook(db, look);
  const stale = cover && cover.lookVersion !== look.version;
  const shown = currentCover(db, look, true);
  const wear = currentWear(db, look);
  const hidden = hiddenLookIds(db).has(look.id);
  const variants = lookVariants(db, look);
  const capsuleMains = capsule ? distinctLooks(db, capsuleLooks(db, capsule.lookIds)) : [];
  const siblings = capsuleMains.filter((l) => l.id !== look.id && !variants.some((v) => v.id === l.id));
  const canMakePrimary = variants.length > 0 && !capsuleMains.some((l) => l.id === look.id);
  // The owner asked for a new picture: the slider runs until it arrives (queued or being made).
  const lookJobs = db.jobs.filter((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === look.id);
  const busy = lookJobs.some((j) => j.state === 'queued' || j.state === 'running');
  const latest = lookJobs.filter((j) => j.lookVersion === look.version).at(-1);
  const renderIssue = latest?.state === 'needs_data' ? t(latest.stateNote ?? 'Потрібні дані')
    : latest?.state === 'error' ? t('Не вдалося оновити картинку') : undefined;
  const paused = rendersPaused(db);
  // Accounts: the month's try-ons are used up (or the budget paused generation).
  const limit = quotaNote(session, 'tryon');
  const kept = look.keptVersion === look.version;
  // Manual fallback when an automatic update is unavailable.
  const askUpdate = Boolean(stale) && !busy && !paused && !limit && !kept && keptNow !== `${look.id}:${look.version}`;
  const options = accessoryOptions(db, look);
  // The advisor's one better owned piece for this version of the look.
  const sw = look.advice?.version === look.version ? look.advice.swap : undefined;
  const active = (id?: string) => db.items.find((i) => i.id === id && i.status !== 'inactive' && !i.mergedInto);
  const swapAdvice = sw && active(sw.from) && active(sw.to) && (!capsule?.pieces || inSavedSet(db, capsule, { kind: 'item', id: sw.to }))
    ? { from: active(sw.from)!, to: active(sw.to)! } : null;

  const update = async () => {
    // The server uses the pinned identity reference when there is one.
    const job = await act(() => api<Job>('POST', '/api/jobs', { lookId: look.id, basePhotoIds: db.profile.basePhotoIds, instructions: '', run: true }));
    if (job?.state === 'needs_data') toast(t(job.stateNote ?? 'Зараз не вийде'), true);
    else if (job) setAsked(job.id);
  };
  const keep = () => {
    setKeptNow(`${look.id}:${look.version}`);
    void act(() => api('PATCH', `/api/looks/${look.id}`, { rev: look.rev, keptVersion: look.version }));
  };
  const itsMe = (yes: boolean) =>
    shown &&
    act(
      () => api('POST', `/api/results/${shown.id}/review`, yes ? { decision: 'accepted' } : { decision: 'rework', reason: 'face' }),
      yes ? t('Прийнято') : t('Прибрано'),
    );
  const swapAccessory = (current: SlotRef, id: string) =>
    act(() => api('PATCH', `/api/looks/${look.id}`, { rev: look.rev, slots: { ...look.slots, accessories: look.slots.accessories.map((r) => (same(r, current) ? { kind: 'item', id } : r)) } }));

  const pieces = SLOTS.flatMap((slot) => look.slots[slot].map((ref) => ({ slot, r: resolveRef(db, ref) })));
  const own = pieces.filter((p) => p.r.kind === 'owned' || p.r.kind === 'candidate');
  const buy = pieces.filter((p) => p.r.kind === 'need' || p.r.kind === 'product');
  // A piece opens its own page (wardrobe item or the purchase); swapping is the small icon on its picture.
  const pieceHref = (r: ResolvedRef) => r.ref.kind === 'item' ? `/wardrobe/${r.ref.id}` : `/shopping?need=${r.ref.kind === 'need' ? r.ref.id : (db.products.find((p) => p.id === r.ref.id)?.needId ?? '')}`;
  const tile = ({ slot, r }: { slot: SlotKey; r: ResolvedRef }) => (
    <a key={`${slot}-${r.ref.kind}-${r.ref.id}`} className="wtile" href={pieceHref(r)}>
      <span className="img">
        {r.art || r.photo ? <img src={thumb((r.art ?? r.photo)!, 480)} alt={r.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={r.category} size={22} /></span>}
        {r.inactive && <span className="tl"><Badge tone="glass">{t('неактуальна')}</Badge></span>}
        <button className="swap-btn" aria-label={`${t('Замінити')}: ${r.title}`} title={t('Замінити')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSwap({ slot, current: r.ref }); }}>
          <ArrowLeftRight size={14} />
        </button>
      </span>
      <span className="nm">{r.title}<TermInfo texts={[r.title]} /></span>
    </a>
  );

  return (
    <div className="page">
      <div className="crumb">
        <a href={isSelection ? '/capsules?tab=selections' : '/capsules'}>{isSelection ? t('Підбірки') : t('Капсули')}</a>
        {capsule && <><span>›</span><a href={`/capsules/${capsule.id}`}>{capsule.name}</a></>}
      </div>
      <div className="page-head">
        <div>
          <h1>{look.name}</h1>
          {(lookRating(look) !== null || indoorOnly(db, look)) && <p className="item-verdict">
            {lookRating(look) !== null && <>{scoreLabel(lookRating(look)!)}{look.advice!.why && <InfoMark title={scoreLabel(lookRating(look)!)} text={look.advice!.why} />}</>}
            {indoorOnly(db, look) && <>{lookRating(look) !== null ? ' · ' : ''}{t('у приміщенні')}</>}
          </p>}
          {hidden && <div className="row wrap" style={{ marginTop: 12 }}><Badge>{look.disliked ? t('приховано') : capsule?.disliked ? t('капсулу приховано') : t('схожий на прихований')}</Badge></div>}
        </div>
        <div className="actions">
          <RateButtons kind="look" target={look} />
          <button className="icon-btn" aria-label={t('Редагувати образ')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
          {capsule && !hidden && pieces.length > 0 && (
            <button type="button" className="btn" onClick={() => setSwap({ variant: true })}>
              <Plus size={15} /> {t('Створити варіант')}
            </button>
          )}
        </div>
      </div>

      <div className="look-page">
        <div className="look-hero">
          <div className="hero-pic">
            <a className="cover" href={shown ? media(shown.imagePath) : undefined} target={shown ? '_blank' : undefined} rel="noreferrer">
              <LookArt look={look} w={960} busy={busy} label reviewLatest />
            </a>
            {!paused && (
              <button className="refresh-btn" disabled={busy || Boolean(limit)} onClick={() => void update()} aria-label={t('Оновити картинку')} title={limit ?? t('Оновити картинку')}>
                <RefreshCw size={15} />
              </button>
            )}
          </div>
          {shown && shown.review === 'pending' && !busy && (
            <div className="update-ask">
              <span>{t('Це я?')}</span>
              <button className="btn sm" onClick={() => void itsMe(false)}>{t('Ні')}</button>
              <button className="btn sm primary" onClick={() => void itsMe(true)}>{t('Так')}</button>
            </div>
          )}
          {!busy && renderIssue && <p className="miss" role="status" style={{ marginTop: 8 }}>{renderIssue}</p>}
          {limit && <p className="miss" role="status" style={{ marginTop: 8 }}>{limit}{session?.support && <> · <a href={session.support} target="_blank" rel="noreferrer">{t('Підтримати')}</a></>}</p>}
          {askUpdate && (
            <div className="update-ask">
              <span>{t('Речі змінено')}</span>
              <button className="btn sm" onClick={keep}>{t('Ні')}</button>
              <button className="btn sm primary" onClick={() => void update()}>{t('Оновити')}</button>
            </div>
          )}
          {swapAdvice && (
            <div className="update-ask">
              <span>{t('Порада:')} {swapAdvice.from.title} → {swapAdvice.to.title}</span>
              <button className="btn sm" onClick={() => void act(() => api('POST', `/api/looks/${look.id}/advice`, { accept: false }))}>{t('Ні')}</button>
              <button className="btn sm primary" onClick={() => void act(() => api('POST', `/api/looks/${look.id}/advice`, { accept: true }))}>{t('Так')}</button>
            </div>
          )}
          {wear && <>
            <div className="section-head"><h2 className="h2">{t('Реальне фото')}</h2></div>
            <WearPair wear={wear} coverId={shown?.id} />
            <WearReview wear={wear} />
          </>}
          <AddWear look={look} />
        </div>
        <div className="look-side">
          <div className="section-head"><h2 className="h2">{t('Речі образу')} <span className="count">{own.length}</span></h2></div>
          <div className="ward-grid">
            {own.map(tile)}
            <button className="wtile add" onClick={() => setSwap({})}>
              <span className="img"><Plus size={22} /></span>
              <span className="nm">{t('Додати річ')}</span>
            </button>
          </div>
          {buy.length > 0 && <>
            <div className="section-head"><h2 className="h2">{t('Докупити')} <span className="count">{buy.length}</span></h2><a href="/shopping">{t('Покупки')}</a></div>
            <div className="ward-grid">{buy.map(tile)}</div>
          </>}
          {options.map((o) => (
            <Fragment key={`${o.current.kind}-${o.current.id}`}>
              <div className="section-head"><h2 className="h2">{t('Або замість «')}{o.title}»</h2></div>
              <div className="ward-grid">
                {o.options.map((i) => {
                  const r = resolveRef(db, { kind: 'item', id: i.id });
                  return (
                    <button key={i.id} className="wtile" onClick={() => void swapAccessory(o.current, i.id)}>
                      <span className="img">{r.art || r.photo ? <img src={thumb((r.art ?? r.photo)!, 480)} alt={i.title} loading="lazy" /> : null}</span>
                      <span className="nm">{i.title}</span>
                    </button>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      {variants.length > 0 && (
        <>
          <div className="section-head"><h2 className="h2">{t('Варіанти')} <span className="count">{variants.length}</span></h2></div>
          <div className="sib-strip">
            {variants.map((l) => <SiblingCard key={l.id} look={l} />)}
          </div>
        </>
      )}
      {siblings.length > 0 && (
        <>
          <div className="section-head"><h2 className="h2">{isSelection ? t('Ще в підбірці') : t('Ще в капсулі')} <span className="count">{siblings.length}</span></h2>{capsule && <a href={`/capsules/${capsule.id}`}>{isSelection ? t('Уся підбірка') : t('Уся капсула')}</a>}</div>
          <div className="sib-strip">
            {siblings.map((l) => <SiblingCard key={l.id} look={l} />)}
          </div>
        </>
      )}
      {editing && <EditLook
        look={look}
        onClose={() => setEditing(false)}
        onMakePrimary={canMakePrimary ? () => void act(() => api('POST', `/api/looks/${look.id}/primary`, { rev: look.rev })).then((saved) => { if (saved) setEditing(false); }) : undefined}
      />}
      {swap?.variant && !swap.current ? (
        <Modal title={t('Яку річ замінити?')} onClose={() => setSwap(null)} wide>
          <div className="own-picks">
            {pieces.map(({ slot, r }) => (
              <button key={`${slot}-${r.ref.kind}-${r.ref.id}`} type="button" className="own-pick" onClick={() => setSwap({ slot, current: r.ref, variant: true })}>
                <span className="img">{r.art || r.photo ? <img src={thumb((r.art ?? r.photo)!, 320)} alt="" /> : <CategoryIcon category={r.category} size={20} />}</span>
                <span>{r.title}</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : swap && <SwapModal look={look} slot={swap.slot} current={swap.current} variant={swap.variant} onClose={() => setSwap(null)} />}
    </div>
  );
}

/** Swap, remove or add a piece, with an explicit set change for a piece outside the capsule. */
function SwapModal({ look, slot, current, variant, onClose }: { look: Look; slot?: SlotKey; current?: SlotRef; variant?: boolean; onClose: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const capsule = db.capsules.find((c) => c.id === look.capsuleId && c.pieces);
  const [allPieces, setAllPieces] = useState(false);
  const [pending, setPending] = useState<{ ref: SlotRef; slots: Look['slots']; lookRev: number; capsuleRev: number } | null>(null);
  const [replacement, setReplacement] = useState<string>();
  const [saving, setSaving] = useState(false);
  const inCapsule = (ref: SlotRef) => !capsule || inSavedSet(db, capsule, ref);
  const inLook = (ref: SlotRef) => Object.values(look.slots).some((refs) => refs.some((r) => same(normalizePiece(db, r), normalizePiece(db, ref))));
  const art = (id?: string) => (id ? db.photos.find((p) => p.id === id)?.path : undefined);
  // Adding: each piece once, under its natural place (a jumper under «Верх», a jacket under «Шар»).
  const NATURAL: Record<string, SlotKey> = { outerwear: 'layer', knitwear: 'top', shirts: 'top', tees: 'top', dresses: 'top', trousers: 'bottom', shorts: 'bottom', skirts: 'bottom', shoes: 'shoes', accessories: 'accessories' };
  const optionsFor = (s: SlotKey) => {
    const cats = slot ? SLOT_CATEGORIES[s] : SLOT_CATEGORIES[s].filter((c) => NATURAL[c] === s);
    const own = current?.kind === 'item' ? db.items.find((i) => i.id === current.id)?.category : current?.kind === 'need' ? db.needs.find((n) => n.id === current.id)?.category : undefined;
    return [
      ...db.items.filter((i) => cats.includes(i.category) && i.status !== 'inactive' && !i.mergedInto && !(eyewearBlocked(db) && accessoryKind(i.title) === 'glasses')).sort((a, b) => Number(b.category === own) - Number(a.category === own)).map((i) => {
        const { art, photo } = itemArt(db, i.id);
        return { ref: { kind: 'item' as const, id: i.id }, title: i.title, photo: art ?? photo };
      }),
      ...db.needs.filter((n) => n.status === 'open' && cats.includes(n.category)).map((n) => ({ ref: { kind: 'need' as const, id: n.id }, title: `${n.title} · ${t('докупити')}`, photo: art(n.conceptPhotoId) })),
    ].filter(({ ref }) => (allPieces || inCapsule(ref)) && (!variant || !inLook(ref)));
  };
  const save = async (slots: Look['slots'], include?: NonNullable<typeof pending>, selected = include?.ref) => {
    if (saving) return;
    setSaving(true);
    const rev = include?.lookRev ?? look.rev;
    const setChange = include ? { capsuleRev: include.capsuleRev, replaceCapsulePiece: replacement } : {};
    const saved = await act(() => variant
      ? api<Look>('POST', '/api/looks', { variant: { lookId: look.id, rev, slot, from: current, to: selected }, ...setChange })
      : api<Look>('PATCH', `/api/looks/${look.id}`, { rev, slots, ...setChange }));
    setSaving(false);
    if (saved) {
      onClose();
      if (variant) go(`/looks/${saved.id}`);
    }
  };
  const choose = (s: SlotKey, ref: SlotRef) => {
    const list = look.slots[s];
    if (!current && list.some((r) => same(r, ref))) return onClose();
    const next = current ? list.map((r) => same(r, current) ? ref : r).filter((r, i, a) => a.findIndex((x) => same(x, r)) === i) : [...list, ref];
    const slots = { ...look.slots, [s]: next };
    if (!capsule || inCapsule(ref)) return save(slots, undefined, ref);
    setReplacement(undefined);
    setPending({ ref, slots, lookRev: look.rev, capsuleRev: capsule.rev });
  };
  const category = pending && pieceCategory(db, pending.ref);
  const group = category && pieceGroup(category);
  const atLimit = Boolean(capsule && group && (freePlaces(db, capsule)?.[group] ?? 0) <= 0);
  const replaceable = pending && atLimit && capsule ? (capsule.pieces ?? []).filter((ref) => {
    const category = pieceCategory(db, ref);
    if (!category || pieceGroup(category) !== group) return false;
    const used = (slots: Look['slots']) => Object.values(slots).some((refs) => refs.some((r) => same(normalizePiece(db, r), normalizePiece(db, ref))));
    return !used(pending.slots) && !visibleCapsuleLooks(db, capsule).some((other) => (variant || other.id !== look.id) && used(other.slots));
  }) : [];
  const slots = slot ? [slot] : SLOTS;
  return (
    <Modal
      title={variant ? t('Створити варіант') : current ? <a href={current.kind === 'item' ? `/wardrobe/${current.id}` : `/shopping?need=${current.kind === 'need' ? current.id : (db.products.find((p) => p.id === current.id)?.needId ?? '')}`} onClick={onClose}>{resolveRef(db, current).title}</a> : t('Додати річ')}
      onClose={() => { if (!saving) onClose(); }}
      wide
      footer={pending && <>
        <button type="button" className="btn" disabled={saving} onClick={() => setPending(null)}>{t('Назад')}</button>
        <button type="button" className="btn primary" disabled={saving || !capsule || (atLimit && !replacement)} onClick={() => void save(pending.slots, pending)}>{variant ? t('Додати в капсулу й створити варіант') : t('Додати в капсулу й образ')}</button>
      </>}
    >
      {pending && capsule ? (
        <div className="stack" style={{ gap: 12 }}>
          <p><b>{resolveRef(db, pending.ref).title}</b> · {capsule.name}</p>
          {atLimit && (replaceable.length ? (
            <>
              <p>{t('Що замінити в капсулі?')}</p>
              <div className="own-picks">
                {replaceable.map((ref) => {
                  const piece = resolveRef(db, ref);
                  const key = pieceKey(normalizePiece(db, ref));
                  return <button key={key} type="button" className={`own-pick${replacement === key ? ' on' : ''}`} aria-pressed={replacement === key} disabled={saving} onClick={() => setReplacement(key)}>
                    <span className="img">{piece.art ? <img src={thumb(piece.art, 320)} alt="" loading="lazy" /> : <CategoryIcon category={piece.category} size={20} />}</span>
                    <span>{piece.title}</span>
                  </button>;
                })}
              </div>
            </>
          ) : <p>{t('У капсулі немає вільного місця')} · <a href={`/capsules/${capsule.id}`}>{t('Уся капсула')}</a></p>)}
        </div>
      ) : <>
        {capsule && <div className="filters start" role="group" aria-label={t('Речі')}>
          <button type="button" className={!allPieces ? 'on' : undefined} aria-pressed={!allPieces} onClick={() => setAllPieces(false)}>{t('Речі капсули')}</button>
          <button type="button" className={allPieces ? 'on' : undefined} aria-pressed={allPieces} onClick={() => setAllPieces(true)}>{t('Усі речі')}</button>
        </div>}
        {current && slot && !variant && (
          <button className="btn sm ghost danger" disabled={saving} style={{ marginBottom: 14 }} onClick={() => void save({ ...look.slots, [slot]: look.slots[slot].filter((r) => !same(r, current)) })}>
            <Trash2 size={13} /> {t('Прибрати з образу')}
          </button>
        )}
        {slots.map((s) => (
          <div key={s} style={{ marginBottom: 18 }}>
            {!slot && <div className="section-head" style={{ marginTop: 0 }}><h2 className="h2">{SLOT_LABEL[s]}</h2></div>}
            <div className="own-picks">
              {optionsFor(s).map((o) => (
                <button key={`${o.ref.kind}-${o.ref.id}`} className={`own-pick${look.slots[s].some((r) => same(r, o.ref)) ? ' on' : ''}`} disabled={saving} onClick={() => void choose(s, o.ref)}>
                  <span className="img">{o.photo ? <img src={thumb(o.photo, 320)} alt={o.title} loading="lazy" /> : null}</span>
                  <span>{o.title}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </>}
    </Modal>
  );
}

function SiblingCard({ look }: { look: Look }) {
  return (
    <a className="sib" href={`/looks/${look.id}`}>
      <span className="img"><LookArt look={look} w={480} /></span>
      <span className="nm">{look.favorite && <b className="liked-dot" aria-label={t('Подобається')} />}{look.name}</span>
      <Missing look={look} />
    </a>
  );
}
