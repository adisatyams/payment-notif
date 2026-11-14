// Gabungan: parse MIME (postal-mime) -> pipeline pencocokan -> webhook.

import PostalMime from 'postal-mime';
import { processNotification } from './matcher.js';
import { sendWebhook } from './webhook.js';
import { ImapClient } from './imap.js';

export async function handleRawEmail(env, ctx, raw, source) {
  const parsed = await PostalMime.parse(raw);
  const mail = {
    messageId: parsed.messageId || null,
    from: parsed.from?.address || '',
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: parsed.html || '',
    date: parsed.date || null,
  };
  const result = await processNotification(env.DB, env, mail, source);
  if (result.status === 'matched') {
    const job = sendWebhook(env.DB, env, result.payment);
    ctx?.waitUntil ? ctx.waitUntil(job) : await job;
  }
  return result;
}

const MAX_PER_RUN = 20;

/** Dipanggil cron. Hanya memproses email baru (UID > posisi terakhir). */
export async function pollImap(env, ctx) {
  if (!env.IMAP_HOST || !env.IMAP_USER || !env.IMAP_PASS) return { skipped: true };

  const db = env.DB;
  const mailbox = env.IMAP_MAILBOX || 'INBOX';
  const client = new ImapClient({ host: env.IMAP_HOST, port: env.IMAP_PORT || 993 });
  const stats = { fetched: 0, matched: 0 };

  try {
    await client.open();
    await client.login(env.IMAP_USER, env.IMAP_PASS);
    const { uidValidity, uidNext } = await client.select(mailbox);

    const savedValidity = Number((await getState(db, 'imap_uidvalidity')) || 0);
    let last = Number((await getState(db, 'imap_last_uid')) || 0);

    // Run pertama / UIDVALIDITY berubah: mulai dari email baru saja, jangan banjiri dengan riwayat.
    if (!last || savedValidity !== uidValidity) {
      last = uidNext - 1;
      await setState(db, 'imap_uidvalidity', String(uidValidity));
      await setState(db, 'imap_last_uid', String(last));
      return { ...stats, baseline: last };
    }

    const uids = (await client.uidsFrom(last + 1)).slice(0, MAX_PER_RUN);
    for (const uid of uids) {
      const raw = await client.fetchRaw(uid);
      if (raw) {
        const r = await handleRawEmail(env, ctx, raw, 'imap');
        stats.fetched++;
        if (r.status === 'matched') stats.matched++;
      }
      await setState(db, 'imap_last_uid', String(uid)); // maju per pesan agar aman bila terputus
    }
  } finally {
    await client.logout();
  }
  return stats;
}

async function getState(db, k) {
  const r = await db.prepare(`SELECT v FROM state WHERE k=?`).bind(k).first();
  return r?.v;
}
async function setState(db, k, v) {
  await db.prepare(`INSERT INTO state (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(k, v).run();
}
