import { useEffect, useState } from 'react';
import { Check, MapPin, Pencil, Plus, RefreshCw, ShoppingBag, Trash2, Undo2, X } from 'lucide-react';
import type { Need, Product } from '../api.ts';
import { api, thumb } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { Badge, CategoryIcon, ConfirmButton, Empty, Img, JobBar, Modal, UploadButton } from '../components/ui.tsx';
import { activeLocale, distinctLooks, fmtDay, itemArt, looksUsing, plainShopName, purchasePlan, purchaseRanking, shopLocation, shopStores, siteLooks, storeKey } from '../lib.ts';
import { TermInfo } from './Glossary.tsx';
import { t } from '../i18n.ts';

const STALE_DAYS = 14;

type ProductForm = Record<'store' | 'brand' | 'model' | 'sku' | 'url' | 'composition' | 'fit' | 'price' | 'currency' | 'recommendedSize' | 'sizeBasis' | 'checkedAt' | 'sources' | 'onlineAvailability' | 'towerAvailability', string>;

function ProductEditor({ need, product, onClose }: { need: Need; product?: Product; onClose: () => void }) {
  const { act } = useApp();
  const [f, setF] = useState<ProductForm>({
    store: product?.store ?? '',
    brand: product?.brand ?? '',
    model: product?.model ?? '',
    sku: product?.sku ?? '',
    url: product?.url ?? '',
    composition: product?.composition ?? '',
    fit: product?.fit ?? '',
    price: product?.price != null ? String(product.price) : '',
    currency: product?.currency ?? 'EUR',
    recommendedSize: product?.recommendedSize ?? '',
    sizeBasis: product?.sizeBasis ?? '',
    checkedAt: product?.checkedAt ?? new Date().toISOString().slice(0, 10),
    sources: product?.sources ?? '',
    onlineAvailability: product?.onlineAvailability ?? 'unknown',
    towerAvailability: product?.towerAvailability ?? 'unknown',
  });
  const set = (k: keyof ProductForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    const body = { ...f, checkedAt: new Date().toISOString().slice(0, 10), needId: need.id, rev: product?.rev };
    const ok = await act(() => (product ? api('PATCH', `/api/products/${product.id}`, body) : api('POST', '/api/products', body)), t('Товар збережено'));
    if (ok) onClose();
  };
  const field = (k: keyof ProductForm, label: string, placeholder = '', full = false) => (
    <label className={`field${full ? ' full' : ''}`}>
      <span>{t(label)}</span>
      <input className="input" value={f[k]} onChange={k === 'price' ? (e) => set(k)({ target: { value: e.target.value.replace(',', '.') } }) : set(k)} placeholder={t(placeholder)} inputMode={k === 'price' ? 'decimal' : undefined} />
    </label>
  );
  return (
    <Modal
      title={product ? t('Редагувати товар') : t('Товар для «{title}»', { title: need.title })}
      onClose={onClose}
      footer={
        <>
          {product && (
            <ConfirmButton className="btn ghost danger" title={t('Видалити товар')} message={t('Видалити {name}?', { name: `${product.brand} ${product.model}` })} onConfirm={async () => { const ok = await act(() => api('DELETE', `/api/products/${product.id}`), t('Товар видалено')); if (ok !== undefined) onClose(); }}>
              <Trash2 size={14} />
            </ConfirmButton>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
          <button className="btn primary" onClick={() => void save()}>{t('Зберегти')}</button>
        </>
      }
    >
      <div className="grid-form">
        {field('store', 'Магазин', 'напр. Massimo Dutti')}
        {field('brand', 'Бренд')}
        {field('model', 'Модель', 'назва моделі')}
        {field('url', 'URL', 'https://…', true)}
        {field('price', 'Ціна', '0.00')}
        {field('recommendedSize', 'Розмір')}
      </div>
    </Modal>
  );
}

/** One question for a replacement (owner, 18.11): may the old item leave the wardrobe? */
function RetireOld({ need, value, onChange }: { need?: Need; value: boolean; onChange: (v: boolean) => void }) {
  const db = useDb();
  const old = need?.replaces ? db.items.find((i) => i.id === need.replaces && i.status !== 'inactive') : undefined;
  if (!old) return null;
  return (
    <label className="row" style={{ gap: 8 }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{t('Прибрати «{title}» з гардероба', { title: old.title })}</span>
    </label>
  );
}

function PurchaseModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const [retire, setRetire] = useState(false);
  const [size, setSize] = useState(product.recommendedSize ?? '');
  const [photoId, setPhotoId] = useState<string | undefined>();
  return (
    <Modal
      title={t('Позначити купленим')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await act(() => api('POST', `/api/products/${product.id}/purchase`, { size, photoId, retire }), t('Річ додано в гардероб, образи оновлено'));
              if (ok) onClose();
            }}
          >
            <Check size={14} /> {t('Куплено')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <p><b>{product.brand} {product.model}</b></p>
        <label className="field">
          <span>{t('Мій розмір (у системі бренду)')}</span>
          <input className="input" value={size} onChange={(e) => setSize(e.target.value)} placeholder={t('напр. M або W32 L32')} />
        </label>
        <div className="row">
          <UploadButton kind="item" multiple={false} className="btn sm" label={photoId ? t('Фото додано ✓') : t('Додати своє фото')} onDone={(ids) => setPhotoId(ids[0])} />
        </div>
        <RetireOld need={db.needs.find((n) => n.id === product.needId)} value={retire} onChange={setRetire} />
      </div>
    </Modal>
  );
}

/** Prices formatted for the active interface language. */
const money = (v: number, cur?: string) => {
  try {
    return new Intl.NumberFormat(activeLocale(), { style: 'currency', currency: cur || 'EUR', currencyDisplay: 'narrowSymbol' }).format(v);
  } catch {
    return `${v} ${cur ?? ''}`.trim();
  }
};

/** Product names without shop codes: «Handball Spezial Shadow Brown (JQ1740)» → «Handball Spezial Shadow Brown». */
const cleanName = (s: string) => s.replace(/\s*\((?=[^)]*\d)[A-Z0-9][A-Z0-9 /.-]{3,}\)\s*$/, '').replace(/\s+\d{6,}(?=\s|$)/g, '').trim();

/** A found product (owner, 18.11): the name opens the shop page; one «Куплено»; × removes the variant. */
/** Where a shop is (owner, 19–20.11): the owner's own shopping place, the nearest store with its distance, or online. */
type Where = { line: string; href?: string };
function storePlaces(db: ReturnType<typeof useDb>): Map<string, Where> {
  const here = shopLocation(db);
  // The city of the shopping place («Arkadia, Warsaw, Poland» → «Warsaw») is left out of store lines there.
  const parts = here.split(',').map((x) => x.trim()).filter(Boolean);
  const city = parts.length > 2 ? parts.at(-2)! : parts.length === 2 ? parts[1] : '';
  const esc = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noCity = (text: string, sep: string) => (city ? text.replace(new RegExp(`${sep}${esc}$`, 'i'), '') : text);
  const map = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const out = new Map<string, Where>();
  for (const s of shopStores(db)) {
    const name = plainShopName(s.name);
    // A store at the owner's own shopping place is named like the others there.
    const atHere = Boolean(here) && Boolean(s.place?.place.toLowerCase().includes(noCity(here.split(',')[0], '\\s+').toLowerCase()));
    if (s.place && !s.place.online) out.set(s.key, { line: atHere ? here.split(',')[0] : `${noCity(s.place.place, ',\\s*')}${s.place.km ? ` · ≈ ${s.place.km} ${t('км')}` : ''}`, href: map(`${name} ${s.place.place}`) });
    else if (s.atPlace && here) out.set(s.key, { line: here.split(',')[0], href: map(`${name} ${here}`) });
    else if (s.place?.online) out.set(s.key, { line: t('онлайн'), href: s.place.url ?? (s.host ? `https://${s.host}` : undefined) });
  }
  return out;
}

/** One found product as one line (owner, 20.11): what, where to buy, price, size, how well it fits, actions. */
function ProductLine({ p, need, best, where }: { p: Product; need: Need; best: boolean; where?: Where }) {
  const db = useDb();
  const { act } = useApp();
  const [buy, setBuy] = useState(false);
  const photo = p.photoId ? db.photos.find((x) => x.id === p.photoId) : undefined;
  const concept = need.conceptPhotoId ? db.photos.find((x) => x.id === need.conceptPhotoId) : undefined;
  const stale = p.checkedAt && Date.now() - new Date(p.checkedAt).getTime() > STALE_DAYS * 864e5;
  const name = cleanName(`${p.brand} ${p.model}`.trim());
  const open = need.status === 'open' && p.status !== 'purchased';
  const shop = plainShopName(p.store);
  return (
    <div className={`product-line${p.status === 'purchased' ? ' bought' : ''}`}>
      <span className="pl-img">{photo ? <Img path={photo.path} w={160} /> : concept ? <Img path={concept.path} w={160} /> : <CategoryIcon category={need.category} size={18} />}</span>
      <span className="pl-main">
        {p.url ? <a className="pl-name" href={p.url} target="_blank" rel="noreferrer">{name}</a> : <b className="pl-name">{name}</b>}
        <span className="pl-sub">{[shop, p.recommendedSize ? `${t('розмір')} ${p.recommendedSize}` : ''].filter(Boolean).join(' · ')}</span>
      </span>
      {where?.href
        ? <a className="pl-where" href={where.href} target="_blank" rel="noreferrer"><MapPin size={13} />{where.line}</a>
        : <span className="pl-where">{where ? <><MapPin size={13} />{where.line}</> : null}</span>}
      <span className="pl-price">{p.price != null ? money(p.price, p.currency) : ''}{stale && <span className="pl-stale">{t('ціна')} {fmtDay(p.checkedAt!)}</span>}</span>
      <span className="pl-score">{p.matchScore != null && <>{p.matchScore}/10{best && <span className="pl-best">{t('найкраще')}</span>}<TermInfo texts={[]} notes={[{ title: t('Чому пасує'), text: p.matchNote }]} /></>}</span>
      <span className="pl-act">
        {p.status === 'purchased' && <Badge tone="ok">{t('куплено')}</Badge>}
        {open && <button className="btn sm quiet" onClick={() => setBuy(true)}><Check size={12} /> {t('Куплено')}</button>}
        {open && <button className="product-x" aria-label={t('Прибрати варіант {name}', { name })} onClick={() => void act(() => api('DELETE', `/api/products/${p.id}`))}><X size={13} /></button>}
      </span>
      {buy && <PurchaseModal product={p} onClose={() => setBuy(false)} />}
    </div>
  );
}

type CoverReply = { looks: number; queued: number; waiting: number };

const coverToast = (verb: string, r: CoverReply) =>
  [t(verb), r.looks ? t('образів оновлено: {n}', { n: r.looks }) : '', r.queued ? t('нових примірок: {n}', { n: r.queued }) : '', r.waiting ? t('примірок чекає: {n}', { n: r.waiting }) : ''].filter(Boolean).join(' · ');

/** "Вже маю": pick the owner's item that is what the recommendation asked for. */
function CoverModal({ need, onClose }: { need: Need; onClose: () => void }) {
  const db = useDb();
  const { act, toast } = useApp();
  const [retire, setRetire] = useState(false);
  const items = db.items.filter((i) => i.category === need.category && i.status !== 'inactive' && !i.mergedInto && i.id !== need.replaces);
  const cover = async (itemId: string) => {
    const r = await act(() => api<CoverReply>('POST', `/api/needs/${need.id}/cover`, { itemId, retire }));
    if (!r) return;
    toast(coverToast(t('Прибрано з покупок'), r));
    onClose();
  };
  return (
    <Modal title={`${t('Вже маю')}: ${need.title}`} onClose={onClose} wide>
      <RetireOld need={need} value={retire} onChange={setRetire} />
      {items.length === 0 ? (
        <p className="muted">{t('У гардеробі немає речей цієї категорії. Додай фото — збіг знайдеться сам.')}</p>
      ) : (
        <div className="own-picks">
          {items.map((i) => {
            const { art, photo } = itemArt(db, i.id);
            return (
              <button key={i.id} className="own-pick" onClick={() => void cover(i.id)}>
                <span className="img"><Img path={art ?? photo} w={320} alt={i.title} /></span>
                <span>{i.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/** «пасує до 5 образів · завершує 2» (owner, 19.11): what the spend really gives; «завершує» only when it completes something (20.11). */
const planLine = (p: { fits: number; completes: number }) => `${t(p.fits === 1 ? 'пасує до {n} образу' : 'пасує до {n} образів', { n: p.fits })}${p.completes ? ` · ${t('завершує {n}', { n: p.completes })}` : ''}`;
/** When one purchase is not enough: the rest of the smallest set and the look it makes wearable. */
const planWith = (p: ReturnType<typeof purchasePlan>) => (p.with ? t('ще {others} — і готовий «{look}»', { others: p.with.others.join(', '), look: p.with.look.name }) : '');

function NeedCard({ need, top = false, places }: { need: Need; top?: boolean; places: Map<string, Where> }) {
  const db = useDb();
  const { act, toast } = useApp();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [owning, setOwning] = useState(false);
  // Found variants, best match first.
  const products = db.products.filter((p) => p.needId === need.id).sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  const plan = purchasePlan(db, need.id);
  const shopPhoto = products.map((p) => db.photos.find((x) => p.photoId && x.id === p.photoId)).find((x) => x !== undefined);
  const searches = db.jobs.filter((j) => j.kind === 'shopsearch' && j.needId === need.id);
  const waitJob = searches.find((j) => j.state === 'running') ?? searches.find((j) => j.state === 'queued');
  const waiting = Boolean(waitJob);
  // The last search that added nothing or failed says so in one grey line.
  const last = [...searches].filter((j) => j.state === 'done' || j.state === 'error').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  const lastNote = !waiting && last && (last.state === 'error' || !/^Знайдено/.test(last.stateNote ?? '')) ? t(last.stateNote ?? '') : '';
  const search = () => act(() => api('POST', `/api/needs/${need.id}/search`));
  const covered = need.coveredByItem ? db.items.find((i) => i.id === need.coveredByItem) : undefined;
  const bought = products.find((p) => p.status === 'purchased');
  const replaces = need.replaces ? db.items.find((i) => i.id === need.replaces) : undefined;
  const forCapsule = need.forCapsule ? db.capsules.find((c) => c.id === need.forCapsule) : undefined;
  const replacedIn = need.coveredLookIds?.map((id) => db.looks.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => Boolean(l)) ?? [];
  const using = looksUsing(db, 'need', need.id);
  const looks = need.status === 'covered' ? distinctLooks(db, replacedIn) : siteLooks(db).filter((l) => using.some((x) => x.id === l.id));
  // «Найкраще пасує» only when one variant is clearly ahead of the next.
  const bestId = products.length && (products[0].matchScore ?? 0) > (products[1]?.matchScore ?? -1) ? products[0].id : '';
  const uncover = async () => {
    const r = await act(() => api<CoverReply>('POST', `/api/needs/${need.id}/uncover`));
    if (r) { toast(coverToast(t('Повернуто в покупки'), r)); setEditing(false); }
  };
  const unbuy = async () => {
    if (!bought) return;
    const ok = await act(() => api('POST', `/api/products/${bought.id}/unpurchase`), t('Покупку скасовано'));
    if (ok !== undefined) setEditing(false);
  };
  return (
    <div id={`need-${need.id}`} className="need">
      <span className="need-art">
        {need.conceptPhotoId && db.photos.find((p) => p.id === need.conceptPhotoId) ? (
          <img src={thumb(db.photos.find((p) => p.id === need.conceptPhotoId)!.path, 240)} alt={need.title} />
        ) : covered?.packshotId && db.photos.find((p) => p.id === covered.packshotId) ? (
          <img src={thumb(db.photos.find((p) => p.id === covered.packshotId)!.path, 240)} alt={need.title} />
        ) : shopPhoto ? (
          // An advisor purchase has no concept picture: the best found product stands in.
          <img src={thumb(shopPhoto.path, 240)} alt={need.title} />
        ) : (
          <CategoryIcon category={need.category} size={24} />
        )}
      </span>
      <div className="need-body">
        <div className="need-head">
          <div className="need-info">
            {top && <span className="eyebrow-sm">{t('Наступна покупка')}</span>}
            <h3>{need.title.includes(' ') ? `${need.title.slice(0, need.title.lastIndexOf(' '))} ` : ''}<span className="nowrap">{need.title.slice(need.title.lastIndexOf(' ') + 1)}<TermInfo texts={[need.title, need.description]} notes={[{ title: t('Навіщо'), text: need.why }, ...(need.status === 'open' ? [{ title: t('Що перевірити'), text: need.fitCheck }] : [])]} /></span>{need.status === 'covered' && <Badge tone="ok">{bought ? t('куплено') : t('вже є')}</Badge>}</h3>
            <span className="need-line">
              {forCapsule && <a href={`/capsules/${forCapsule.id}`}>{forCapsule.name}</a>}
              {replaces && <span>{t('замінить')} <a href={`/wardrobe/${replaces.id}`}>{replaces.title}</a></span>}
              {covered && <span>{bought ? t('куплено') : t('своя річ')}: <a href={`/wardrobe/${covered.id}`}>{covered.title}</a></span>}
              {need.status === 'open' && plan.fits > 0 && <span>{planLine(plan)}</span>}
            </span>
            {need.status === 'open' && plan.with && <span className="need-line">{planWith(plan)}</span>}
            {looks.length > 0 && (
              <span className="need-looks">{looks.map((l) => <a key={l.id} href={`/looks/${l.id}`}>{l.name}</a>)}</span>
            )}
          </div>
          <div className="need-acts">
            {need.status === 'open' && (
              <button className="icon-btn" disabled={waiting} onClick={() => void search()} aria-label={products.length ? t('Оновити пошук') : t('Знайти варіанти')} title={products.length ? t('Оновити пошук') : t('Знайти варіанти')}>
                <RefreshCw size={14} />
              </button>
            )}
            <button className="icon-btn" aria-label={t('Редагувати покупку')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
          </div>
        </div>
        {waitJob && <div className="search-run"><JobBar job={waitJob} label /></div>}
        {lastNote && <span className="small muted">{lastNote}</span>}
        {products.length > 0 && (
          <div className="product-lines">
            {products.map((p) => <ProductLine key={p.id} p={p} need={need} best={p.id === bestId} where={places.get(storeKey(p.store))} />)}
          </div>
        )}
      </div>
      {adding && <ProductEditor need={need} onClose={() => setAdding(false)} />}
      {editing && (
        <Modal
          title={need.title}
          onClose={() => setEditing(false)}
          footer={
            <>
              {!bought && (
                <ConfirmButton className="btn ghost danger" title={t('Видалити покупку')} message={<>{t('Видалити «{name}»?', { name: need.title })}{using.length ? ` ${t('Вона зникне з {n} образів.', { n: using.length })}` : ''}</>} onConfirm={async () => { const ok = await act(() => api('DELETE', `/api/needs/${need.id}`), 'Видалено'); if (ok !== undefined) setEditing(false); }}>
                  <Trash2 size={14} />
                </ConfirmButton>
              )}
              <span style={{ flex: 1 }} />
              {need.status === 'open' && <button className="btn" onClick={() => { setEditing(false); setAdding(true); }}><Plus size={14} /> {t('Товар у магазині')}</button>}
              {need.status === 'open' && <button className="btn primary" onClick={() => { setEditing(false); setOwning(true); }}><Check size={14} /> {t('Вже маю')}</button>}
              {need.status === 'covered' && covered && !bought && <button className="btn" onClick={() => void uncover()}><Undo2 size={14} /> {t('Повернути в покупки')}</button>}
              {bought && <ConfirmButton className="btn" title={t('Скасувати покупку')} message={<>{t('Скасувати покупку «{name}»? Річ зникне з гардероба, покупка повернеться.', { name: cleanName(`${bought.brand} ${bought.model}`) })}</>} onConfirm={() => void unbuy()}><Undo2 size={14} /> {t('Скасувати покупку')}</ConfirmButton>}
            </>
          }
        >
          <p className="muted">{need.description}</p>
        </Modal>
      )}
      {owning && <CoverModal need={need} onClose={() => setOwning(false)} />}
    </div>
  );
}

export function ShoppingPage({ focus }: { focus?: string }) {
  const db = useDb();
  useEffect(() => {
    if (focus) window.setTimeout(() => document.getElementById(`need-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [focus]);
  // Open purchases only, by the next-purchase rating (owner, 20.11: no «Відкриті / Усі» filter). A link to a closed one
  // (from a wardrobe item) still shows it, after the open ones.
  const order = new Map(purchaseRanking(db).map((r, i) => [r.need.id, i]));
  const needs = db.needs
    .filter((n) => n.status === 'open' || n.id === focus)
    .sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
  const places = storePlaces(db);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Покупки')}</h1>
        </div>
      </div>
      {/* Where to buy sits on every product line (owner, 20.11), so there is no separate store list to scroll to. */}
      {needs.length === 0 ? (
        <Empty icon={<ShoppingBag />} title={t('Відкритих покупок немає')} />
      ) : (
        <div className="needs">
          {needs.map((n, i) => <NeedCard key={n.id} need={n} top={i === 0 && n.status === 'open'} places={places} />)}
        </div>
      )}
    </div>
  );
}
