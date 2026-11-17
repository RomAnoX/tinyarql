// Export of the saved-query library to a folder. Needs nothing. Run: ~/.tinyjs/bin/tjs run test/sqlfiles.js
import { api } from '../src/main.js';
import { safeFileName } from '../src/sqlfiles.js';
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const failsWith = async (f, re) => { try { await f(); } catch (e) { return re.test(e.message); } return false; };
const dec = new TextDecoder();

ok(safeFileName('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j', 'characters no OS allows in a name become _');
ok(safeFileName('  ..hidden. ') === 'hidden', 'leading dots and edge spaces are trimmed (no hidden files, no "..")');
ok(safeFileName('') === 'query' && safeFileName('...') === 'query', 'an empty result falls back to "query"');
ok(safeFileName('x'.repeat(300)).length === 100, 'long names are cut to 100');
ok(safeFileName('Café ✓ 日本') === 'Café ✓ 日本', 'Unicode names are kept');

const dir = `${tjs.tmpDir || '/tmp'}/tinyarql-sqlfiles-${Date.now()}`;
await tjs.makeDir(dir);
const r = await api.exportQueries({ dir, items: [{ name: 'users', sql: 'select 1;' }, { name: 'Users', sql: 'select 2;\n' }, { name: 'a/b', sql: 'select 3' }] });
ok(r.written === 3, 'reports how many were written');
const read = async (f) => dec.decode(await tjs.readFile(`${dir}/${f}`));
ok(await read('users.sql') === 'select 1;\n', 'a file ends with one newline');
ok(await read('Users (2).sql') === 'select 2;\n', 'names that differ only by case do not overwrite each other, and an existing newline is not doubled');
ok(await read('a_b.sql') === 'select 3\n', 'a name with a slash cannot escape the folder');
await api.exportQueries({ dir, items: [{ name: 'users', sql: 'select 9;' }] });
ok(await read('users.sql') === 'select 1;\n' && await read('users (3).sql') === 'select 9;\n', 'an existing file is never overwritten (the next free " (n)" is used; "Users (2)" was taken, and macOS ignores case)');

ok(await failsWith(() => api.exportQueries({ dir: 'rel', items: [{ name: 'a', sql: 'b' }] }), /full folder path/), 'a relative folder is refused');
ok(await failsWith(() => api.exportQueries({ dir, items: [] }), /Nothing to export/), 'an empty library is refused');
ok(await failsWith(() => api.exportQueries({ dir: `${dir}/nope`, items: [{ name: 'a', sql: 'b' }] }), /^That folder does not exist$/), 'a missing folder: "That folder does not exist"');
ok(await failsWith(() => api.exportQueries({ dir: `${dir}/users.sql`, items: [{ name: 'a', sql: 'b' }] }), /not a folder/), 'a file instead of a folder is refused');
ok(await failsWith(() => api.exportQueries({ dir, items: [{ name: 'a', sql: 5 }] }), /Nothing to write/), 'non-text SQL is refused');
for await (const e of await tjs.readDir(dir)) await tjs.remove(`${dir}/${e.name}`);
await tjs.remove(dir);
console.log('all ok');
