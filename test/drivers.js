// MySQL section needs a MySQL 8 on 127.0.0.1:33061 (users tester/secret [caching_sha2], native/secret [native_password], nopass/'' ;
// database testdb with table people(id,name,note,born,score,flag,meta json,raw blob) + view v; database otherdb with table elsewhere).
// (test/postgres-server.sh and test/mysql-server.sh start both servers.)
// Needs a Postgres on 127.0.0.1:54329 (user tester / password secret, db postgres) with table people(id serial, name, note) + a view.
// Run: ~/.tinyjs/bin/tjs run test/drivers.js
import { connect as pg } from '../src/drivers/postgres.js';
import { connect as lite } from '../src/drivers/sqlite.js';
import { connect as my } from '../src/drivers/mysql.js';
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); console.log('ok', m); };

const p = await pg({ port: 54329, user: 'tester', password: 'secret', database: 'postgres' });
eq((await p.query('select id, name, note from people order by id')).rows, [['1','ada','x'],['2','bob',null]], 'pg rows + null');
eq((await p.query('select 1 as a, 2 as b')).columns, ['a','b'], 'pg columns');
const ty = await p.query(`select '{"a":[1,2]}'::jsonb as j, '{"a":1}'::json as k, 'x'::text as t, 1::int4 as i, now() as ts, '{}'::jsonb is null as b, point(1,2) as odd`);
eq(ty.types, ['jsonb', 'json', 'text', 'int4', 'timestamptz', 'bool', null], 'pg column types by oid');
eq(ty.rows[0][0], '{"a": [1, 2]}', 'pg jsonb arrives as text');
eq((await p.tables()).map((t) => t.name + ':' + t.type), ['people:table', 'v:view'], 'pg tables');
eq((await p.tables())[0].columns, ['id', 'name', 'note'], 'pg table columns in order');
eq((await p.select((await p.tables())[0].ref, 1, 1)).rows, [['2','bob',null]], 'pg select offset');
try { await p.query('select * from nope'); throw 0; } catch (e) { eq(String(e.message).includes('does not exist'), true, 'pg error surfaced'); }
eq((await p.query('select 7 as n')).rows, [['7']], 'pg usable after error');
eq((await p.query('select generate_series(1,1500)')).truncated, true, 'pg truncates at 1000');
// ---- cancelling a running query ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
eq(await p.cancel(), false, 'cancel with nothing running does nothing');
let stopErr = null;
const slow = p.query('select pg_sleep(30)').catch((e) => { stopErr = e; });
await sleep(300);
const t0 = Date.now();
eq(await p.cancel(), true, 'cancel while a query runs sends the request');
await slow;
eq(Date.now() - t0 < 3000, true, 'the 30s query stops within 3s');
eq([stopErr && stopErr.code, /user request/.test(stopErr ? stopErr.message : '')], ['57014', true], 'it fails with SQLSTATE 57014 "user request"');
eq((await p.query('select 7 as n')).rows, [['7']], 'the same connection is usable after a cancel');
eq(await p.cancel(), false, 'nothing running again after the next query finished');
const batch = p.query('create temp table c1(x int); insert into c1 values (1); select pg_sleep(30)').catch(() => {});
await sleep(300); await p.cancel(); await batch;
eq((await p.query("select count(*) from pg_tables where tablename = 'c1'")).rows, [['0']], 'a cancelled multi-statement batch is rolled back as one');
await p.close();
const pm = await pg({ port: 54329, user: 'md5user', password: 'secret', database: 'postgres' });
const pa = await pg({ port: 54329, user: 'tester', password: 'secret', database: 'postgres' });
eq((await pa.query("select rolpassword like 'md5%' from pg_authid where rolname = 'md5user'")).rows, [['t']], 'pg md5 login: the account really uses an md5 password (negative control for the scram path)');
await pa.close();
eq((await pm.query('select name from people order by id')).rows, [['ada'], ['bob']], 'pg md5 login works');
await pm.close();
try { await pg({ port: 54329, user: 'md5user', password: 'wrong', database: 'postgres' }); throw 0; } catch (e) { eq(/password|authentication/i.test(e.message), true, 'pg md5 login: a wrong password is rejected'); }
try { await pg({ port: 54329, user: 'tester', password: 'wrong', database: 'postgres' }); throw 0; } catch (e) { eq(/password|authentication/i.test(e.message), true, 'pg bad password rejected'); }

const s = await lite({ path: ':memory:' });
await s.query('create table t(a, b)');
await s.query("insert into t values (1,'x')");
eq((await s.query('select * from t')).rows, [[1,'x']], 'sqlite rows');
eq((await s.tables()).map((t) => t.name), ['t'], 'sqlite tables');
eq((await s.tables())[0].columns, ['a', 'b'], 'sqlite table columns');
await s.query('delete from t');
eq((await s.select((await s.tables())[0].ref, 10, 0)).columns, ['a','b'], 'sqlite empty-table headers');
console.log('ALL PASS');

import { splitStatements } from '../src/drivers/sqlite.js';
eq(splitStatements("select 'a;b'; -- x; y\nselect \"c;\" /* ; */ ; ").length, 2, 'split ignores ; in strings/comments');
eq(splitStatements('select 1;;  ; select 2').length, 2, 'split drops empty statements');
const m = await lite({ path: ':memory:' });
await m.query("create table z(v); insert into z values (1); insert into z values (2);");
eq((await m.query('select count(*) as n from z')).rows, [[2]], 'sqlite runs every statement');
eq((await m.query('insert into z values (3); select v from z order by v')).rows, [[1],[2],[3]], 'last statement result returned');
console.log('ALL PASS 2');

// ================= MySQL =================
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const mp = { host: '127.0.0.1', port: 33061, database: 'testdb' };
const failsWithMy = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const sleepMy = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- logins ----
const myFirst = await my({ ...mp, user: 'tester', password: 'secret' });
await myFirst.query('flush privileges');  // empties the server's auth cache, so the next caching_sha2 login must do the full RSA exchange
const myFull = await my({ ...mp, user: 'tester', password: 'secret' });
eq(myFull.via, 'caching_sha2_password (full, RSA)', 'MySQL: caching_sha2_password full login (RSA public key over plaintext)');
eq((await myFull.query('select current_user() as u')).rows, [['tester@%']], 'MySQL: ...and it is really logged in');
const myCached = await my({ ...mp, user: 'tester', password: 'secret' });
eq(myCached.via, 'caching_sha2_password (cached)', 'MySQL: caching_sha2_password cached (fast) login');
const myNative = await my({ ...mp, user: 'native', password: 'secret' });
eq([myNative.via, (await myNative.query('select current_user() as u')).rows], ['mysql_native_password', [['native@%']]], 'MySQL: mysql_native_password login');
const myNopass = await my({ ...mp, user: 'nopass', password: '' });
eq((await myNopass.query('select current_user() as u')).rows, [['nopass@%']], 'MySQL: an account with an empty password');
for (const c of [myFull, myCached, myNative, myNopass]) await c.close();

let myBad = await failsWithMy(() => my({ ...mp, user: 'tester', password: 'wrong' }));
eq([myBad && myBad.code, /Access denied/.test(myBad ? myBad.message : '')], [1045, true], 'MySQL: a wrong password is refused (error 1045, "Access denied")');
myBad = await failsWithMy(() => my({ ...mp, user: 'native', password: 'wrong' }));
eq(myBad && myBad.code, 1045, 'MySQL: ...also with the native login');
myBad = await failsWithMy(() => my({ ...mp, user: 'nobody', password: 'x' }));
eq(myBad && myBad.code, 1045, 'MySQL: an unknown user is refused');
myBad = await failsWithMy(() => my({ ...mp, database: 'no_such_db', user: 'tester', password: 'secret' }));
eq([myBad && myBad.code, /Unknown database/.test(myBad ? myBad.message : '')], [1049, true], 'MySQL: an unknown database is reported (1049)');
myBad = await failsWithMy(() => my({ host: '127.0.0.1', port: 1, user: 'tester', password: 'secret' }));
ok(myBad && /refused|ECONNREFUSED/i.test(myBad.message), 'MySQL: a closed port fails fast: ' + (myBad && myBad.message));
const myT0 = Date.now();
myBad = await failsWithMy(() => my({ host: '127.0.0.1', port: 54329, user: 'tester', password: 'secret', greetingTimeoutMs: 700 }));
ok(myBad && /did not greet us/.test(myBad.message) && Date.now() - myT0 < 4000, 'MySQL: a port that accepts but never speaks MySQL (Postgres) times out with a clear message: ' + (myBad && myBad.message));

// ---- queries ----
const myConn = await my({ ...mp, user: 'tester', password: 'secret' });
const myPeople = await myConn.query('select * from people order by id');
eq(myPeople.columns, ['id', 'name', 'note', 'born', 'score', 'flag', 'meta', 'raw'], 'MySQL: column names');
eq(myPeople.types, ['int', 'varchar', 'text', 'date', 'decimal', 'tinyint', 'json', 'blob'], 'MySQL: column types by name (json is "json", so the JSON panel applies)');
eq(myPeople.rows[0], ['1', 'ada', 'x', '1815-12-10', '12.50', '1', '{"a": [1, 2]}', '0x00ff10'], 'MySQL: values as text (decimal exact, date, JSON, binary as hex)');
eq(myPeople.rows[1], ['2', 'bob', null, null, null, '0', null, null], 'MySQL: NULLs are null');
eq((await myConn.query("select 'héllo ✓ 日本' as s, '' as e, null as n")).rows, [['héllo ✓ 日本', '', null]], 'MySQL: unicode, empty string and NULL stay distinct');
const bigv = (await myConn.query("select repeat('a', 1000000) as big")).rows[0][0];
eq(bigv.length, 1000000, 'MySQL: a 1 MB value comes through whole');
await myConn.query("create temporary table bt(b binary(2), vb varbinary(5), c char(3), t text); insert into bt values (x'0102', x'ff', 'ab', 'z')");
const myBt = await myConn.query('select * from bt');
eq([myBt.types, myBt.rows[0]], [['binary', 'varbinary', 'char', 'text'], ['0x0102', '0xff', 'ab', 'z']], 'MySQL: BINARY, VARBINARY, CHAR and TEXT columns: types, and binary values as hex');
eq((await myConn.query('select 1 as a, 2.5 as b, 1e3 as c, now() as d')).types.slice(0, 3), ['bigint', 'decimal', 'double'], 'MySQL: numeric literal types (an integer literal is a bigint in MySQL 8)');
let myErr = await failsWithMy(() => myConn.query('select * from nope'));
eq([myErr && myErr.code, /doesn't exist/.test(myErr ? myErr.message : '')], [1146, true], 'MySQL: an error carries its code and message');
eq((await myConn.query('select 7 as n')).rows, [['7']], 'MySQL: usable after an error');
eq((await myConn.query('select 1 as a; select 2 as b, 3 as c')).columns, ['b', 'c'], 'MySQL: a script returns its last result set');
eq((await myConn.query('create temporary table tmpx(i int); insert into tmpx values (1),(2),(3); select count(*) as n from tmpx')).rows, [['3']], 'MySQL: a script with DDL, DML and a query');
eq((await myConn.query('insert into tmpx values (4)')).tag, '1 row affected', 'MySQL: a statement with no rows reports what it did');
eq((await myConn.query('update tmpx set i = i + 10 where i < 3')).tag, '2 rows affected', 'MySQL: ...with a plural count');
myErr = await failsWithMy(() => myConn.query('select 1 as one; select * from nope; select 3 as three'));
eq(myErr && myErr.code, 1146, 'MySQL: a script stops at its first error');
eq((await myConn.query('select 8 as n')).rows, [['8']], 'MySQL: ...and the connection stays in step');
const myCap = await myConn.query('set session cte_max_recursion_depth = 5000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 1500) select n from c');
eq([myCap.rows.length, myCap.truncated], [1000, true], 'MySQL: results are capped at 1000 rows and say so');
eq((await myConn.query('select 9 as n')).rows, [['9']], 'MySQL: ...the rest of a capped result is read away, so the connection stays in step');

// ---- schema ----
const myTables = await myConn.tables();
eq(myTables.map((t) => `${t.name}:${t.type}`), ['people:table', 'v:view'], 'MySQL: tables and views of the connection\'s database');
eq([myTables[0].ref, myTables[0].columns], ['`testdb`.`people`', ['id', 'name', 'note', 'born', 'score', 'flag', 'meta', 'raw']], 'MySQL: backtick-quoted refs and columns in order');
eq((await myConn.select(myTables[0].ref, 1, 1)).rows[0][1], 'bob', 'MySQL: select with limit and offset');
await myConn.query('create table if not exists `we``ird`(k int)');
const myWeird = (await myConn.tables()).find((t) => t.name === 'we`ird');
eq([myWeird && myWeird.ref, (await myConn.select(myWeird.ref, 5, 0)).rows], ['`testdb`.`we``ird`', []], 'MySQL: a backtick in a table name is escaped and usable');
await myConn.query('drop table `we``ird`');
const myNoDb = await my({ host: '127.0.0.1', port: 33061, user: 'tester', password: 'secret' });
eq((await myNoDb.tables()).map((t) => t.name), ['otherdb.elsewhere', 'testdb.people', 'testdb.v'], 'MySQL: with no default database every user schema is listed, qualified');
await myNoDb.close();

// ---- stopping a statement ----
const myHeavy = 'select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c';
eq(await myConn.cancel(), false, 'MySQL: cancel with nothing running does nothing');
let myStopErr = null;
const slowMy = myConn.query(myHeavy).catch((x) => { myStopErr = x; });
await sleepMy(400);
const myTc = Date.now();
eq(await myConn.cancel(), true, 'MySQL: cancel while a statement runs sends KILL QUERY');
await slowMy;
ok(Date.now() - myTc < 5000, 'MySQL: the long statement stops within 5s');
eq([myStopErr && myStopErr.code, myStopErr && myStopErr.cancelled], [1317, true], 'MySQL: it fails with 1317 "interrupted", flagged cancelled');
eq((await myConn.query('select 10 as n')).rows, [['10']], 'MySQL: the same connection is usable after a cancel');
eq(await myConn.cancel(), false, 'MySQL: nothing running again');

// ---- the streaming mySink (used by CSV export) ----
const mySeen = { cols: [], batches: 0, rows: 0, last: null };
const mySink = { async columns(names, types) { mySeen.cols.push([names, types]); mySeen.rows = 0; }, async rows(b) { mySeen.batches++; mySeen.rows += b.length; mySeen.last = b[b.length - 1]; } };
await myConn.stream('set session cte_max_recursion_depth = 10000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 5000) select n, concat("row ", n) as label from c', mySink);
eq([mySeen.cols.length, mySeen.cols[0][0], mySeen.rows, mySeen.last], [1, ['n', 'label'], 5000, ['5000', 'row 5000']], 'MySQL: streaming delivers all 5000 rows (no 1000 cap), in batches');
ok(mySeen.batches > 1, 'MySQL: ...as several batches');
mySeen.cols = [];
await myConn.stream('select 1 as a; select 2 as b, 3 as c', mySink);
eq([mySeen.cols.map((c) => c[0].join()), mySeen.rows, mySeen.last], [['a', 'b,c'], 1, ['2', '3']], 'MySQL: each result set opens afresh, the last one wins');
const myBroken = { async columns() {}, async rows() { throw new Error('disk full'); } };
const myTb = Date.now();
myErr = await failsWithMy(() => myConn.stream('set session cte_max_recursion_depth = 300000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 200000) select n from c', myBroken));
eq(myErr && myErr.message, 'disk full', 'MySQL: a failing sink\'s error is the one reported');
eq((await myConn.query('select 11 as n')).rows, [['11']], 'MySQL: ...and the connection is still in step (the rest of the result was drained)');
ok(Date.now() - myTb < 20000, 'MySQL: ...without waiting for 200,000 rows to arrive');
myErr = await failsWithMy(() => myConn.stream('set session cte_max_recursion_depth = 10000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 5000) select if(n = 2000, (select 1 union select 2), n) as v from c', { async columns() {}, async rows() {} }));
ok(myErr && /more than 1 row/.test(myErr.message), 'MySQL: an SQL error partway through a stream is reported: ' + (myErr && myErr.message));
eq((await myConn.query('select 12 as n')).rows, [['12']], 'MySQL: ...and the connection is usable afterwards');
await myConn.close();
await myFirst.close();
console.log('ALL PASS 3 (MySQL)');
