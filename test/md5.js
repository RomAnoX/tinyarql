// MD5 against the RFC 1321 test suite, plus lengths around the padding boundaries checked against the system md5. Run: ~/.tinyjs/bin/tjs run test/md5.js
import { md5hex } from '../src/md5.js';
const enc = new TextEncoder();
const rfc = { '': 'd41d8cd98f00b204e9800998ecf8427e', a: '0cc175b9c0f1b6a831c399e269772661', abc: '900150983cd24fb0d6963f7d28e17f72',
  'message digest': 'f96b697d7cb7938d525a2f31aaf161d0', abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789': 'd174ab98d277d9f5a5611c2c9f419d9f',
  '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a' };
for (const [i, h] of Object.entries(rfc)) if (md5hex(enc.encode(i)) !== h) throw new Error('FAIL md5 ' + JSON.stringify(i));
console.log('ok RFC 1321 vectors');
// padding boundaries (55, 56, 63, 64, 65 bytes and longer) against /sbin/md5, which ships with macOS
for (const len of [55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
  const s = 'x'.repeat(len);
  const p = tjs.spawn(['/sbin/md5', '-s', s], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const r = p.stdout.getReader(); let t = '';
  for (;;) { const { value, done } = await r.read(); if (done) break; t += new TextDecoder().decode(value); }
  const want = t.trim();
  if (md5hex(enc.encode(s)) !== want) throw new Error('FAIL md5 length ' + len);
}
console.log('ok padding boundaries match the system md5');
console.log('ALL PASS');
tjs.exit(0);
