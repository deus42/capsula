import { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { CATEGORIES } from '../../server/schema.ts';
import { api, type KnownSize } from '../api.ts';
import { brandKey, sizeEvidence, sizingBrands } from '../brand-sizes.ts';
import { sizeGuides } from '../size-guides.ts';
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

export function BrandSizing() {
  const db = useDb();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState('');
  const brands = sizingBrands(db);
  const records = sizeEvidence(db);
  const activeBrand = brands.find((brand) => brandKey(brand) === selected) ?? db.profile.knownSizes?.[0]?.brand ?? brands[0];
  const activeGuides = activeBrand ? sizeGuides(activeBrand) : [];
  const personal = records.filter((row) => brandKey(row.brand) === brandKey(activeBrand ?? ''));
  return (
    <section className="card lg brand-sizing" aria-labelledby="brand-sizing-title">
      <div className="section-head">
        <h2 className="h2" id="brand-sizing-title">{t('Розміри за брендами')}</h2>
        <button type="button" className="icon-btn" aria-label={t('Редагувати розміри')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
      </div>
      {db.profile.shoeSizeEu && <p className="small muted">{t('Мій розмір взуття (EU)')} <strong>{db.profile.shoeSizeEu}</strong></p>}
      {activeBrand && (
        <>
          <label className="field brand-size-picker">
            <span>{t('Бренд')}</span>
            <select className="select" value={brandKey(activeBrand)} onChange={(event) => setSelected(event.target.value)}>
              {brands.map((brand) => <option key={brandKey(brand)} value={brandKey(brand)}>{brand}</option>)}
            </select>
          </label>
          {personal.length ? <ul className="brand-size-records">
            {personal.map((row, index) => <li key={row.item?.id ?? index}>
              {row.item ? <a href={`/wardrobe/${row.item.id}`}>{row.item.title}</a> : <span>{t(CATEGORY_LABEL[row.category])}</span>}
              <strong>{row.size}</strong>
            </li>)}
          </ul> : <p className="small muted">{t('Мій розмір ще не записано')}</p>}
          {activeGuides.length ? activeGuides.map((guide) => (
            <section className="brand-guide" key={guide.title}>
              <div className="section-head">
                <h3>{t(guide.title)}</h3>
                <a href={guide.url} target="_blank" rel="noreferrer">{t('Оригінал')}</a>
              </div>
              {guide.rows.length ? <div className="brand-guide-scroll">
                <table>
                  <thead><tr>{guide.columns.map((column) => <th scope="col" key={column}>{t(column)}</th>)}</tr></thead>
                  <tbody>{guide.rows.map(([size, ...cells]) => <tr key={size}><th scope="row">{size}</th>{cells.map((cell, index) => <td key={guide.columns[index + 1]}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div> : <p className="small muted">{t('Точна сітка залежить від моделі')}</p>}
            </section>
          )) : <p className="small muted">{t('Офіційної таблиці ще немає')}</p>}
        </>
      )}
      {editing && <EditSizes brands={brands} defaultBrand={activeBrand} onClose={() => setEditing(false)} />}
    </section>
  );
}
