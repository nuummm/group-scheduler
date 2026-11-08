import { z } from "zod";
import { MAX_SLOT_SPAN } from "@/lib/candidates";
import { EDIT_KEY_HEADER } from "@/lib/http";
import { type ExtraSlot, isTimeText, MAX_EXTRA_SLOTS, toMinutes } from "@/lib/schedule";
import { MAX_GROUPS } from "./events";

/**
 * リクエストボディの形の正本。検証をハンドラごとに散らさずここに集め、型もそのまま導出する。
 *
 * 文言に「グループ」「区分」のような呼び名は入れない（呼び名は設定で変わるので、
 * 呼び名が要る文言は events.ts で設定から組む）。
 */

// 形だけでは足りない。2026-02-31 は Date.UTC が 3/3 に繰り上げるので、
// 要求と違う日付で列が作られる。往復させて一致するものだけ通す。
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が不正です。")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "その日付は存在しません。");

export const createEventSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "イベント名を入力してください。")
      .max(80, "イベント名は 80 文字以内にしてください。"),
    description: z.string().max(500, "説明は 500 文字以内にしてください。").default(""),
    scheduleMode: z.enum(["weekly", "date_range"], "日程の決め方が不正です。"),
    startDate: z.string().default(""),
    endDate: z.string().default(""),
    groups: z
      .array(z.string().trim().max(40, "名前は 40 文字以内にしてください。"))
      .max(MAX_GROUPS, `最初に登録できるのは ${MAX_GROUPS} 件までです。`)
      .default([]),
    /** 区分とグループを引き継ぐ元のイベント。空なら引き継がない。 */
    copyFromSlug: z.string().default(""),
  })
  .refine(
    (value) =>
      value.scheduleMode !== "date_range" ||
      (isoDate.safeParse(value.startDate).success && isoDate.safeParse(value.endDate).success),
    { message: "開始日と終了日を入力してください。" },
  );

const timeText = z
  .string()
  .trim()
  .refine(isTimeText, "時刻は 18:00 のような形式で入力してください。");

export const extraSlotSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "コマの名前を入力してください。")
      .max(12, "コマの名前は 12 文字以内にしてください。"),
    start: timeText,
    end: timeText,
  })
  .refine((slot) => toMinutes(slot.start) < toMinutes(slot.end), {
    message: "終了時刻は開始時刻より後にしてください。",
  });

/**
 * 追加コマの並びの検査。名前の重複と、前のコマとの時刻の重なりを見る。
 *
 * イベント情報と一緒に送る経路と、追加コマだけを送る経路の両方から呼ぶ。
 * 片方に付け忘れると、そちらからは重なった時刻がそのまま通ってしまう。
 * 基本のコマとの重なりはイベントごとに違うので、events.ts で見る。
 */
function checkExtraSlots(slots: ExtraSlot[] | undefined, ctx: z.RefinementCtx): void {
  if (!slots) return;
  const names = new Set<string>();
  let previousEnd = -1;
  for (const slot of slots) {
    if (names.has(slot.label)) {
      ctx.addIssue({ code: "custom", message: `「${slot.label}」が重複しています。` });
      return;
    }
    names.add(slot.label);
    if (toMinutes(slot.start) < previousEnd) {
      ctx.addIssue({
        code: "custom",
        message: `「${slot.label}」の開始時刻が前のコマと重なっています。`,
      });
      return;
    }
    previousEnd = toMinutes(slot.end);
  }
}

/** 追加コマだけを送るとき用。イベント名と説明には触らない。 */
export const extraSlotsOnlySchema = z.object({
  extraSlots: z
    .array(extraSlotSchema)
    .max(MAX_EXTRA_SLOTS, `追加できるコマは ${MAX_EXTRA_SLOTS} 件までです。`)
    .superRefine(checkExtraSlots),
});

export const eventInfoSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "イベント名を入力してください。")
    .max(80, "イベント名は 80 文字以内にしてください。"),
  // 省略＝変更しない。既定を "" にすると、名前だけ直したいときに説明が消える。
  description: z.string().max(500, "説明は 500 文字以内にしてください。").optional(),
  extraSlots: z
    .array(extraSlotSchema)
    .max(MAX_EXTRA_SLOTS, `追加できるコマは ${MAX_EXTRA_SLOTS} 件までです。`)
    .optional()
    .superRefine(checkExtraSlots),
});

/** 空文字も有効（メモを消したという意思）。 */
export const eventNotesSchema = z.object({
  notes: z.string().max(2000, "メモは 2000 文字以内にしてください。"),
});

export const addGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名前を入力してください。")
    .max(40, "名前は 40 文字以内にしてください。"),
});

/**
 * グループの設定変更。1 回の長さと、確定した開催枠。
 *
 * `fixed` は 3 状態ある。未指定なら今のまま、`null` なら確定を解除、
 * 値があればそこへ確定する。省略と null を同じ扱いにすると解除できなくなる。
 */
export const updateGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名前を入力してください。")
    .max(40, "名前は 40 文字以内にしてください。")
    .optional(),
  slotSpan: z
    .number()
    .int()
    .min(1, "コマ数は 1 以上にしてください。")
    .max(MAX_SLOT_SPAN, `コマ数は ${MAX_SLOT_SPAN} 以下にしてください。`)
    .optional(),
  fixed: z
    .object({
      columnKey: z.string().min(1, "曜日の指定が不正です。"),
      startSlot: z.number().int().min(1, "コマの指定が不正です。"),
    })
    .nullable()
    .optional(),
  requiredGradeId: z
    .number()
    .int()
    .positive("「必ず参加」の指定が不正です。")
    .nullable()
    .optional(),
  /** 置き場所は残したまま、動かさない指定だけを外すときに使う。 */
  pinned: z.boolean().optional(),
});

export const addGradeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名前を入力してください。")
    .max(20, "名前は 20 文字以内にしてください。"),
});

export const upsertParticipantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名前を入力してください。")
    .max(40, "名前は 40 文字以内にしてください。"),
  // 省略＝変更しない。空配列は「所属なしにする」という意思なので区別する。
  groupIds: z.array(z.number().int()).max(MAX_GROUPS).optional(),
  gradeId: z.number().int().nullable().optional(),
  password: z.string().max(128, "合言葉が長すぎます。").default(""),
  participantId: z.number().int().nullable().default(null),
  editKey: z.string().nullable().default(null),
  note: z.string().max(500, "ひとことは 500 文字以内にしてください。").nullable().default(null),
});

export const participantAccessSchema = z.object({
  participantId: z.number().int(),
  password: z.string().max(128, "合言葉が長すぎます。").default(""),
});

export const participantDeleteSchema = z.object({
  password: z.string().max(128, "合言葉が長すぎます。").default(""),
});

export const participantVisibilitySchema = z.object({
  hiddenInMatrix: z.boolean(),
});

/**
 * 予定表の保存。属性と予定をまとめて 1 回で送る。
 * `expectedVersion` は開いたときの版で、他の端末が先に保存していたら弾くために使う。
 */
export const saveScheduleSchema = z.object({
  participantId: z.number().int(),
  editKey: z.string().min(1),
  expectedVersion: z.number().int().nullable().default(null),
  name: z
    .string()
    .trim()
    .min(1, "名前を入力してください。")
    .max(40, "名前は 40 文字以内にしてください。"),
  groupIds: z.array(z.number().int()).max(MAX_GROUPS).optional(),
  gradeId: z.number().int().nullable().optional(),
  note: z.string().max(500, "ひとことは 500 文字以内にしてください。").nullable().default(null),
  busyCells: z.array(z.object({ columnKey: z.string(), slot: z.number().int() })).max(61 * 24),
});

/** 席カードのタップ。`silent` を立てると Slack へのお知らせを出さない。 */
export const seatToggleSchema = z.object({
  silent: z.boolean().default(false),
});

/**
 * `away` / `offsite` はその状態にする。`clear-away` は離席をやめる指示で、
 * 戻り先（在室 or 不在）はサーバーが履歴から決める。
 */
export const seatStatusSchema = z.object({
  status: z.enum(["away", "offsite", "clear-away"], "状態の指定が不正です。"),
});

/**
 * 取り消し。`eventId` は「この変更を戻したい」という名指し。
 * 省略できるのは、保留の情報を持たないまま押される経路（古い画面など）のため。
 */
export const seatUndoSchema = z.object({
  eventId: z.number().int().positive().optional(),
});

export const seatRenameSchema = z.object({
  // 長さはコードポイント数で数える（サロゲートペアの絵文字を 2 文字と数えないため、
  // attendance.ts 側の判定と揃える）。
  // 空文字は「既定名に戻す」を意味するので許可する（島名と同じ流儀）。
  label: z
    .string()
    .trim()
    .refine((value) => [...value].length <= 24, "名前は 24 文字以内にしてください。"),
});

/** 空文字は「自動採番の表示に戻す」を意味するので許可する。 */
export const islandRenameSchema = z.object({
  // 長さはコードポイント数で数える（席名と同じ。UTF-16 で数えると絵文字が
  // 2 文字になり、実装側の判定より先に弾かれて上限が食い違う）。
  label: z
    .string()
    .trim()
    .refine((value) => [...value].length <= 20, "島の名前は 20 文字以内にしてください。"),
});

export const seatKindSchema = z.object({
  seatKind: z.enum(["seat", "void"], "席の種類の指定が不正です。"),
});

export const addSeatSchema = z.object({
  islandKey: z.string().min(1, "島の指定が不正です。"),
});

/** 全体表のフィルタ条件はクエリ文字列で来る（`?groupIds=1,2&filterMode=any`）。 */
function parseIdList(raw: string | null): number[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value)),
    ),
  ];
}

export function parseFilterQuery(url: URL): {
  groupFilterIds: number[];
  gradeFilterIds: number[];
  filterMode: "all" | "any";
} {
  return {
    groupFilterIds: parseIdList(url.searchParams.get("groupIds")),
    gradeFilterIds: parseIdList(url.searchParams.get("gradeIds")),
    // 既定は「選んだ人を合わせて見る」。日程調整では複数のグループの全員が空くコマを
    // 探すことのほうが多く、重なりだけを見たい場面は限られる。
    filterMode: url.searchParams.get("filterMode") === "all" ? "all" : "any",
  };
}

export function parseParticipantQuery(request: Request): {
  participantId: number | null;
  editKey: string | null;
} {
  const rawId = new URL(request.url).searchParams.get("participantId");
  const participantId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
  return {
    participantId: Number.isInteger(participantId) ? participantId : null,
    editKey: request.headers.get(EDIT_KEY_HEADER),
  };
}
