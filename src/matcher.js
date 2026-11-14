// Mencocokkan notifikasi email dengan tagihan pending di D1.

import { parseNotification } from './parser.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const GRACE_SECONDS = 15 * 60; // transfer sedikit telat dari batas expired masih diterima

/**
 * Proses satu email. Idempoten: Message-ID yang sama tidak diproses dua kali.
 * @returns {{status: string, payment?: object, amounts?: number[]}}
 */
export async function processNotification(db, env, mail, source, now = nowSec()) {
  const messageId = mail.messageId || `nomid:${source}:${mail.from}:${mail.subject}:${mail.date || now}`;

  const existing = await db.prepare(`SELECT id FROM notifs WHERE message_id = ?`).bind(messageId).first();
  if (existing) return { status: 'duplicate' };

  const parsed = parseNotification(mail, env);
  const snippet = (parsed.body || mail.text || '').replace(/\s+/g, ' ').slice(0, 500);

  if (!parsed.relevant) {
    await insertNotif(db, { messageId, source, mail, amounts: [], snippet, status: 'ignored', now });
    return { status: 'ignored', reason: parsed.reason };
  }

  // Cari tagihan pending yang nominal totalnya persis sama dengan salah satu nominal di email.
  const placeholders = parsed.amounts.map(() => '?').join(',');
  const candidate = await db
    .prepare(
      `SELECT * FROM payments
       WHERE status='pending' AND expires_at + ? > ? AND amount_total IN (${placeholders})
       ORDER BY created_at ASC LIMIT 1`
    )
    .bind(GRACE_SECONDS, now, ...parsed.amounts)
    .first();

  if (!candidate) {
    await insertNotif(db, { messageId, source, mail, amounts: parsed.amounts, snippet, status: 'unmatched', now });
    return { status: 'unmatched', amounts: parsed.amounts };
  }

  const notifId = await insertNotif(db, {
    messageId, source, mail, amounts: parsed.amounts, snippet, status: 'matched', now, paymentId: candidate.id,
  });

  // Update bersyarat: hanya jika masih pending (mencegah konfirmasi ganda).
  const upd = await db
    .prepare(
      `UPDATE payments SET status='paid', paid_at=?, notif_id=?, paid_via='email'
       WHERE id=? AND status='pending'`
    )
    .bind(now, notifId, candidate.id)
    .run();

  if ((upd.meta?.changes ?? 0) === 0) {
    await db.prepare(`UPDATE notifs SET match_status='duplicate', payment_id=NULL WHERE id=?`).bind(notifId).run();
    return { status: 'duplicate' };
  }

  const payment = await db.prepare(`SELECT * FROM payments WHERE id=?`).bind(candidate.id).first();
  return { status: 'matched', payment, amounts: parsed.amounts };
}

async function insertNotif(db, { messageId, source, mail, amounts, snippet, status, now, paymentId = null }) {
  const received = mail.date ? Math.floor(new Date(mail.date).getTime() / 1000) || now : now;
  const r = await db
    .prepare(
      `INSERT INTO notifs (message_id, source, sender, subject, amounts, snippet, received_at, match_status, payment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(messageId, source, mail.from || null, mail.subject || null, JSON.stringify(amounts), snippet, received, status, paymentId)
    .run();
  return r.meta?.last_row_id;
}
