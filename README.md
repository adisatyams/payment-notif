# payment-notif

Konfirmasi pembayaran otomatis dari email notifikasi bank, memakai **kode unik** pada nominal.
Berjalan penuh di Cloudflare (Workers + D1 + Email Routing + Cron). Terpisah dari ERP.

## Cara kerja

1. Aplikasi lain (ERP, n8n, bot WhatsApp) memanggil `POST /api/payments` dengan `amount: 100000`.
2. Worker membuat tagihan dengan kode unik, mis. **Rp 100.345** (`100000 + 345`), dan menyimpannya di D1.
   Kode unik dijamin berbeda untuk setiap tagihan yang masih pending (partial unique index).
3. Pelanggan transfer **persis** Rp 100.345.
4. Email notifikasi bank masuk lewat salah satu jalur:
   - **Email Routing -> Email Worker** (disarankan, real-time, tanpa IMAP), atau
   - **IMAP polling** tiap 2 menit via cron (`cloudflare:sockets`, mis. Gmail + app password).
5. Email disaring: pengirim harus ada di allowlist, harus berupa uang masuk, nominal diambil
   (saldo dan biaya admin diabaikan).
6. Nominal dicocokkan dengan tagihan pending -> status `paid`, lalu webhook bertanda tangan HMAC dikirim.
   Email yang tak cocok disimpan sebagai `unmatched` untuk ditinjau.

Keamanan: allowlist pengirim bersifat fail-closed, Message-ID di-dedupe (satu email hanya melunasi sekali),
update status bersyarat `WHERE status='pending'`, API memakai Bearer token.

> Catatan: header `From` email bisa dipalsukan. Untuk produksi, andalkan jalur Email Routing
> (cek SPF/DKIM/DMARC di Cloudflare) dan/atau filter di sisi Gmail. Kode unik bukan pengganti verifikasi
> mutasi untuk nominal besar.

## Setup

```bash
npm install
npx wrangler d1 create payment_notif        # salin database_id ke wrangler.toml
npm run db:init                             # terapkan schema.sql
npx wrangler secret put API_KEY
npx wrangler secret put WEBHOOK_SECRET      # opsional
npx wrangler secret put IMAP_USER           # jika pakai IMAP
npx wrangler secret put IMAP_PASS           # app password
npm run deploy
```

Atur `ALLOWED_SENDERS` (domain pengirim bank), `WEBHOOK_URL`, dll di `wrangler.toml`.

**Jalur Email Routing:** Cloudflare Dashboard -> Email -> Email Routing -> Routing rules ->
buat alamat (mis. `bayar@domainanda.com`) dengan action *Send to a Worker* -> `payment-notif`.
Lalu forward notifikasi bank ke alamat itu.

**Jalur IMAP:** isi `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`. Run pertama hanya menetapkan posisi
awal (email lama tidak diproses). Untuk Gmail aktifkan IMAP dan buat App Password.

## API (header `Authorization: Bearer <API_KEY>`)

| Method | Path | Fungsi |
|---|---|---|
| POST | `/api/payments` | `{amount, customer?, external_ref?}` -> tagihan + nominal unik |
| GET | `/api/payments?status=&external_ref=` | daftar tagihan |
| GET | `/api/payments/:ref` | status satu tagihan (polling dari ERP) |
| POST | `/api/payments/:ref/cancel` | batalkan |
| POST | `/api/payments/:ref/confirm` | lunasi manual |
| GET | `/api/notifs?status=unmatched` | email yang belum cocok |

Contoh:

```bash
curl -X POST https://payment-notif.<akun>.workers.dev/api/payments \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"amount":100000,"customer":"Budi","external_ref":"INV-001"}'
# -> {"ref":"PAY-7K2QXA","amount_total":100345,"amount_display":"Rp 100.345","status":"pending",...}
```

Webhook `payment.paid` berisi `ref`, `external_ref`, `amount_total`, `paid_at`; tanda tangan di header
`x-signature` (HMAC-SHA256 hex dari body memakai `WEBHOOK_SECRET`).

## Pengembangan

```bash
npm test     # 14 tes (parser, kode unik, matcher) memakai node:sqlite
npm run dev
```

## Batasan saat ini

- Parser memakai pola umum (kata "transfer masuk", "Rp ..."); sesuaikan dengan format email bank Anda
  setelah melihat contoh nyata di `/api/notifs?status=ignored`.
- Klien IMAP minimal (LOGIN, tanpa OAuth, mailbox tunggal). Belum diuji terhadap server IMAP sungguhan.
- Satu nominal total hanya bisa dipakai satu tagihan pending; maksimal 999 tagihan pending per nominal dasar.
