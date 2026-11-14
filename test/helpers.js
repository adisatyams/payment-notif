// Shim D1 di atas node:sqlite supaya logika SQL bisa diuji lokal.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first() {
      return sqlite.prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
  });
  return { prepare: (sql) => wrap(sql) };
}
