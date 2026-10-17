// Run: ~/.tinyjs/bin/tjs run test/csv.js  (no display or database needed)
import { csvField, csvLine, createCsvWriter } from '../src/csv.js';

const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

// ---- fields ----
eq(['plain', 42, 3.5, true, 12345678901234567890n].map(csvField), ['plain', '42', '3.5', 'true', '12345678901234567890'], 'plain values are written as they are');
eq([null, undefined].map(csvField), ['', ''], 'NULL is an empty field');
eq(csvField(''), '""', 'an empty string is "" so it differs from NULL');
eq(csvField('a,b'), '"a,b"', 'a comma forces quotes');
eq(csvField('say "hi"'), '"say ""hi"""', 'quotes are doubled');
eq(csvField('line1\nline2'), '"line1\nline2"', 'an LF forces quotes');
eq(csvField('a\rb'), '"a\rb"', 'a CR forces quotes');
eq(csvField(' pad'), '" pad"', 'leading space is protected');
eq(csvField('pad '), '"pad "', 'trailing space is protected');
eq(csvField('héllo ✓ 日本'), 'héllo ✓ 日本', 'unicode is left alone');
eq(csvField('=1+1'), '=1+1', 'formulas are not rewritten (exact values)');
eq(csvField(new Uint8Array([0, 255, 16])), '0x00ff10', 'binary becomes hex');
eq(csvLine(['a', 'b,c', null, '']), 'a,"b,c",,""\r\n', 'a line is CRLF-terminated');

// ---- a tiny RFC 4180 reader, to prove what we write can be read back exactly ----
function parse(text) {
  const rows = []; let row = [], field = '', q = false, quotedField = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') { q = true; quotedField = true; }
    else if (c === ',') { row.push(quotedField || field !== '' ? field : null); field = ''; quotedField = false; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(quotedField || field !== '' ? field : null); rows.push(row); row = []; field = ''; quotedField = false; i++; }
    else field += c;
  }
  return rows;
}
const alphabet = ['a', 'B', ' ', ',', '"', '\n', '\r', '\r\n', 'é', '✓', '=', '-', '0', ''];
const rnd = () => { const r = Math.random(); if (r < 0.15) return null; let s = ''; for (let i = Math.floor(Math.random() * 6); i > 0; i--) s += alphabet[Math.floor(Math.random() * alphabet.length)]; return s; };
let bad = 0;
for (let n = 0; n < 500; n++) {
  const width = 1 + Math.floor(Math.random() * 4), rows = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => Array.from({ length: width }, rnd));
  const back = parse(rows.map(csvLine).join(''));
  if (JSON.stringify(back) !== JSON.stringify(rows)) { bad++; if (bad < 3) console.log('MISMATCH', JSON.stringify(rows), JSON.stringify(back)); }
}
ok(bad === 0, '500 random tables (commas, quotes, CR/LF, unicode, NULL vs "") read back exactly');

// ---- the file writer ----
const dir = `/tmp/tinyarql-csv-test-${tjs.pid}`;
await tjs.makeDir(dir, { recursive: true });
const read = async (p) => new TextDecoder().decode(await tjs.readFile(p));
const exists = async (p) => { try { await tjs.stat(p); return true; } catch { return false; } };
let w = createCsvWriter(`${dir}/a.csv`);
ok(!w.started, 'a writer has written nothing until start()');
await w.start(['id', 'name']); await w.write([[1, 'ada'], [2, 'b,ob']]); await w.write([[3, null]]);
ok(await exists(`${dir}/a.csv.part`) && !(await exists(`${dir}/a.csv`)), 'while writing, the data lives in <name>.part, not in the real file');
await w.finish();
ok(!(await exists(`${dir}/a.csv.part`)) && (await read(`${dir}/a.csv`)) === 'id,name\r\n1,ada\r\n2,"b,ob"\r\n3,\r\n', 'finish() renames it into place');
await tjs.writeFile(`${dir}/keep.csv`, 'precious');
w = createCsvWriter(`${dir}/keep.csv`);
await w.start(['x']); await w.write([[1]]); await w.abort();
ok((await read(`${dir}/keep.csv`)) === 'precious' && !(await exists(`${dir}/keep.csv.part`)), 'abort() leaves an existing file untouched and removes the partial one');
w = createCsvWriter(`${dir}/keep.csv`);
await w.start(['x']); await w.write([[1]]); await w.finish();
ok((await read(`${dir}/keep.csv`)) === 'x\r\n1\r\n', 'a finished export replaces an existing file');
w = createCsvWriter(`${dir}/multi.csv`);
await w.start(['first']); await w.write([[1]]); await w.start(['b', 'c']); await w.write([[2, 3]]); await w.finish();
ok((await read(`${dir}/multi.csv`)) === 'b,c\r\n2,3\r\n', 'start() again begins the file afresh (a script\'s last result wins)');
w = createCsvWriter(`${dir}/big.csv`);
await w.start(['n']); for (let i = 0; i < 50; i++) await w.write(Array.from({ length: 2000 }, (_, k) => [i * 2000 + k]));
await w.finish();
const big = await read(`${dir}/big.csv`);
ok(big.split('\r\n').length === 100002 && big.startsWith('n\r\n0\r\n1\r\n') && big.endsWith('99999\r\n'), '100,000 rows written in pieces arrive complete and in order');
w = createCsvWriter(`${dir}/nope/x.csv`);
let failed = null; try { await w.start(['a']); } catch (e) { failed = e; }
ok(failed && /ENOENT/.test(failed.message), 'a missing folder fails at start()');
await w.abort();
for (const f of ['a.csv', 'keep.csv', 'multi.csv', 'big.csv']) { try { await tjs.remove(`${dir}/${f}`); } catch {} }
try { await tjs.remove(dir); } catch {}
console.log('ALL PASS');
