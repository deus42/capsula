import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Check, Footprints, ImagePlus, Layers, Loader2, PersonStanding, Shirt, ThumbsDown, ThumbsUp, Upload, Watch, X } from 'lucide-react';
import type { Category, Job, Look, Photo, PhotoKind, Slots } from '../api.ts';
import { thumb, uploadFile } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { api } from '../api.ts';
import { ratingOf } from '../rating.ts';
import type { ResolvedRef } from '../lib.ts';
import { REF_KIND_LABEL, currentCover, indoorOnly, expectedSeconds, jobProgress, lookJob, missingInfo, piecesOf, progressShare } from '../lib.ts';
import { TermInfo } from '../pages/Glossary.tsx';
import { t } from '../i18n.ts';

/** Props that may be plain Ukrainian text are translated where they are shown; other nodes pass through. */
const tr = <T,>(v: T): T | string => (typeof v === 'string' ? t(v) : v);

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function KindDot({ kind }: { kind: ResolvedRef['kind'] }) {
  return <span className={`kind-dot k-${kind}`} title={t(REF_KIND_LABEL[kind])} />;
}

export function KindLegend() {
  return (
    <div className="legend">
      {(['owned', 'candidate', 'need', 'product'] as const).map((k) => (
        <span key={k}>
          <KindDot kind={k} /> {t(REF_KIND_LABEL[k])}
        </span>
      ))}
    </div>
  );
}

export function Img({ path, w = 720, alt = '', className }: { path?: string; w?: number; alt?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!path || failed) return <div className={`ph-img ${className ?? ''}`} />;
  return <img src={thumb(path, w)} alt={alt} loading="lazy" className={className} onError={() => setFailed(true)} />;
}

export function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <Overlay onClose={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{tr(title)}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Закрити')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </Overlay>
  );
}


/** File input + drag-and-drop. On iPhone the picker offers camera or library. */
export function UploadButton({
  kind,
  params = {},
  label = 'Завантажити фото',
  multiple = true,
  onDone,
  className = 'btn',
}: {
  kind: PhotoKind;
  params?: Record<string, string>;
  label?: string;
  multiple?: boolean;
  onDone?: (ids: string[]) => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const { act } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const ids: string[] = [];
    await act(async () => {
      for (const f of Array.from(files)) ids.push((await uploadFile(f, { kind, ...params })).id);
    }, files.length > 1 ? t('Завантажено {n} фото', { n: files.length }) : t('Фото завантажено'));
    setBusy(false);
    if (ref.current) ref.current.value = '';
    if (ids.length) onDone?.(ids);
  };
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
        {t(label)}
      </button>
      <input ref={ref} type="file" accept="image/*,.heic,.heif" multiple={multiple} hidden onChange={(e) => void run(e.target.files)} />
    </>
  );
}

export function Dropzone({ kind, params = {}, text, onDone }: { kind: PhotoKind; params?: Record<string, string>; text: string; onDone?: (ids: string[]) => void }) {
  const { act } = useApp();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
        if (!files.length) return;
        const ids: string[] = [];
        void act(async () => {
          for (const f of files) ids.push((await uploadFile(f, { kind, ...params })).id);
        }, t('Завантажено {n} фото', { n: files.length })).then(() => ids.length && onDone?.(ids));
      }}
    >
      <ImagePlus size={20} style={{ margin: '0 auto 6px' }} />
      <div>{t(text)}</div>
      <div style={{ marginTop: 10 }}>
        <UploadButton kind={kind} params={params} onDone={onDone} className="btn sm" label={t('Вибрати файли')} />
      </div>
    </div>
  );
}

export function PhotoPicker({
  title,
  selected,
  onClose,
  onSave,
  filter,
}: {
  title: string;
  selected: string[];
  onClose: () => void;
  onSave: (ids: string[]) => void;
  filter?: (p: Photo) => boolean;
}) {
  const db = useDb();
  const [sel, setSel] = useState<string[]>(selected);
  const photos = db.photos.filter((p) => !p.archivedAt && (!filter || filter(p))).reverse();
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {t('Вибрано')}: {sel.length}
          </span>
          <button className="btn" onClick={onClose}>
            {t('Скасувати')}
          </button>
          <button className="btn primary" onClick={() => onSave(sel)}>
            {t('Зберегти вибір')}
          </button>
        </>
      }
    >
      <div className="thumb-grid">
        {photos.map((p) => (
          <button key={p.id} className={`card tile${sel.includes(p.id) ? ' selected' : ''}`} onClick={() => toggle(p.id)}>
            <div className="img">
              <Img path={p.path} w={360} />
              <span className="sel">{sel.includes(p.id) && <Check size={14} />}</span>
              <span className="corner">
                <Badge tone={p.kind === 'base' ? 'dark' : ''}>{p.kind === 'source' ? t('чат 14.11') : p.kind === 'base' ? t('базове') : p.kind}</Badge>
              </span>
            </div>
            <div className="meta">
              <span className="id">{p.originalName}</span>
              {p.observation && <span className="small muted">{p.observation}</span>}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="card pad" style={{ textAlign: 'center', padding: 40 }}>
      <div style={{ color: 'var(--faint)', display: 'grid', placeItems: 'center', marginBottom: 10 }}>{icon}</div>
      <b>{tr(title)}</b>
      {children && <div className="muted" style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

export function CategoryIcon({ category, size = 18 }: { category?: Category; size?: number }) {
  if (category === 'shoes') return <Footprints size={size} />;
  if (category === 'accessories') return <Watch size={size} />;
  if (category === 'outerwear') return <Layers size={size} />;
  return <Shirt size={size} />;
}

export function Piece({ r, w = 520 }: { r: ResolvedRef; w?: number }) {
  if (r.art) {
    return (
      <div className="piece" title={`${r.title} — ${t(REF_KIND_LABEL[r.kind])}`}>
        <img src={thumb(r.art, w)} alt={r.title} loading="lazy" />
      </div>
    );
  }
  return (
    <div className="piece ph" title={`${r.title} — ${t(REF_KIND_LABEL[r.kind])}`}>
      <span className="ico"><CategoryIcon category={r.category} size={18} /></span>
    </div>
  );
}

/** Small image row of an outfit's pieces; titles live in tooltips, not on screen. */
export function PieceStrip({ slots, size = 44 }: { slots: Slots; size?: number }) {
  const db = useDb();
  const pieces = piecesOf(db, slots);
  return (
    <div className="pstrip">
      {pieces.map((r) => (
        <span key={`${r.ref.kind}-${r.ref.id}`} className={`pthumb k-${r.kind}`} style={{ width: size, height: size }} title={`${r.title} — ${t(REF_KIND_LABEL[r.kind])}`}>
          {r.art ? <img src={thumb(r.art, 160)} alt="" loading="lazy" /> : <CategoryIcon category={r.category} size={Math.round(size * 0.4)} />}
        </span>
      ))}
    </div>
  );
}

/** Flat-lay of an outfit's pieces: used wherever a try-on does not exist yet. */
/** The look's best try-on, or its pieces laid out — never an empty card; a thin bar runs while a try-on is made. */
/** A second-by-second clock for progress bars. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Real progress (owner, 18.11): the thin bar fills from the start to the usual end of this kind of
 * work, so start and end are clear; with `label`, a small «ще ≈ 2 хв» (or «у черзі» while waiting).
 */
export function JobBar({ job, label = false, className = '' }: { job: Job; label?: boolean; className?: string }) {
  const db = useDb();
  const now = useNow();
  const p = jobProgress(db, job, now);
  return (
    <>
      <span className={`busy-bar det ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.pct * 100)} aria-label={p.label} title={p.label}>
        <i style={{ width: `${p.pct * 100}%` }} />
      </span>
      {label && <span className="eta">{p.label}</span>}
    </>
  );
}

/** The top bar: one span over all running work — earliest start to the latest usual end — that never moves backwards. */
export function SpanBar({ jobs, className = '' }: { jobs: Job[]; className?: string }) {
  const db = useDb();
  const now = useNow();
  const peak = useRef(0);
  const ids = useRef(new Set<string>());
  // Overlapping work never moves the bar back; the next job of a chain (photo → picture → advisor) starts it afresh.
  if (!jobs.some((j) => ids.current.has(j.id))) peak.current = 0;
  ids.current = new Set(jobs.map((j) => j.id));
  const starts = jobs.map((j) => new Date(j.startedAt!).getTime());
  const start = Math.min(...starts);
  const end = Math.max(...jobs.map((j, i) => starts[i] + expectedSeconds(db, j.kind) * 1000));
  peak.current = Math.max(peak.current, progressShare(Math.max(0, now - start) / 1000, Math.max(1, end - start) / 1000));
  return (
    <span className={`busy-bar det ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(peak.current * 100)}>
      <i style={{ width: `${peak.current * 100}%` }} />
    </span>
  );
}

/** Just the words: «ще ≈ 2 хв», «майже готово», «у черзі» — ticking on its own. */
/**
 * A chat composer (owner, 20.11: «стандартна для чат-ботів, контроли менші — як у Codex або Claude»): the text grows
 * with what is typed, quiet controls sit bottom left, a small round send button bottom right. Enter sends; an empty
 * text is allowed (the search then picks on its own).
 */
export function Composer({ value, onChange, onSend, busy, placeholder, label, children, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  placeholder: string;
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`composer ${className}`}>
      <div className="composer-text" data-value={(value || placeholder) + ' '}>
        <textarea
          value={value}
          rows={1}
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy) onSend();
            }
          }}
        />
      </div>
      <div className="composer-bar">
        {children}
        <span className="grow" />
        <button type="button" className="composer-send" onClick={onSend} disabled={busy} aria-label={busy ? t('Шукаю') : t(label)} title={busy ? t('Шукаю') : t(label)}>
          {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
        </button>
      </div>
    </div>
  );
}

export function JobEta({ job }: { job: Job }) {
  const db = useDb();
  const now = useNow();
  return <>{jobProgress(db, job, now).label}</>;
}

export function LookArt({ look, w = 700, max, busy, label = false, reviewLatest = false }: { look: Look; w?: number; max?: number; busy?: boolean; label?: boolean; reviewLatest?: boolean }) {
  const db = useDb();
  const cover = currentCover(db, look, reviewLatest);
  // `busy` = the owner asked on this page: waiting counts too; elsewhere only running work shows.
  const job = busy === false ? undefined : lookJob(db, look.id, busy === true);
  return (
    <span className="look-art">
      {cover ? <img src={thumb(cover.imagePath, w)} alt={look.name} loading="lazy" /> : <LookCollage slots={look.slots} max={max} />}
      {job && <JobBar job={job} label={label} />}
    </span>
  );
}

/** Quiet «бракує: …» under a look's name; the «+N» stays visible when the title is cut. */
export function Missing({ look }: { look: Look }) {
  const db = useDb();
  const m = missingInfo(db, look);
  const indoor = indoorOnly(db, look);
  if (!m && !indoor) return null;
  return <>
    {m && <span className="miss"><span className="miss-t">{m.text}</span>{m.more > 0 && <span className="miss-n">+{m.more}</span>}</span>}
    {indoor && <span className="miss">{t('у приміщенні')}</span>}
  </>;
}

export function LookCollage({ slots, max = 5 }: { slots: Slots; max?: number }) {
  const db = useDb();
  const pieces = piecesOf(db, slots).slice(0, max);
  if (pieces.length === 0) return <div className="collage n1"><div className="piece ph"><Shirt size={20} /><span>{t('Образ порожній')}</span></div></div>;
  if (pieces.length <= 2) return <div className={`collage n${pieces.length}`}>{pieces.map((r) => <Piece key={r.ref.id} r={r} />)}</div>;
  const [first, ...rest] = pieces;
  return (
    <div className="collage">
      <Piece r={first} w={720} />
      <div className="side" style={{ gridTemplateRows: `repeat(${rest.length}, minmax(0, 1fr))` }}>
        {rest.map((r) => <Piece key={`${r.ref.kind}-${r.ref.id}`} r={r} w={360} />)}
      </div>
    </div>
  );
}

export interface SubNavItem {
  key: string;
  label: string;
  icon?: ReactNode;
  n?: number;
}

export function SubNav({ groups, value, onChange }: { groups: { label?: string; items: SubNavItem[] }[]; value: string; onChange: (key: string) => void }) {
  return (
    <nav className="subnav">
      {groups.map((g, i) => (
        <div key={i} style={{ display: 'contents' }}>
          {g.label && <div className="label">{t(g.label)}</div>}
          {g.items.map((it) => (
            <button key={it.key} className={`subnav-item${value === it.key ? ' on' : ''}`} onClick={() => onChange(it.key)}>
              {it.icon}
              <span>{t(it.label)}</span>
              {it.n !== undefined && <span className="n">{it.n}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function PageHead({ crumb, title, sub, actions }: { crumb?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="page-head">
        <div>
          <h1>{tr(title)}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </>
  );
}

/** Destructive action behind a confirmation dialog. */
export function ConfirmButton({
  children,
  className = 'btn danger',
  title,
  message,
  confirmLabel = 'Видалити',
  onConfirm,
}: {
  children: ReactNode;
  className?: string;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={tr(title)} aria-label={tr(title)}>
        {children}
      </button>
      {open && (
        <Modal
          title={title}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>{t('Скасувати')}</button>
              <button
                className="btn primary"
                style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onConfirm();
                  setBusy(false);
                  setOpen(false);
                }}
              >
                {busy ? <Loader2 size={14} className="spin" /> : null} {t(confirmLabel)}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 15 }}>{tr(message)}</div>
        </Modal>
      )}
    </>
  );
}

/** What a cover shows while the owner's try-on for these looks is not ready. */
export function RenderPlaceholder({ lookIds }: { lookIds: string[] }) {
  const db = useDb();
  const jobs = db.jobs.filter((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId && lookIds.includes(j.lookId));
  const running = jobs.find((j) => j.state === 'running');
  const queued = jobs.some((j) => j.state === 'queued');
  const waiting = jobs.find((j) => j.state === 'needs_data');
  const noBase = db.profile.basePhotoIds.length === 0;
  // Work in progress is only the thin bar (owner rule); words stay for what the owner can act on.
  return (
    <div className="render-ph" title={!running && !queued && waiting?.stateNote ? t(waiting.stateNote) : undefined}>
      {running && <JobBar job={running} />}
      <PersonStanding size={24} />
      {!running && !queued && <span>{waiting ? t('Примірка чекає') : noBase ? t('Додай своє фото') : t('Примірки ще немає')}</span>}
    </div>
  );
}

/**
 * Owner rating in black and white. Dislike hides (kept as a finished look,
 * restorable in «Капсули → Приховані»); like ranks first. Pressing the active
 * button again clears it.
 */
export function RateButtons({ kind, target, size = 'md' }: { kind: 'look' | 'capsule'; target: { id: string; favorite: boolean; disliked?: boolean }; size?: 'sm' | 'md' }) {
  const { act } = useApp();
  const rating = ratingOf(target);
  const set = (next: 'like' | 'dislike') => {
    const value = rating === next ? null : next;
    const msg = value === 'dislike' ? t('Приховано — повернути можна в «Капсули → Приховані»') : value === 'like' ? t('Подобається — тепер першим') : t('Оцінку знято');
    void act(() => api('POST', `/api/${kind === 'look' ? 'looks' : 'capsules'}/${target.id}/rating`, { rating: value }), msg);
  };
  const ic = size === 'sm' ? 14 : 16;
  return (
    <div className={`rate ${size}`} role="group" aria-label={t('Оцінка')}>
      <button className={`rate-btn${rating === 'like' ? ' on' : ''}`} aria-pressed={rating === 'like'} aria-label={t('Подобається')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); set('like'); }}>
        <ThumbsUp size={ic} fill={rating === 'like' ? 'currentColor' : 'none'} />
      </button>
      <button className={`rate-btn${rating === 'dislike' ? ' on' : ''}`} aria-pressed={rating === 'dislike'} aria-label={t('Не подобається — сховати')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); set('dislike'); }}>
        <ThumbsDown size={ic} fill={rating === 'dislike' ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

/** Pieces in two blocks: what the owner has, and what to buy. Each tile links to its item or need. */
export function PieceBlocks({ pieces, ownTitle = 'Мої речі' }: { pieces: ResolvedRef[]; ownTitle?: string }) {
  const db = useDb();
  const seen = new Set<string>();
  const unique = pieces.filter((r) => {
    const k = `${r.ref.kind}:${r.ref.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const own = unique.filter((r) => r.kind === 'owned' || r.kind === 'candidate');
  const buy = unique.filter((r) => r.kind === 'need' || r.kind === 'product');
  const tile = (r: ResolvedRef) => (
    <a key={`${r.ref.kind}-${r.ref.id}`} className="wtile" href={r.ref.kind === 'item' ? `/wardrobe/${r.ref.id}` : `/shopping?need=${r.ref.kind === 'need' ? r.ref.id : (db.products.find((p) => p.id === r.ref.id)?.needId ?? '')}`}>
      <div className="img">
        {r.art || r.photo ? <img src={thumb((r.art ?? r.photo)!, 480)} alt={r.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={r.category} size={22} /></span>}
        {r.inactive && <span className="tl"><Badge tone="glass">{t('неактуальна')}</Badge></span>}
      </div>
      <span className="nm">{r.title}<TermInfo texts={[r.title]} /></span>
    </a>
  );
  return (
    <>
      {own.length > 0 && <>
        <div className="section-head"><h2 className="h2">{t(ownTitle)} <span className="count">{own.length}</span></h2></div>
        <div className="ward-grid">{own.map(tile)}</div>
      </>}
      {buy.length > 0 && <>
        <div className="section-head"><h2 className="h2">{t('Докупити')} <span className="count">{buy.length}</span></h2><a href="/shopping">{t('Покупки')}</a></div>
        <div className="ward-grid">{buy.map(tile)}</div>
      </>}
    </>
  );
}
