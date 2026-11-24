import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { brandKey, sizeEvidence, sizingBrands } from '../src/brand-sizes.ts';
import { sizeGuides } from '../src/size-guides.ts';
import { dispatch } from './routes.ts';
import { ownerSizes, shopSearchPrompt } from './shop-search.ts';
import { createStore } from './store.ts';
import { emptyDb } from './tenants.ts';

test('profile sizes and original guides provide separate evidence for store searches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsula-brand-size-'));
  try {
    const store = createStore(dir, emptyDb);
    const ctx = { store, projectRoot: dir, drain: () => undefined };
    await dispatch(ctx, 'PATCH', '/api/profile', {
      brands: ['Levi’s', 'Nike'],
      knownSizes: [{ brand: "Levi's", category: 'trousers', size: 'W28 L30' }],
      shoeSizeEu: '39½',
      measurements: { foot: { value: null }, waist: { value: 74 } },
    });
    await assert.rejects(dispatch(ctx, 'PATCH', '/api/profile', { shoeSizeEu: 'swimming' }), /форматі EU/);
    const shoes = await dispatch(ctx, 'POST', '/api/needs', { title: 'Test sneakers', category: 'shoes' }) as { id: string };
    const trousers = await dispatch(ctx, 'POST', '/api/needs', { title: 'Test jeans', category: 'trousers' }) as { id: string };
    const product = await dispatch(ctx, 'POST', '/api/products', { needId: trousers.id, brand: 'Levi’s', model: 'Demo', store: 'Test', recommendedSize: 'W26 L30' }) as { id: string };
    await dispatch(ctx, 'POST', `/api/products/${product.id}/purchase`, { size: 'W29 L30' });
    const db = store.read();
    assert.equal(db.profile.shoeSizeEu, '39½');
    assert.equal(db.profile.measurements.foot.value, null);
    assert.deepEqual(sizingBrands(db).map(brandKey), ['levis', 'nike']);
    assert.deepEqual(sizeEvidence(db).map((row) => [row.size, Boolean(row.item)]), [['W28 L30', false], ['W29 L30', true]]);
    assert.deepEqual(ownerSizes(db), ["Levi's trousers: W28 L30", 'Levi’s trousers: W29 L30']);
    const jacket = await dispatch(ctx, 'POST', '/api/needs', { title: 'Test jacket', category: 'outerwear' }) as { id: string };
    const queue = (id: string) => dispatch(ctx, 'POST', `/api/needs/${id}/search`, {}) as Promise<Parameters<typeof shopSearchPrompt>[1]>;
    const shoePrompt = shopSearchPrompt(store.read(), await queue(shoes.id));
    assert.match(shoePrompt, /Usual shoe size: EU 39½/);
    assert.match(shoePrompt, /nike\.com\/hr\/size-fit\/mens-footwear/);
    assert.doesNotMatch(shoePrompt, /foot [0-9]/);
    const jacketPrompt = shopSearchPrompt(store.read(), await queue(jacket.id));
    assert.match(jacketPrompt, /waist 74 cm/);
    assert.doesNotMatch(jacketPrompt, /Usual shoe size/);
    for (const brand of sizingBrands(db)) assert.ok(sizeGuides(brand).length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('published sizing charts contain aligned rows and official source URLs', () => {
  const sample = ['Adidas', 'ABUS', 'Castelli', "Levi's", 'Napapijri', 'Nike', 'Polo Ralph Lauren', 'Puma', 'Scotch & Soda', 'Speedo', 'The North Face', 'Timberland', 'Under Armour', 'Vans'];
  for (const brand of sample) {
    const guides = sizeGuides(brand);
    assert.ok(guides.length, brand);
    for (const guide of guides) {
      assert.match(guide.url, /^https:\/\//);
      assert.ok(guide.rows.every((row) => row.length === guide.columns.length), `${brand} ${guide.title}`);
    }
  }
  assert.deepEqual(sizeGuides('Levi’s')[0].rows.find(([waist]) => waist === '33'), ['33', '83.8', '100.3']);
});
