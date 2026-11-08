/**
 * API のレスポンス型。サーバーの組み立てとクライアントの描画が同じ形を見るための正本。
 */

import type { AssignmentResult } from "./assignment";
import type { ColumnDefinition, ExtraSlot, ScheduleMode, SlotDefinition } from "./schedule";

export interface GroupSummary {
  id: number;
  name: string;
  color: string;
  position: number;
  memberCount: number;
  /** 1 回の開催に必要な連続コマ数。開催候補を探すときの窓の幅。 */
  slotSpan: number;
  /**
   * 人が置いた場所。null なら解いた結果に任せる。
   * `pinned` が false でも **そこから動かさない**（違いは、解き直したときに残るかどうか）。
   */
  fixed: FixedSlot | null;
  /** その置き場所を動かさないか（仮決め済みか）。 */
  pinned: boolean;
  /**
   * 参加が欠かせない区分（主宰者など）。
   * 指定すると、その区分の人が出られない枠は候補から外れる。
   */
  requiredGradeId: number | null;
}

/** 確定した開催枠。終わりのコマは `slotSpan` から求めた値。 */
export interface FixedSlot {
  columnKey: string;
  startSlot: number;
  endSlot: number;
}

/**
 * 区分。グループと違い 1 人 1 つしか持てない。
 * 既定の区分（設定 DEFAULT_ROLES）と主宰者の区分（設定 OWNER_ROLE）が入り、あとから自由に足せる。
 */
export interface GradeSummary {
  id: number;
  name: string;
  position: number;
  memberCount: number;
  /** 消したり名前を変えたりできない枠（主宰者の区分）。 */
  locked: boolean;
}

export interface EventListItem {
  slug: string;
  title: string;
  description: string;
  scheduleMode: ScheduleMode;
  startDate: string;
  endDate: string;
  createdAt: string;
  participantCount: number;
  groups: Pick<GroupSummary, "id" | "name" | "color">[];
}

export interface EventDetail {
  slug: string;
  title: string;
  description: string;
  /** 予定表の下に出る共有メモ。イベント全体で 1 つ。 */
  notes: string;
  scheduleMode: ScheduleMode;
  startDate: string;
  endDate: string;
  createdAt: string;
  columns: ColumnDefinition[];
  slotDefinitions: SlotDefinition[];
  /** 1〜6 限の後ろに足してある任意のコマ。編集画面がそのまま扱う。 */
  extraSlots: ExtraSlot[];
  groups: GroupSummary[];
  grades: GradeSummary[];
}

/** セルに積む「予定がある人」。名前だけ持つ（所属を積むと表 1 枚が数 MB になる）。 */
export interface CellParticipant {
  name: string;
}

export interface SummaryCell {
  columnKey: string;
  slot: number;
  busyCount: number;
  /** このコマに予定が入っている人。名前表示とツールチップの両方がこれだけを使う。 */
  busyParticipants: CellParticipant[];
}

export interface EventSummary {
  participantCount: number;
  /** 表示条件に合致した人数。空き人数の分母。 */
  matchedCount: number;
  /**
   * 表示条件に合致した人の名前。セルごとに「空いている人」を出すために使う。
   * 空き ＝ ここから busyParticipants を引いたもの。セル単位で持つと重複が多いので
   * サマリに 1 回だけ載せる。
   */
  matchedNames: string[];
  groupFilterIds: number[];
  gradeFilterIds: number[];
  filterMode: FilterMode;
  cells: SummaryCell[];
}

export type FilterMode = "all" | "any";

export interface ParticipantListItem {
  id: number;
  name: string;
  busyCount: number;
  createdAt: string;
  updatedAt: string;
  hasPassword: boolean;
  /** 予定表を保存したことがあるか。「0 コマ」と「未入力」を分けるために持つ。 */
  responded: boolean;
  hiddenInMatrix: boolean;
  note: string;
  groups: Pick<GroupSummary, "id" | "name" | "color">[];
  /** 未選択は null。 */
  gradeId: number | null;
  gradeName: string | null;
}

export interface CurrentParticipant {
  id: number;
  name: string;
  editKey: string;
  /**
   * 読み込んだ時点の版。保存のときにそのまま送り返して、開いているあいだに
   * 他の端末が同じ予定表を保存していないか確かめる。
   * 更新時刻ではなく通し番号なのは、同じ秒に 2 人が保存しても差が出るようにするため。
   */
  version: number;
  hiddenInMatrix: boolean;
  note: string;
  groups: Pick<GroupSummary, "id" | "name" | "color">[];
  gradeId: number | null;
  busyCells: { columnKey: string; slot: number }[];
}

export interface EventView {
  /** 中身の版。他の端末の変更を拾うための軽い巡回で突き合わせる。 */
  revision: string;
  event: EventDetail;
  summary: EventSummary;
  participants: ParticipantListItem[];
  currentParticipant: CurrentParticipant | null;
  /**
   * 全グループの開催枠を同時に解いた結果。1 コマに 1 グループまでを保証する。
   * 表示条件の絞り込みには影響されない（そのグループのメンバー全員を見た結果でないと
   * 開催できる枠かどうかの判断に使えないため）。グループが 1 つも無ければ null。
   */
  assignment: AssignmentResult | null;
}

export type SeatStatus = "present" | "away" | "offsite";
export type SeatKind = "seat" | "void";

export interface Seat {
  key: string;
  label: string;
  row: number;
  col: number;
  status: SeatStatus;
  seatKind: SeatKind;
  updatedAt: string;
}

export interface Island {
  key: string;
  title: string;
  position: number;
  seatCount: number;
  seats: Seat[];
}

export type AwardKind = "streak" | "monthly" | "yearly";

/**
 * その場所に来ている積み重ねに対する称号。
 *
 * **日数などの数値は持たない。** 「何日来たか」を見せると、多い少ないの物差しが
 * 画面に現れてしまう。称号だけなら、受け取った人は嬉しく、受け取っていない人には
 * 何の情報にもならない。
 */
export interface AttendanceAward {
  kind: AwardKind;
  /** 「今月いちばんの常連」のような表示名。 */
  title: string;
  seatKey: string;
  seatLabel: string;
}

/**
 * よく来ている人を称えるための情報。
 *
 * 各称号は該当者 1 人だけで、しかも最低ラインを超えたときにしか発行しない。
 * 「来ていない」ことが読み取れる値はサーバー側で落としてあるので、画面はそのまま描いてよい。
 */
export interface AttendanceHighlights {
  awards: AttendanceAward[];
}

/**
 * 自分でカードを押して在室にした人へ、その場で返すお祝い。
 *
 * 盤面（`AttendanceView`）には載せない。載せると全員の画面に出てしまい、
 * 誰が何日続けて来ているかが常時見える状態になる。押した本人の応答にだけ付ける。
 */
export interface ArrivalCelebration {
  seatLabel: string;
  /** 今日を含めた連続日数。 */
  streakDays: number;
  /**
   * 今月いちばん来ている人のときだけ入る。`lead` は 2 位との差。
   * 2 位が誰かは返さない（来ていない人が読み取れる情報にしない）。
   */
  monthlyLead: { days: number; lead: number } | null;
  /** 今年度いちばん来ている人か。演出をひと回り良くするために使う。 */
  yearlyTop: boolean;
}

export interface AttendanceView {
  summary: {
    presentCount: number;
    awayCount: number;
    totalSeatCount: number;
  };
  islands: Island[];
  /** Slack へ送信待ちの通知（この間は取り消せる）。 */
  pending: PendingNotice[];
  highlights: AttendanceHighlights;
  /** 盤面の内容ハッシュ。ポーリングで差分がないときの再描画を避けるために使う。 */
  revision: string;
}

export interface PendingNotice {
  seatKey: string;
  seatLabel: string;
  /**
   * この保留を生んだ履歴の id。取り消しはこれを指して行う。
   *
   * 指さずに「その席の最後の変更」を戻すと、**自分が押したあとに他の人が
   * 同じ席を触っていた場合、その人の操作を巻き戻してしまう**
   * （取り消したのに在室になる、という真逆の結果になる）。
   */
  eventId: number;
  /** 送信予定時刻（ISO8601 UTC）。クライアントは残り時間の表示に使う。 */
  sendAt: string;
  /**
   * いまから送信までの残り（ミリ秒）。
   *
   * `sendAt` は絶対時刻なので、端末の時計がずれていると残り時間がずれる。
   * 遅れている端末では「まだ取り消せる」と出したまま Slack に投稿され、
   * 進んでいる端末では取り消しボタンが出ないまま消える。
   * 表示と自動消灯は、この差分だけで組む。
   */
  remainingMs: number;
}

export interface AttendanceLogEntry {
  id: number;
  seatKey: string;
  seatLabel: string;
  status: SeatStatus;
  previousStatus: SeatStatus;
  createdAt: string;
}

export interface KnowledgeNote {
  id: number;
  title: string;
  /** 住所。空なら「どこにも属さない」。 */
  category: string;
  body: string;
  tags: string[];
  author: string;
  /** 書きかけか。 */
  wip: boolean;
  /**
   * 中身を書き直すたびに 1 進む版。書き直す画面はこれを持ち帰って送り返す。
   * 「仕上げる / 書きかけに戻す」だけでは進まない（中身は変わっていないため）。
   */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeSummary = Omit<KnowledgeNote, "body"> & { excerpt: string };
