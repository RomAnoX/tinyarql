// Same Postgres as test/drivers.js. Run: ~/.tinyjs/bin/tjs run test/main.js
import { api, init } from '../src/main.js';
const mem = new Map();
const pushes = [];
init({ push: (event, data) => pushes.push([event, data]), store: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => (mem.set(k, v), true) },
       secrets: { get: async (k) => mem.get('s:' + k) ?? null, set: async (k, v) => (mem.set('s:' + k, v), true), delete: async (k) => mem.delete('s:' + k) } });
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };

const c = await api.saveConnection({ conn: { name: 'pg', type: 'postgres', host: '127.0.0.1', port: 54329, user: 'tester', database: 'postgres' }, password: 'secret' });
ok(!JSON.stringify(mem.get('connections')).includes('secret'), 'password not in store');
ok(await api.testConnection({ conn: c, password: 'secret' }), 'testConnection');
const tables = await api.connect({ id: c.id });
ok(tables.length === 2, 'connect lists tables');
const r = await api.query({ id: c.id, sql: 'select name from people order by id' });
ok(r.rows[0][0] === 'ada' && typeof r.ms === 'number', 'query');
ok((await api.browse({ id: c.id, ref: tables[0].ref, page: 0, pageSize: 1 })).rows.length === 1, 'browse page');
// ---- cancelQuery ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ok((await api.cancelQuery({ id: c.id })).cancelled === false, 'cancelQuery with nothing running reports false');
const pending = api.query({ id: c.id, sql: 'select pg_sleep(30)' });
await sleep(300);
ok((await api.cancelQuery({ id: c.id })).cancelled === true, 'cancelQuery while running reports true');
const stopped = await pending;
ok(stopped.cancelled === true && stopped.ms < 3000 && !('rows' in stopped), 'the stopped query resolves as { cancelled: true } (not an error)');
ok((await api.query({ id: c.id, sql: 'select 5 as n' })).rows[0][0] === '5', 'the session still works after a stop');
let boom = null; try { await api.query({ id: c.id, sql: 'select * from nope_nope' }); } catch (e) { boom = e; }
ok(boom && /does not exist/.test(boom.message), 'real errors still throw');
const lite = await api.saveConnection({ conn: { name: 'lite', type: 'sqlite', path: ':memory:' } });
await api.connect({ id: lite.id });
ok((await api.cancelQuery({ id: lite.id })).cancelled === false, 'SQLite sessions cannot be cancelled: reports false');
let off = null; try { await api.cancelQuery({ id: 'nope' }); } catch (e) { off = e; }
ok(off && off.message === 'not connected', 'cancelQuery on an unknown connection throws not connected');
await api.deleteConnection({ id: lite.id });
await api.deleteConnection({ id: c.id });
ok((await api.listConnections()).length === 0, 'delete');
try { await api.query({ id: c.id, sql: 'select 1' }); ok(false, 'should throw'); } catch (e) { ok(e.message === 'not connected', 'disconnected throws'); }
// ---- .sql files ----
const dir = `/tmp/tinyarql-main-test-${tjs.pid}`;
await tjs.makeDir(dir, { recursive: true });
const failsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };
const wrote = await api.writeTextFile({ path: `${dir}/a.sql`, text: 'select \'héllo ✓\';\r\nselect 2;\n' });
ok(wrote.bytes === new TextEncoder().encode('select \'héllo ✓\';\r\nselect 2;\n').length, 'writeTextFile reports the byte count (UTF-8 bytes, not characters)');
const readBack = await api.readTextFile({ path: `${dir}/a.sql` });
ok(readBack.text === 'select \'héllo ✓\';\r\nselect 2;\n', 'unicode and CRLF line endings come back exactly as written');
await tjs.writeFile(`${dir}/bom.sql`, new Uint8Array([0xEF, 0xBB, 0xBF, 0x73, 0x65, 0x6C]));
ok((await api.readTextFile({ path: `${dir}/bom.sql` })).text === 'sel', 'a UTF-8 byte-order mark is stripped');
ok(await failsWith(() => api.readTextFile({ path: `${dir}/missing.sql` }), /^File not found$/), 'missing file: "File not found"');
ok(await failsWith(() => api.readTextFile({ path: dir }), /folder, not a file/), 'a folder is refused in plain words');
await tjs.writeFile(`${dir}/bin.dat`, new Uint8Array([0x73, 0xFF, 0xFE, 0x41]));
ok(await failsWith(() => api.readTextFile({ path: `${dir}/bin.dat` }), /not valid UTF-8/), 'invalid UTF-8 is refused as not a text file');
await tjs.writeFile(`${dir}/nul.sql`, new Uint8Array([0x61, 0x00, 0x62]));
ok(await failsWith(() => api.readTextFile({ path: `${dir}/nul.sql` }), /binary data/), 'NUL bytes are refused as binary');
await tjs.writeFile(`${dir}/big.sql`, new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61));
ok(await failsWith(() => api.readTextFile({ path: `${dir}/big.sql` }), /larger than 5 MB/), 'a file over 5 MB is refused before it is read');
await tjs.writeFile(`${dir}/five.sql`, new Uint8Array(5 * 1024 * 1024).fill(0x61));
ok((await api.readTextFile({ path: `${dir}/five.sql` })).bytes === 5 * 1024 * 1024, 'exactly 5 MB is accepted');
ok(await failsWith(() => api.readTextFile({ path: '' }), /No file given/), 'an empty path is refused');
ok(await failsWith(() => api.writeTextFile({ path: `${dir}/nope/x.sql`, text: 'a' }), /^That folder does not exist$/), 'writing into a missing folder: "That folder does not exist"');
ok(await failsWith(() => api.writeTextFile({ path: 'relative.sql', text: 'a' }), /full file path/), 'a relative path is refused');
ok(await failsWith(() => api.writeTextFile({ path: `${dir}/x.sql`, text: 5 }), /Nothing to write/), 'non-text content is refused');
await api.writeTextFile({ path: `${dir}/a.sql`, text: 'replaced' });
ok((await api.readTextFile({ path: `${dir}/a.sql` })).text === 'replaced', 'writing overwrites an existing file');
for (const f of ['a.sql', 'bom.sql', 'bin.dat', 'nul.sql', 'big.sql', 'five.sql']) { try { await tjs.remove(`${dir}/${f}`); } catch {} }
try { await tjs.remove(dir); } catch {}
// ---- CSV export ----
const csvDir = `/tmp/tinyarql-main-csv-${tjs.pid}`;
await tjs.makeDir(csvDir, { recursive: true });
const readText = async (p) => new TextDecoder().decode(await tjs.readFile(p));
const fileExists = async (p) => { try { await tjs.stat(p); return true; } catch { return false; } };
const pgc = await api.saveConnection({ conn: { name: 'pg-csv', type: 'postgres', host: '127.0.0.1', port: 54329, user: 'tester', database: 'postgres' }, password: 'secret' });
await api.connect({ id: pgc.id });
const sqc = await api.saveConnection({ conn: { name: 'lite-csv', type: 'sqlite', path: ':memory:' } });
await api.connect({ id: sqc.id });

// the rows already on screen
const shown = await api.exportRowsCsv({ path: `${csvDir}/shown.csv`, columns: ['id', 'note'], rows: [[1, 'a,b'], [2, null], [3, '']] });
ok(shown.rows === 3 && (await readText(`${csvDir}/shown.csv`)) === 'id,note\r\n1,"a,b"\r\n2,\r\n3,""\r\n', 'exportRowsCsv writes the rows given');
ok(await failsWith(() => api.exportRowsCsv({ path: `${csvDir}/nope/x.csv`, columns: ['a'], rows: [] }), /^That folder does not exist$/), 'exportRowsCsv into a missing folder: "That folder does not exist"');
ok(await failsWith(() => api.exportRowsCsv({ path: 'rel.csv', columns: ['a'], rows: [] }), /full file path/), 'exportRowsCsv refuses a relative path');
ok(await failsWith(() => api.exportRowsCsv({ path: `${csvDir}/x.csv`, columns: [], rows: [] }), /Nothing to export/), 'exportRowsCsv refuses an export with no columns');
ok(!(await fileExists(`${csvDir}/x.csv`)) && !(await fileExists(`${csvDir}/x.csv.part`)), 'a refused export leaves nothing behind');
ok((await api.exportRowsCsv({ path: `${csvDir}/header-only.csv`, columns: ['a', 'b'], rows: [] })).rows === 0 && (await readText(`${csvDir}/header-only.csv`)) === 'a,b\r\n', 'zero rows still produce the header');

// the whole result, streamed (Postgres)
pushes.length = 0;
const big = await api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/pg-big.csv`, sql: "select i, 'row ' || i as label, case when i % 3 = 0 then null else 'x,y' end as v, case when i = 2 then '' else 'z' end as e from generate_series(1, 5000) as i" });
const bigLines = (await readText(`${csvDir}/pg-big.csv`)).split('\r\n');
ok(big.rows === 5000 && bigLines.length === 5002 && bigLines[0] === 'i,label,v,e', 'streams all 5000 rows (the on-screen cap of 1000 does not apply) plus the header');
ok(bigLines[1] === '1,row 1,"x,y",z' && bigLines[2] === '2,row 2,"x,y",""' && bigLines[3] === '3,row 3,,z' && bigLines[5000] === '5000,row 5000,"x,y",z' && bigLines[5001] === '', 'first, NULL, empty-string and last rows are exact');
ok(pushes.some(([e, d]) => e === 'exportProgress' && d.id === pgc.id && d.rows > 0), 'progress events are pushed while it runs', JSON.stringify(pushes.slice(0, 2)));
ok(!(await fileExists(`${csvDir}/pg-big.csv.part`)), 'no partial file is left after a finished export');
const script = await api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/pg-script.csv`, sql: 'select 1 as a; select 2 as b, 3 as c' });
ok(script.rows === 1 && (await readText(`${csvDir}/pg-script.csv`)) === 'b,c\r\n2,3\r\n', 'a script exports its last statement\'s result');
ok(await failsWith(() => api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/pg-ddl.csv`, sql: 'create temp table csv_z(x int)' }), /did not return any rows/) && !(await fileExists(`${csvDir}/pg-ddl.csv`)), 'a statement with no rows says so and writes no file');

// failure safety
await tjs.writeFile(`${csvDir}/precious.csv`, 'precious');
ok(await failsWith(() => api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/precious.csv`, sql: 'select 1 / (i - 2000) as q from generate_series(1, 5000) as i' }), /division by zero/), 'a SQL error partway through is reported');
ok((await readText(`${csvDir}/precious.csv`)) === 'precious' && !(await fileExists(`${csvDir}/precious.csv.part`)), '...and the file it would have replaced is untouched, with no partial file');
ok((await api.query({ id: pgc.id, sql: 'select 11 as n' })).rows[0][0] === '11', '...and the connection is still usable');
const t0 = Date.now();
ok(await failsWith(() => api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/nope/x.csv`, sql: 'select * from generate_series(1, 300000)' }), /^That folder does not exist$/), 'an unwritable destination fails with a plain message');
ok((await api.query({ id: pgc.id, sql: 'select 12 as n' })).rows[0][0] === '12' && Date.now() - t0 < 8000, '...and the connection is still in step with the server (the rest of that result was drained)');

// stopping an export
const slowExport = api.exportQueryCsv({ id: pgc.id, path: `${csvDir}/pg-stop.csv`, sql: "select i, md5(i::text) from generate_series(1, 20000000) as i" });
await sleep(500);
ok((await api.cancelQuery({ id: pgc.id })).cancelled === true, 'cancelQuery reaches an export that is running');
const stoppedExport = await slowExport;
ok(stoppedExport.cancelled === true && !(await fileExists(`${csvDir}/pg-stop.csv`)) && !(await fileExists(`${csvDir}/pg-stop.csv.part`)), 'a stopped export resolves as cancelled and leaves no file at all');
ok((await api.query({ id: pgc.id, sql: 'select 13 as n' })).rows[0][0] === '13', '...and the connection is still usable');

// SQLite
const lite5 = await api.exportQueryCsv({ id: sqc.id, path: `${csvDir}/lite.csv`, sql: "with recursive c(x) as (select 1 union all select x + 1 from c where x < 2500) select x, 'n' || x as name, case when x = 2 then 'a' || char(13) || char(10) || 'b' end as multi, x'00ff' as b from c" });
const liteText = await readText(`${csvDir}/lite.csv`);
ok(lite5.rows === 2500 && liteText.startsWith('x,name,multi,b\r\n1,n1,,0x00ff\r\n2,n2,"a\r\nb",0x00ff\r\n3,n3,,0x00ff\r\n') && liteText.endsWith('2500,n2500,,0x00ff\r\n'), 'SQLite streams all 2500 rows; NULL, a multi-line value and a blob come out right');
ok(await failsWith(() => api.exportQueryCsv({ id: sqc.id, path: `${csvDir}/lite0.csv`, sql: 'select 1 as a where 0' }), /did not return any rows/), 'a SQLite result with no rows reports that there is nothing to export');
ok(await failsWith(() => api.exportQueryCsv({ id: 'nope', path: `${csvDir}/x.csv`, sql: 'select 1' }), /not connected/), 'an unknown connection throws not connected');
await api.deleteConnection({ id: pgc.id }); await api.deleteConnection({ id: sqc.id });
for (const f of ['shown.csv', 'header-only.csv', 'pg-big.csv', 'pg-script.csv', 'precious.csv', 'lite.csv']) { try { await tjs.remove(`${csvDir}/${f}`); } catch {} }
try { await tjs.remove(csvDir); } catch {}
// ---- MySQL (needs a MySQL 8 on 127.0.0.1:33061: see the header of test/drivers.js) ----
const myDir = `/tmp/tinyarql-main-mysql-${tjs.pid}`;
await tjs.makeDir(myDir, { recursive: true });
const myConn = await api.saveConnection({ conn: { name: 'my', type: 'mysql', host: '127.0.0.1', port: 33061, user: 'tester', database: 'testdb' }, password: 'secret' });
ok(await api.testConnection({ conn: myConn, password: 'secret' }) === true, 'testConnection works for a MySQL connection');
ok(await failsWith(() => api.testConnection({ conn: myConn, password: 'wrong' }), /Access denied/), 'a wrong MySQL password is reported in the server\'s words');
ok(await failsWith(() => api.testConnection({ conn: { ...myConn, database: 'no_such_db' }, password: 'secret' }), /Unknown database/), 'an unknown MySQL database is reported');
const myTables = await api.connect({ id: myConn.id });
ok(myTables.map((t) => t.name).join() === 'people,v' && myTables[0].columns.length === 8, 'connect lists the MySQL database\'s tables and views with their columns');
const myRes = await api.query({ id: myConn.id, sql: 'select id, name, meta from people order by id' });
ok(myRes.rows[0][1] === 'ada' && myRes.types.join() === 'int,varchar,json' && typeof myRes.ms === 'number', 'api.query runs MySQL and reports types');
ok((await api.browse({ id: myConn.id, ref: myTables[0].ref, page: 0, pageSize: 1 })).rows.length === 1, 'browse pages a MySQL table');
const myBlob = await api.query({ id: myConn.id, sql: "select cast(repeat('a', 5000) as binary) as b" });
ok(/^0x(61){2048}… \(5,000 bytes\)$/.test(myBlob.rows[0][0]), 'a large binary value is shortened in the grid, with its size');
const heavyMy = 'select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c';
const pendingMy = api.query({ id: myConn.id, sql: heavyMy });
await sleep(400);
ok((await api.cancelQuery({ id: myConn.id })).cancelled === true, 'cancelQuery reaches a running MySQL statement');
const stoppedMy = await pendingMy;
ok(stoppedMy.cancelled === true && stoppedMy.ms < 5000 && !('rows' in stoppedMy), 'the stopped MySQL query resolves as { cancelled: true } (not an error)');
ok((await api.query({ id: myConn.id, sql: 'select 5 as n' })).rows[0][0] === '5', 'the MySQL session still works after a stop');
ok(await failsWith(() => api.query({ id: myConn.id, sql: 'select * from nope_nope' }), /doesn't exist/), 'real MySQL errors still throw');

// CSV export from MySQL
const myCsv = await api.exportQueryCsv({ id: myConn.id, path: `${myDir}/my.csv`, sql: "set session cte_max_recursion_depth = 10000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 5000) select n, concat('row ', n) as label, if(n % 3 = 0, null, 'x,y') as v, if(n = 2, '', 'z') as e, cast('é' as binary) as bin from c" });
const myCsvLines = (await readText(`${myDir}/my.csv`)).split('\r\n');
ok(myCsv.rows === 5000 && myCsvLines.length === 5002 && myCsvLines[0] === 'n,label,v,e,bin', 'MySQL: all 5000 rows are streamed to CSV, past the on-screen cap');
ok(myCsvLines[1] === '1,row 1,"x,y",z,0xc3a9' && myCsvLines[2] === '2,row 2,"x,y","",0xc3a9' && myCsvLines[3] === '3,row 3,,z,0xc3a9' && myCsvLines[5000] === '5000,row 5000,"x,y",z,0xc3a9', 'MySQL: NULL vs empty string, quoting and binary-as-hex are exact in the file');
const myFull = await api.exportQueryCsv({ id: myConn.id, path: `${myDir}/blob.csv`, sql: "select cast(repeat('a', 5000) as binary) as b" });
const blobLine = (await readText(`${myDir}/blob.csv`)).split('\r\n')[1];
ok(blobLine.length === 2 + 10000 && !blobLine.includes('…'), 'MySQL: an export writes a large binary value in full (the grid only previews it)');
await tjs.writeFile(`${myDir}/precious.csv`, 'precious');
ok(await failsWith(() => api.exportQueryCsv({ id: myConn.id, path: `${myDir}/precious.csv`, sql: 'set session cte_max_recursion_depth = 10000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 5000) select if(n = 2000, (select 1 union select 2), n) as v from c' }), /more than 1 row/), 'MySQL: an SQL error partway through an export is reported');
ok((await readText(`${myDir}/precious.csv`)) === 'precious' && !(await fileExists(`${myDir}/precious.csv.part`)), '...the file it would have replaced is untouched, with no partial file');
ok((await api.query({ id: myConn.id, sql: 'select 6 as n' })).rows[0][0] === '6', '...and the connection is still usable');
ok(await failsWith(() => api.exportQueryCsv({ id: myConn.id, path: `${myDir}/nope/x.csv`, sql: 'select * from information_schema.columns' }), /^That folder does not exist$/), 'MySQL: an unwritable destination fails with a plain message');
ok((await api.query({ id: myConn.id, sql: 'select 7 as n' })).rows[0][0] === '7', '...and the connection is still in step (the rest of that result was drained)');
const slowMyExport = api.exportQueryCsv({ id: myConn.id, path: `${myDir}/stop.csv`, sql: 'select a.column_name, b.column_name from information_schema.columns a, information_schema.columns b, information_schema.columns c' });
await sleep(600);
ok((await api.cancelQuery({ id: myConn.id })).cancelled === true, 'cancelQuery reaches a MySQL export that is running');
const stoppedMyExport = await slowMyExport;
ok(stoppedMyExport.cancelled === true && !(await fileExists(`${myDir}/stop.csv`)) && !(await fileExists(`${myDir}/stop.csv.part`)), 'a stopped MySQL export resolves as cancelled and leaves no file at all');
ok((await api.query({ id: myConn.id, sql: 'select 8 as n' })).rows[0][0] === '8', '...and the connection is still usable');
await api.deleteConnection({ id: myConn.id });
for (const f of ['my.csv', 'blob.csv', 'precious.csv']) { try { await tjs.remove(`${myDir}/${f}`); } catch {} }
try { await tjs.remove(myDir); } catch {}
console.log('ALL PASS');
tjs.exit(0);  // init() starts the window-state poll timer, which would keep the process alive
