import type { DB, Item, Photo } from '../server/schema.ts';

/** Only garment art can be reused as a catalogue cover. */
export const isCataloguePhoto = (photo: Photo) =>
  (photo.kind === 'packshot' || photo.kind === 'product') && !photo.inspiration && !photo.referenceRole;

/** Current covers first, then those retained by earlier merges. */
export function itemCoverOptions(db: Pick<DB, 'items' | 'photos'>, items: Item[]): Photo[] {
  const visited = new Set<string>();
  const covers = new Set<string>();
  const pending = [...items];
  for (const item of pending) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (item.packshotId) covers.add(item.packshotId);
    for (const id of item.mergedFrom ?? []) {
      const source = db.items.find((candidate) => candidate.id === id);
      if (source) pending.push(source);
    }
  }
  return [...covers].flatMap((id) => {
    const photo = db.photos.find((candidate) => candidate.id === id);
    return photo && isCataloguePhoto(photo) ? [photo] : [];
  });
}

export const primaryPhotoFirst = (ids: string[], primary?: string) =>
  primary && ids.includes(primary) ? [primary, ...ids.filter((id) => id !== primary)] : ids;
