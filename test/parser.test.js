import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRupiah, extractAmounts, parseNotification, htmlToText } from '../src/parser.js';

test('parseRupiah: format Indonesia & Inggris', () => {
  assert.equal(parseRupiah('100.345'), 100345);
  assert.equal(parseRupiah('100.345,00'), 100345);
  assert.equal(parseRupiah('100,345.00'), 100345);
  assert.equal(parseRupiah('1.250.000'), 1250000);
  assert.equal(parseRupiah('100345'), 100345);
  assert.equal(parseRupiah('100.345,50'), null); // sen non-nol
  assert.equal(parseRupiah('abc'), null);
});

test('extractAmounts: abaikan saldo & biaya', () => {
  const t = 'Transfer masuk Rp 100.345 berhasil. Saldo Rp 5.000.000. Biaya admin Rp 2.500';
  assert.deepEqual(extractAmounts(t), [100345]);
});

const env = { ALLOWED_SENDERS: 'bca.co.id,jago.com' };

test('parseNotification: uang masuk dari pengirim dipercaya', () => {
  const r = parseNotification(
    { from: 'noreply@bca.co.id', subject: 'Notifikasi Transfer Masuk', text: 'Dana masuk sebesar Rp100.345,00 dari BUDI' },
    env
  );
  assert.equal(r.relevant, true);
  assert.deepEqual(r.amounts, [100345]);
});

test('parseNotification: tolak pengirim palsu', () => {
  const r = parseNotification(
    { from: 'penipu@evil.com', subject: 'Transfer masuk', text: 'Dana masuk Rp 100.345' }, env
  );
  assert.equal(r.relevant, false);
  assert.equal(r.reason, 'sender-not-allowed');
});

test('parseNotification: tolak transfer keluar', () => {
  const r = parseNotification(
    { from: 'a@jago.com', subject: 'Transfer keluar', text: 'Anda berhasil mengirim Rp 100.345' }, env
  );
  assert.equal(r.relevant, false);
});

test('parseNotification: allowlist kosong = tolak semua (fail-closed)', () => {
  const r = parseNotification({ from: 'a@bca.co.id', subject: 'Transfer masuk', text: 'Rp 100.345' }, {});
  assert.equal(r.relevant, false);
});

test('htmlToText', () => {
  assert.match(htmlToText('<p>Dana masuk&nbsp;<b>Rp 100.345</b></p>'), /Dana masuk\s+Rp 100\.345/);
});
