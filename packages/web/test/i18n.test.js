/**
 * Dictionary parity. Six locales, one key set, one placeholder vocabulary.
 *
 * `t()` falls back to English and then to the raw key, so a missing translation
 * is not an error — it is a French viewer seeing `censusExtinct` where a sentence
 * should be, and a missing *placeholder* is worse: `replaceAll('{day}')` never
 * fires, so the sentence renders with braces in it. Both are invisible until
 * somebody switches language, which is precisely why this is a test and not a
 * convention.
 *
 * Scope, stated honestly: the call-site sweep covers `t('literal')` and
 * `data-i18n`/`data-i18n-title` attributes. Keys assembled at runtime (a handful
 * of them, e.g. per-archetype labels) are not reachable by grep and are covered
 * only by the six-way key-set comparison below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// i18n.js reads the saved language at module scope, which is the one thing about
// it that is not pure. Stubbed rather than skipped: the dictionary and the picker
// are the subject of this file, and both live behind that line.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { DICT, LANGS } = await import('../i18n.js');

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const LOCALES = Object.keys(DICT);

/** `{name}` placeholders, in first-seen order, de-duplicated. */
const holes = (s) => [...new Set([...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();

test('every locale carries the same key set', () => {
  assert.deepEqual(LOCALES, LANGS.map((l) => l.code), 'the picker and the dictionary agree about how many languages there are');
  const en = Object.keys(DICT.en).sort();
  for (const code of LOCALES) {
    if (code === 'en') continue;
    const keys = Object.keys(DICT[code]).sort();
    assert.deepEqual(
      { missing: en.filter((k) => !keys.includes(k)), extra: keys.filter((k) => !en.includes(k)) },
      { missing: [], extra: [] },
      `${code} is out of step with en`,
    );
  }
});

test('no translation drops a placeholder or invents one', () => {
  for (const key of Object.keys(DICT.en)) {
    const want = holes(DICT.en[key]);
    for (const code of LOCALES) {
      assert.deepEqual(holes(DICT[code][key]), want, `${code}/${key} speaks to different arguments than en`);
    }
  }
});

test('no key is present and empty', () => {
  const empty = [];
  for (const code of LOCALES) {
    for (const [k, v] of Object.entries(DICT[code])) if (!String(v).trim()) empty.push(`${code}/${k}`);
  }
  assert.deepEqual(empty, []);
});

test('every label the code asks for is in the dictionary it falls back to', () => {
  const sources = [readFileSync(here('../app.js'), 'utf8'), readFileSync(here('../index.html'), 'utf8')];
  const used = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-title)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 100, `${used.size} literal keys found, which is fewer than this file has ever had`);
  const missing = [...used].filter((k) => !(k in DICT.en)).sort();
  assert.deepEqual(missing, [], 'a key nothing defines renders as itself, in every language');
});
