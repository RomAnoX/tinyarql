// Needs: Postgres as in test/drivers.js, plus an sshd on 127.0.0.1:22222 accepting the key in SSH_TEST_KEY.
// Run: SSH_TEST_KEY=/path/to/key ~/.tinyjs/bin/tjs run test/tunnel.js   (PATH may front-load an `ssh` wrapper)
import { api, init } from '../src/main.js';
import { openTunnel } from '../src/tunnel.js';
const mem = new Map();
init({ store: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => (mem.set(k, v), true) },
       secrets: { get: async (k) => mem.get('s:' + k) ?? null, set: async (k, v) => (mem.set('s:' + k, v), true), delete: async (k) => mem.delete('s:' + k) } });
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const failsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = tjs.env.SSH_TEST_KEY;
const base = { name: 'pg', type: 'postgres', host: '127.0.0.1', port: 54329, user: 'tester', database: 'postgres' };
const viaSsh = { ...base, sshHost: '127.0.0.1', sshPort: 22222, sshKey: key };

// 1. full path through the backend api
const c = await api.saveConnection({ conn: viaSsh, password: 'secret' });
await api.connect({ id: c.id });
ok((await api.query({ id: c.id, sql: 'select 41 + 1 as n' })).rows[0][0] === '42', 'query through ssh tunnel');
// cancel must work through the tunnel too: the cancel request is a second connection to the same forwarded port
const slowQ = api.query({ id: c.id, sql: 'select pg_sleep(30)' });
await sleep(400);
ok((await api.cancelQuery({ id: c.id })).cancelled === true, 'cancelQuery goes through the tunnel');
const stoppedQ = await slowQ;
ok(stoppedQ.cancelled === true && stoppedQ.ms < 4000, 'a query stopped through the tunnel resolves as cancelled');
ok((await api.query({ id: c.id, sql: 'select 1 as n' })).rows[0][0] === '1', 'tunnel session works after a stop');
await api.disconnect({ id: c.id });

// MySQL through the same tunnel (needs MySQL on 127.0.0.1:33061 too). Stopping a statement logs in a second time, so that
// second login has to go through the forwarded port as well.
const myBase = { name: 'my', type: 'mysql', host: '127.0.0.1', port: 33061, user: 'tester', database: 'testdb', sshHost: '127.0.0.1', sshPort: 22222, sshKey: key };
const myc = await api.saveConnection({ conn: myBase, password: 'secret' });
await api.connect({ id: myc.id });
ok((await api.query({ id: myc.id, sql: "select current_user() as u, 'via tunnel' as how" })).rows[0].join() === 'tester@%,via tunnel', 'MySQL: query through the ssh tunnel');
const slowMyQ = api.query({ id: myc.id, sql: 'select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c' });
await sleep(500);
ok((await api.cancelQuery({ id: myc.id })).cancelled === true, 'MySQL: cancelQuery goes through the tunnel (a second login on the forwarded port)');
const stoppedMyQ = await slowMyQ;
ok(stoppedMyQ.cancelled === true && stoppedMyQ.ms < 6000, 'MySQL: a statement stopped through the tunnel resolves as cancelled');
ok((await api.query({ id: myc.id, sql: 'select 1 as n' })).rows[0][0] === '1', 'MySQL: the tunnel session works after a stop');
await api.disconnect({ id: myc.id });
ok(await failsWith(() => api.testConnection({ conn: { ...myBase, port: 33999 }, password: 'secret' }), /./), 'MySQL: a wrong remote port fails through the tunnel');
await api.deleteConnection({ id: myc.id });

// 2. forwarded target is really used: remote-side port with no database behind it must fail
let failed = false;
try { await api.testConnection({ conn: { ...viaSsh, port: 54330 }, password: 'secret' }); } catch { failed = true; }
ok(failed, 'wrong remote db port fails through the tunnel');

// 3. closing the tunnel frees the local port
const t = await openTunnel({ sshHost: '127.0.0.1', sshPort: 22222, keyPath: key, host: '127.0.0.1', port: 54329 });
(await tjs.connect('tcp', '127.0.0.1', t.port)).close();
t.close();
let refused = false;
for (let i = 0; i < 30 && !refused; i++) { await sleep(100); try { (await tjs.connect('tcp', '127.0.0.1', t.port)).close(); } catch { refused = true; } }
ok(refused, 'local port closed after tunnel.close()');

// 4. failures are reported, not hung
try { await openTunnel({ sshHost: '127.0.0.1', sshPort: 22221, keyPath: key, host: '127.0.0.1', port: 54329 }); ok(false, 'bad ssh port'); }
catch (e) { ok(/SSH tunnel failed/.test(e.message), 'unreachable ssh server -> clear error: ' + e.message.split('\n')[0]); }
try { await openTunnel({ sshHost: '127.0.0.1', sshPort: 22222, keyPath: '/nonexistent', host: '127.0.0.1', port: 54329 }); ok(false, 'bad key'); }
catch (e) { ok(/SSH tunnel failed/.test(e.message), 'unusable key -> clear error: ' + e.message.split('\n')[0]); }

// 5. option injection is rejected before ssh is ever spawned
for (const bad of [{ sshHost: '-oProxyCommand=touch /tmp/pwned' }, { sshHost: '127.0.0.1', sshUser: '-oFoo=bar' }, { sshHost: 'a b' }]) {
  try { await openTunnel({ sshPort: 22, host: '127.0.0.1', port: 5432, ...bad }); ok(false, 'injection ' + JSON.stringify(bad)); }
  catch (e) { ok(/invalid/.test(e.message), 'rejects ' + JSON.stringify(bad)); }
}
console.log('ALL PASS');
tjs.exit(0);  // init() starts the window-state poll timer, which would keep the process alive
