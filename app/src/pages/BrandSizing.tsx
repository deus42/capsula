import { Fragment, useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { CATEGORIES } from '../../server/schema.ts';
import { api, type KnownSize } from '../api.ts';
import { brandKey, sizeEvidence, sizingBrands, type SizeEvidence } from '../brand-sizes.ts';
import { myRows, sizeGuides } from '../size-guides.ts';
import { useApp, useDb } from '../store.tsx';
import { Modal } from '../components/ui.tsx';
import { CATEGORY_LABEL } from '../lib.ts';
import { t } from '../i18n.ts';
import './brand-sizing.css';

function EditSizes({ brands, defaultBrand, onClose }: { brands: string[]; defaultBrand?: string; onClose: () => void }) {
  const { profile } = useDb();
  const { act } = useApp();
  const [sizes, setSizes] = useState(() => [...(profile.knownSizes ?? [])]);
  const [shoeSizeEu, setShoeSizeEu] = useState(profile.shoeSizeEu ?? '');
  const [saving, setSaving] = useState(false);
  const patch = (id: string, changes: Partial<KnownSize>) =>
    setSizes((rows) => rows.map((row) => row.id === id ? { ...row, ...changes } : row));
  const save = async () => {
    setSaving(true);
    const result = await act(() => api('PATCH', '/api/profile', { rev: profile.rev, knownSizes: sizes, shoeSizeEu }), t('Збережено'));
    setSaving(false);
    if (result) onClose();
  };
  return (
    <Modal title={t('Розміри за брендами')} onClose={onClose} footer={
      <button form="known-size-form" className="btn primary" disabled={saving}>{t('Зберегти')}</button>
    }>
      <form id="known-size-form" className="brand-size-edit" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field">
          <span>{t('Мій розмір взуття (EU)')}</span>
          <input className="input" value={shoeSizeEu} maxLength={16} onChange={(event) => setShoeSizeEu(event.target.value)} />
        </label>
        <datalist id="sizing-brands">{brands.map((brand) => <option key={brand} value={brand} />)}</datalist>
        {sizes.map((row) => (
          <div className="brand-size-fields" key={row.id}>
            <label className="field"><span>{t('Бренд')}</span><input className="input" list="sizing-brands" maxLength={80} required value={row.brand} onChange={(event) => patch(row.id, { brand: event.target.value })} /></label>
            <label className="field"><span>{t('Категорія')}</span><select className="select" value={row.category} onChange={(event) => patch(row.id, { category: event.target.value as KnownSize['category'] })}>
              {CATEGORIES.map((category) => <option key={category} value={category}>{t(CATEGORY_LABEL[category])}</option>)}
            </select></label>
            <label className="field"><span>{t('Розмір')}</span><input className="input" maxLength={40} required value={row.size} onChange={(event) => patch(row.id, { size: event.target.value })} /></label>
            <button type="button" className="icon-btn sm" aria-label={t('Прибрати розмір')} onClick={() => setSizes((rows) => rows.filter((size) => size.id !== row.id))}><X size={14} /></button>
          </div>
        ))}
        <div><button type="button" className="btn ghost" onClick={() => setSizes((rows) => [...rows, { id: crypto.randomUUID(), brand: defaultBrand ?? '', size: '', category: 'trousers' }])}>
          <Plus size={14} />{t('Додати розмір')}
        </button></div>
      </form>
    </Modal>
  );
}

/** Brands as quiet text toggles; my sizes stand out in the display serif and as marked rows of the original charts. */
export function BrandSizing() {
  const db = useDb();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const [hold, setHold] = useState(0);
  // Switching brands keeps the toggles in place: the charts below never end above the screen's bottom edge,
  // so a shorter chart cannot pull the page up (this section is the last one on the page).
  const pick = (key: string) => {
    const top = panel.current?.getBoundingClientRect().top;
    if (top !== undefined) setHold(Math.max(0, Math.ceil(window.innerHeight - top)));
    setSelected(key);
  };
  const brands = sizingBrands(db);
  const records = sizeEvidence(db).filter((row) => row.brand);
  const known = (name: string) => brands.find((brand) => brandKey(brand) === brandKey(name));
  const activeBrand = known(selected) ?? records.map((row) => known(row.brand)).find(Boolean) ?? brands[0];
  const activeGuides = activeBrand ? sizeGuides(activeBrand) : [];
  const personal = records.filter((row) => brandKey(row.brand) === brandKey(activeBrand ?? ''));
  const mine = new Map<string, { size: string; category: SizeEvidence['category']; items: { id: string; title: string }[] }>();
  for (const row of personal) {
    const key = `${row.category}|${row.size.trim().toUpperCase()}`;
    const group = mine.get(key) ?? { size: row.size.trim(), category: row.category, items: [] };
    if (row.item) group.items.push(row.item);
    mine.set(key, group);
  }
  const rowsFor = (guide: ReturnType<typeof sizeGuides>[number]) => {
    const own = personal.filter((row) => guide.categories.includes(row.category)).map((row) => row.size);
    const shoe = guide.columns[0] === 'EU' && guide.categories.includes('shoes') && db.profile.shoeSizeEu ? [db.profile.shoeSizeEu] : [];
    return myRows(guide, own.length ? own : shoe);
  };
  const marked = activeGuides.map(rowsFor);
  return (
    <section className="card lg brand-sizing" aria-labelledby="brand-sizing-title">
      <div className="section-head">
        <h2 className="h2" id="brand-sizing-title">{t('Розміри за брендами')}</h2>
        <button type="button" className="icon-btn" aria-label={t('Редагувати розміри')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
      </div>
      {db.profile.shoeSizeEu && <p className="small muted">{t('Мій розмір взуття (EU)')} <strong>{db.profile.shoeSizeEu}</strong></p>}
      {activeBrand && (
        <>
          <div className="filters start brand-size-brands" role="group" aria-label={t('Бренд')}>
            {brands.map((brand) => {
              const on = brandKey(brand) === brandKey(activeBrand);
              return <button type="button" key={brandKey(brand)} className={on ? 'on' : undefined} aria-pressed={on} onClick={() => pick(brandKey(brand))}>{brand}</button>;
            })}
          </div>
          <div ref={panel} style={hold ? { minHeight: hold } : undefined}>
          {mine.size ? <ul className="brand-size-mine">
            {[...mine.entries()].map(([key, group]) => <li key={key}>
              <strong>{group.size}</strong>
              <span>{group.items.length
                ? group.items.map((item, index) => <Fragment key={item.id}>{index ? ', ' : ''}<a href={`/wardrobe/${item.id}`}>{item.title}</a></Fragment>)
                : t(CATEGORY_LABEL[group.category])}</span>
            </li>)}
          </ul> : !marked.some((rows) => rows.size) && <p className="small muted brand-size-none">{t('Мій розмір ще не записано')}</p>}
          {activeGuides.length ? activeGuides.map((guide, guideIndex) => (
            <section className="brand-guide" key={guide.title}>
              <div className="section-head">
                <h3>{t(guide.title)}</h3>
                <a href={guide.url} target="_blank" rel="noreferrer">{t('Оригінал')}</a>
              </div>
              {guide.rows.length ? <div className="brand-guide-scroll">
                <table>
                  <thead><tr>{guide.columns.map((column) => <th scope="col" key={column}>{t(column)}</th>)}</tr></thead>
                  <tbody>{guide.rows.map(([size, ...cells]) => {
                    const own = marked[guideIndex].has(size);
                    return <tr key={size} className={own ? 'mine' : undefined} aria-current={own || undefined}>
                      <th scope="row">{size}</th>{cells.map((cell, index) => <td key={guide.columns[index + 1]}>{cell}</td>)}
                    </tr>;
                  })}</tbody>
                </table>
              </div> : <p className="small muted">{t('Точна сітка залежить від моделі')}</p>}
            </section>
          )) : <p className="small muted">{t('Офіційної таблиці ще немає')}</p>}
          </div>
        </>
      )}
      {editing && <EditSizes brands={brands} defaultBrand={activeBrand} onClose={() => setEditing(false)} />}
    </section>
  );
}
