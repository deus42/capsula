import type { DB } from './schema.ts';

/** Keep rejected images in local history while removing them from every site view. */
export function stateView(db: DB) {
  const hidden = new Set(db.results.filter((r) => r.hiddenAt).map((r) => r.id));
  return {
    ...db,
    results: db.results.filter((r) => !hidden.has(r.id)).map(({ prompt: _p, ...r }) => r),
    comparisons: db.comparisons.filter((c) => !hidden.has(c.resultA) && !hidden.has(c.resultB)),
    // A hidden render is not named beside the real photos either; the photos and the review text stay.
    wears: (db.wears ?? []).map((w) => (w.resultId && hidden.has(w.resultId) ? { ...w, resultId: undefined, review: w.review && { ...w.review, resultId: undefined } } : w)),
    jobs: db.jobs.map((j) => {
      const visible = j.resultId && hidden.has(j.resultId) ? { ...j, resultId: undefined } : j;
      const isTryOn = (j.kind ?? 'tryon') === 'tryon';
      const snapshot = {
        lookName: j.snapshot.lookName,
        slots: [],
        basePhotoIds: isTryOn ? j.snapshot.basePhotoIds : [],
        basePhotoPaths: [],
        ...(isTryOn && j.snapshot.identity ? { identity: j.snapshot.identity } : {}),
      };
      return { ...visible, snapshot };
    }),
  };
}
