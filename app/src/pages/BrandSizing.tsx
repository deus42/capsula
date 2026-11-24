import { Fragment, useLayoutEffect, useRef, useState } from 'react';
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
  const addSize = () => {
    const id = globalThis.crypto?.randomUUID?.() ?? `K-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setSizes((rows) => [...rows, { id, brand: defaultBrand ?? '', size: '', category: 'trousers' }]);
  };
  const save = async () => {
    setSaving(true);
    const result = await act(() => api('PATCH', '/api/profile', { knownSizes: sizes, shoeSizeEu }), t('Збережено'));
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
        <div><button type="button" className="btn ghost" onClick={addSize}>
          <Plus size={14} />{t('Додати розмір')}
        </button></div>
      </form>
    </Modal>
  );
}

/** My size per brand in a quiet list; the chosen brand's original charts beside it, sizes across, my size marked and in view. */
export function BrandSizing() {
  const db = useDb();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState('');
  const detail = useRef<HTMLDivElement>(null);
  const [hold, setHold] = useState(0);
  // Switching brands keeps the list in place: the charts keep their height down to the screen's bottom edge,
  // so a shorter chart cannot pull the page up (this section is the last one on the page).
  const pick = (key: string) => {
    const box = detail.current?.getBoundingClientRect();
    if (box) setHold(Math.max(0, Math.ceil(Math.min(box.height, window.innerHeight - box.top))));
    setSelected(key);
  };
  const brands = sizingBrands(db);
  const records = sizeEvidence(db).filter((row) => row.brand);
  const known = (name: string) => brands.find((brand) => brandKey(brand) === brandKey(name));
  const activeBrand = known(selected) ?? records.map((row) => known(row.brand)).find(Boolean) ?? brands[0];
  const activeKey = brandKey(activeBrand ?? '');
  const activeGuides = activeBrand ? sizeGuides(activeBrand, db.profile.wardrobeFocus ?? 'men') : [];
  const sizesOf = (brand: string) => [...new Map(records
    .filter((row) => brandKey(row.brand) === brandKey(brand))
    .map((row) => [row.size.trim().toUpperCase(), row.size.trim()])).values()].join(' · ');
  const personal = records.filter((row) => brandKey(row.brand) === activeKey);
  const mine = new Map<string, { size: string; category: SizeEvidence['category']; items: { id: string; title: string }[] }>();
  for (const row of personal) {
    const key = `${row.category}|${row.size.trim().toUpperCase()}`;
    const group = mine.get(key) ?? { size: row.size.trim(), category: row.category, items: [] };
    if (row.item) group.items.push(row.item);
    mine.set(key, group);
  }
  const from = [...mine.values()].filter((group) => group.items.length);
  const marked = activeGuides.map((guide) => {
    const mySizes = personal.filter((row) => guide.categories.includes(row.category)).map((row) => row.size);
    if (guide.categories.includes('shoes') && db.profile.shoeSizeEu) mySizes.push(db.profile.shoeSizeEu);
    return myRows(guide, mySizes);
  });
  const markKey = marked.map((rows) => [...rows].join(',')).join('|');
  // Each chart scrolls sideways so my size sits in the middle of what is visible.
  useLayoutEffect(() => {
    detail.current?.querySelectorAll<HTMLElement>('.brand-guide-scroll').forEach((scroller) => {
      const own = scroller.querySelectorAll<HTMLElement>('thead .my-col');
      if (!own.length) {
        scroller.scrollLeft = 0;
        return;
      }
      const label = scroller.querySelector<HTMLElement>('thead th')?.offsetWidth ?? 0;
      const last = own[own.length - 1];
      const middle = (own[0].offsetLeft + last.offsetLeft + last.offsetWidth) / 2;
      scroller.scrollLeft = middle - label - (scroller.clientWidth - label) / 2;
    });
  }, [activeKey, markKey]);
  return (
    <section className="card lg brand-sizing" aria-labelledby="brand-sizing-title">
      <div className="section-head">
        <h2 className="h2" id="brand-sizing-title">{t('Розміри за брендами')}</h2>
        <div className="brand-size-actions">
          {db.profile.shoeSizeEu && <span>{t('Взуття')} (EU) <strong>{db.profile.shoeSizeEu}</strong></span>}
          <button type="button" className="icon-btn" aria-label={t('Редагувати розміри')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
        </div>
      </div>
      {!activeBrand && !db.profile.shoeSizeEu && <p className="small muted">{t('Додай розмір через олівець.')}</p>}
      {activeBrand && (
        <div className="brand-size-layout">
          <div className="brand-size-list" role="group" aria-label={t('Бренд')}>
            {brands.map((brand) => {
              const on = brandKey(brand) === activeKey;
              const size = sizesOf(brand);
              return <button type="button" key={brandKey(brand)} className={on ? 'on' : undefined} aria-pressed={on} onClick={() => pick(brandKey(brand))}>
                <span>{brand}</span>{size && <strong>{size}</strong>}
              </button>;
            })}
          </div>
          <div className="brand-size-detail" ref={detail} style={hold ? { minHeight: hold } : undefined}>
            {from.length > 0 && <p className="brand-size-from">{from.map((group, index) => <Fragment key={`${group.category}|${group.size}`}>
              {index ? ' · ' : ''}{mine.size > 1 && `${group.size} — `}
              {group.items.map((item, i) => <Fragment key={item.id}>{i ? ', ' : ''}<a href={`/wardrobe/${item.id}`}>{item.title}</a></Fragment>)}
            </Fragment>)}</p>}
            {!mine.size && !marked.some((rows) => rows.size) && <p className="small muted">{t('Мій розмір ще не записано')}</p>}
            {activeGuides.length ? activeGuides.map((guide, guideIndex) => (
              <section className="brand-guide" key={`${guide.focus}:${guide.title}`}>
                <div className="brand-guide-head">
                  <h3>{t(guide.title)}</h3>
                  <a href={guide.url} target="_blank" rel="noreferrer">{t('Оригінал')}</a>
                </div>
                {guide.rows.length ? <div className="brand-guide-scroll">
                  <table>
                    <thead><tr>
                      <th scope="row">{t(guide.columns[0])}</th>
                      {guide.rows.map(([size]) => {
                        const own = marked[guideIndex].has(size);
                        return <th scope="col" key={size} className={own ? 'my-col' : undefined} aria-label={own ? t('Мій розмір {size}', { size }) : undefined}>{size}</th>;
                      })}
                    </tr></thead>
                    <tbody>{guide.columns.slice(1).map((column, index) => <tr key={column}>
                      <th scope="row">{t(column)}</th>
                      {guide.rows.map((row) => <td key={row[0]} className={marked[guideIndex].has(row[0]) ? 'my-col' : undefined}>{row[index + 1]}</td>)}
                    </tr>)}</tbody>
                  </table>
                </div> : <p className="small muted">{t('Точна сітка залежить від моделі')}</p>}
              </section>
            )) : <p className="small muted">{t('Офіційної таблиці ще немає')}</p>}
          </div>
        </div>
      )}
      {editing && <EditSizes brands={brands} defaultBrand={activeBrand} onClose={() => setEditing(false)} />}
    </section>
  );
}
