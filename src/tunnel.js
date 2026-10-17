// SSH local-forward via the system `ssh` binary (txiki.js has no ssh client library).
// ponytail: key/agent auth only (BatchMode, no password or passphrase prompts); a new host key is
// trusted on first use (accept-new) and checked against ~/.ssh/known_hosts afterwards.
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (v, what) => {
  v = String(v ?? '').trim();
  if (!v || v.startsWith('-') || /\s/.test(v)) throw new Error(`invalid ${what}`);  // no option injection
  return v;
};

export async function openTunnel({ sshHost, sshPort = 22, sshUser, keyPath, host, port }) {
  const dest = (sshUser ? arg(sshUser, 'SSH user') + '@' : '') + arg(sshHost, 'SSH host');
  const target = `${arg(host, 'database host')}:${+port}`;
  if (!(+port > 0 && +port < 65536) || !(+sshPort > 0 && +sshPort < 65536)) throw new Error('invalid port');

  let lastErr = 'ssh failed to start';
  for (let attempt = 0; attempt < 5; attempt++) {
    const local = 20000 + Math.floor(Math.random() * 40000);
    // Skip a port something already listens on, or the readiness probe below would hit that instead of ssh.
    if (await tjs.connect('tcp', '127.0.0.1', local).then((c) => (c.close(), true), () => false)) continue;
    const p = tjs.spawn([
      'ssh', '-N', '-T',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=10',
      '-p', String(+sshPort), '-L', `127.0.0.1:${local}:${target}`,
      ...(keyPath ? ['-i', keyPath] : []),
      '--', dest,
    ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });

    let exited = false, err = '';
    p.wait().then(() => { exited = true; });
    const reader = p.stderr.getReader();
    (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        if (err.length < 4000) err += dec.decode(value);
      }
    })();
    const close = () => { try { p.kill('SIGTERM'); } catch {} };

    for (let i = 0; i < 150 && !exited; i++) {  // ~15s for ssh to authenticate and bind
      try {
        (await tjs.connect('tcp', '127.0.0.1', local)).close();
        return { port: local, close };
      } catch {}
      await sleep(100);
    }
    close();
    await sleep(50);
    lastErr = err.trim() || (exited ? 'ssh exited' : 'timed out waiting for the tunnel');
    if (!/address already in use|cannot listen|bind/i.test(lastErr)) break;  // only a taken local port is worth retrying
  }
  throw new Error('SSH tunnel failed: ' + lastErr);
}
