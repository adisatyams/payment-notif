import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.js';
import { createPayment, expireOld, confirmManually } from '../src/payments.js';
import { processNotification } from '../src/matcher.js';

const env = { ALLOWED_SENDERS: 'bca.co.id', PAYMENT_TTL_MINUTES: '60', UNIQUE_CODE_MAX: '999' };
const mailFor = (amount, id) => ({
  messageId: id, from: 'noreply@bca.co.id', subject: 'Transfer Masuk',
  text: `Dana masuk Rp ${amount.toLocaleString('id-ID')}`,
});

test('kode unik: total = base + 1..999 dan selalu berbeda antar tagihan pending', async () => {
  const db = makeDb();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = await createPayment(db, env, { amount: 100000 });
    assert.ok(p.unique_code >= 1 && p.unique_code <= 999);
    assert.equal(p.amount_total, 100000 + p.unique_code);
    assert.ok(!seen.has(p.amount_total), 'nominal total harus unik');
    seen.add(p.amount_total);
  }
});

test('email cocok -> tagihan jadi paid, email sama diproses ulang = duplicate', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 250000, customer: 'Budi', externalRef: 'INV-1' });
  const r1 = await processNotification(db, env, mailFor(p.amount_total, '<m1@x>'), 'imap');
  assert.equal(r1.status, 'matched');
  assert.equal(r1.payment.status, 'paid');
  assert.equal(r1.payment.paid_via, 'email');

  const r2 = await processNotification(db, env, mailFor(p.amount_total, '<m1@x>'), 'imap');
  assert.equal(r2.status, 'duplicate');
});

test('nominal tanpa kode unik yang cocok -> unmatched, tagihan tetap pending', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 100000 });
  const r = await processNotification(db, env, mailFor(100000, '<m2@x>'), 'imap'); // lupa kode unik
  assert.equal(r.status, 'unmatched');
  const row = await db.prepare('SELECT status FROM payments WHERE ref=?').bind(p.ref).first();
  assert.equal(row.status, 'pending');
});

test('email transfer ganda dengan Message-ID berbeda tidak melunasi dua kali', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 100000 });
  assert.equal((await processNotification(db, env, mailFor(p.amount_total, '<a@x>'), 'imap')).status, 'matched');
  assert.equal((await processNotification(db, env, mailFor(p.amount_total, '<b@x>'), 'imap')).status, 'unmatched');
});

test('tagihan kedaluwarsa tidak dicocokkan, dan kode unik dibebaskan', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 100000 });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600; // 3 jam kemudian (> TTL 60m + grace 15m)
  const r = await processNotification(db, env, mailFor(p.amount_total, '<c@x>'), 'imap', later);
  assert.equal(r.status, 'unmatched');
  assert.equal(await expireOld(db, later), 1);
  // nominal yang sama boleh dipakai tagihan baru setelah expired
  await db.prepare(`INSERT INTO payments (ref, amount_base, unique_code, amount_total, status, created_at, expires_at)
                    VALUES ('PAY-ZZZZZZ', 100000, ?, ?, 'pending', 1, 99999999999)`)
    .bind(p.unique_code, p.amount_total).run();
});

test('pengirim tidak dipercaya -> ignored, tagihan tidak lunas', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 100000 });
  const r = await processNotification(db, env, { ...mailFor(p.amount_total, '<d@x>'), from: 'x@evil.com' }, 'imap');
  assert.equal(r.status, 'ignored');
  const row = await db.prepare('SELECT status FROM payments WHERE ref=?').bind(p.ref).first();
  assert.equal(row.status, 'pending');
});

test('konfirmasi manual', async () => {
  const db = makeDb();
  const p = await createPayment(db, env, { amount: 100000 });
  assert.equal(await confirmManually(db, p.ref), true);
  assert.equal(await confirmManually(db, p.ref), false);
});
