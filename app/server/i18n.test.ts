// Every Ukrainian line the interface can show has an English one.
// The check reads the sources: each quoted Ukrainian string and each piece of Ukrainian JSX text in src must be
// a key of src/i18n/en.ts. Files with their own bilingual text, and data that is matched rather than shown
// (colour and accessory patterns, country words), are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/i18n/en.ts';
import { setLanguage, t, plural, LOOKS } from '../src/i18n.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
// capsule-pieces.ts builds the server's set errors; their full texts are English keys in en.ts.
const OWN_TEXT = new Set(['pages/Legal.tsx', 'style-catalogue.ts', 'look-memory.ts', 'capsule-pieces.ts', 'i18n.ts', 'i18n/en.ts']);
const CYR = /[А-Яа-яІіЇїЄєҐґ]/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

/** Ukrainian strings in a source file: quoted literals and JSX text, without comments, regexes or matched data. */
function ukrainianStrings(file: string): string[] {
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1');
  // Data that is matched, never shown.
  s = s.replace(/const (COLOURS|COUNTRY_WORDS|MY_PLACE)\b[^\n]*/g, '').replace(/isEyewear = [^\n]*/g, '');
  s = s.replace(/\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\[])+\/[dgimsuy]*/g, (m) => (CYR.test(m) ? '""' : m));
  // Server text compared, not shown (e.g. startsWith('Потрібні окремі фото речей:')).
  s = s.replace(/\.(startsWith|includes|test)\((['"])[^'"]*\2\)/g, '');
  const out: string[] = [];
  for (const m of s.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const v = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (CYR.test(v)) out.push(v);
  }
  if (file.endsWith('.tsx')) {
    for (const m of s.matchAll(/>([^<>{}]+)</g)) if (CYR.test(m[1]) && !/['"`]|=>|&&/.test(m[1])) out.push(`JSX: ${m[1].trim()}`);
  }
  // A part that holds markup or code means the scanner lost its place on an apostrophe in JSX text: not a template.
  for (const part of templateText(s)) if (CYR.test(part) && !/<\/|\)\}|=>/.test(part)) out.push(`TEMPLATE: ${part.trim().slice(0, 80)}`);
  return out;
}

/** The static text of template literals, nested ones included; `${…}` expressions are skipped. */
function templateText(s: string): string[] {
  const parts: string[] = [];
  const stack: ('tpl' | number)[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const top = stack.at(-1);
    if (top === 'tpl') {
      if (c === '\\') { buf += s[i + 1] ?? ''; i++; }
      else if (c === '`') { parts.push(buf); buf = ''; stack.pop(); }
      else if (c === '$' && s[i + 1] === '{') { parts.push(buf); buf = ''; stack.push(0); i++; }
      else buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      // Skip a quoted string in code.
      for (i++; i < s.length && s[i] !== c && s[i] !== '\n'; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '`') { stack.push('tpl'); continue; }
    if (typeof top === 'number') {
      if (c === '{') stack[stack.length - 1] = top + 1;
      else if (c === '}') { if (top === 0) stack.pop(); else stack[stack.length - 1] = top - 1; }
    }
  }
  return parts;
}

test('every Ukrainian interface string has an English line, with no Ukrainian left in templates or JSX text', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file);
    if (OWN_TEXT.has(rel)) continue;
    for (const v of ukrainianStrings(file)) {
      checked += 1;
      if (!(v in en)) missing.push(`${rel}: ${v}`);
    }
  }
  assert.ok(checked > 300, `only ${checked} strings found: the scan is not reading the sources`);
  assert.deepEqual(missing, []);
});

test('t() falls back to Ukrainian, fills placeholders and picks plural forms in both languages', () => {
  setLanguage('uk');
  assert.equal(t('Додано фото: {n}', { n: 3 }), 'Додано фото: 3');
  assert.equal(plural(1, LOOKS), '1 образ');
  assert.equal(plural(3, LOOKS), '3 образи');
  assert.equal(plural(11, LOOKS), '11 образів');
  setLanguage('en');
  assert.equal(t('Додано фото: {n}', { n: 3 }), 'Photos added: 3');
  assert.equal(t('Рядок без перекладу'), 'Рядок без перекладу');
  assert.equal(plural(1, LOOKS), '1 look');
  assert.equal(plural(5, LOOKS), '5 looks');
  setLanguage('uk');
});

test('dates and scores follow the active interface language', async () => {
  const { fmtDay, scoreLabel } = await import('../src/lib.ts');
  setLanguage('uk');
  assert.equal(scoreLabel(8.6), '8,6/10');
  assert.match(fmtDay('2026-11-22T12:00:00.000Z'), /листопада/);
  setLanguage('en');
  assert.equal(scoreLabel(8.6), '8.6/10');
  assert.match(fmtDay('2026-11-22T12:00:00.000Z'), /November/);
  setLanguage('uk');
});
