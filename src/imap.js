// Klien IMAP minimal di atas cloudflare:sockets (TLS langsung, port 993).
// Hanya fitur yang dibutuhkan: LOGIN, SELECT, UID SEARCH, UID FETCH, LOGOUT.

import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder('latin1'); // header IMAP ASCII; badan pesan dikembalikan sebagai bytes

function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = new Uint8Array(0);
  }
  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('IMAP: koneksi ditutup server');
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf);
    merged.set(value, this.buf.length);
    this.buf = merged;
  }
  async readLine() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i !== -1) {
        const line = dec.decode(this.buf.subarray(0, i)).replace(/\r$/, '');
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      await this.fill();
    }
  }
  async readBytes(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async write(s) {
    await this.writer.write(enc.encode(s));
  }
  close() {
    try { this.reader.releaseLock(); this.writer.releaseLock(); this.socket.close(); } catch {}
  }
}

export class ImapClient {
  constructor({ host, port = 993 }) {
    this.host = host;
    this.port = Number(port);
    this.tagN = 0;
  }

  async open() {
    const socket = connect({ hostname: this.host, port: this.port }, { secureTransport: 'on', allowHalfOpen: false });
    this.c = new Conn(socket);
    const greeting = await this.c.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error('IMAP greeting tidak valid: ' + greeting);
  }

  /** Kirim perintah, kumpulkan respons sampai baris bertag. Literal {n} dibaca sebagai bytes. */
  async cmd(text) {
    const tag = 'A' + String(++this.tagN).padStart(3, '0');
    await this.c.write(`${tag} ${text}\r\n`);
    const untagged = []; // { line, literals: Uint8Array[] }
    for (;;) {
      let line = await this.c.readLine();
      const literals = [];
      let m;
      while ((m = line.match(/\{(\d+)\}$/))) {
        literals.push(await this.c.readBytes(Number(m[1])));
        line += await this.c.readLine(); // sisa baris setelah literal
      }
      if (line.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(line)) throw new Error('IMAP error: ' + line.replace(/(LOGIN).*/i, '$1 ***'));
        return untagged;
      }
      untagged.push({ line, literals });
    }
  }

  async login(user, pass) {
    await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
  }

  async select(mailbox) {
    const res = await this.cmd(`SELECT ${quote(mailbox)}`);
    const all = res.map((r) => r.line).join('\n');
    return {
      uidValidity: Number((all.match(/UIDVALIDITY (\d+)/i) || [])[1] || 0),
      uidNext: Number((all.match(/UIDNEXT (\d+)/i) || [])[1] || 1),
    };
  }

  async uidsFrom(uid) {
    const res = await this.cmd(`UID SEARCH UID ${uid}:*`);
    const line = res.find((r) => /^\* SEARCH/i.test(r.line));
    if (!line) return [];
    return line.line.replace(/^\* SEARCH\s*/i, '').split(/\s+/).filter(Boolean).map(Number).filter((n) => n >= uid);
  }

  /** Ambil sumber mentah satu pesan (dibatasi maksOctets) tanpa menandainya sebagai dibaca. */
  async fetchRaw(uid, maxOctets = 300000) {
    const res = await this.cmd(`UID FETCH ${uid} (BODY.PEEK[]<0.${maxOctets}>)`);
    for (const r of res) if (r.literals.length) return r.literals[0];
    return null;
  }

  async logout() {
    try { await this.cmd('LOGOUT'); } catch {}
    this.c?.close();
  }
}
