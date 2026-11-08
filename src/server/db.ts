import { seedDemoEvent } from "./demo";
import { addMissingColumns, claimOnce } from "./migrations";
import { getRuntime, invalidateMemo } from "./runtime";
import { SCHEMA_SQL } from "./schema";

/**
 * SQLite への唯一の入口。実体は Durable Object の `ctx.storage.sql`。
 *
 * DO の SQL は同期 API で、DO 自体が 1 本のスレッドで動くので、要求は自然に直列化される。
 * ドメイン側のコードは
 * `prepare().get / all / run` の形で書いてあるので、その形をここで包んで渡す。
 */

export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): RunResult;
}

export interface Db {
  prepare(query: string): Statement;
  /** 結果を使わない文（DDL など）。複数の文を `;` でつないで渡してよい。 */
  exec(query: string): void;
}

export function createDb(sql: SqlStorage): Db {
  return {
    prepare(query) {
      return {
        // `cursor.one()` は 0 行で例外を投げるので get の代わりにならない。
        get: (...params) => sql.exec<Row>(query, ...params).toArray()[0],
        all: (...params) => sql.exec<Row>(query, ...params).toArray(),
        run: (...params) => {
          sql.exec(query, ...params).toArray();
          // DO のカーソルには lastInsertRowid が無く、rowsWritten は索引への書き込みも数える。
          // SQLite の関数で直前の文の結果を引く（同期で続けて読むので他の文は割り込まない）。
          const row = sql
            .exec<{ changes: number; id: number }>(
              "SELECT changes() AS changes, last_insert_rowid() AS id",
            )
            .one();
          return { changes: Number(row.changes), lastInsertRowid: Number(row.id) };
        },
      };
    },
    exec(query) {
      sql.exec(query).toArray();
    },
  };
}

export function getDb(): Db {
  return getRuntime().db;
}

/** 席の初期レイアウト（4 席 × 4 島）。DB が空のときだけ書き込む。 */
const DEFAULT_ISLANDS = [
  { key: "northwest", position: 1 },
  { key: "northeast", position: 2 },
  { key: "southwest", position: 3 },
  { key: "southeast", position: 4 },
] as const;

const SEATS_PER_DEFAULT_ISLAND = 4;

/** 「空席 A」「空席 AA」のような通し名。番号を Excel 列式の英字に変換する。 */
export function placeholderSeatLabel(index: number): string {
  let value = Math.max(1, Math.trunc(index));
  const letters: string[] = [];
  while (value > 0) {
    value -= 1;
    letters.push(String.fromCharCode(65 + (value % 26)));
    value = Math.floor(value / 26);
  }
  return `空席 ${letters.reverse().join("")}`;
}

function seedDefaultSeats(db: Db, now: string): void {
  // 席は最後の 1 つまで消せる。数だけを見て入れ直すと、レイアウトを組み替える途中で
  // DO が眠って起きただけで「空席 A〜P」が生え直す。入れるのはこの DB で一度きり。
  // 印を先に取るのは、既に席がある DB でも「もう入れた」ことにしておくため。
  if (!claimOnce(db, "seed-default-seats")) {
    return;
  }
  const row = db.prepare("SELECT COUNT(*) AS count FROM attendance_seats").get() as {
    count: number;
  };
  if (row.count > 0) {
    return;
  }
  const insert = db.prepare(`
    INSERT INTO attendance_seats
      (seat_key, island_key, seat_label, row_index, col_index, seat_position, status, seat_kind, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'offsite', 'seat', ?)
  `);
  const insertIsland = db.prepare(
    "INSERT OR IGNORE INTO attendance_islands (island_key, label, position, updated_at) VALUES (?, '', ?, ?)",
  );
  let seatNumber = 0;
  for (const island of DEFAULT_ISLANDS) {
    insertIsland.run(island.key, island.position, now);
    for (let seatIndex = 1; seatIndex <= SEATS_PER_DEFAULT_ISLAND; seatIndex += 1) {
      seatNumber += 1;
      insert.run(
        `${island.key}-${seatIndex}`,
        island.key,
        placeholderSeatLabel(seatNumber),
        Math.floor((seatIndex - 1) / 2) + 1,
        ((seatIndex - 1) % 2) + 1,
        seatIndex,
        now,
      );
    }
  }
}

/**
 * スキーマの適用（正本スキーマ → 列の追加 → 初期データ）。DO が起きるたびに 1 回走る。
 *
 * まとめて 1 つのトランザクションにする。途中で落ちたときに「印だけ付いて中身が半端」の
 * まま二度と入れ直されない、という状態を作らないため。
 */
export function applySchema(): void {
  const { storage } = getRuntime();
  const db = getDb();
  storage.transactionSync(() => {
    db.exec(SCHEMA_SQL);
    // 既にある表への列の追加は、表が揃ったこの位置で必ず通す。
    addMissingColumns(db);
    const now = nowIso();
    seedDefaultSeats(db, now);
    // 空の DB には使い方の見本を入れる。何もない画面だけを渡されても始められない。
    seedDemoEvent(db, now);
  });
}

/**
 * 読み取りと書き込みをひとつのトランザクションで囲む。
 *
 * 「読んで → 書く」を別々に実行すると、複数端末から同時に押したときに取りこぼす。
 * 状態を見てから更新する操作は必ずこれを通す。
 * DO の SQL では BEGIN / COMMIT を書けないので `transactionSync` に任せる。
 */
export function inTransaction<T>(run: (db: Db) => T): T {
  const { storage } = getRuntime();
  const result = storage.transactionSync(() => {
    const value = run(getDb());
    // 非同期のコールバックは確定のあとに続きが走るので、そこで投げても巻き戻らない。
    // 黙って通すと「失敗したのに書き込まれている」になるため、形の時点で断る。
    if (value instanceof Promise) {
      throw new Error("inTransaction には同期の処理だけを渡してください。");
    }
    return value;
  });
  invalidateMemo();
  return result;
}

/** 保存する時刻はすべて UTC の ISO8601（秒精度）に揃える。 */
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}
