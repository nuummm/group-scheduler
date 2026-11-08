/**
 * 正本スキーマ。DO が起きるたびに冪等に適用する。
 *
 * 既にある表へ列を足すときは migrations.ts にも書く（`CREATE TABLE IF NOT EXISTS` は
 * 既存の表を変えない）。
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  schedule_mode TEXT NOT NULL CHECK (schedule_mode IN ('weekly', 'date_range')),
  start_date    TEXT NOT NULL DEFAULT '',
  end_date      TEXT NOT NULL DEFAULT '',
  -- 予定表の下に置く自由記述。イベント全体で 1 つ、誰でも書ける共有メモ。
  notes         TEXT NOT NULL DEFAULT '',
  -- 毎週固定モードの基本のコマ（JSON 配列）と曜日（JSON 配列）。作成時の設定を写して持つ。
  -- 設定をあとで変えても、既存イベントのコマ番号（availability の保存キー）がずれないようにするため。
  weekly_slots  TEXT NOT NULL DEFAULT '',
  weekdays      TEXT NOT NULL DEFAULT '',
  -- 基本のコマの後ろに足す任意のコマ（JSON 配列）。毎週固定モードでのみ使う。
  extra_slots   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);

-- グループ（画面での呼び名は設定 TERM_GROUP）。掛け持ちできるので参加者との関係は多対多。
CREATE TABLE IF NOT EXISTS event_groups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  color     TEXT NOT NULL,
  position  INTEGER NOT NULL,
  -- 1 回の開催に必要な連続コマ数。開催候補を探すときの窓の幅になる。
  slot_span INTEGER NOT NULL DEFAULT 1,
  -- 人が決めた置き場所。NULL なら「まだ人は触っていない（解いた結果に任せる）」。
  -- 終わりのコマは slot_span から求まるので持たない。
  fixed_column_key TEXT,
  fixed_start_slot INTEGER,
  -- 仮決めか。1 = 仮決め、0 = 仮決めを外したが場所は残っている。
  -- どちらも解では動かない（他のグループがここを避ける）。違うのは「解き直す」の扱いで、
  -- 0 は捨てられ、1 は残る。解除しただけで元の場所へ飛ばないようにするための区別。
  pinned           INTEGER NOT NULL DEFAULT 0,
  -- 参加が欠かせない区分（主宰者など）。この区分の人が出られない枠は候補にしない。
  -- event_grades より前に作る表なので外部キーは張らず、区分を消すときに明示的に外す。
  required_grade_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_event_groups_event ON event_groups(event_id, position);

-- 1 度だけ実行したい後始末の記録（初期データの投入など）。
-- 「空なら入れ直す」でごまかすと、利用者が消したという意思を毎回踏み潰してしまう。
CREATE TABLE IF NOT EXISTS schema_marks (
  name       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 区分（画面での呼び名は設定 TERM_ROLE）。グループ（複数選べる属性・event_groups）とは別で、
-- 1 人 1 つしか持てない。初期値は設定 DEFAULT_ROLES から入れ、あとから自由に足せる。
CREATE TABLE IF NOT EXISTS event_grades (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- 1 = 主宰者の区分（設定 OWNER_ROLE）。グループの「必ず参加」の指し先なので消せない。
  owner    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_event_grades_event ON event_grades(event_id, position);

CREATE TABLE IF NOT EXISTS participants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  edit_key         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL DEFAULT '',
  hidden_in_matrix INTEGER NOT NULL DEFAULT 0,
  -- 区分。未選択は NULL。区分が消されたら SET NULL で外れる。
  grade_id         INTEGER REFERENCES event_grades(id) ON DELETE SET NULL,
  note             TEXT NOT NULL DEFAULT '',
  -- 書き込みのたびに 1 つ進む版。同時編集の検出に使う。
  -- updated_at は秒精度なので、同じ秒に 2 人が保存すると差が出ず検出できない。
  row_version      INTEGER NOT NULL DEFAULT 0,
  -- 予定表を保存したことがあるか。「0 コマ」は本当に予定が無い人と未入力の人で
  -- 見分けが付かず、更新時刻は開いただけでも動くので、保存の事実を別に持つ。
  responded        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);

CREATE TABLE IF NOT EXISTS participant_groups (
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  group_id       INTEGER NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (participant_id, group_id)
);

-- 行が存在すること自体が「このコマは予定あり」を意味する。
CREATE TABLE IF NOT EXISTS availability (
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  slot           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (participant_id, day, slot)
);

CREATE INDEX IF NOT EXISTS idx_availability_event ON availability(event_id);

-- 島。席とは別に持つ。席の集合として暗黙に定義すると、席を全部消したときに島ごと
-- 消えてしまい「席のない島」を置いておけない。
CREATE TABLE IF NOT EXISTS attendance_islands (
  island_key TEXT PRIMARY KEY NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_seats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_key        TEXT NOT NULL UNIQUE,
  island_key      TEXT NOT NULL,
  seat_label      TEXT NOT NULL,
  row_index       INTEGER NOT NULL,
  col_index       INTEGER NOT NULL,
  seat_position   INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'offsite' CHECK (status IN ('present', 'away', 'offsite')),
  seat_kind       TEXT NOT NULL DEFAULT 'seat' CHECK (seat_kind IN ('seat', 'void')),
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_seats_layout
  ON attendance_seats(island_key, seat_position);

-- 在室の記録。「現在の状態」だけでなく、変化を記録として振り返れるようにする。
CREATE TABLE IF NOT EXISTS attendance_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_key        TEXT NOT NULL,
  seat_label      TEXT NOT NULL,
  status          TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_events_created ON attendance_events(created_at DESC);
-- 称号の集計が読むのは「不在から在室に来た」記録だけ。全部の記録を走査すると、
-- 1 日の読み取り行数の枠（無料プラン）が操作の回数ぶん削られる。
CREATE INDEX IF NOT EXISTS idx_attendance_events_arrivals ON attendance_events(created_at, seat_key)
  WHERE status = 'present' AND previous_status = 'offsite';

-- Slack へ送信待ちの通知。この行が消えれば通知は「そもそも送られない」。
-- 席ごとに 1 件だけ持つ（同じ席の直後の操作は後勝ちで置き換える）。
CREATE TABLE IF NOT EXISTS pending_notifications (
  seat_key   TEXT PRIMARY KEY,
  seat_label TEXT NOT NULL,
  -- この保留を生んだ attendance_events.id。取り消しはこれを名指しで行う。
  -- 名指しせずに「その席の最後の変更」を戻すと、押したあとに他の人が同じ席を
  -- 触っていた場合にその人の操作を巻き戻してしまう（取り消したのに在室になる）。
  event_id   INTEGER NOT NULL DEFAULT 0,
  send_at    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_notifications_send_at ON pending_notifications(send_at);

-- 認証の失敗。失敗だけを数える（成功は記録しない）。key は入口なら ip:<アドレス>、
-- 参加者のパスワードなら participant:<参加者 id>。
CREATE TABLE IF NOT EXISTS auth_failures (
  key       TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_key ON auth_failures(key, failed_at);
CREATE INDEX IF NOT EXISTS idx_auth_failures_at ON auth_failures(failed_at);

-- いまロック中の key。行があって locked_until が未来なら、正しい合言葉でも通さない。
CREATE TABLE IF NOT EXISTS auth_locks (
  key          TEXT PRIMARY KEY,
  locked_until INTEGER NOT NULL
);
`;
