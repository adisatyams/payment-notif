-- Skema D1 untuk payment-notif

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT    NOT NULL UNIQUE,          -- contoh: PAY-7K2QXA
  external_ref  TEXT,                             -- nomor order/invoice dari sistem lain (ERP, n8n, dll)
  customer      TEXT,
  amount_base   INTEGER NOT NULL,                 -- nominal tagihan asli, mis. 100000
  unique_code   INTEGER NOT NULL,                 -- kode unik, mis. 345
  amount_total  INTEGER NOT NULL,                 -- yang harus ditransfer, mis. 100345
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','expired','cancelled')),
  created_at    INTEGER NOT NULL,                 -- epoch detik
  expires_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  notif_id      INTEGER,                          -- email yang mengonfirmasi
  paid_via      TEXT,                             -- 'email' | 'manual'
  webhook_sent_at  INTEGER,
  webhook_attempts INTEGER NOT NULL DEFAULT 0
);

-- Kunci utama kode unik: tidak boleh ada dua tagihan PENDING dengan nominal total sama.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_pending_total
  ON payments(amount_total) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_payments_status ON payments(status, expires_at);
CREATE INDEX IF NOT EXISTS ix_payments_external ON payments(external_ref);

CREATE TABLE IF NOT EXISTS notifs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT    NOT NULL UNIQUE,          -- dedupe: satu email hanya diproses sekali
  source        TEXT    NOT NULL,                 -- 'email-routing' | 'imap'
  sender        TEXT,
  subject       TEXT,
  amounts       TEXT,                             -- JSON array nominal yang terbaca
  snippet       TEXT,                             -- potongan teks (maks 500 char) untuk audit
  received_at   INTEGER NOT NULL,
  match_status  TEXT    NOT NULL                  -- matched | unmatched | ignored | duplicate
                CHECK (match_status IN ('matched','unmatched','ignored','duplicate')),
  payment_id    INTEGER REFERENCES payments(id)
);

CREATE INDEX IF NOT EXISTS ix_notifs_status ON notifs(match_status, received_at);

-- Penyimpanan kecil key/value (posisi UID terakhir IMAP, dll)
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
