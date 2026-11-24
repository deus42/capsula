import type { Category, DB } from '../server/schema.ts';
import { wardrobeBrands } from './lib.ts';

export function brandKey(name: string) {
  const key = name.normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '');
  if (key === 'ralphlauren') return 'poloralphlauren';
  if (key === 'northface' || key === 'tnf') return 'thenorthface';
  if (key === 'ua') return 'underarmour';
  if (key === 'adidasoriginals') return 'adidas';
  return key;
}

export interface SizeEvidence {
  brand: string;
  category: Category;
  size: string;
  item?: { id: string; title: string };
  note?: string;
}

/** Saved sizes and recorded sizes of owned pieces. Store recommendations are a separate source. */
export function sizeEvidence(db: DB): SizeEvidence[] {
  const rows: SizeEvidence[] = [...(db.profile.knownSizes ?? [])];
  for (const item of db.items) {
    if (!item.size?.trim() || item.status === 'inactive' || item.mergedInto) continue;
    const matching = item.brand ? [item.brand] : wardrobeBrands({ items: [{ ...item, observation: undefined }] });
    const brand = matching.length === 1 ? matching[0].trim() : '';
    rows.push({ brand, category: item.category, size: item.size, item: { id: item.id, title: item.title } });
  }
  return rows;
}

export function sizingBrands(db: DB): string[] {
  const names = [
    ...(db.profile.brands ?? []),
    ...wardrobeBrands(db),
    ...db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto).map((i) => i.brand?.trim() ?? ''),
    ...(db.profile.knownSizes ?? []).map((s) => s.brand),
  ];
  const distinct = new Map<string, string>();
  for (const brand of names) {
    const key = brandKey(brand);
    if (key && !distinct.has(key)) distinct.set(key, brand);
  }
  return [...distinct.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
