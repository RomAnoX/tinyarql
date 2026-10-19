// TLS for the database drivers. txiki.js has TLSSocket, but it can only start TLS on a fresh connection, and Postgres and
// MySQL both begin in plaintext and then switch (SSLRequest). So the driver does its plaintext preamble on a TCP socket,
// and `startTls` hands that socket to a TLSSocket through a loopback relay: a local listener whose one client is the
// TLSSocket, with a byte pump to the real connection. The relay carries only ciphertext; certificates are checked by the
// TLSSocket itself (chain, and the name in `sni`). There is no option to skip the check: trust a server by giving its CA.
const dec = new TextDecoder();

// reader/writer: the open TCP connection (after the preamble). Returns { readable, writable, close } carrying cleartext.
// opts: { sni: the host name the certificate must match, ca: PEM text of the trusted CA; omitted = the system roots }
export async function startTls({ reader, writer, close }, { sni, ca }) {
  const server = new TCPServerSocket('127.0.0.1', { localPort: 0 });
  const { localPort, readable: incoming } = await server.opened;
  const options = { sni };
  if (ca) options.ca = ca;
  const tls = new TLSSocket('127.0.0.1', localPort, options);
  let local;
  const done = () => { try { tls.close(); } catch {} try { local?.close(); } catch {} try { close(); } catch {} };
  try {
    const sockets = incoming.getReader();
    const { value: accepted } = await sockets.read();
    server.close();  // exactly one client, ever
    local = accepted;
    const { readable: lr, writable: lw } = await accepted.opened;
    const pump = async (r, w) => {
      try { for (;;) { const { value, done: end } = await r.read(); if (end) break; await w.write(value); } } catch {}
      done();
    };
    pump(lr.getReader(), writer);
    pump(reader, lw.getWriter());
    const { readable, writable } = await tls.opened;
    return { readable, writable, close: done };  // closing tears down the relay and the TCP connection too
  } catch (e) {
    done();
    throw tlsError(e);
  }
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
