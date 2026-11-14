// Kirim webhook bertanda tangan HMAC saat pembayaran terkonfirmasi.

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sendWebhook(db, env, payment) {
  if (!env.WEBHOOK_URL) return false;
  const body = JSON.stringify({
    event: 'payment.paid',
    ref: payment.ref,
    external_ref: payment.external_ref,
    customer: payment.customer,
    amount_base: payment.amount_base,
    unique_code: payment.unique_code,
    amount_total: payment.amount_total,
    paid_at: payment.paid_at,
    paid_via: payment.paid_via,
  });
  const headers = { 'content-type': 'application/json' };
  if (env.WEBHOOK_SECRET) headers['x-signature'] = await hmacHex(env.WEBHOOK_SECRET, body);

  let ok = false;
  try {
    const res = await fetch(env.WEBHOOK_URL, { method: 'POST', headers, body });
    ok = res.ok;
  } catch {
    ok = false;
  }
  await db
    .prepare(
      `UPDATE payments SET webhook_attempts = webhook_attempts + 1,
       webhook_sent_at = CASE WHEN ? THEN strftime('%s','now') ELSE webhook_sent_at END
       WHERE id = ?`
    )
    .bind(ok ? 1 : 0, payment.id)
    .run();
  return ok;
}

/** Dipanggil cron: ulangi webhook yang gagal (maks 10 percobaan). */
export async function retryWebhooks(db, env) {
  if (!env.WEBHOOK_URL) return;
  const { results } = await db
    .prepare(
      `SELECT * FROM payments WHERE status='paid' AND webhook_sent_at IS NULL AND webhook_attempts < 10 LIMIT 20`
    )
    .all();
  for (const p of results) await sendWebhook(db, env, p);
}
