// TLS to Postgres and MySQL, against servers that really require it. Needs both scratch servers (test/postgres-server.sh and
// test/mysql-server.sh start them with a self-signed certificate for localhost and the accounts `tlsonly` / `tlsnative`).
// Run: ~/.tinyjs/bin/tjs run test/tls.js
import { connect as pg } from '../src/drivers/postgres.js';
import { connect as my } from '../src/drivers/mysql.js';
import { api, init } from '../src/main.js';
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); console.log('ok', m); };
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = tjs.env.TMPDIR || '/tmp';
const pgCert = `${tmp}/tinyarql-postgres/server.crt`, myCert = `${tmp}/tinyarql-mysql/server.crt`;
const ca = async (p) => new TextDecoder().decode(await tjs.readFile(p));
const fails = async (fn, re) => { try { await fn(); return 'connected'; } catch (e) { return re.test(e.message) ? true : e.message; } };
const CERT = /certificate could not be verified/;

// ---- PostgreSQL ----
const pgBase = { host: '127.0.0.1', port: 54329, user: 'tlsonly', password: 'secret', database: 'postgres' };
const myCa = await ca(myCert);
const pgTls = { sni: 'localhost', ca: await ca(pgCert) };
const p = await pg({ ...pgBase, tls: pgTls });
eq((await p.query('select ssl from pg_stat_ssl where pid = pg_backend_pid()')).rows, [['t']], 'pg: the session really is encrypted (server-side view)');
eq((await p.query('select name from people order by id')).rows, [['ada'], ['bob']], 'pg: queries work over TLS');
eq((await p.query('select generate_series(1,1500)')).truncated, true, 'pg: a result larger than one TLS record arrives whole');
let stop = null;
const slow = p.query('select pg_sleep(30)').catch((e) => { stop = e; });
await sleep(300);
const t0 = Date.now();
eq(await p.cancel(), true, 'pg: cancel works over TLS (its second connection negotiates TLS too)');
await slow;
ok(Date.now() - t0 < 3000 && stop && stop.cancelled, 'pg: the stopped statement fails as cancelled, within 3s');
eq((await p.query('select 1')).rows, [['1']], 'pg: connection usable after the cancel');
await p.close();
eq(await fails(() => pg({ ...pgBase }), /no encryption/), true, 'pg: negative control, the TLS-only user is refused without TLS');
eq(await fails(() => pg({ ...pgBase, tls: { sni: 'localhost' } }), CERT), true, 'pg: a self-signed certificate is refused when its CA is not given');
eq(await fails(() => pg({ ...pgBase, tls: { sni: 'other.example', ca: pgTls.ca } }), CERT), true, 'pg: a certificate for another host name is refused, even with its CA given');
eq(await fails(() => pg({ ...pgBase, user: 'tester', tls: { sni: 'localhost', ca: myCa } }), CERT), true, 'pg: a certificate from a different CA is refused');
const pi = await pg({ ...pgBase, tls: { sni: 'other.example', insecure: true } });
eq((await pi.query('select ssl from pg_stat_ssl where pid = pg_backend_pid()')).rows, [['t']], 'pg insecure: no CA and a wrong host name still connect, encrypted');
eq(await pi.cancel(), false, 'pg insecure: nothing running yet');
const islow = pi.query('select pg_sleep(30)').catch((e) => e);
await sleep(300); await pi.cancel();
ok((await islow).cancelled === true, 'pg insecure: cancel works (its second connection pins the certificate too)');
await pi.close();
eq(await fails(() => pg({ ...pgBase, user: 'tester', password: 'wrong', tls: { sni: 'x', insecure: true } }), /password|authentication/i), true, 'pg insecure: a bad password still fails as such');

// ---- MySQL ----
const myBase = { host: '127.0.0.1', port: 33061, password: 'secret', database: 'testdb' };
const myTls = { sni: 'localhost', ca: myCa };
for (const user of ['tlsonly', 'tlsnative']) {
  const c = await my({ ...myBase, user, tls: myTls });
  eq((await c.query("show session status like 'Ssl_version'")).rows[0][1].startsWith('TLS'), true, `mysql ${user}: the session really is encrypted (server-side view)`);
  eq((await c.query('select name from people order by id')).rows, [['ada'], ['bob']], `mysql ${user}: queries work over TLS`);
  await c.close();
}
const mc = await my({ ...myBase, user: 'tlsonly', tls: myTls });
const mslow = mc.query('select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c').catch((e) => e);
await sleep(400);
eq(await mc.cancel(), true, 'mysql: cancel works over TLS');
ok((await mslow).cancelled === true, 'mysql: the stopped statement fails as cancelled');
eq((await mc.query('select 1')).rows, [['1']], 'mysql: connection usable after the cancel');
await mc.close();
eq(await fails(() => my({ ...myBase, user: 'tlsonly' }), /Access denied/), true, 'mysql: negative control, the TLS-only user is refused without TLS');
eq(await fails(() => my({ ...myBase, user: 'tlsonly', tls: { sni: 'localhost' } }), CERT), true, 'mysql: a self-signed certificate is refused when its CA is not given');
eq(await fails(() => my({ ...myBase, user: 'tlsonly', tls: { sni: 'other.example', ca: myTls.ca } }), CERT), true, 'mysql: a certificate for another host name is refused');
const plain = await my({ ...myBase, user: 'tester', tls: myTls });
eq((await plain.query('select 2')).rows, [['2']], 'mysql: TLS also works for an account that does not require it (caching_sha2 full login inside TLS)');
await plain.close();
for (const user of ['tlsonly', 'tlsnative']) {
  const c = await my({ ...myBase, user, tls: { sni: 'other.example', insecure: true } });
  eq((await c.query("show session status like 'Ssl_version'")).rows[0][1].startsWith('TLS'), true, `mysql insecure ${user}: no CA and a wrong host name still connect, encrypted`);
  await c.close();
}
const ic = await my({ ...myBase, user: 'tlsonly', tls: { sni: 'x', insecure: true } });
const islowMy = ic.query('select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c').catch((e) => e);
await sleep(400); await ic.cancel();
ok((await islowMy).cancelled === true, 'mysql insecure: cancel works');
await ic.close();

// ---- through the backend API (the connection form's fields) ----
const mem = new Map();
init({ push() {}, store: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => (mem.set(k, v), true) },
       secrets: { get: async (k) => mem.get('s:' + k) ?? null, set: async (k, v) => (mem.set('s:' + k, v), true), delete: async (k) => mem.delete('s:' + k) } });
const conn = (x) => api.saveConnection({ conn: { name: 't', type: 'postgres', host: '127.0.0.1', port: 54329, user: 'tlsonly', database: 'postgres', ...x }, password: 'secret' });
const good = await conn({ tls: true, tlsCa: pgCert });
eq((await api.connect({ id: good.id })).map((t) => t.name), ['people', 'v'], 'api: a saved connection with tls and a CA file connects');
eq((await api.query({ id: good.id, sql: 'select ssl from pg_stat_ssl where pid = pg_backend_pid()' })).rows, [['t']], 'api: ...and is encrypted');
await api.disconnect({ id: good.id });
const hint = await fails(async () => api.connect({ id: (await conn({ tls: false })).id }), /Use TLS/);
eq(hint, true, 'api: a TLS-only server reached without TLS says to turn on "Use TLS"');
eq(await fails(async () => api.connect({ id: (await conn({ tls: true })).id }), CERT), true, 'api: tls on without the CA file explains the certificate problem');
const insecure = await conn({ tls: true, tlsInsecure: true });
await api.connect({ id: insecure.id });
eq((await api.query({ id: insecure.id, sql: 'select ssl from pg_stat_ssl where pid = pg_backend_pid()' })).rows, [['t']], 'api: tlsInsecure connects without a CA file, encrypted');
await api.disconnect({ id: insecure.id });
eq(await fails(async () => api.connect({ id: (await conn({ tls: false, tlsInsecure: true })).id }), /Use TLS/), true, 'api: tlsInsecure without tls on does nothing (the "Use TLS" hint shows)');
eq(await fails(async () => api.connect({ id: (await conn({ tls: true, tlsCa: '/nope/ca.pem' })).id }), /Could not read the CA/), true, 'api: a missing CA file is reported plainly');
eq(await fails(async () => api.connect({ id: (await conn({ tls: true, tlsCa: '/etc/hosts' })).id }), /not a PEM certificate/), true, 'api: a file that is not a certificate is reported plainly');
console.log('ALL PASS');
tjs.exit(0);
