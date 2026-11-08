/**
 * 日程の骨格（列とコマ）を決める純粋ロジック。
 *
 * サーバー（検証・集計）とクライアント（描画）の両方がここを見る。列とコマの定義が
 * 二重化すると「保存できたのに表に出ない」類のズレが生まれるため、正本はこの 1 ファイル。
 */

export type ScheduleMode = "weekly" | "date_range";

export interface SlotDefinition {
  slot: number;
  /** 週固定モードの見出し（「1限」など）。期間指定モードでは空文字。 */
  label: string;
  start: string;
  end: string;
  /** 入っていれば見出しにそのまま使う（追加コマ用）。 */
  heading?: string;
}

/**
 * イベントごとに足せる任意のコマ。基本のコマのあとに続く「7限」「夜」などを想定する。
 * 見出しは自由文で、時刻もイベントの都合で決められる。
 */
export interface ExtraSlot {
  /** 見出しにそのまま出す文字列（例: "7限"）。 */
  label: string;
  start: string;
  end: string;
}

/** 追加できるコマ数の上限。表が縦に伸びすぎると読めなくなる。 */
export const MAX_EXTRA_SLOTS = 6;

/** `8:40` を分に直す。時刻の前後関係を比べるのに使う。 */
export function toMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** `8:40` / `18:00` のような時刻表記か。 */
export function isTimeText(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export interface ColumnDefinition {
  /** 週固定なら "mon"、期間指定なら "2026-04-10"。availability.day に入る値。 */
  key: string;
  label: string;
  shortLabel: string;
}

/** 期間指定モードで受け付ける最大日数。列数が増えると表が実用的でなくなる。 */
export const MAX_RANGE_DAYS = 61;

/** 毎週固定モードの基本のコマ（既定値）。組織ごとの時間割は設定 `WEEKLY_SLOTS` で差し替える。 */
export const DEFAULT_WEEKLY_SLOTS: SlotDefinition[] = [
  { slot: 1, label: "1限", start: "9:00", end: "10:30" },
  { slot: 2, label: "2限", start: "10:40", end: "12:10" },
  { slot: 3, label: "3限", start: "13:00", end: "14:30" },
  { slot: 4, label: "4限", start: "14:40", end: "16:10" },
  { slot: 5, label: "5限", start: "16:20", end: "17:50" },
  { slot: 6, label: "6限", start: "18:00", end: "19:30" },
];

/** 基本のコマの上限。追加コマと合わせても 1 日の表が縦に伸びすぎないようにする。 */
export const MAX_WEEKLY_SLOTS = 12;

export const DATE_RANGE_SLOTS: SlotDefinition[] = Array.from({ length: 24 }, (_, hour) => ({
  slot: hour + 1,
  label: "",
  start: `${String(hour).padStart(2, "0")}:00`,
  end: `${String((hour + 1) % 24).padStart(2, "0")}:00`,
}));

const WEEKDAY_SHORT = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 毎週固定モードで列にできる曜日。キーは availability.day に入るので変えない。 */
export const ALL_WEEKDAYS: ColumnDefinition[] = [
  { key: "mon", label: "月曜日", shortLabel: "月" },
  { key: "tue", label: "火曜日", shortLabel: "火" },
  { key: "wed", label: "水曜日", shortLabel: "水" },
  { key: "thu", label: "木曜日", shortLabel: "木" },
  { key: "fri", label: "金曜日", shortLabel: "金" },
  { key: "sat", label: "土曜日", shortLabel: "土" },
  { key: "sun", label: "日曜日", shortLabel: "日" },
];

export const DEFAULT_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

/**
 * 設定の `WEEKLY_SLOTS`（`9:00-10:30,10:40-12:10` や `朝=8:30-9:00,1限=9:00-10:30`）を読む。
 *
 * 見出しを省いたコマは「N限」にする。時刻が読めない・前のコマと重なる・空、のどれかなら
 * 既定値に戻す。半端に読めた分だけで動かすと、気づかないまま時間割が欠ける。
 */
export function parseWeeklySlots(text: string | undefined): SlotDefinition[] {
  const entries = (text ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_WEEKLY_SLOTS) {
    return DEFAULT_WEEKLY_SLOTS;
  }
  const slots: SlotDefinition[] = [];
  let previousEnd = -1;
  for (const [index, entry] of entries.entries()) {
    const separator = entry.lastIndexOf("=");
    const label = separator >= 0 ? entry.slice(0, separator).trim() : `${index + 1}限`;
    const [start = "", end = ""] = entry
      .slice(separator + 1)
      .split("-")
      .map((part) => part.trim());
    if (
      !label ||
      !isTimeText(start) ||
      !isTimeText(end) ||
      toMinutes(start) >= toMinutes(end) ||
      toMinutes(start) < previousEnd ||
      slots.some((slot) => slot.label === label)
    ) {
      return DEFAULT_WEEKLY_SLOTS;
    }
    previousEnd = toMinutes(end);
    slots.push({ slot: index + 1, label, start, end });
  }
  return slots;
}

/** 設定の `WEEKDAYS`（`mon,tue,wed`）を読む。知らないキーが混ざっていたら既定値に戻す。 */
export function parseWeekdays(text: string | undefined): string[] {
  const keys = (text ?? "")
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
  const known = new Set(ALL_WEEKDAYS.map((day) => day.key));
  if (keys.length === 0 || keys.some((key) => !known.has(key))) {
    return DEFAULT_WEEKDAYS;
  }
  // 曜日の順に並べ直す（設定の書き順で列が入れ替わらないように）。
  return ALL_WEEKDAYS.map((day) => day.key).filter((key) => keys.includes(key));
}

/** 曜日キーの並びから列を組む。知らないキーは落とす。 */
export function weekdayColumns(keys: readonly string[]): ColumnDefinition[] {
  return ALL_WEEKDAYS.filter((day) => keys.includes(day.key));
}

/** 「月〜金 × 1限〜6限」のような要約。イベントを作る前の説明に使う。 */
export function describeWeeklyLayout(
  columns: readonly ColumnDefinition[],
  slots: readonly SlotDefinition[],
): string {
  const range = (first?: string, last?: string) =>
    first === last ? (first ?? "") : `${first ?? ""}〜${last ?? ""}`;
  return `${range(columns[0]?.shortLabel, columns.at(-1)?.shortLabel)} × ${range(
    slots[0]?.label,
    slots.at(-1)?.label,
  )}`;
}

/**
 * イベントで使うコマの一覧。
 *
 * 追加コマは基本のコマの後ろに、番号を続けて並べる（基本が 6 コマなら 7、8…）。
 * 番号は availability の保存キーなので、途中に挿し込まず必ず末尾に足すこと。
 * 期間指定モードは 24 時間を 1 時間刻みで埋めていて隙間が無いため、追加コマは受け付けない。
 */
export function getSlotDefinitions(
  mode: ScheduleMode,
  extraSlots: ExtraSlot[] = [],
  baseSlots: readonly SlotDefinition[] = DEFAULT_WEEKLY_SLOTS,
): SlotDefinition[] {
  if (mode !== "weekly") {
    return DATE_RANGE_SLOTS;
  }
  return [
    ...baseSlots,
    ...extraSlots.map((extra, index) => ({
      slot: baseSlots.length + index + 1,
      label: extra.label,
      start: extra.start,
      end: extra.end,
      heading: extra.label,
    })),
  ];
}

/** `YYYY-MM-DD` を UTC 基準の Date にする（ローカルタイムゾーンで日付がずれないように）。 */
function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("日付の形式が不正です。");
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function formatDisplayDate(value: string): string {
  const date = parseIsoDate(value);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}（${WEEKDAY_SHORT[date.getUTCDay()]}）`;
}

export function iterDates(startText: string, endText: string): string[] {
  const start = parseIsoDate(startText);
  const end = parseIsoDate(endText);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) {
    throw new Error("終了日は開始日以降にしてください。");
  }
  if (days + 1 > MAX_RANGE_DAYS) {
    throw new Error(`期間は ${MAX_RANGE_DAYS} 日以内にしてください。`);
  }
  return Array.from({ length: days + 1 }, (_, offset) =>
    toIsoDate(new Date(start.getTime() + offset * 86_400_000)),
  );
}

export function buildColumns(
  mode: ScheduleMode,
  startDate: string,
  endDate: string,
  weekdays: readonly string[] = DEFAULT_WEEKDAYS,
): ColumnDefinition[] {
  if (mode === "weekly") {
    return weekdayColumns(weekdays);
  }
  return iterDates(startDate, endDate).map((value) => {
    const display = formatDisplayDate(value);
    return { key: value, label: display, shortLabel: display };
  });
}

/** 週固定は「1限」、期間指定は「09:00」を列見出しに使う。追加コマは自分の見出しを持つ。 */
export function slotHeading(slot: SlotDefinition, mode: ScheduleMode): string {
  if (slot.heading) {
    return slot.heading;
  }
  return mode === "weekly" ? slot.label : slot.start;
}
