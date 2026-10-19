// TLS for the database drivers. txiki.js has TLSSocket, but it can only start TLS on a fresh connection, and Postgres and
// MySQL both begin in plaintext and then switch (SSLRequest). So the driver does its plaintext preamble on a TCP socket,
// and `startTls` hands that socket to a TLSSocket through a loopback relay: a local listener whose one client is the
// TLSSocket, with a byte pump to the real connection. The relay carries only ciphertext; certificates are checked by the
// TLSSocket itself (chain, and the name in `sni`). TLSSocket cannot skip the check; see pinCertificate for the workaround.
const dec = new TextDecoder();

// The relay: a one-shot listener on 127.0.0.1 whose single client is joined by a byte pump to the open connection.
// Returns the port to dial and `stop()`, which closes everything.
async function relay({ reader, writer, close }) {
  const server = new TCPServerSocket('127.0.0.1', { localPort: 0 });
  const { localPort, readable: incoming } = await server.opened;
  let local;
  const stop = () => { try { server.close(); } catch {} try { local?.close(); } catch {} try { close(); } catch {} };
  (async () => {
    try {
      const { value: accepted } = await incoming.getReader().read();
      server.close();  // exactly one client, ever
      local = accepted;
      const { readable: lr, writable: lw } = await accepted.opened;
      const pump = async (r, w) => {
        try { for (;;) { const { value, done: end } = await r.read(); if (end) break; await w.write(value); } } catch {}
        stop();
      };
      pump(lr.getReader(), writer);
      pump(reader, lw.getWriter());
    } catch { stop(); }
  })();
  return { port: localPort, stop };
}

// reader/writer/close: the open TCP connection (after the preamble). Returns { readable, writable, close } carrying cleartext.
// opts: { sni: the host name the certificate must match, ca: PEM text of the trusted CA (omitted = the system roots),
//         insecure: don't verify; see pinCertificate }
// preamble: opens and returns another connection already past the plaintext preamble; only used when `insecure`.
export async function startTls(conn, opts, preamble) {
  let { sni, ca } = opts;
  if (opts.insecure) ({ ca, sni } = await pinCertificate(await preamble()));
  const { port, stop } = await relay(conn);
  try {
    const options = { sni };
    if (ca) options.ca = ca;
    const tls = new TLSSocket('127.0.0.1', port, options);
    const { readable, writable } = await tls.opened;
    return { readable, writable, close: () => { try { tls.close(); } catch {} stop(); } };  // closing tears down the relay and the TCP connection too
  } catch (e) {
    stop();
    throw tlsError(e);
  }
}

// "Don't verify the certificate". TLSSocket cannot skip verification, so instead we read the certificate the server
// presents (system `openssl s_client`, dialled through a relay over a connection that already did the plaintext preamble)
// and then trust exactly that, under the name it carries. This accepts any server, so it protects against passive
// eavesdropping only, not against someone impersonating the server. ponytail: TLSSocket still checks the validity dates
// and needs a trust anchor, so it works for self-signed certificates (or chains that include their root), not for an
// expired one or a CA-signed leaf whose root the server does not send. Upgrade path: libssl through tjs:ffi.
export async function pinCertificate(conn) {
  const { port, stop } = await relay(conn);
  try {
    const out = await run(['openssl', 's_client', '-connect', `127.0.0.1:${port}`, '-showcerts'], null);
    const certs = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certs) throw new Error('Could not read the server\'s certificate (is it speaking TLS?)');
    const text = await run(['openssl', 'x509', '-noout', '-text'], certs[0] + '\n');  // openssl wants the final newline
    const name = /DNS:([^,\s]+)/.exec(text)?.[1] || /IP Address:([^,\s]+)/.exec(text)?.[1] || /CN\s*=\s*([^,\n/]+)/.exec(text)?.[1]?.trim();
    if (!name) throw new Error('The server\'s certificate has no name in it');
    return { ca: certs.join('\n'), sni: name };
  } finally { stop(); }
}

// Runs a command, optionally feeding it `input`, and returns its stdout (10 s limit).
async function run(argv, input) {
  let p;
  try { p = tjs.spawn(argv, { stdin: input == null ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' }); }
  catch (e) { throw new Error('"Don\'t verify certificate" needs the openssl command, which could not be started: ' + (e.message || e)); }
  const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 10000);
  try {
    // not awaited: on this runtime a write to a child's stdin pipe never settles, though the data does arrive
    if (input != null) { const w = p.stdin.getWriter(); w.write(new TextEncoder().encode(input)).catch(() => {}); w.close().catch(() => {}); }
    const r = p.stdout.getReader();
    let text = '';
    for (;;) { const { value, done } = await r.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    try { p.kill('SIGKILL'); } catch {}  // stdout closing means it is done; its exit status is of no interest
    return text;
  } finally { clearTimeout(timer); }
}

// mbedTLS says "X509 - Certificate verification failed, e.g. CRL, CA or signature check failed"; say what to do about it.
export const tlsError = (e) => {
  const m = String(e && e.message || e);
  if (/X509|certificate verif/i.test(m)) return new Error('The server\'s certificate could not be verified. If it is signed by your own or a private CA (or self-signed), choose that CA\'s certificate file in the connection settings. (' + m + ')');
  return e instanceof Error ? e : new Error(m);
};

export const readCa = async (path) => {
  if (!path) return undefined;
  let text;
  try { text = dec.decode(await tjs.readFile(path)); } catch (e) { throw new Error('Could not read the CA certificate file: ' + (e.message || e)); }
  if (!/-----BEGIN CERTIFICATE-----/.test(text)) throw new Error('That file is not a PEM certificate (it should contain "BEGIN CERTIFICATE")');
  return text;
};
