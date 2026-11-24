import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Camera, Check, CircleCheck, Copy, Heart, Link2, Loader2, LocateFixed, MapPin, Minus, Plus, Ruler, Store, Trash2, TriangleAlert, UserRound, Users, X } from 'lucide-react';
import type { MeasureKey, QuotaKind, QuotaStatus } from '../api.ts';
import { api, thumb } from '../api.ts';
import { go, useApp, useDb } from '../store.tsx';
import { Badge, ConfirmButton, PageHead, PhotoPicker, SubNav } from '../components/ui.tsx';
import { useIntake } from './Home.tsx';
import { BrandSizing } from './BrandSizing.tsx';
import { InfoMark } from './Glossary.tsx';
import { MEASURES, fmtDay, plainShopName, shopLocation, wardrobeBrands } from '../lib.ts';
import { LOOKS, currentLanguage, plural, t } from '../i18n.ts';

const STANDARD = [
  '2–3 фото на повний зріст спереду',
  'Камера на рівні грудей — не дзеркальне селфі',
  'Без окулярів, кепки й предметів перед тілом',
  'Рівне світло, однотонний фон',
  'Плюс одне крупне фото обличчя спереду',
];

const TABS = [
  { key: 'base', label: 'Мої фото', icon: <Camera size={17} /> },
  { key: 'measurements', label: 'Мірки', icon: <Ruler size={17} /> },
  { key: 'shops', label: 'Магазини', icon: <Store size={17} /> },
  { key: 'preferences', label: 'Побажання', icon: <Heart size={17} /> },
];

function Section({ title, sub, actions, children }: { title?: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  const head = title || sub || actions;
  return (
    <section className="card lg">
      {head && (
        <div className="row" style={{ alignItems: 'flex-start', marginBottom: 22, gap: 16 }}>
          <div style={{ flex: 1 }}>
            {title && <h2 className="display" style={{ fontSize: 28 }}>{title}</h2>}
            {sub && <p className="muted" style={{ marginTop: 6, maxWidth: 560 }}>{sub}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function BasePhotos() {
  const db = useDb();
  const { act } = useApp();
  const prof = db.profile;
  const [picker, setPicker] = useState(false);
  const intake = useIntake();
  const busy = db.jobs.filter((j) => j.kind === 'intake' && (j.state === 'queued' || j.state === 'running')).length;
  const originals = (prof.identity ? [prof.identity.sourcePhotoId] : prof.basePhotoIds).map((id) => db.photos.find((p) => p.id === id)).filter(Boolean) as typeof db.photos;
  const base = prof.identity?.approvedPortrait ? originals.map((p) => ({ ...p, path: prof.identity!.face.path, originalName: t('Схвалений портрет') })) : originals;
  const ok = base.filter((p) => p.meetsStandard).length;
  return (
    <Section
      title={t('Мої фото')}
      sub={prof.identity?.disabledReason ?? (prof.identity ? `${base[0]?.originalName ?? t('Оригінал')} ${t('— опора обличчя.')} ${t(prof.identity.preserveHeadAngle ? 'Оригінальний ракурс.' : 'Прямий погляд, голова рівно.')} ${prof.identity.noGlasses ? t('Без окулярів.') : ''} ${prof.identity.hairstyle ?? ''}` : t('Обличчя для примірок береться лише з цих фото.'))}
      actions={!prof.identity && <button className="btn" onClick={() => setPicker(true)}>{t('Вибрати з наявних')}</button>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 24 }} className="profile-base">
        <div className="stack" style={{ gap: 18 }}>
          {intake.field}
          <a className="btn" href="/gallery?type=original">{t('Усі мої оригінали й референси')}</a>
          <a className="btn" href="/gallery?type=face">{t('Референси обличчя ·')} {db.photos.filter((p) => p.referenceRole === 'face').length}</a>
          <button className="dropzone" onClick={intake.pick} disabled={intake.busy} style={{ cursor: 'pointer', width: '100%' }}>
            {intake.busy || busy ? <Loader2 size={22} className="spin" style={{ margin: '0 auto' }} /> : <Camera size={22} style={{ margin: '0 auto' }} />}
            <b>{busy ? t('Розбираю фото: {n}', { n: busy }) : t('Додати фото')}</b>
            {t('Сайт сам визначить: твоє фото для примірок, одяг чи етикетка.')}
          </button>
          {base.length > 0 && (
            <div className="photo-grid">
              {base.map((p) => (
                <div key={p.id} className="ptile">
                  <div className="img">
                    <img src={thumb(p.path, 480)} alt="" />
                    <span className="tl">
                      <Badge tone={`${p.meetsStandard ? 'ok' : p.meetsStandard === false ? 'warn' : ''} glass`}>
                        {p.meetsStandard ? t('за стандартом') : p.meetsStandard === false ? t('не за стандартом') : t('не перевірено')}
                      </Badge>
                    </span>
                    {!prof.identity && <span className="tr">
                      <button className="icon-btn" aria-label={t('Прибрати з моїх фото')} onClick={() => void act(() => api('PATCH', '/api/profile', { rev: prof.rev, basePhotoIds: prof.basePhotoIds.filter((x) => x !== p.id) }), t('Прибрано'))}>
                        <X size={14} />
                      </button>
                    </span>}
                  </div>
                  <button className={`btn sm${p.meetsStandard ? ' primary' : ''}`} onClick={() => void act(() => api('PATCH', `/api/photos/${p.id}`, { meetsStandard: !p.meetsStandard }))}>
                    {p.meetsStandard ? <Check size={13} /> : <TriangleAlert size={13} />} {p.meetsStandard ? t('Відповідає') : t('Позначити як відповідне')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="note" style={{ padding: 18, alignSelf: 'start' }}>
          <div className="row" style={{ marginBottom: 12 }}>
            <b>{t('Стандарт фото')}</b>
            <span style={{ flex: 1 }} />
            <Badge tone={ok >= 2 ? 'ok' : 'warn'}>{ok}{t('/2 готово')}</Badge>
          </div>
          <ul className="checklist">
            {STANDARD.map((s) => <li key={s}><CircleCheck size={15} />{t(s)}</li>)}
          </ul>
        </div>
      </div>
      {picker && (
        <PhotoPicker
          title={t('Мої фото з наявних')}
          selected={prof.basePhotoIds}
          filter={(p) => p.kind === 'base' || p.kind === 'source'}
          onClose={() => setPicker(false)}
          onSave={(ids) => {
            setPicker(false);
            void act(() => api('PATCH', '/api/profile', { rev: prof.rev, basePhotoIds: ids }), t('Мої фото оновлено'));
          }}
        />
      )}
    </Section>
  );
}

/** A first tap on − or + starts from a usual value instead of zero (owner, 20.11: convenient selectors). */
const TYPICAL: Record<MeasureKey, number> = { height: 178, chest: 100, waist: 86, hips: 100, shoulders: 46, sleeve: 64, inseam: 82, foot: 27 };
const STEP: Record<MeasureKey, number> = { height: 1, chest: 1, waist: 1, hips: 1, shoulders: 0.5, sleeve: 0.5, inseam: 1, foot: 0.5 };

/** «Як міряти» (owner, 20.11): a quiet line drawing with numbered measuring lines; the row in focus lights its line. */
function MeasureFigure({ active }: { active: MeasureKey | null }) {
  const body = 'M92 52L92 64C82 68 68 69 62 77C56 86 54 112 52 158L46 228C45 238 42 246 46 250C50 252 53 246 54 236L60 170C62 140 65 118 70 104C73 140 77 168 75 192C73 208 70 220 72 234L76 322L80 406C75 412 66 416 66 422C66 425 70 426 74 426L94 426L95 408L97 322L100 256';
  const lines: { key: MeasureKey; d: string; at: [number, number] }[] = [
    { key: 'height', d: 'M176 13L176 426M171 13L181 13M171 426L181 426', at: [176, 220] },
    { key: 'chest', d: 'M71 114Q100 121 129 114', at: [100, 118] },
    { key: 'waist', d: 'M75 190Q100 196 125 190', at: [100, 193] },
    { key: 'hips', d: 'M72 232Q100 240 128 232', at: [100, 236] },
    { key: 'shoulders', d: 'M62 70L138 70M62 66L62 74M138 66L138 74', at: [100, 70] },
    { key: 'sleeve', d: 'M55 80L38 228', at: [46, 154] },
    { key: 'inseam', d: 'M104 262L109 404', at: [107, 334] },
    { key: 'foot', d: 'M66 436L94 436M66 432L66 440M94 432L94 440', at: [80, 436] },
  ];
  return (
    <svg className="measure-figure" viewBox="0 0 200 446" role="img" aria-label={t('Як міряти')}>
      <ellipse className="body" cx="100" cy="32" rx="15" ry="19" />
      <path className="body" d={body} />
      <path className="body" d={body} transform="translate(200 0) scale(-1 1)" />
      {lines.map((l) => <path key={l.key} className={`ml${active === l.key ? ' on' : ''}`} d={l.d} />)}
      {lines.map((l) => (
        <g key={l.key} className={`mk${active === l.key ? ' on' : ''}`}>
          <circle cx={l.at[0]} cy={l.at[1]} r="8" />
          <text x={l.at[0]} y={l.at[1] + 0.5}>{MEASURES.findIndex((m) => m.key === l.key) + 1}</text>
        </g>
      ))}
    </svg>
  );
}

function Measurements() {
  const db = useDb();
  const { act } = useApp();
  const prof = db.profile;
  const load = () => Object.fromEntries(MEASURES.map((m) => [m.key, prof.measurements[m.key].value?.toString() ?? ''])) as Record<MeasureKey, string>;
  const [values, setValues] = useState(load);
  const [active, setActive] = useState<MeasureKey | null>(null);
  const timers = useRef<Partial<Record<MeasureKey, number>>>({});
  // Saved values come back without overwriting a number that is still being typed.
  useEffect(() => setValues((cur) => { const next = load(); for (const m of MEASURES) if (timers.current[m.key]) next[m.key] = cur[m.key]; return next; }), [prof.rev]);
  // Each measure saves itself shortly after the last change (no rev: quick changes in a row never conflict).
  const set = (k: MeasureKey, v: string) => {
    setValues((x) => ({ ...x, [k]: v }));
    window.clearTimeout(timers.current[k]);
    timers.current[k] = window.setTimeout(() => {
      delete timers.current[k];
      void act(() => api('PATCH', '/api/profile', { measurements: { [k]: { value: v } } }));
    }, 700);
  };
  const step = (k: MeasureKey, dir: 1 | -1) => {
    const cur = parseFloat(values[k]);
    set(k, String(Number.isFinite(cur) ? Math.round((cur + dir * STEP[k]) * 10) / 10 : TYPICAL[k]));
  };
  return (
    <Section>
      <div className="measure-layout">
        <MeasureFigure active={active} />
        <div className="measure-list">
          {MEASURES.map((m, i) => (
            <div key={m.key} className={`measure-row${active === m.key ? ' on' : ''}`} onMouseEnter={() => setActive(m.key)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(m.key)} onBlur={() => setActive(null)}>
              <span className="m-num">{i + 1}</span>
              <span className="m-label">{t(m.label)}<InfoMark title={t(m.label)} text={t(m.how)} /></span>
              <span className="stepper">
                <button type="button" aria-label={`${t('Менше')}: ${t(m.label)}`} onClick={() => step(m.key, -1)}><Minus size={14} /></button>
                <input inputMode="decimal" value={values[m.key]} placeholder="—" aria-label={`${t(m.label)}, ${t('см')}`} onChange={(e) => set(m.key, e.target.value.replace(',', '.'))} />
                <span className="unit">{t('см')}</span>
                <button type="button" aria-label={`${t('Більше')}: ${t(m.label)}`} onClick={() => step(m.key, 1)}><Plus size={14} /></button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

/** Brand and shop names written once: «Levi’s Poland», «LEVI'S» and «Levi's» are one choice. */
const cleanShop = plainShopName;
const nameKey = (s: string) => s.toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function uniqueNames(list: string[]) {
  const seen = new Map<string, string>();
  for (const v of list.map(cleanShop).filter(Boolean)) if (!seen.has(nameKey(v))) seen.set(nameKey(v), v);
  return [...seen.values()];
}

/** A tap-to-pick list (owner, 20.11: convenient selectors): every known option as a quiet pill, the chosen ones in ink.
 *  The order is alphabetical and never changes on a tap, so nothing jumps; «+ інший» adds one more. */
function PickField({ label, selected: saved, options, placeholder, onSave }: { label: string; selected: string[]; options: string[]; placeholder: string; onSave: (next: string[]) => void }) {
  const [sel, setSel] = useState(saved);
  const [text, setText] = useState('');
  const savedKey = saved.join('\n');
  useEffect(() => setSel(saved), [savedKey]);
  const all = uniqueNames([...sel, ...options]).sort((a, b) => a.localeCompare(b, 'uk', { sensitivity: 'base' }));
  const on = (v: string) => sel.some((x) => nameKey(x) === nameKey(v));
  const change = (next: string[]) => { setSel(next); onSave(next); };
  const toggle = (v: string) => change(on(v) ? sel.filter((x) => nameKey(x) !== nameKey(v)) : [...sel, v]);
  const add = () => { const v = text.trim(); setText(''); if (v && !on(v)) change([...sel, v]); };
  return (
    <div className="field">
      <span>{label}</span>
      <div className="pick-chips">
        {all.map((v) => <button key={nameKey(v)} type="button" className={`pick${on(v) ? ' on' : ''}`} aria-pressed={on(v)} onClick={() => toggle(v)}>{v}</button>)}
        <form className="pick-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onBlur={add} placeholder={placeholder} aria-label={placeholder} />
        </form>
      </div>
    </div>
  );
}

const MY_PLACE = 'Моє місце';
const RADII: { v: number | null; label: string }[] = [
  { v: 5, label: '5 км' }, { v: 15, label: '15 км' }, { v: 50, label: '50 км' }, { v: null, label: 'Будь-яка' }, { v: 0, label: 'Лише онлайн' },
];

/** «Магазини» (owner, 18–20.11): where searches look — my place (shared by the browser) or a named one, how far, my stores, my brands. */
function Shops() {
  const db = useDb();
  const { act, toast } = useApp();
  const prof = db.profile;
  const [place, setPlace] = useState(shopLocation(db));
  const [locating, setLocating] = useState(false);
  useEffect(() => setPlace(shopLocation(db)), [prof.rev]);
  // No rev: each field saves only itself, so quick changes in a row never conflict.
  const save = (patch: Record<string, unknown>) => void act(() => api('PATCH', '/api/profile', patch));
  const locate = () => {
    if (!('geolocation' in navigator)) { toast(t('Цей браузер не ділиться місцем')); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); save({ coords: { lat: pos.coords.latitude, lon: pos.coords.longitude }, location: MY_PLACE }); },
      () => { setLocating(false); toast(t('Місце не отримано — дозволь браузеру доступ до геолокації')); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
    );
  };
  const radius = prof.radiusKm ?? null;
  const stores = uniqueNames([...db.products.map((p) => p.store), ...(db.stores ?? []).map((s) => s.name)]);
  const brands = uniqueNames([...wardrobeBrands(db), ...db.products.map((p) => p.brand)]);
  return (
    <Section>
      <div className="stack" style={{ gap: 26 }}>
        <div className="field">
          <span>{t('Де шукати')}</span>
          <div className="place-field">
            <MapPin size={16} />
            <input
              value={place}
              placeholder={t('Місто чи торговий центр')}
              aria-label={t('Де шукати')}
              onChange={(e) => setPlace(e.target.value)}
              onBlur={() => { if (place.trim() !== shopLocation(db)) save({ location: place.trim(), coords: null }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            <button type="button" className="locate" onClick={locate} disabled={locating} aria-label={MY_PLACE} title={MY_PLACE}>
              {locating ? <Loader2 size={16} className="spin" /> : <LocateFixed size={16} />}
            </button>
          </div>
        </div>
        <div className="field">
          <span>{t('Відстань')}</span>
          <div className="filters start" role="group" aria-label={t('Відстань до магазинів')}>
            {RADII.map((r) => <button key={r.label} type="button" className={radius === r.v ? 'on' : ''} aria-pressed={radius === r.v} onClick={() => save({ radiusKm: r.v })}>{t(r.label)}</button>)}
          </div>
        </div>
        <PickField label={t('Мої магазини')} selected={prof.stores ?? []} options={stores} placeholder={t('+ інший магазин')} onSave={(next) => save({ stores: next })} />
        <PickField label={t('Мої бренди')} selected={prof.brands ?? wardrobeBrands(db)} options={brands} placeholder={t('+ інший бренд')} onSave={(next) => save({ brands: next })} />
      </div>
    </Section>
  );
}

function Preferences() {
  const db = useDb();
  const { act } = useApp();
  const prof = db.profile;
  const [prefs, setPrefs] = useState(prof.preferences);
  useEffect(() => setPrefs(prof.preferences), [prof.rev]);
  const fields = [
    ['comfort', t('Комфорт'), t('Як має відчуватися одяг протягом дня.')],
    ['materials', t('Матеріали'), t('Тканини, яким віддаєш перевагу або яких уникаєш.')],
    ['fit', t('Посадка'), t('Крій штанів, сорочок, верхнього одягу; довжина.')],
    ['branding', t('Брендування'), t('Наскільки помітними можуть бути логотипи.')],
  ] as const;
  // Language, what to dress the person in and the hemisphere save at once, like every quiet toggle.
  const choose = (patch: Record<string, string | boolean>) => void act(() => api('PATCH', '/api/profile', { rev: prof.rev, ...patch }));
  const rows: { label: string; key: 'language' | 'wardrobeFocus' | 'hemisphere' | 'allowEyewear'; current?: string; options: [string, string][] }[] = [
    { label: t('Мова'), key: 'language', current: currentLanguage(), options: [['uk', t('Українська')], ['en', 'English']] },
    { label: t('Одяг'), key: 'wardrobeFocus', current: prof.wardrobeFocus, options: [['men', t('Чоловічий')], ['women', t('Жіночий')], ['any', t('Будь-який')]] },
    { label: t('Півкуля'), key: 'hemisphere', current: prof.hemisphere ?? 'north', options: [['north', t('Північна')], ['south', t('Південна')]] },
    { label: t('Окуляри'), key: 'allowEyewear', current: prof.allowEyewear ? 'yes' : 'no', options: [['no', t('Ні')], ['yes', t('Так')]] },
  ];
  return (
    <Section actions={<button className="btn primary" onClick={() => void act(() => api('PATCH', '/api/profile', { rev: prof.rev, preferences: prefs }), t('Побажання збережено'))}>{t('Зберегти')}</button>}>
      <div className="pref-rows">
        {rows.map((r) => (
          <div key={r.key} className="pref-row">
            <span>{t(r.label)}</span>
            <div className="filters start">
              {r.options.map(([value, label]) => (
                <button key={value} className={r.current === value ? 'on' : ''} aria-pressed={r.current === value} onClick={() => r.current !== value && choose({ [r.key]: r.key === 'allowEyewear' ? value === 'yes' : value })}>{value === 'en' || value === 'uk' ? label : t(label)}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid-form">
        {fields.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <textarea className="textarea" value={prefs[k]} onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.value }))} />
          </label>
        ))}
      </div>
    </Section>
  );
}

/** Accounts mode: who is signed in, sign out, delete the account. */
function Account() {
  const { session, act } = useApp();
  if (!session?.user) return null;
  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    window.location.href = '/';
  };
  return (
    <div className="stack" style={{ gap: 28 }}>
      <section className="account-row">
        <div>
          <b>{session.user.name}</b>
          <p className="small muted">{session.user.email}</p>
        </div>
        <button className="quiet-toggle" onClick={() => void signOut()}>{t('Вийти')}</button>
      </section>
      {session.quota && <MonthUsage quota={session.quota} support={session.support ?? null} />}
      <section>
        <ConfirmButton
          className="btn ghost danger"
          title={t('Видалити акаунт')}
          message={<>{t('Видалити акаунт і все в ньому — фото, речі, капсули, образи й примірки — назавжди?')}</>}
          onConfirm={async () => {
            const ok = await act(() => api('DELETE', '/api/account'));
            if (ok !== undefined) window.location.href = '/';
          }}
        >
          <Trash2 size={14} /> {t('Видалити акаунт')}
        </ConfirmButton>
      </section>
    </div>
  );
}

interface AdminAccount {
  id: string; name: string; email: string; createdAt: string; lastSignIn: string | null; owner: boolean; test: boolean;
  wardrobe: { photos: number; items: number; looks: number; capsules: number } | null;
  ai: Record<QuotaKind, number> | null;
}
interface Invite { code: string; expiresAt: string; usedBy: string | null; disabled: number }
const ITEMS = { one: '{n} річ', few: '{n} речі', many: '{n} речей' };
const TRYONS = { one: '{n} примірка', few: '{n} примірки', many: '{n} примірок' };

/** One quiet line under a name: what the account holds, this month's try-ons and the last sign-in. */
function accountLine(a: AdminAccount, withEmail: boolean) {
  return [
    withEmail && a.email,
    a.wardrobe && `${plural(a.wardrobe.items, ITEMS)} · ${plural(a.wardrobe.looks, LOOKS)}`,
    a.ai?.tryon ? plural(a.ai.tryon, TRYONS) : null,
    a.lastSignIn && `${t('вхід')} ${fmtDay(a.lastSignIn)}`,
  ].filter(Boolean).join(' · ');
}

/** Profile → «Адмін», the owner only: everyone with an account, invite links, and test accounts with one-time sign-in links. */
function Admin() {
  const { session, act, toast } = useApp();
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const invitesOn = session?.invites !== false;
  const loadAccounts = () => void api<AdminAccount[]>('GET', '/api/admin/users').then(setAccounts).catch(() => undefined);
  const loadInvites = () => void api<Invite[]>('GET', '/api/invites').then(setInvites).catch(() => undefined);
  useEffect(() => {
    loadAccounts();
    if (invitesOn) loadInvites();
  }, [invitesOn]);
  const copy = async (text: string, note: string) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    toast(note);
  };
  const inviteLink = (code: string) => `${window.location.origin}/i/${code}`;
  const SIGN_IN_COPIED = 'Посилання входу скопійовано: одноразове, 10 хв. Відкрий його в приватному вікні';
  const people = accounts.filter((a) => !a.test);
  const tests = accounts.filter((a) => a.test);
  const open = invites.filter((i) => !i.usedBy && !i.disabled && i.expiresAt > new Date().toISOString());
  return (
    <div className="stack" style={{ gap: 28 }}>
      <section className="stack" style={{ gap: 10 }}>
        <h2 className="h2">{t('Люди')} <span className="count">{people.length}</span></h2>
        <ul className="set-list">
          {people.map((a) => (
            <li key={a.id}>
              <span className="set-name">{a.name}{a.owner && <span className="buy"> · {t('адмін')}</span>}<br /><span className="buy">{accountLine(a, true)}</span></span>
            </li>
          ))}
        </ul>
      </section>
      {invitesOn && (
        <section className="stack" style={{ gap: 10 }}>
          <div className="section-head" style={{ margin: 0 }}>
            <h2 className="h2">{t('Запрошення')} <span className="count">{open.length}</span></h2>
            <button className="quiet-toggle" onClick={() => void act(() => api<Invite>('POST', '/api/invites')).then((inv) => { if (inv) { loadInvites(); void copy(inviteLink(inv.code), 'Посилання скопійовано'); } })}>{t('Нове запрошення')}</button>
          </div>
          <ul className="set-list">
            {open.map((i) => (
              <li key={i.code}>
                <span className="set-name">{inviteLink(i.code).replace(/^https?:\/\//, '')}<span className="buy"> {t('· до')} {fmtDay(i.expiresAt)}</span></span>
                <button className="icon-btn" aria-label={t('Скопіювати посилання')} onClick={() => void copy(inviteLink(i.code), 'Посилання скопійовано')}><Copy size={13} /></button>
                <button className="icon-btn" aria-label={t('Скасувати запрошення')} onClick={() => void act(() => api('DELETE', `/api/invites/${encodeURIComponent(i.code)}`)).then(loadInvites)}><X size={13} /></button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="stack" style={{ gap: 10 }}>
        <div className="section-head" style={{ margin: 0 }}>
          <h2 className="h2">{t('Тестові акаунти')} <span className="count">{tests.length}</span></h2>
          <button className="quiet-toggle" onClick={() => void act(() => api<{ link: string }>('POST', '/api/admin/test-accounts', { name: `${t('Тест')} ${tests.length + 1}` })).then((made) => { if (made) { loadAccounts(); void copy(made.link, SIGN_IN_COPIED); } })}>{t('Новий тестовий')}</button>
        </div>
        <ul className="set-list">
          {tests.map((a) => (
            <li key={a.id}>
              <span className="set-name">{a.name}{accountLine(a, false) && <><br /><span className="buy">{accountLine(a, false)}</span></>}</span>
              <button className="icon-btn" aria-label={t('Посилання входу')} onClick={() => void act(() => api<{ link: string }>('POST', `/api/admin/test-accounts/${encodeURIComponent(a.id)}/link`)).then((made) => { if (made) void copy(made.link, SIGN_IN_COPIED); })}><Link2 size={13} /></button>
              <ConfirmButton className="icon-btn" title={t('Видалити тестовий акаунт')} message={<>{t('Видалити «{name}» і все в ньому назавжди?', { name: a.name })}</>} onConfirm={async () => { await act(() => api('DELETE', `/api/admin/test-accounts/${encodeURIComponent(a.id)}`)); loadAccounts(); }}>
                <X size={13} />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const USAGE_LABEL: [QuotaKind, string][] = [['tryon', 'Примірки'], ['packshot', 'Фото речей'], ['intake', 'Розпізнавання'], ['styling', 'Підбори']];
const usd = (n: number) => `$${n.toFixed(2)}`;

/** One quiet line: this month's allowances for an account; for the owner, the accounts' spending against the budget. */
function MonthUsage({ quota, support }: { quota: QuotaStatus; support: string | null }) {
  const line = USAGE_LABEL.map(([k, label]) => {
    const { used, limit } = quota.kinds[k];
    return `${t(label)} ${limit === null ? used : Math.min(used, limit)} ${t('з')} ${limit ?? '—'}`;
  }).join(' · ');
  return (
    <section className="stack" style={{ gap: 6 }}>
      <h2 className="h2">{t('Цього місяця')}</h2>
      {quota.owner
        ? <p className="small muted">{t('Акаунти:')} {usd(quota.spentUsd ?? 0)}{quota.budgetUsd != null && <> {t('з')} {usd(quota.budgetUsd)}</>} {t('· твої:')} {usd(quota.ownSpentUsd ?? 0)}</p>
        : <p className="small muted">{line}</p>}
      {quota.paused && <p className="small muted">{t('Генерацію призупинено до 1-го числа.')}</p>}
      {!quota.owner && support && <p className="small"><a href={support} target="_blank" rel="noreferrer">{t('Підтримати Capsula')}</a></p>}
    </section>
  );
}

export function ProfilePage({ tab }: { tab?: string }) {
  const { session } = useApp();
  const accountTabs = [{ key: 'account', label: t('Акаунт'), icon: <UserRound size={17} /> }, ...(session?.user?.owner ? [{ key: 'admin', label: t('Адмін'), icon: <Users size={17} /> }] : [])];
  const tabs = session?.mode === 'accounts' ? [...TABS, ...accountTabs] : TABS;
  const current = tabs.some((t) => t.key === tab) ? tab! : 'base';
  return (
    <div className="page">
      <PageHead title={t('Мій профіль')} />
      <div className="split">
        <SubNav value={current} onChange={(k) => go(`/profile/${k}`)} groups={[{ items: tabs }]} />
        <div>
          {current === 'base' && <BasePhotos />}
          {current === 'measurements' && <><Measurements /><BrandSizing /></>}
          {current === 'shops' && <Shops />}
          {current === 'preferences' && <Preferences />}
          {current === 'account' && <Account />}
          {current === 'admin' && <Admin />}
        </div>
      </div>
    </div>
  );
}
