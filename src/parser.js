// Parser murni (tanpa dependensi) untuk email notifikasi bank / dompet digital.

const INCOMING_RE =
  /(transfer\s+masuk|dana\s+masuk|uang\s+masuk|kredit|credit|penerimaan|pembayaran\s+diterima|telah\s+diterima|received|incoming|saldo\s+bertambah|\bCR\b)/i;
const OUTGOING_RE =
  /(transfer\s+keluar|debit|berhasil\s+mengirim|tarik\s+tunai|pembayaran\s+berhasil\s+ke|outgoing|\bDB\b)/i;
const SKIP_BEFORE_RE = /(saldo|balance|biaya|fee|admin|limit|sisa)[^0-9]{0,15}$/i;

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Ubah string angka gaya Indonesia/Inggris menjadi integer rupiah.
 * "100.345" -> 100345 | "100.345,00" -> 100345 | "100,345.00" -> 100345
 * Mengembalikan null bila ada sen non-nol atau format tak dikenal.
 */
export function parseRupiah(raw) {
  let s = String(raw).trim().replace(/[.,]+$/, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s;
  let dec = '';

  if (lastDot !== -1 && lastComma !== -1) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const idx = s.lastIndexOf(decSep);
    intPart = s.slice(0, idx);
    dec = s.slice(idx + 1);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    const isThousands = parts.slice(1).every((p) => p.length === 3);
    if (!isThousands) {
      if (parts.length !== 2) return null;
      intPart = parts[0];
      dec = parts[1];
    }
  }
  if (dec && /[1-9]/.test(dec)) return null; // sen non-nol: bukan nominal kode unik
  const digits = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Ambil semua nominal "Rp ..." / "IDR ..." dari teks, buang yang konteksnya saldo/biaya. */
export function extractAmounts(text) {
  const out = [];
  const re = /(?:Rp\.?|IDR)\s*([0-9][0-9.,]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 25), m.index);
    if (SKIP_BEFORE_RE.test(before)) continue;
    const n = parseRupiah(m[1]);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

export function isIncoming(text, incomingRe = INCOMING_RE) {
  const inc = incomingRe.test(text);
  const out = OUTGOING_RE.test(text);
  return inc && !(out && !inc);
}

export function senderAllowed(from, allowedCsv) {
  const list = String(allowedCsv || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false; // fail-closed
  const f = String(from || '').toLowerCase();
  return list.some((a) => f.includes(a));
}

/**
 * Saring satu email. Kembalikan { relevant, amounts }.
 * relevant=false bila pengirim tak dipercaya, bukan uang masuk, atau tak ada nominal.
 */
export function parseNotification({ from, subject, text, html }, env = {}) {
  if (!senderAllowed(from, env.ALLOWED_SENDERS)) {
    return { relevant: false, reason: 'sender-not-allowed', amounts: [] };
  }
  const body = text && text.trim() ? text : htmlToText(html);
  const haystack = `${subject || ''}\n${body}`;
  if (!isIncoming(haystack)) {
    return { relevant: false, reason: 'not-incoming', amounts: [], body };
  }
  const amounts = extractAmounts(haystack);
  if (amounts.length === 0) {
    return { relevant: false, reason: 'no-amount', amounts: [], body };
  }
  return { relevant: true, amounts, body };
}
