import { randomBytes } from "node:crypto";
import type {
  ArrivalCelebration,
  AttendanceLogEntry,
  AttendanceView,
  Island,
  Seat,
  SeatKind,
  SeatStatus,
} from "@/lib/types";
import { badRequest, notFound } from "./api";
import { buildArrival, buildHighlights, rememberHighlights } from "./attendance-stats";
import { type Db, getDb, inTransaction, nowIso, placeholderSeatLabel } from "./db";
import { cancelPendingNotice, listPendingNotices, scheduleCheckInNotice } from "./slack";

/** 1 島の 1 行あたりの席数。座席表は 2 列で折り返す。 */
const SEATS_PER_ROW = 2;
const MAX_SEAT_LABEL_LENGTH = 24;
const MAX_ISLAND_LABEL_LENGTH = 20;

/**
 * 取り消せる時間。押し間違いを直すための機能なので、いつまでも遡れる必要はない。
 * 無制限にすると API を直接叩いて履歴を際限なく巻き戻せてしまう。
 */
const UNDO_WINDOW_MS = 5 * 60_000;

interface SeatRow {
  seat_key: string;
  island_key: string;
  seat_label: string;
  row_index: number;
  col_index: number;
  seat_position: number;
  status: SeatStatus;
  seat_kind: SeatKind;
  updated_at: string;
}

function selectSeats(db: Db): SeatRow[] {
  return (
    db
      .prepare(`
      SELECT seat_key, island_key, seat_label, row_index, col_index,
             seat_position, status, seat_kind, updated_at
      FROM attendance_seats
      ORDER BY seat_position ASC, id ASC
    `)
      // SQL の戻り値は Record<string, SqlValue>。status / seat_kind は
      // CHECK 制約で値域が保証されているため、ここでリテラル型へ橋渡しする。
      .all() as unknown as SeatRow[]
  );
}

/**
 * 盤面の内容ハッシュ。ポーリングで前回と同じなら再描画しないための印。
 *
 * 毎回描き直すと、変化がなくてもアニメーションが飛び、操作中の状態が壊れやすい。
 *
 * 島・保留中の通知・称号もハッシュに含める。いずれも席の状態が動かないまま変わりうるため
 * （島名の変更、席のない島の削除、通知の送信、日付をまたいだ連続日数）、
 * 席だけを見ていると他の端末で表示が古いまま残る。
 */
function computeRevision(
  rows: SeatRow[],
  islandKeys: string[],
  pendingKeys: string[],
  highlightKeys: string[],
): string {
  let hash = 0x811c9dc5;
  const source = [
    ...rows.map(
      (row) =>
        `${row.seat_key}:${row.status}:${row.seat_kind}:${row.seat_label}:${row.seat_position}`,
    ),
    // 島の名前や並び、席のない島の増減は席行に現れない。含めないと他の端末へ伝わらない。
    `islands=${islandKeys.join(",")}`,
    `pending=${pendingKeys.join(",")}`,
    `highlights=${highlightKeys.join(",")}`,
  ].join("|");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 盤面を組み立てる。
 *
 * `inTransaction` の中から呼ぶときは `writing` を立てること。未コミットの内容が
 * 称号のキャッシュに焼き付くのを防ぐ（ROLLBACK すると存在しない状態が残る）。
 */
function buildView(db: Db, options: { writing?: boolean } = {}): AttendanceView {
  const rows = selectSeats(db);
  // 島は席とは独立に存在する（席が 0 でも並べたいので、島の一覧が起点）。
  const islandRows = db
    .prepare(
      "SELECT island_key, label, position FROM attendance_islands ORDER BY position ASC, island_key ASC",
    )
    .all() as { island_key: string; label: string; position: number }[];

  const grouped = new Map<string, { position: number; label: string; seats: Seat[] }>();
  for (const island of islandRows) {
    grouped.set(island.island_key, { position: island.position, label: island.label, seats: [] });
  }
  // 島は attendance_islands が正本。ここに無い island_key の席は表に出さない
  // （席から島を復元すると、島テーブル側の操作と食い違ったまま動いてしまう）。

  let presentCount = 0;
  let awayCount = 0;
  let totalSeatCount = 0;

  for (const row of rows) {
    const island = grouped.get(row.island_key);
    if (!island) {
      continue;
    }
    if (row.seat_kind === "seat") {
      totalSeatCount += 1;
      if (row.status === "present") presentCount += 1;
      if (row.status === "away") awayCount += 1;
    }
    island.seats.push({
      key: row.seat_key,
      label: row.seat_label,
      row: row.row_index,
      col: row.col_index,
      // 席なしマスは状態を持たない。表示側で分岐しないで済むよう offsite に潰す。
      status: row.seat_kind === "seat" ? row.status : "offsite",
      seatKind: row.seat_kind,
      updatedAt: row.updated_at,
    });
  }

  const islands: Island[] = [...grouped.entries()]
    .sort((a, b) => a[1].position - b[1].position || a[0].localeCompare(b[0]))
    .map(([key, island], index) => ({
      key,
      // 名前が付いていなければ並び順から自動で振る。
      title: island.label.trim() || `島 ${index + 1}`,
      position: index + 1,
      seatCount: island.seats.filter((seat) => seat.seatKind === "seat").length,
      seats: [...island.seats].sort(
        (a, b) => a.row - b.row || a.col - b.col || a.key.localeCompare(b.key),
      ),
    }));

  const pending = listPendingNotices();
  const highlights = buildHighlights(db, { cache: !options.writing });
  return {
    summary: { presentCount, awayCount, totalSeatCount },
    islands,
    pending,
    highlights,
    revision: computeRevision(
      rows,
      islandRows.map((island) => `${island.island_key}:${island.label}:${island.position}`),
      pending.map((item) => item.seatKey),
      highlights.awards.map((award) => `${award.kind}:${award.seatKey}`),
    ),
  };
}

export function getAttendance(): AttendanceView {
  return buildView(getDb());
}

function requireSeat(db: Db, seatKey: string): SeatRow {
  const row = db
    .prepare(`
      SELECT seat_key, island_key, seat_label, row_index, col_index,
             seat_position, status, seat_kind, updated_at
      FROM attendance_seats WHERE seat_key = ?
    `)
    .get(seatKey) as unknown as SeatRow | undefined;
  if (!row) {
    throw notFound("席が見つかりません。");
  }
  return row;
}

/** 記録した履歴の id を返す。状態が動かなかったときは null。 */
function writeStatus(
  db: Db,
  seat: SeatRow,
  nextStatus: SeatStatus,
  timestamp: string,
): number | null {
  // 状態が動いていないなら履歴に積まない。積むと `away → away` のような
  // **何も変えていない 1 件**が履歴の先頭に立ち、取り消しがそれを消すだけで
  // 終わって「押しても何も起きない」ように見える（離席ボタンの連打で実際に起きた）。
  if (seat.status === nextStatus) {
    return null;
  }
  db.prepare("UPDATE attendance_seats SET status = ?, updated_at = ? WHERE seat_key = ?").run(
    nextStatus,
    timestamp,
    seat.seat_key,
  );
  const inserted = db
    .prepare(`
    INSERT INTO attendance_events (seat_key, seat_label, status, previous_status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(seat.seat_key, seat.seat_label, nextStatus, seat.status, timestamp);
  return Number(inserted.lastInsertRowid);
}

/** 盤面を返す書き込み。確定したあと、組み直した称号を控えに置く。 */
function writeView<T extends AttendanceView>(run: (db: Db) => T): T {
  const view = inTransaction(run);
  rememberHighlights(view.highlights);
  return view;
}

/**
 * 書き込みのあとの共通処理。
 *
 * 称号は履歴だけでなく席の名前・種類にも依存するので、席テーブルを触ったときも
 * 控えを使わず作り直す（控えはトランザクションを抜けたところで捨てられる）。
 */
function buildViewAfterWrite(db: Db): AttendanceView {
  return buildView(db, { writing: true });
}

/**
 * 席カードのタップ。在室中 ↔ 不在を切り替える。
 *
 * 在室に変わったときだけ Slack のお知らせを予約し、不在に戻したときは保留を取り消す
 * ＝ 誤タップして押し直せば、お知らせはそもそも送られない。
 * 離席中から在室へ戻す場合は「もともとその場にいた」ので知らせない。
 *
 * `silent` を立てると記録だけ残してお知らせを出さない（そっと来たいとき用）。
 *
 * **不在から在室にしたときだけ** `arrival`（席名・連続日数・今月の差・今年度いちばんか）を
 * 添えて返す。押した本人の画面に数秒出すためだけの値で、盤面には載せない。
 */
export function toggleSeat(
  seatKey: string,
  options: { silent?: boolean } = {},
): AttendanceView & { arrival?: ArrivalCelebration } {
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    if (seat.seat_kind !== "seat") {
      throw badRequest("席ではないマスは切り替えできません。");
    }
    const nextStatus: SeatStatus = seat.status === "present" ? "offsite" : "present";
    const eventId = writeStatus(db, seat, nextStatus, nowIso());

    if (nextStatus === "present" && seat.status === "offsite" && !options.silent) {
      // 履歴の id を持たせる。取り消しはこれを名指しで行うので、押したあとに
      // 他の人が同じ席を触っていたら断られる（その人の操作を巻き戻さない）。
      scheduleCheckInNotice(seat.seat_key, seat.seat_label, eventId ?? 0);
    } else if (nextStatus === "offsite") {
      cancelPendingNotice(seat.seat_key);
    }
    const view = buildViewAfterWrite(db);
    if (nextStatus !== "present") {
      return view;
    }
    // 不在から来たときだけ。離席から戻っただけで紙吹雪が出ると、
    // 「来た」の意味が薄くなる（日数の集計も offsite からの遷移だけを数えている）。
    return seat.status === "offsite"
      ? { ...view, arrival: buildArrival(db, seat.seat_key, seat.seat_label) }
      : view;
  });
}

/** 離席中・不在への切り替え。在室中への変更はカードのタップ側に一本化する。 */
export function setSeatStatus(seatKey: string, status: SeatStatus): AttendanceView {
  if (status === "present") {
    throw badRequest("この操作では在室中に変更できません。");
  }
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    if (seat.seat_kind !== "seat") {
      throw badRequest("席ではないマスは変更できません。");
    }
    writeStatus(db, seat, status, nowIso());
    if (status === "offsite") {
      cancelPendingNotice(seat.seat_key);
    }
    return buildViewAfterWrite(db);
  });
}

/**
 * 離席をやめる。**離席にする前の状態へ戻す。**
 *
 * 離席ボタンは押すたびに意味が変わるトグルなので、戻り先を決め打ちにできない。
 * 在室から離席にした人は在室へ、不在から離席にした人は不在へ戻すのが、
 * 「もう一度押したら元に戻る」という見た目どおりの動きになる。
 *
 * 決め打ちにすると片方が必ず壊れる。不在に固定すると在室の人が消え、
 * 在室に固定すると**来ていない人が在室中になる**（どちらも実際に踏んだ）。
 */
export function clearAway(seatKey: string): AttendanceView {
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    if (seat.seat_kind !== "seat") {
      throw badRequest("席ではないマスは変更できません。");
    }
    if (seat.status !== "away") {
      // すでに誰かが動かしている。いまの状態のまま返す（勝手に上書きしない）。
      // トランザクションの中なので writing を立てる。立てないと、未コミットの状態を
      // 称号のキャッシュに焼き付けてしまう。
      return buildView(db, { writing: true });
    }
    // 離席にした 1 手前を履歴から拾う。見つからなければ不在へ（来ていた証拠がない）。
    const beforeAway = db
      .prepare(`
        SELECT previous_status
        FROM attendance_events
        WHERE seat_key = ? AND status = 'away'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(seatKey) as { previous_status: SeatStatus } | undefined;
    const back: SeatStatus = beforeAway?.previous_status === "present" ? "present" : "offsite";
    writeStatus(db, seat, back, nowIso());
    if (back === "offsite") {
      cancelPendingNotice(seat.seat_key);
    }
    return buildViewAfterWrite(db);
  });
}

/**
 * 直前の変更を取り消す。
 *
 * 履歴の 1 件前の状態へ戻し、その履歴自体も消す（取り消した操作は「なかったこと」にする）。
 * 保留中の Slack 通知も同時に破棄するので、猶予の内であれば誤操作は外に漏れない。
 *
 * `eventId` を渡すと、**それがその席の最後の変更であるときだけ**戻す。渡さずに
 * 「最後の変更」を無条件に戻すと、押したあとに他の人が同じ席を触っていた場合に
 * その人の操作を巻き戻してしまう（取り消したのに在室中になる、という真逆の結果になる）。
 */
export function undoSeatChange(seatKey: string, eventId?: number): AttendanceView {
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    // 席でないマスに書き戻さない。書けてしまうと `seat_kind='void'` なのに
    // `status='present'` という、表示では見えない不整合が残る。
    if (seat.seat_kind !== "seat") {
      throw badRequest("席ではないマスは取り消せません。");
    }
    const lastChange = db
      .prepare(`
        SELECT id, previous_status, created_at
        FROM attendance_events
        WHERE seat_key = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(seatKey) as { id: number; previous_status: SeatStatus; created_at: string } | undefined;
    if (!lastChange || Date.now() - Date.parse(lastChange.created_at) > UNDO_WINDOW_MS) {
      throw badRequest("取り消せる操作がありません。");
    }
    if (eventId !== undefined && lastChange.id !== eventId) {
      throw badRequest("そのあとに別の変更があったので取り消せません。");
    }
    db.prepare("UPDATE attendance_seats SET status = ?, updated_at = ? WHERE seat_key = ?").run(
      lastChange.previous_status,
      nowIso(),
      seat.seat_key,
    );
    db.prepare("DELETE FROM attendance_events WHERE id = ?").run(lastChange.id);
    cancelPendingNotice(seat.seat_key);
    return buildViewAfterWrite(db);
  });
}

/**
 * 席の名前を変える。
 *
 * **空にすると既定名（`空席 A` など）へ戻す。** 人が抜けて席が空いたときに
 * 名前を消せないと、Slack の通知に居ない人の名前が出続ける。島名を空にすると
 * 自動の名前に戻るのと同じ流儀に揃える。
 */
export function renameSeat(seatKey: string, label: string): AttendanceView {
  const trimmed = label.trim();
  if ([...trimmed].length > MAX_SEAT_LABEL_LENGTH) {
    throw badRequest(`名前は ${MAX_SEAT_LABEL_LENGTH} 文字以内にしてください。`);
  }
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    if (seat.seat_kind !== "seat") {
      throw badRequest("席ではないマスの名前は変更できません。");
    }
    // 空なら通し番号を振り直す。既存の最大値の次を使うので、他の席とはぶつからない。
    const nextLabel = trimmed || placeholderSeatLabel(nextSeatLabelNumber(db));
    db.prepare("UPDATE attendance_seats SET seat_label = ?, updated_at = ? WHERE seat_key = ?").run(
      nextLabel,
      nowIso(),
      seatKey,
    );
    // 保留中の通知が古い名前のまま送られないように追従させる。
    db.prepare("UPDATE pending_notifications SET seat_label = ? WHERE seat_key = ?").run(
      nextLabel,
      seatKey,
    );
    return buildViewAfterWrite(db);
  });
}

/**
 * 島の名前を変える。
 *
 * 名前の正本は `attendance_islands.label`。空文字で保存すると
 * 「島 1」のような自動採番の表示に戻る。
 */
export function renameIsland(islandKey: string, label: string): AttendanceView {
  const trimmed = label.trim();
  if ([...trimmed].length > MAX_ISLAND_LABEL_LENGTH) {
    throw badRequest(`島の名前は ${MAX_ISLAND_LABEL_LENGTH} 文字以内にしてください。`);
  }
  return writeView((db) => {
    const updated = db
      .prepare("UPDATE attendance_islands SET label = ?, updated_at = ? WHERE island_key = ?")
      .run(trimmed, nowIso(), islandKey);
    if (updated.changes === 0) {
      throw notFound("島が見つかりません。");
    }
    return buildViewAfterWrite(db);
  });
}

/**
 * すべての席をまとめて不在に戻す。
 *
 * 帰り際の押し忘れを翌朝まとめて片付けるための操作。島ごとにやると数が多いので、
 * 盤面全体に対する 1 操作として置く。履歴は 1 席ずつ残す（誰がいつ変わったかを追えるように）。
 */
export function clearAllSeats(): AttendanceView {
  return writeView((db) => {
    const seats = db
      .prepare(`
        SELECT seat_key, seat_label, status
        FROM attendance_seats
        WHERE seat_kind = 'seat' AND status <> 'offsite'
      `)
      .all() as unknown as Pick<SeatRow, "seat_key" | "seat_label" | "status">[];
    const timestamp = nowIso();
    for (const seat of seats) {
      writeStatus(db, seat as SeatRow, "offsite", timestamp);
      cancelPendingNotice(seat.seat_key);
    }
    return buildViewAfterWrite(db);
  });
}

/**
 * 島のマスをまとめて席 / 席なしに切り替える。
 *
 * 使っていない島をひとまとめに畳むための操作。1 マスずつ変えるのは数が多いと現実的でない。
 * 席なしにするときは状態も不在へ戻す（席でないものが在室中では困る）。
 */
export function setIslandSeatKind(islandKey: string, seatKind: SeatKind): AttendanceView {
  return writeView((db) => {
    const exists = db
      .prepare("SELECT 1 AS found FROM attendance_islands WHERE island_key = ?")
      .get(islandKey);
    if (!exists) {
      throw notFound("島が見つかりません。");
    }
    // 島ごとの切り替えでも、在室中だった席は記録を残してから畳む。
    const occupied = db
      .prepare(`
        SELECT seat_key, seat_label, status
        FROM attendance_seats
        WHERE island_key = ? AND status <> 'offsite'
      `)
      .all(islandKey) as unknown as Pick<SeatRow, "seat_key" | "seat_label" | "status">[];
    const timestamp = nowIso();
    for (const seat of occupied) {
      writeStatus(db, seat as SeatRow, "offsite", timestamp);
    }
    db.prepare(
      "UPDATE attendance_seats SET seat_kind = ?, status = 'offsite', updated_at = ? WHERE island_key = ?",
    ).run(seatKind, timestamp, islandKey);
    db.prepare(
      "DELETE FROM pending_notifications WHERE seat_key IN (SELECT seat_key FROM attendance_seats WHERE island_key = ?)",
    ).run(islandKey);
    return buildViewAfterWrite(db);
  });
}

/** 席 ↔ 席なしマスの切り替え。状態は必ず不在に戻す（席でないものが在室中では困る）。 */
export function setSeatKind(seatKey: string, seatKind: SeatKind): AttendanceView {
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    const timestamp = nowIso();
    // 在室中の席を席なしにするときも記録を残す。残さないと undo が「その前の操作」を
    // 復元してしまい、画面と履歴が食い違う。
    if (seat.status !== "offsite") {
      writeStatus(db, seat, "offsite", timestamp);
    }
    db.prepare(
      "UPDATE attendance_seats SET seat_kind = ?, status = 'offsite', updated_at = ? WHERE seat_key = ?",
    ).run(seatKind, timestamp, seatKey);
    cancelPendingNotice(seatKey);
    return buildViewAfterWrite(db);
  });
}

/** 島の中で席番号と行列位置を振り直す。追加・削除のあとに必ず通す。 */
function resequenceIsland(db: Db, islandKey: string): void {
  const rows = db
    .prepare(
      "SELECT id FROM attendance_seats WHERE island_key = ? ORDER BY seat_position ASC, id ASC",
    )
    .all(islandKey) as { id: number }[];
  const update = db.prepare(
    "UPDATE attendance_seats SET seat_position = ?, row_index = ?, col_index = ? WHERE id = ?",
  );
  rows.forEach((row, index) => {
    update.run(
      index + 1,
      Math.floor(index / SEATS_PER_ROW) + 1,
      (index % SEATS_PER_ROW) + 1,
      row.id,
    );
  });
}

function resequenceIslands(db: Db): void {
  const rows = db
    .prepare("SELECT island_key FROM attendance_islands ORDER BY position ASC, island_key ASC")
    .all() as { island_key: string }[];
  const update = db.prepare("UPDATE attendance_islands SET position = ? WHERE island_key = ?");
  rows.forEach((row, index) => {
    update.run(index + 1, row.island_key);
  });
}

/**
 * 次の席に振る通し番号。
 *
 * 席数から数えると、途中の席を消したあとに追加したとき既存と同じ名前が生まれる。
 * 既存の「空席 X」の最大値の次を使う。
 */
function nextSeatLabelNumber(db: Db): number {
  const labels = (
    db.prepare("SELECT seat_label FROM attendance_seats").all() as { seat_label: string }[]
  ).map((row) => row.seat_label);
  let max = 0;
  for (const label of labels) {
    const match = /^空席 ([A-Z]+)$/.exec(label.trim());
    if (!match?.[1]) continue;
    let value = 0;
    for (const char of match[1]) {
      value = value * 26 + (char.charCodeAt(0) - 64);
    }
    max = Math.max(max, value);
  }
  return max + 1;
}

export function addIsland(): AttendanceView {
  return writeView((db) => {
    const islandCount = (
      db.prepare("SELECT COUNT(*) AS count FROM attendance_islands").get() as { count: number }
    ).count;
    const islandKey = `island-${randomBytes(4).toString("hex")}`;
    const baseSeatNumber = nextSeatLabelNumber(db) - 1;
    const timestamp = nowIso();
    db.prepare(
      "INSERT INTO attendance_islands (island_key, label, position, updated_at) VALUES (?, '', ?, ?)",
    ).run(islandKey, islandCount + 1, timestamp);
    const insert = db.prepare(`
      INSERT INTO attendance_seats
        (seat_key, island_key, seat_label, row_index, col_index, seat_position, status, seat_kind, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'offsite', 'seat', ?)
    `);
    for (let seatIndex = 1; seatIndex <= 4; seatIndex += 1) {
      insert.run(
        `seat-${randomBytes(5).toString("hex")}`,
        islandKey,
        placeholderSeatLabel(baseSeatNumber + seatIndex),
        Math.floor((seatIndex - 1) / SEATS_PER_ROW) + 1,
        ((seatIndex - 1) % SEATS_PER_ROW) + 1,
        seatIndex,
        timestamp,
      );
    }
    return buildViewAfterWrite(db);
  });
}

export function removeIsland(islandKey: string): AttendanceView {
  return writeView((db) => {
    const exists = db
      .prepare("SELECT 1 AS found FROM attendance_islands WHERE island_key = ?")
      .get(islandKey);
    if (!exists) {
      throw notFound("島が見つかりません。");
    }
    db.prepare(
      "DELETE FROM pending_notifications WHERE seat_key IN (SELECT seat_key FROM attendance_seats WHERE island_key = ?)",
    ).run(islandKey);
    db.prepare("DELETE FROM attendance_seats WHERE island_key = ?").run(islandKey);
    db.prepare("DELETE FROM attendance_islands WHERE island_key = ?").run(islandKey);
    resequenceIslands(db);
    return buildViewAfterWrite(db);
  });
}

export function addSeat(islandKey: string): AttendanceView {
  return writeView((db) => {
    const island = db
      .prepare("SELECT 1 AS found FROM attendance_islands WHERE island_key = ?")
      .get(islandKey);
    if (!island) {
      throw notFound("島が見つかりません。");
    }
    const seatCount = (
      db
        .prepare("SELECT COUNT(*) AS count FROM attendance_seats WHERE island_key = ?")
        .get(islandKey) as { count: number }
    ).count;
    const nextPosition = seatCount + 1;
    db.prepare(`
      INSERT INTO attendance_seats
        (seat_key, island_key, seat_label, row_index, col_index, seat_position, status, seat_kind, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'offsite', 'seat', ?)
    `).run(
      `seat-${randomBytes(5).toString("hex")}`,
      islandKey,
      placeholderSeatLabel(nextSeatLabelNumber(db)),
      Math.floor((nextPosition - 1) / SEATS_PER_ROW) + 1,
      ((nextPosition - 1) % SEATS_PER_ROW) + 1,
      nextPosition,
      nowIso(),
    );
    return buildViewAfterWrite(db);
  });
}

/**
 * 指定した席を削除する（末尾に限らず、抜きたい席を選べる）。
 * 島は席と独立して存在するので、最後の 1 席まで消してよい（席のない島が残る）。
 */
export function removeSeat(seatKey: string): AttendanceView {
  return writeView((db) => {
    const seat = requireSeat(db, seatKey);
    db.prepare("DELETE FROM pending_notifications WHERE seat_key = ?").run(seatKey);
    db.prepare("DELETE FROM attendance_seats WHERE seat_key = ?").run(seatKey);
    resequenceIsland(db, seat.island_key);
    return buildViewAfterWrite(db);
  });
}

export function listAttendanceLog(limit = 50): AttendanceLogEntry[] {
  const rows = getDb()
    .prepare(`
      SELECT id, seat_key, seat_label, status, previous_status, created_at
      FROM attendance_events
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(limit, 1), 200)) as {
    id: number;
    seat_key: string;
    seat_label: string;
    status: SeatStatus;
    previous_status: SeatStatus;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    seatKey: row.seat_key,
    seatLabel: row.seat_label,
    status: row.status,
    previousStatus: row.previous_status,
    createdAt: row.created_at,
  }));
}
