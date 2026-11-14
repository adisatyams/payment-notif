// Operasi tagihan: buat (dengan kode unik), cari, expire, konfirmasi.

const nowSec = () => Math.floor(Date.now() / 1000);

function randomRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'PAY-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function randomInt(min, max) {
  const range = max - min + 1;
  const buf = crypto.getRandomValues(new Uint32Array(1));
  return min + (buf[0] % range);
}

export async function expireOld(db, now = nowSec()) {
  const r = await db
    .prepare(`UPDATE payments SET status='expired' WHERE status='pending' AND expires_at <= ?`)
    .bind(now)
    .run();
  return r.meta?.changes ?? 0;
}

/**
 * Buat tagihan baru. Nominal total = base + kode unik (1..UNIQUE_CODE_MAX).
 * Keunikan dijamin oleh partial unique index; bila bentrok, coba kode lain.
 */
export async function createPayment(db, env, { amount, customer = null, externalRef = null }) {
  const base = Number(amount);
  if (!Number.isInteger(base) || base <= 0) throw new HttpError(400, 'amount harus integer > 0');

  const ttlMin = Number(env.PAYMENT_TTL_MINUTES || 180);
  const maxCode = Math.min(Number(env.UNIQUE_CODE_MAX || 999), 999);
  const now = nowSec();
  await expireOld(db, now);

  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomInt(1, maxCode);
    const total = base + code;
    const ref = randomRef();
    try {
      await db
        .prepare(
          `INSERT INTO payments (ref, external_ref, customer, amount_base, unique_code, amount_total, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(ref, externalRef, customer, base, code, total, now, now + ttlMin * 60)
        .run();
      return getPayment(db, ref);
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) continue; // total atau ref bentrok -> ulangi
      throw e;
    }
  }
  throw new HttpError(409, 'Tidak ada kode unik tersedia untuk nominal ini, coba lagi sebentar lagi');
}

export async function getPayment(db, ref) {
  return db.prepare(`SELECT * FROM payments WHERE ref = ?`).bind(ref).first();
}

export async function listPayments(db, { status, externalRef, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (externalRef) { where.push('external_ref = ?'); args.push(externalRef); }
  const sql = `SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, Math.min(Number(limit) || 50, 200)).all();
  return results;
}

export async function cancelPayment(db, ref) {
  const r = await db
    .prepare(`UPDATE payments SET status='cancelled' WHERE ref = ? AND status='pending'`)
    .bind(ref)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Tandai lunas secara manual (mis. admin memverifikasi mutasi sendiri). */
export async function confirmManually(db, ref, now = nowSec()) {
  const r = await db
    .prepare(
      `UPDATE payments SET status='paid', paid_at=?, paid_via='manual'
       WHERE ref = ? AND status IN ('pending','expired')`
    )
    .bind(now, ref)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
