import type { Db } from "./db";

/**
 * 既にある DB への構造変更。
 *
 * schema.ts は `CREATE TABLE IF NOT EXISTS` なので、すでに表がある DB には
 * 新しい列が入らない。**列を足したら schema.ts とここの両方に書く。**
 * DO が起きるたびに走るので、ここに置くのは何度流しても結果が変わらないものだけ。
 */

function columnNames(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * 足す列の一覧。書き方の例:
 * `{ table: "events", column: "notes", definition: "TEXT NOT NULL DEFAULT ''" }`
 *
 * 既存の表には外部キー付きの列を足せないので、参照だけの整数列にする
 * （新規作成の schema.ts 側では REFERENCES 付きにしてよい）。
 */
const COLUMN_ADDITIONS: { table: string; column: string; definition: string }[] = [];

export function addMissingColumns(db: Db): void {
  for (const addition of COLUMN_ADDITIONS) {
    const columns = columnNames(db, addition.table);
    if (columns.size > 0 && !columns.has(addition.column)) {
      db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
    }
  }
}

/** この名前の後始末をまだやっていなければ true を返し、印を残す。 */
export function claimOnce(db: Db, name: string): boolean {
  const done = db.prepare("SELECT 1 AS found FROM schema_marks WHERE name = ?").get(name);
  if (done) {
    return false;
  }
  db.prepare("INSERT INTO schema_marks (name, created_at) VALUES (?, ?)").run(
    name,
    `${new Date().toISOString().slice(0, 19)}Z`,
  );
  return true;
}
