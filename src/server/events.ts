import { randomBytes } from "node:crypto";
import { type AssignmentResult, assignSeminars } from "@/lib/assignment";
import { type CandidateMember, cellKey } from "@/lib/candidates";
import {
  buildColumns,
  type ExtraSlot,
  getSlotDefinitions,
  isTimeText,
  iterDates,
  MAX_EXTRA_SLOTS,
  parseWeekdays,
  type ScheduleMode,
  type SlotDefinition,
  toMinutes,
} from "@/lib/schedule";
import type {
  CurrentParticipant,
  EventDetail,
  EventListItem,
  EventSummary,
  EventView,
  FilterMode,
  FixedSlot,
  GradeSummary,
  GroupSummary,
  ParticipantListItem,
  SummaryCell,
} from "@/lib/types";
import { badRequest, conflict, forbidden, notFound } from "./api";
import { assertNotLocked, failAttempt } from "./auth-guard";
import { serverConfig } from "./config";
import { type Db, getDb, inTransaction, nowIso } from "./db";
import { hashPassword, verifyPassword } from "./password";
import { memo } from "./runtime";

/**
 * グループの色。position の順に巡回して割り当てる。
 *
 * 画面での呼び名（グループ / 区分）は設定で変わるので、コードと DB では
 * group（event_groups）と grade（event_grades）の名前で通す。
 */
const GROUP_COLORS = [
  "#3b82f6",
  "#f97316",
  "#14b8a6",
  "#8b5cf6",
  "#ef4444",
  "#eab308",
  "#22c55e",
  "#ec4899",
];

export const MAX_GROUPS = 16;

/** 期間指定の表は 1464 マス × 人数ぶん並べ替えるので、毎回 localeCompare で作り直さない。 */
const JA_COLLATOR = new Intl.Collator("ja");
export const MAX_GRADES = 16;

/** 画面での呼び名。エラー文にも同じ言葉を使う。 */
function terms() {
  return serverConfig().site.terms;
}

/**
 * 既定の区分を入れる。**イベントを作った時だけ**呼ぶこと。
 *
 * 「空なら入れ直す」を読み取り経路でやると、区分を全部消しても次に開いた瞬間に
 * 復活してしまい、消したという意思が無視される。
 * 主宰者の区分（設定 OWNER_ROLE）は末尾に 1 つだけ、消せない印を付けて入れる。
 */
export function seedDefaultGrades(
  db: Db,
  eventId: number,
  roles: { names: string[]; owner: string } = {
    names: serverConfig().defaultRoles,
    owner: serverConfig().ownerRole,
  },
): void {
  const insert = db.prepare(
    "INSERT INTO event_grades (event_id, name, position, owner) VALUES (?, ?, ?, ?)",
  );
  roles.names.forEach((name, index) => {
    insert.run(eventId, name, index, 0);
  });
  insert.run(eventId, roles.owner, roles.names.length, 1);
}

function listGrades(db: Db, eventId: number): GradeSummary[] {
  const rows = db
    .prepare(`
      SELECT g.id, g.name, g.position, g.owner, COUNT(p.id) AS member_count
      FROM event_grades g
      LEFT JOIN participants p ON p.grade_id = g.id
      WHERE g.event_id = ?
      GROUP BY g.id
      ORDER BY g.position ASC, g.id ASC
    `)
    .all(eventId) as {
    id: number;
    name: string;
    position: number;
    owner: number;
    member_count: number;
  }[];
  // 画面へ渡す形に詰め替える（列名は snake_case、画面は camelCase）。
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    position: row.position,
    memberCount: row.member_count,
    locked: row.owner === 1,
  }));
}

export function addEventGrade(slug: string, name: string): { grade: GradeSummary } {
  const trimmed = name.trim();
  const { role } = terms();
  if (!trimmed) {
    throw badRequest(`${role}の名前を入力してください。`);
  }
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const existing = listGrades(db, row.id);
    if (existing.length >= MAX_GRADES) {
      throw badRequest(`${role}は ${MAX_GRADES} 件までです。`);
    }
    if (existing.some((grade) => grade.name.toLowerCase() === trimmed.toLowerCase())) {
      throw conflict("同じ名前は追加できません。");
    }
    const created = db
      .prepare("INSERT INTO event_grades (event_id, name, position) VALUES (?, ?, ?)")
      .run(row.id, trimmed, existing.length);
    return {
      grade: {
        id: Number(created.lastInsertRowid),
        name: trimmed,
        position: existing.length,
        memberCount: 0,
        locked: false,
      },
    };
  });
}

export function renameEventGrade(slug: string, gradeId: number, name: string): { name: string } {
  const trimmed = name.trim();
  const { role } = terms();
  if (!trimmed) {
    throw badRequest(`${role}の名前を入力してください。`);
  }
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const existing = listGrades(db, row.id);
    const target = existing.find((grade) => grade.id === gradeId);
    if (!target) {
      throw notFound(`${role}が見つかりません。`);
    }
    if (target.locked) {
      throw badRequest(`「${target.name}」の名前は変えられません。`);
    }
    if (
      existing.some(
        (grade) => grade.id !== gradeId && grade.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      throw conflict(`同じ名前の${role}があります。`);
    }
    db.prepare("UPDATE event_grades SET name = ? WHERE id = ? AND event_id = ?").run(
      trimmed,
      gradeId,
      row.id,
    );
    return { name: trimmed };
  });
}

export function deleteEventGrade(slug: string, gradeId: number): { name: string } {
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const { role, group } = terms();
    const grade = db
      .prepare("SELECT id, name, owner FROM event_grades WHERE id = ? AND event_id = ?")
      .get(gradeId, row.id) as { id: number; name: string; owner: number } | undefined;
    if (!grade) {
      throw notFound(`${role}が見つかりません。`);
    }
    if (grade.owner === 1) {
      throw badRequest(`「${grade.name}」は消せません。${group}の「必ず参加」で使います。`);
    }
    // 参照している参加者の区分は「未選択」に戻す。required_grade_id には外部キーを
    // 張っていないので、外部キー任せにせず明示的に外す。
    db.prepare("UPDATE participants SET grade_id = NULL WHERE grade_id = ?").run(gradeId);
    db.prepare("UPDATE event_groups SET required_grade_id = NULL WHERE required_grade_id = ?").run(
      gradeId,
    );
    db.prepare("DELETE FROM event_grades WHERE id = ?").run(gradeId);
    const remaining = db
      .prepare("SELECT id FROM event_grades WHERE event_id = ? ORDER BY position ASC, id ASC")
      .all(row.id) as { id: number }[];
    const update = db.prepare("UPDATE event_grades SET position = ? WHERE id = ?");
    remaining.forEach((item, index) => {
      update.run(index, item.id);
    });
    return { name: grade.name };
  });
}

interface EventRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  schedule_mode: ScheduleMode;
  start_date: string;
  end_date: string;
  notes: string;
  weekly_slots: string;
  weekdays: string;
  extra_slots: string;
  created_at: string;
}

/**
 * 毎週固定モードの基本のコマと曜日。作成時に写した値を読み、読めなければ今の設定に倒す
 * （壊れた JSON でイベントごと開けなくなるより、既定の時間割で開けるほうがましなので）。
 */
function layoutOf(row: EventRow): { baseSlots: SlotDefinition[]; weekdays: string[] } {
  const config = serverConfig();
  let baseSlots = config.weeklySlots;
  try {
    const parsed: unknown = row.weekly_slots ? JSON.parse(row.weekly_slots) : null;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (item) =>
          typeof item?.label === "string" && isTimeText(item?.start) && isTimeText(item?.end),
      )
    ) {
      baseSlots = parsed.map((item: { label: string; start: string; end: string }, index) => ({
        slot: index + 1,
        label: item.label,
        start: item.start,
        end: item.end,
      }));
    }
  } catch {
    console.error("[scheduler] weekly_slots の JSON を読めませんでした");
  }
  let weekdays = config.weekdays;
  try {
    const parsed: unknown = row.weekdays ? JSON.parse(row.weekdays) : null;
    if (Array.isArray(parsed) && parsed.length > 0) {
      weekdays = parseWeekdays(parsed.join(","));
    }
  } catch {
    console.error("[scheduler] weekdays の JSON を読めませんでした");
  }
  return { baseSlots, weekdays };
}

function slotDefinitionsOf(row: EventRow, extraSlots?: ExtraSlot[]): SlotDefinition[] {
  return getSlotDefinitions(
    row.schedule_mode,
    extraSlots ?? parseExtraSlots(row.extra_slots, row.schedule_mode),
    layoutOf(row).baseSlots,
  );
}

/** 追加コマは基本のコマの終わりより後から始める。重なると同じ時間が 2 行に出てしまう。 */
function assertExtraSlotsAfterBase(row: EventRow, extraSlots: ExtraSlot[]): void {
  const first = extraSlots[0];
  const lastBase = layoutOf(row).baseSlots.at(-1);
  if (first && lastBase && toMinutes(first.start) < toMinutes(lastBase.end)) {
    throw badRequest(`「${first.label}」は ${lastBase.end} 以降に始めてください。`);
  }
}

/**
 * 追加コマの読み出し。壊れた JSON でイベントごと開けなくなるより、
 * 追加コマが無い状態で開けるほうがましなので、失敗しても投げない。
 */
function parseExtraSlots(raw: string, mode: ScheduleMode): ExtraSlot[] {
  if (mode !== "weekly" || !raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ExtraSlot =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as ExtraSlot).label === "string" &&
          isTimeText(String((item as ExtraSlot).start ?? "")) &&
          isTimeText(String((item as ExtraSlot).end ?? "")),
      )
      .slice(0, MAX_EXTRA_SLOTS);
  } catch {
    console.error("[scheduler] extra_slots の JSON を読めませんでした");
    return [];
  }
}

/**
 * URL に使う slug。
 *
 * ASCII 以外を落とすだけだと、日本語のタイトルはすべて `event` に潰れて共有 URL が
 * 意味を成さない。ASCII 部分が残るならそれを活かし、残らなければ短いトークンにする。
 * どちらの場合も末尾に乱数を足して一意にする（URL も推測しにくくなる）。
 */
function buildSlug(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const token = randomBytes(4)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ascii.length >= 3 ? `${ascii}-${token}` : `event-${token}`;
}

function requireEventRow(db: Db, slug: string): EventRow {
  const row = db.prepare("SELECT * FROM events WHERE slug = ?").get(slug) as EventRow | undefined;
  if (!row) {
    throw notFound("イベントが見つかりません。");
  }
  return row;
}

/**
 * 保存済みの日付から列を組む。
 *
 * 作成時に検査しているので普通は通るが、上限を下げたあとの古いイベントなど、
 * 「保存されているが今の規則では作れない」状態は起こりうる。素通しすると
 * 500 になって画面ごと開けなくなるので、読める理由に翻訳する。
 */
function columnsOf(row: EventRow) {
  try {
    return buildColumns(row.schedule_mode, row.start_date, row.end_date, layoutOf(row).weekdays);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "日付の指定が不正です。");
  }
}

function serializeEvent(db: Db, row: EventRow): EventDetail {
  const groups = db
    .prepare(`
      SELECT g.id, g.name, g.color, g.position, g.slot_span,
             g.fixed_column_key, g.fixed_start_slot, g.pinned, g.required_grade_id,
             COUNT(pg.participant_id) AS member_count
      FROM event_groups g
      LEFT JOIN participant_groups pg ON pg.group_id = g.id
      WHERE g.event_id = ?
      GROUP BY g.id
      ORDER BY g.position ASC, g.id ASC
    `)
    .all(row.id) as (Omit<
    GroupSummary,
    "memberCount" | "slotSpan" | "fixed" | "pinned" | "requiredGradeId"
  > & {
    member_count: number;
    slot_span: number;
    fixed_column_key: string | null;
    fixed_start_slot: number | null;
    pinned: number;
    required_grade_id: number | null;
  })[];

  const extraSlots = parseExtraSlots(row.extra_slots, row.schedule_mode);
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    notes: row.notes,
    scheduleMode: row.schedule_mode,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    columns: columnsOf(row),
    slotDefinitions: slotDefinitionsOf(row, extraSlots),
    extraSlots,
    grades: listGrades(db, row.id),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      position: group.position,
      memberCount: group.member_count,
      slotSpan: group.slot_span,
      fixed:
        group.fixed_column_key === null || group.fixed_start_slot === null
          ? null
          : {
              columnKey: group.fixed_column_key,
              startSlot: group.fixed_start_slot,
              endSlot: group.fixed_start_slot + Math.max(1, group.slot_span) - 1,
            },
      pinned: group.pinned !== 0,
      requiredGradeId: group.required_grade_id,
    })),
  };
}

/**
 * 全体表の集計。
 *
 * 各コマには描画に使う busyCount と、名前だけの busyParticipants を返す。
 * 「空いている人の一覧」までは詰めない（期間指定モードの 61 日 × 24 コマでは
 * 毎レスポンス数万件になる）。空き人数は matchedCount − busyCount として画面で求まる。
 */
function buildSummary(
  db: Db,
  event: EventDetail,
  eventId: number,
  groupFilterIds: number[],
  gradeFilterIds: number[],
  filterMode: FilterMode,
): EventSummary {
  const participantRows = db
    .prepare(`
      SELECT id, name, hidden_in_matrix, grade_id
      FROM participants
      WHERE event_id = ?
      ORDER BY name COLLATE NOCASE ASC
    `)
    .all(eventId) as {
    id: number;
    name: string;
    hidden_in_matrix: number;
    grade_id: number | null;
  }[];

  const groupRows = db
    .prepare(`
      SELECT pg.participant_id, g.id AS group_id, g.name, g.color
      FROM participant_groups pg
      JOIN participants p ON p.id = pg.participant_id
      JOIN event_groups g ON g.id = pg.group_id
      WHERE p.event_id = ?
      ORDER BY g.position ASC, g.id ASC
    `)
    .all(eventId) as { participant_id: number; group_id: number; name: string; color: string }[];

  const groupIdsByParticipant = new Map<number, Set<number>>();
  const groupsByParticipant = new Map<number, { id: number; name: string; color: string }[]>();
  for (const row of groupRows) {
    const ids = groupIdsByParticipant.get(row.participant_id) ?? new Set<number>();
    ids.add(row.group_id);
    groupIdsByParticipant.set(row.participant_id, ids);

    const list = groupsByParticipant.get(row.participant_id) ?? [];
    list.push({ id: row.group_id, name: row.name, color: row.color });
    groupsByParticipant.set(row.participant_id, list);
  }

  /**
   * 絞り込みの意味。
   *
   * - `any`（既定）… 選んだ区分・グループの **人を合わせて** 見る。「新人とプロジェクト A の
   *   全員が空いているコマ」を探すのが日程調整の普通の用なので、こちらを既定にする。
   * - `all` … 選んだ条件を **すべて満たす人だけ**。掛け持ちの重なりを見たいときに使う。
   *
   * 区分は 1 人 1 つなので、区分どうしは `all` でも「いずれか」で見るしかない。
   */
  const hasGroupFilter = groupFilterIds.length > 0;
  const hasGradeFilter = gradeFilterIds.length > 0;

  const inSelectedGroups = (participantId: number, everyOne: boolean): boolean => {
    const groups = groupIdsByParticipant.get(participantId) ?? new Set<number>();
    return everyOne
      ? groupFilterIds.every((id) => groups.has(id))
      : groupFilterIds.some((id) => groups.has(id));
  };
  const inSelectedGrades = (gradeId: number | null): boolean =>
    gradeId !== null && gradeFilterIds.includes(gradeId);

  const matches = (participantId: number, gradeId: number | null): boolean => {
    if (!hasGroupFilter && !hasGradeFilter) {
      return true;
    }
    if (filterMode === "any") {
      return (
        (hasGroupFilter && inSelectedGroups(participantId, false)) ||
        (hasGradeFilter && inSelectedGrades(gradeId))
      );
    }
    return (
      (!hasGroupFilter || inSelectedGroups(participantId, true)) &&
      (!hasGradeFilter || inSelectedGrades(gradeId))
    );
  };

  const visible = new Map<
    number,
    { name: string; groups: { id: number; name: string; color: string }[] }
  >();
  for (const row of participantRows) {
    if (row.hidden_in_matrix || !matches(row.id, row.grade_id)) {
      continue;
    }
    visible.set(row.id, { name: row.name, groups: groupsByParticipant.get(row.id) ?? [] });
  }

  const busyRows = db
    .prepare("SELECT participant_id, day, slot FROM availability WHERE event_id = ?")
    .all(eventId) as { participant_id: number; day: string; slot: number }[];

  const busyByCell = new Map<string, number[]>();
  for (const row of busyRows) {
    if (!visible.has(row.participant_id)) {
      continue;
    }
    const key = `${row.day}:${row.slot}`;
    const list = busyByCell.get(key) ?? [];
    list.push(row.participant_id);
    busyByCell.set(key, list);
  }

  const cells: SummaryCell[] = [];
  for (const column of event.columns) {
    for (const slotDefinition of event.slotDefinitions) {
      const key = `${column.key}:${slotDefinition.slot}`;
      const busyIds = busyByCell.get(key) ?? [];
      // 名前だけを積む。所属まで入れると 61 日 × 24 コマの表で数 MB になる。
      const busyParticipants = busyIds
        .map((id) => ({ name: visible.get(id)?.name ?? "" }))
        .sort((a, b) => JA_COLLATOR.compare(a.name, b.name));
      cells.push({
        columnKey: column.key,
        slot: slotDefinition.slot,
        busyCount: busyParticipants.length,
        busyParticipants,
      });
    }
  }

  return {
    participantCount: participantRows.length,
    matchedCount: visible.size,
    matchedNames: [...visible.values()]
      .map((participant) => participant.name)
      .sort(JA_COLLATOR.compare),
    groupFilterIds,
    gradeFilterIds,
    filterMode,
    cells,
  };
}

function listParticipants(db: Db, eventId: number): ParticipantListItem[] {
  const rows = db
    .prepare(`
      SELECT p.id, p.name, p.password_hash, p.hidden_in_matrix, p.note,
             p.created_at, p.updated_at, p.grade_id, p.responded, g.name AS grade_name,
             COUNT(a.slot) AS busy_count
      FROM participants p
      LEFT JOIN availability a ON a.participant_id = p.id
      LEFT JOIN event_grades g ON g.id = p.grade_id
      WHERE p.event_id = ?
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE ASC
    `)
    .all(eventId) as {
    id: number;
    name: string;
    password_hash: string;
    hidden_in_matrix: number;
    note: string;
    created_at: string;
    updated_at: string;
    grade_id: number | null;
    responded: number;
    grade_name: string | null;
    busy_count: number;
  }[];

  const groupRows = db
    .prepare(`
      SELECT pg.participant_id, g.id, g.name, g.color
      FROM participant_groups pg
      JOIN participants p ON p.id = pg.participant_id
      JOIN event_groups g ON g.id = pg.group_id
      WHERE p.event_id = ?
      ORDER BY g.position ASC, g.id ASC
    `)
    .all(eventId) as { participant_id: number; id: number; name: string; color: string }[];

  const groupsByParticipant = new Map<number, { id: number; name: string; color: string }[]>();
  for (const row of groupRows) {
    const list = groupsByParticipant.get(row.participant_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    groupsByParticipant.set(row.participant_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    busyCount: row.busy_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasPassword: Boolean(row.password_hash),
    responded: Boolean(row.responded),
    hiddenInMatrix: Boolean(row.hidden_in_matrix),
    note: row.note,
    groups: groupsByParticipant.get(row.id) ?? [],
    gradeId: row.grade_id,
    gradeName: row.grade_name,
  }));
}

function serializeCurrentParticipant(
  db: Db,
  eventId: number,
  participantId: number,
  editKey: string,
): CurrentParticipant | null {
  const row = db
    .prepare(`
      SELECT id, name, edit_key, hidden_in_matrix, note, grade_id, row_version
      FROM participants
      WHERE id = ? AND event_id = ? AND edit_key = ?
    `)
    .get(participantId, eventId, editKey) as
    | {
        id: number;
        name: string;
        edit_key: string;
        hidden_in_matrix: number;
        note: string;
        grade_id: number | null;
        row_version: number;
      }
    | undefined;
  if (!row) {
    return null;
  }
  const groups = db
    .prepare(`
      SELECT g.id, g.name, g.color
      FROM participant_groups pg
      JOIN event_groups g ON g.id = pg.group_id
      WHERE pg.participant_id = ?
      ORDER BY g.position ASC, g.id ASC
    `)
    .all(row.id) as { id: number; name: string; color: string }[];
  // 参加者は 1 つのイベントにしか属さないので participant_id だけで引く。event_id も
  // 条件に入れると、イベント全員分の索引が選ばれて全員の予定を読んでしまう。
  const busyCells = db
    .prepare("SELECT day, slot FROM availability WHERE participant_id = ?")
    .all(row.id) as { day: string; slot: number }[];

  return {
    id: row.id,
    name: row.name,
    editKey: row.edit_key,
    version: row.row_version,
    hiddenInMatrix: Boolean(row.hidden_in_matrix),
    note: row.note,
    groups,
    gradeId: row.grade_id,
    busyCells: busyCells.map((cell) => ({ columnKey: cell.day, slot: cell.slot })),
  };
}

export interface EventViewOptions {
  participantId?: number | null;
  editKey?: string | null;
  groupFilterIds?: number[];
  gradeFilterIds?: number[];
  filterMode?: FilterMode;
}

/**
 * 全グループの開催案を組む。
 *
 * 絞り込みは効かせない。全体表の表示条件で人を減らすと「その条件の人だけが空いている枠」に
 * なってしまい、開催できる枠かどうかの判断に使えないため、対象は常にそのグループの
 * メンバー全員（全体表で非表示にしている人は除く）。
 * 「必ず参加」を指定したグループには、未登録でもその区分の人を加える。
 */
function buildSeminarPlanning(
  db: Db,
  event: EventDetail,
  eventId: number,
): AssignmentResult | null {
  if (event.groups.length === 0) {
    return null;
  }
  const busyRows = db
    .prepare(`
      SELECT a.participant_id, a.day, a.slot
      FROM availability a
      JOIN participants p ON p.id = a.participant_id
      WHERE a.event_id = ? AND p.hidden_in_matrix = 0
    `)
    .all(eventId) as { participant_id: number; day: string; slot: number }[];
  const busyByParticipant = new Map<number, Set<string>>();
  for (const row of busyRows) {
    const set = busyByParticipant.get(row.participant_id) ?? new Set<string>();
    set.add(cellKey(row.day, row.slot));
    busyByParticipant.set(row.participant_id, set);
  }

  const memberRows = db
    .prepare(`
      SELECT pg.group_id, p.id, p.name
      FROM participant_groups pg
      JOIN participants p ON p.id = pg.participant_id
      WHERE p.event_id = ? AND p.hidden_in_matrix = 0
      ORDER BY p.name COLLATE NOCASE ASC
    `)
    .all(eventId) as { group_id: number; id: number; name: string }[];
  const membersByGroup = new Map<number, CandidateMember[]>();
  for (const row of memberRows) {
    const list = membersByGroup.get(row.group_id) ?? [];
    list.push({ name: row.name, busy: busyByParticipant.get(row.id) ?? new Set<string>() });
    membersByGroup.set(row.group_id, list);
  }

  // 区分ごとの参加者。「主宰者の参加が必須」のように、グループに登録されていなくても
  // 開催枠の判断に加えたい人を引くために使う。
  const gradeRows = db
    .prepare(`
      SELECT p.grade_id, p.id, p.name
      FROM participants p
      WHERE p.event_id = ? AND p.hidden_in_matrix = 0 AND p.grade_id IS NOT NULL
      ORDER BY p.name COLLATE NOCASE ASC
    `)
    .all(eventId) as { grade_id: number; id: number; name: string }[];
  const membersByGrade = new Map<number, CandidateMember[]>();
  for (const row of gradeRows) {
    const list = membersByGrade.get(row.grade_id) ?? [];
    list.push({ name: row.name, busy: busyByParticipant.get(row.id) ?? new Set<string>() });
    membersByGrade.set(row.grade_id, list);
  }

  /**
   * グループの検討対象。必須の区分を指定していれば、その人がグループに未登録でも加える
   * （「このグループ＋主宰者」で置き場所を探せるようにするため）。
   */
  const sourceOf = (group: GroupSummary) => {
    const members = membersByGroup.get(group.id) ?? [];
    if (group.requiredGradeId === null) {
      return { members, requiredNames: [] as string[], requiredMissing: false };
    }
    const required = membersByGrade.get(group.requiredGradeId) ?? [];
    const known = new Set(members.map((member) => member.name));
    return {
      members: [...members, ...required.filter((member) => !known.has(member.name))],
      requiredNames: required.map((member) => member.name),
      // 指定した区分が空（全員が全体表から外れた・消えた・カテゴリだけコピーした）。
      // 空の必須は「制約なし」と同じ形になるので、ここで区別を残す。
      requiredMissing: required.length === 0,
    };
  };

  const columns = event.columns.map((column) => ({ key: column.key, label: column.shortLabel }));
  const slotNumbers = event.slotDefinitions.map((slot) => slot.slot);

  // グループ単体の候補だけでは実行できる案にならない。掛け持ちの人が同時に 2 つへ
  // 呼ばれないよう、全グループの置き場所をまとめて決める。
  return assignSeminars(
    event.groups.map((group) => {
      const { members, requiredNames, requiredMissing } = sourceOf(group);
      return {
        groupId: group.id,
        groupName: group.name,
        groupColor: group.color,
        slotSpan: group.slotSpan,
        members,
        requiredNames,
        requiredMissing,
        // 人が置いた場所は、仮決めでも掴んで動かしただけでも動かさない。
        // 違いは見た目（📌）と、解き直しで残すかどうかだけ。
        placedStart: group.fixed
          ? { columnKey: group.fixed.columnKey, startSlot: group.fixed.startSlot }
          : null,
        pinned: group.pinned,
      };
    }),
    columns,
    slotNumbers,
  );
}

/**
 * イベントの内容ハッシュ。
 *
 * 10 人が同時に自分の予定を入れる場面では、各端末が数秒ごとに変化を見に来る。
 * そのたびに画面ぶんの JSON（数十 KB）と割り当ての計算を回すのは無駄なので、
 * まず「変わったかどうか」だけを軽く返す。ここが変わったときだけ本体を取りに行く。
 *
 * 集計そのものではなく **更新時刻と件数** から作る。参加者の予定・所属・区分、
 * グループの設定（コマ数・仮決め・必ず参加）、イベント情報のどれが変わっても値が動く。
 */
export function getEventRevision(slug: string): { revision: string } {
  // 開いている端末が数秒ごとに見に来る。書き込みが無い間は DB を読まずに返す。
  return memo(`event-revision:${slug}`, () => computeEventRevision(slug));
}

function computeEventRevision(slug: string): { revision: string } {
  const db = getDb();
  const row = requireEventRow(db, slug);
  const parts = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM participants WHERE event_id = ?) AS participant_count,
        -- 同じ秒に 1 人抜けて 1 人入ると、件数も更新時刻も元に戻る。最大 id なら戻らない。
        (SELECT COALESCE(MAX(id), 0) FROM participants WHERE event_id = ?) AS participant_max_id,
        -- 版の合計。更新時刻は秒精度なので、同じ秒に別々の人が保存すると差が出ない。
        (SELECT COALESCE(SUM(row_version), 0) FROM participants WHERE event_id = ?) AS participant_version,
        -- 全体表から外す操作は更新時刻を動かさないが、集計と割り当ての結果は変わる。
        (SELECT COALESCE(GROUP_CONCAT(id || ':' || hidden_in_matrix), '') FROM participants WHERE event_id = ?) AS hidden_state,
        (SELECT COALESCE(MAX(updated_at), '') FROM participants WHERE event_id = ?) AS participant_at,
        (SELECT COUNT(*) FROM availability WHERE event_id = ?) AS availability_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM availability WHERE event_id = ?) AS availability_at,
        (SELECT COUNT(*) FROM participant_groups pg JOIN participants p ON p.id = pg.participant_id WHERE p.event_id = ?) AS link_count,
        (SELECT COALESCE(GROUP_CONCAT(id || ':' || name || ':' || slot_span || ':' || COALESCE(fixed_column_key, '') || ':' || COALESCE(fixed_start_slot, '') || ':' || pinned || ':' || COALESCE(required_grade_id, '')), '') FROM event_groups WHERE event_id = ?) AS groups,
        (SELECT COALESCE(GROUP_CONCAT(id || ':' || name), '') FROM event_grades WHERE event_id = ?) AS grades
    `)
    .get(...Array.from({ length: 10 }, () => row.id)) as Record<string, string | number>;

  const source = [
    row.title,
    row.description,
    row.notes,
    row.extra_slots,
    ...Object.values(parts).map(String),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return { revision: (hash >>> 0).toString(36) };
}

export function getEventView(slug: string, options: EventViewOptions = {}): EventView {
  const groupIds = options.groupFilterIds ?? [];
  const gradeIds = options.gradeFilterIds ?? [];
  const filterMode = options.filterMode ?? "any";
  // 同じ版の表を、開いている人数ぶん組み直さない。20 人が同時に開いている場で
  // 1 人が保存すると、全員が取り直しに来る（読む行数も計算も 20 倍になる）。
  // 本人の分（currentParticipant）だけは人ごとに違うので控えの外で組む。
  const { eventId, view } = memo(
    `event-view:${slug}:${groupIds.join(",")}:${gradeIds.join(",")}:${filterMode}`,
    () => {
      const db = getDb();
      const row = requireEventRow(db, slug);
      const event = serializeEvent(db, row);
      return {
        eventId: row.id,
        view: {
          // 画面ぶんを取り直したときも版を返す。次の巡回で「変わった」と誤判定しないため。
          revision: getEventRevision(slug).revision,
          // 割り当ては絞り込みに左右されないので、条件違いの表どうしでも使い回す。
          assignment: memo(`event-assignment:${slug}`, () =>
            buildSeminarPlanning(db, event, row.id),
          ),
          event,
          summary: buildSummary(db, event, row.id, groupIds, gradeIds, filterMode),
          participants: listParticipants(db, row.id),
        },
      };
    },
  );
  return {
    ...view,
    currentParticipant:
      options.participantId && options.editKey
        ? serializeCurrentParticipant(getDb(), eventId, options.participantId, options.editKey)
        : null,
  };
}

export function listEvents(): EventListItem[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT e.id, e.slug, e.title, e.description, e.schedule_mode,
             e.start_date, e.end_date, e.created_at,
             COUNT(p.id) AS participant_count
      FROM events e
      LEFT JOIN participants p ON p.event_id = e.id
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `)
    // schedule_mode は CHECK 制約で値域が保証されているのでリテラル型へ橋渡しする。
    .all() as unknown as (EventRow & { participant_count: number })[];

  const groupRows = db
    .prepare("SELECT event_id, id, name, color FROM event_groups ORDER BY position ASC, id ASC")
    .all() as { event_id: number; id: number; name: string; color: string }[];
  const groupsByEvent = new Map<number, { id: number; name: string; color: string }[]>();
  for (const row of groupRows) {
    const list = groupsByEvent.get(row.event_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    groupsByEvent.set(row.event_id, list);
  }

  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    description: row.description,
    scheduleMode: row.schedule_mode,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    participantCount: row.participant_count,
    groups: groupsByEvent.get(row.id) ?? [],
  }));
}

export interface CreateEventInput {
  title: string;
  description: string;
  scheduleMode: ScheduleMode;
  startDate: string;
  endDate: string;
  groups: string[];
  /** 区分とグループを引き継ぐ元のイベント。空なら引き継がない。 */
  copyFromSlug?: string;
}

export function createEvent(input: CreateEventInput): { slug: string } {
  if (input.scheduleMode === "date_range") {
    // 日付の妥当性（順序・日数上限）はここで弾く。列が組めない設定は保存させない。
    // schedule.ts は純粋ロジックなので素の Error を投げる。ここで 400 に翻訳しないと
    // 「終了日が開始日より前」のような打ち間違いが 500 になってしまう。
    try {
      iterDates(input.startDate, input.endDate);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "日程の指定が不正です。");
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.groups.slice(0, MAX_GROUPS)) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) {
      continue;
    }
    seen.add(name.toLowerCase());
    names.push(name);
  }

  return inTransaction((db) => {
    // 乱数由来の slug なので衝突はまず起きないが、当たったときに 500 で返すのではなく引き直す。
    let slug = buildSlug(input.title);
    while (db.prepare("SELECT 1 AS found FROM events WHERE slug = ?").get(slug)) {
      slug = buildSlug(input.title);
    }
    const { weeklySlots, weekdays } = serverConfig();
    const created = db
      .prepare(`
        INSERT INTO events (slug, title, description, schedule_mode, start_date, end_date,
                            weekly_slots, weekdays, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        slug,
        input.title.trim(),
        input.description.trim(),
        input.scheduleMode,
        input.scheduleMode === "date_range" ? input.startDate : "",
        input.scheduleMode === "date_range" ? input.endDate : "",
        JSON.stringify(weeklySlots.map(({ label, start, end }) => ({ label, start, end }))),
        JSON.stringify(weekdays),
        nowIso(),
      );
    seedDefaultGrades(db, Number(created.lastInsertRowid));
    const insertGroup = db.prepare(
      "INSERT INTO event_groups (event_id, name, color, position) VALUES (?, ?, ?, ?)",
    );
    names.forEach((name, index) => {
      insertGroup.run(
        created.lastInsertRowid,
        name,
        GROUP_COLORS[index % GROUP_COLORS.length] as string,
        index,
      );
    });
    return { slug };
  });
}

export function deleteEvent(slug: string): void {
  inTransaction((db) => {
    const row = requireEventRow(db, slug);
    // 外部キーが有効なので participants / availability / groups は連鎖して消える。
    db.prepare("DELETE FROM events WHERE id = ?").run(row.id);
  });
}

/** イベント名と説明の更新。説明は空にできる（消したという意思として扱う）。 */
export function updateEventInfo(
  slug: string,
  input: { title: string; description?: string; extraSlots?: ExtraSlot[] },
): { title: string; description: string } {
  const title = input.title.trim();
  if (!title) {
    throw badRequest("イベント名を入力してください。");
  }
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    // 送られてこなかった項目は触らない。既定値で埋めると、名前だけ直したいときに
    // 説明が消える（複数人で開いている画面では、他の人の書いたものが消える）。
    const description =
      input.description === undefined ? row.description : input.description.trim();
    if (!input.extraSlots) {
      db.prepare("UPDATE events SET title = ?, description = ? WHERE id = ?").run(
        title,
        description,
        row.id,
      );
      return { title, description };
    }
    // 追加コマは毎週固定モードだけの機能。期間指定モードでは黙って無視する。
    const extraSlots = row.schedule_mode === "weekly" ? input.extraSlots : [];
    assertExtraSlotsAfterBase(row, extraSlots);
    // コマ番号は配列の位置そのもの。画面は末尾への追加と末尾からの削除しかできず、
    // 途中を抜く操作は無い。名前で突き合わせる検査を置いていたが、
    // 「末尾を 1 つ消しつつ残したコマを改名する」という普通の操作まで弾いていたので外した。
    // 実際に効くのは、この下でやる「無くなったコマの後始末」のほう。
    db.prepare("UPDATE events SET title = ?, description = ?, extra_slots = ? WHERE id = ?").run(
      title,
      description,
      JSON.stringify(extraSlots),
      row.id,
    );
    // 減らしたコマに入っていた予定は消す。残しても表に出ないまま参加者の
    // 「N コマ予定あり」だけが合わなくなる。
    const slotCount = slotDefinitionsOf(row, extraSlots).length;
    db.prepare("DELETE FROM availability WHERE event_id = ? AND slot > ?").run(row.id, slotCount);
    // 無くなったコマに仮決めしていたグループも外す。残すと表に出ないコマを指したまま
    // 「決まっている」ことになり、以降そのグループの設定を何も変えられなくなる。
    db.prepare(
      "UPDATE event_groups SET fixed_column_key = NULL, fixed_start_slot = NULL, pinned = 0 WHERE event_id = ? AND fixed_start_slot IS NOT NULL AND fixed_start_slot + slot_span - 1 > ?",
    ).run(row.id, slotCount);
    return { title, description };
  });
}

/**
 * 追加コマだけを差し替える。イベント名と説明には触らない。
 *
 * コマを 1 つ足すたびに名前と説明を送り直すと、複数人で開いているときに
 * 他の人の変更を巻き戻してしまう。
 */
export function updateEventSlots(
  slug: string,
  extraSlots: ExtraSlot[],
): { slotCount: number; clearedGroups: string[] } {
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const next = row.schedule_mode === "weekly" ? extraSlots : [];
    assertExtraSlotsAfterBase(row, next);
    db.prepare("UPDATE events SET extra_slots = ? WHERE id = ?").run(JSON.stringify(next), row.id);
    const slotCount = slotDefinitionsOf(row, next).length;
    // 無くなったコマの後始末は情報の更新と同じ。詳しくは updateEventInfo の注釈。
    db.prepare("DELETE FROM availability WHERE event_id = ? AND slot > ?").run(row.id, slotCount);
    // 外す前に名前を取っておく。黙って消えると「決めたはずのものが無い」になる。
    const clearedGroups = (
      db
        .prepare(
          "SELECT name FROM event_groups WHERE event_id = ? AND fixed_start_slot IS NOT NULL AND fixed_start_slot + slot_span - 1 > ? ORDER BY position ASC, id ASC",
        )
        .all(row.id, slotCount) as { name: string }[]
    ).map((group) => group.name);
    db.prepare(
      "UPDATE event_groups SET fixed_column_key = NULL, fixed_start_slot = NULL, pinned = 0 WHERE event_id = ? AND fixed_start_slot IS NOT NULL AND fixed_start_slot + slot_span - 1 > ?",
    ).run(row.id, slotCount);
    return { slotCount, clearedGroups };
  });
}

/** 予定表の下の共有メモを保存する。空文字は「メモなし」として正しい状態。 */
export function updateEventNotes(slug: string, notes: string): { notes: string } {
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    db.prepare("UPDATE events SET notes = ? WHERE id = ?").run(notes, row.id);
    return { notes };
  });
}

export function addEventGroup(slug: string, name: string): { group: GroupSummary } {
  const trimmed = name.trim();
  const { group: term } = terms();
  if (!trimmed) {
    throw badRequest(`${term}名を入力してください。`);
  }
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const existing = db
      .prepare("SELECT id, name FROM event_groups WHERE event_id = ? ORDER BY position ASC, id ASC")
      .all(row.id) as { id: number; name: string }[];
    if (existing.length >= MAX_GROUPS) {
      throw badRequest(`${term}は ${MAX_GROUPS} 件までです。`);
    }
    if (existing.some((group) => group.name.toLowerCase() === trimmed.toLowerCase())) {
      throw conflict(`同じ${term}名は追加できません。`);
    }
    const position = existing.length;
    const color = GROUP_COLORS[position % GROUP_COLORS.length] as string;
    const created = db
      .prepare(
        "INSERT INTO event_groups (event_id, name, color, position, pinned) VALUES (?, ?, ?, ?, 0)",
      )
      .run(row.id, trimmed, color, position);
    return {
      group: {
        id: Number(created.lastInsertRowid),
        name: trimmed,
        color,
        position,
        memberCount: 0,
        slotSpan: 1,
        fixed: null,
        pinned: false,
        requiredGradeId: null,
      },
    };
  });
}

/**
 * グループの設定を変える。
 *
 * `slotSpan` と「確定した開催枠」の両方を扱う。渡されなかった項目は今の値のまま
 * （`fixed` は「未指定 = 変えない」「null = 確定を解除」を区別する必要があるので、
 * キーの有無で判定する）。
 */
export function updateEventGroup(
  slug: string,
  groupId: number,
  input: {
    name?: string;
    slotSpan?: number;
    fixed?: { columnKey: string; startSlot: number } | null;
    /** 省略＝変えない。位置を送ったときは既定で「動かさない」に倒す。 */
    pinned?: boolean;
    requiredGradeId?: number | null;
  },
): {
  slotSpan: number;
  fixed: FixedSlot | null;
  pinned: boolean;
  requiredGradeId: number | null;
} {
  const { group: term, role } = terms();
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const current = db
      .prepare(
        "SELECT slot_span, fixed_column_key, fixed_start_slot, pinned, required_grade_id FROM event_groups WHERE id = ? AND event_id = ?",
      )
      .get(groupId, row.id) as
      | {
          slot_span: number;
          fixed_column_key: string | null;
          fixed_start_slot: number | null;
          pinned: number;
          required_grade_id: number | null;
        }
      | undefined;
    if (!current) {
      throw notFound(`${term}が見つかりません。`);
    }

    const requiredGradeId =
      input.requiredGradeId === undefined ? current.required_grade_id : input.requiredGradeId;
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw badRequest(`${term}名を入力してください。`);
      }
      // 重複判定は JS 側で行う。SQLite の LOWER() は ASCII しか畳まないので、
      // 追加のときの判定（toLowerCase）と規則が食い違う。
      const others = db
        .prepare("SELECT name FROM event_groups WHERE event_id = ? AND id <> ?")
        .all(row.id, groupId) as { name: string }[];
      if (others.some((other) => other.name.toLowerCase() === trimmed.toLowerCase())) {
        throw conflict(`同じ${term}名があります。`);
      }
      db.prepare("UPDATE event_groups SET name = ? WHERE id = ? AND event_id = ?").run(
        trimmed,
        groupId,
        row.id,
      );
    }

    // 区分を変えるときだけ確かめる。「必ず参加」に誰もいない区分を指すと、
    // 制約を付けたつもりで何も効かない状態になる。
    if (input.requiredGradeId !== undefined && requiredGradeId !== null) {
      const grade = db
        .prepare(`
          SELECT g.id, COUNT(p.id) AS member_count
          FROM event_grades g
          LEFT JOIN participants p ON p.grade_id = g.id AND p.hidden_in_matrix = 0
          WHERE g.id = ? AND g.event_id = ?
          GROUP BY g.id
        `)
        .get(requiredGradeId, row.id) as { id: number; member_count: number } | undefined;
      if (!grade) {
        throw badRequest(`その${role}は存在しません。`);
      }
      if (grade.member_count === 0) {
        throw badRequest(`その${role}には全体表に出るメンバーがいません。`);
      }
    }

    const slotSpan = input.slotSpan ?? current.slot_span;
    const fixed =
      input.fixed === undefined
        ? current.fixed_column_key === null || current.fixed_start_slot === null
          ? null
          : { columnKey: current.fixed_column_key, startSlot: current.fixed_start_slot }
        : input.fixed;
    // 位置を消したら「動かさない」も一緒に落とす。位置が無いのに指定だけ残っても意味がない。
    // 位置を持っていなかった行の `pinned` も意味を持たないので、引き継がずに落とす。
    const hadPlace = current.fixed_column_key !== null && current.fixed_start_slot !== null;
    let pinned = fixed === null ? false : (input.pinned ?? (hadPlace && current.pinned !== 0));

    // 今回動く可能性があるときだけ確かめる。触っていない仮決めを毎回検証すると、
    // コマ割りが変わって指し先が消えたとき、無関係な変更まで通らなくなる。
    let place = fixed;
    if (place && (input.fixed !== undefined || input.slotSpan !== undefined)) {
      const event = serializeEvent(db, row);
      const target = place;
      const columnExists = event.columns.some((column) => column.key === target.columnKey);
      if (input.fixed !== undefined && !columnExists) {
        throw badRequest("その曜日は存在しません。");
      }
      const slots = event.slotDefinitions.map((slot) => slot.slot);
      // 確定枠は必ず連続していないといけない。追加コマを消した直後などは
      // コマ番号が飛ぶので、番号の大小ではなく並びそのもので確かめる。
      const start = slots.indexOf(target.startSlot);
      const window = start < 0 ? [] : slots.slice(start, start + slotSpan);
      const contiguous =
        columnExists &&
        window.length === slotSpan &&
        window.every((slot, offset) => slot === target.startSlot + offset);
      if (!contiguous) {
        // 落とし所を人が指したときだけ断る。コマ数を伸ばして入らなくなっただけなら、
        // 断るより外して通すほうがいい（断ると「まず仮決めを外す」導線が画面に無い）。
        if (input.fixed !== undefined) {
          throw badRequest("そのコマからは必要な数だけ連続して確保できません。");
        }
        place = null;
        pinned = false;
      }
    }

    db.prepare(
      "UPDATE event_groups SET slot_span = ?, fixed_column_key = ?, fixed_start_slot = ?, pinned = ?, required_grade_id = ? WHERE id = ? AND event_id = ?",
    ).run(
      slotSpan,
      place?.columnKey ?? null,
      place?.startSlot ?? null,
      pinned ? 1 : 0,
      requiredGradeId,
      groupId,
      row.id,
    );

    return {
      slotSpan,
      fixed: place ? { ...place, endSlot: place.startSlot + slotSpan - 1 } : null,
      pinned,
      requiredGradeId,
    };
  });
}

/**
 * 人が決めた置き場所を捨てて、解き直せる状態に戻す。
 *
 * `keepPinned` を立てると仮決め済みだけを残す。掴んで動かした位置は「覚えているだけ」なので、
 * それを捨てれば素の最適化に戻せる。仮決めは決めたことなので残す、という使い分け。
 */
export function clearGroupSchedules(
  slug: string,
  options: { keepPinned?: boolean } = {},
): { cleared: number } {
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const result = db
      .prepare(`
        UPDATE event_groups
        SET fixed_column_key = NULL, fixed_start_slot = NULL, pinned = 0
        WHERE event_id = ? AND fixed_start_slot IS NOT NULL ${options.keepPinned ? "AND pinned = 0" : ""}
      `)
      .run(row.id);
    return { cleared: Number(result.changes) };
  });
}

/**
 * 別のイベントから区分とグループだけを引き継ぐ。
 *
 * 期ごとにおなじ顔ぶれで作り直すので、カテゴリを 1 から打ち直すのは手間なだけ。
 * 引き継ぐのは **名前と設定だけ**。参加者・予定・仮決めは持ってこない
 * （前の期の都合を新しいイベントに混ぜない）。同じ名前がすでにあれば飛ばす。
 * 主宰者の区分はどのイベントにも 1 つずつあるので写さず、「必ず参加」は互いの主宰者どうしでつなぐ。
 */
export function copyEventCategories(
  slug: string,
  sourceSlug: string,
): { grades: number; groups: number; skippedByLimit: number } {
  if (slug === sourceSlug) {
    throw badRequest("同じイベントからは引き継げません。");
  }
  return inTransaction((db) => {
    const target = requireEventRow(db, slug);
    const source = requireEventRow(db, sourceSlug);

    const existingGrades = listGrades(db, target.id);
    const gradeNames = new Set(existingGrades.map((grade) => grade.name.toLowerCase()));
    const sourceGrades = listGrades(db, source.id);
    const insertGrade = db.prepare(
      "INSERT INTO event_grades (event_id, name, position) VALUES (?, ?, ?)",
    );
    let position = existingGrades.length;
    let grades = 0;
    // 上限で落ちたぶんは数える。重複で飛ばしたのと同じ扱いにすると、
    // 「同じ名前は飛ばしました」という説明で 12 件が消える。
    let skippedByLimit = 0;
    for (const grade of sourceGrades) {
      if (grade.locked || gradeNames.has(grade.name.toLowerCase())) {
        continue;
      }
      if (position >= MAX_GRADES) {
        skippedByLimit += 1;
        continue;
      }
      insertGrade.run(target.id, grade.name, position);
      gradeNames.add(grade.name.toLowerCase());
      position += 1;
      grades += 1;
    }

    // 「必ず参加」の指し先は id ではなく名前でつなぎ直す（イベントごとに id が違う）。
    const targetGrades = listGrades(db, target.id);
    const gradeIdByName = new Map(
      targetGrades.map((grade) => [grade.name.toLowerCase(), grade.id]),
    );
    const targetOwnerId = targetGrades.find((grade) => grade.locked)?.id ?? null;
    const sourceGradeById = new Map(sourceGrades.map((grade) => [grade.id, grade]));

    const existingGroups = db
      .prepare("SELECT name FROM event_groups WHERE event_id = ?")
      .all(target.id) as { name: string }[];
    const groupNames = new Set(existingGroups.map((group) => group.name.toLowerCase()));
    const sourceGroups = db
      .prepare(
        "SELECT name, slot_span, required_grade_id FROM event_groups WHERE event_id = ? ORDER BY position ASC, id ASC",
      )
      .all(source.id) as { name: string; slot_span: number; required_grade_id: number | null }[];
    const insertGroup = db.prepare(
      "INSERT INTO event_groups (event_id, name, color, position, slot_span, required_grade_id, pinned) VALUES (?, ?, ?, ?, ?, ?, 0)",
    );
    let groupPosition = existingGroups.length;
    let groups = 0;
    for (const group of sourceGroups) {
      if (groupNames.has(group.name.toLowerCase())) {
        continue;
      }
      if (groupPosition >= MAX_GROUPS) {
        skippedByLimit += 1;
        continue;
      }
      const required = group.required_grade_id
        ? sourceGradeById.get(group.required_grade_id)
        : undefined;
      const requiredId = required?.locked
        ? targetOwnerId
        : required
          ? (gradeIdByName.get(required.name.toLowerCase()) ?? null)
          : null;
      insertGroup.run(
        target.id,
        group.name,
        GROUP_COLORS[groupPosition % GROUP_COLORS.length] as string,
        groupPosition,
        group.slot_span,
        requiredId,
      );
      groupNames.add(group.name.toLowerCase());
      groupPosition += 1;
      groups += 1;
    }

    return { grades, groups, skippedByLimit };
  });
}

export function deleteEventGroup(slug: string, groupId: number): { name: string } {
  return inTransaction((db) => {
    const row = requireEventRow(db, slug);
    const group = db
      .prepare("SELECT id, name FROM event_groups WHERE id = ? AND event_id = ?")
      .get(groupId, row.id) as { id: number; name: string } | undefined;
    if (!group) {
      throw notFound(`${terms().group}が見つかりません。`);
    }
    db.prepare("DELETE FROM event_groups WHERE id = ?").run(groupId);
    // 削除後は position を詰め直し、色も並び順どおりに振り直す。
    const remaining = db
      .prepare("SELECT id FROM event_groups WHERE event_id = ? ORDER BY position ASC, id ASC")
      .all(row.id) as { id: number }[];
    const update = db.prepare("UPDATE event_groups SET position = ?, color = ? WHERE id = ?");
    remaining.forEach((item, index) => {
      update.run(index, GROUP_COLORS[index % GROUP_COLORS.length] as string, item.id);
    });
    return { name: group.name };
  });
}

/** 送られてきたグループ ID を、このイベントに実在するものだけに絞る。 */
function sanitizeGroupIds(db: Db, eventId: number, groupIds: number[]): number[] {
  const valid = new Set(
    (
      db.prepare("SELECT id FROM event_groups WHERE event_id = ?").all(eventId) as { id: number }[]
    ).map((row) => row.id),
  );
  const seen = new Set<number>();
  return groupIds.filter((id) => {
    if (!valid.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

export interface UpsertParticipantInput {
  slug: string;
  name: string;
  /** 省略時は変更しない（note と同じ扱い）。空配列は「所属なしにする」という意思。 */
  groupIds?: number[] | null;
  /** 区分。未選択は null、省略は「変更しない」。1 人 1 つしか持てない。 */
  gradeId?: number | null | undefined;
  password: string;
  participantId?: number | null;
  editKey?: string | null;
  note?: string | null;
}

/** 送られてきた区分 ID が、このイベントに実在するときだけ通す。 */
function sanitizeGradeId(
  db: Db,
  eventId: number,
  gradeId: number | null | undefined,
): number | null {
  if (gradeId === null || gradeId === undefined) {
    return null;
  }
  const found = db
    .prepare("SELECT 1 AS found FROM event_grades WHERE id = ? AND event_id = ?")
    .get(gradeId, eventId);
  return found ? gradeId : null;
}

export function upsertParticipant(input: UpsertParticipantInput): {
  participantId: number;
  editKey: string;
} {
  const name = input.name.trim();
  if (!name) {
    throw badRequest("名前を入力してください。");
  }

  return inTransaction((db) => {
    const event = requireEventRow(db, input.slug);
    const groupIds = input.groupIds ? sanitizeGroupIds(db, event.id, input.groupIds) : null;
    const gradeId =
      input.gradeId === undefined ? undefined : sanitizeGradeId(db, event.id, input.gradeId);
    const timestamp = nowIso();

    if (input.participantId && input.editKey) {
      const existing = db
        .prepare(`
          SELECT id, edit_key, password_hash, note, grade_id
          FROM participants
          WHERE id = ? AND event_id = ? AND edit_key = ?
        `)
        .get(input.participantId, event.id, input.editKey) as
        | {
            id: number;
            edit_key: string;
            password_hash: string;
            note: string;
            grade_id: number | null;
          }
        | undefined;
      if (!existing) {
        throw forbidden("この参加者情報は更新できません。");
      }
      // 改名でも他のメンバーと重複させない（新規登録時だけ見ても、改名で同名ができる）。
      const duplicate = db
        .prepare(
          "SELECT 1 AS found FROM participants WHERE event_id = ? AND LOWER(name) = LOWER(?) AND id <> ?",
        )
        .get(event.id, name, existing.id);
      if (duplicate) {
        throw conflict("同じ名前のメンバーが登録済みです。");
      }
      db.prepare(
        "UPDATE participants SET name = ?, password_hash = ?, note = ?, grade_id = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?",
      ).run(
        name,
        input.password ? hashPassword(input.password) : existing.password_hash,
        input.note === null || input.note === undefined ? existing.note : input.note.trim(),
        gradeId === undefined ? existing.grade_id : gradeId,
        timestamp,
        existing.id,
      );
      // 送られてこなかったグループは触らない。空の値で上書きすると、名前だけ打ち直した人の
      // 所属が黙って消える。
      if (groupIds) {
        db.prepare("DELETE FROM participant_groups WHERE participant_id = ?").run(existing.id);
        const link = db.prepare(
          "INSERT INTO participant_groups (participant_id, group_id) VALUES (?, ?)",
        );
        for (const groupId of groupIds) {
          link.run(existing.id, groupId);
        }
      }
      return { participantId: existing.id, editKey: existing.edit_key };
    }

    const duplicate = db
      .prepare("SELECT 1 AS found FROM participants WHERE event_id = ? AND LOWER(name) = LOWER(?)")
      .get(event.id, name);
    if (duplicate) {
      throw conflict("同じ名前のメンバーが登録済みです。登録メンバーから開いてください。");
    }

    const editKey = randomBytes(18).toString("base64url");
    const created = db
      .prepare(`
        INSERT INTO participants (event_id, name, edit_key, password_hash, note, grade_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        name,
        editKey,
        input.password ? hashPassword(input.password) : "",
        input.note?.trim() ?? "",
        gradeId ?? null,
        timestamp,
        timestamp,
      );
    const participantId = Number(created.lastInsertRowid);
    const link = db.prepare(
      "INSERT INTO participant_groups (participant_id, group_id) VALUES (?, ?)",
    );
    for (const groupId of groupIds ?? []) {
      link.run(participantId, groupId);
    }
    return { participantId, editKey };
  });
}

/**
 * 参加者のパスワードを照合する。外れたら失敗として数え、続けば 429 で止める。
 *
 * トランザクションの外で呼ぶこと。中で投げると失敗の記録まで巻き戻る。
 */
function checkParticipantPassword(
  slug: string,
  participantId: number,
  password: string,
  wrong: string,
): { id: number; name: string; edit_key: string } {
  const db = getDb();
  const event = requireEventRow(db, slug);
  const row = db
    .prepare(
      "SELECT id, name, edit_key, password_hash FROM participants WHERE id = ? AND event_id = ?",
    )
    .get(participantId, event.id) as
    | { id: number; name: string; edit_key: string; password_hash: string }
    | undefined;
  if (!row) {
    throw notFound("参加者が見つかりません。");
  }
  if (!row.password_hash) {
    return row;
  }
  const key = `participant:${row.id}`;
  assertNotLocked(key);
  if (!verifyPassword(password, row.password_hash)) {
    failAttempt(key, forbidden(wrong));
  }
  return row;
}

export function accessParticipant(
  slug: string,
  participantId: number,
  password: string,
): { participantId: number; editKey: string } {
  const row = checkParticipantPassword(
    slug,
    participantId,
    password,
    "パスワードが正しくありません。",
  );
  return { participantId: row.id, editKey: row.edit_key };
}

export function deleteParticipant(
  slug: string,
  participantId: number,
  password: string,
): { name: string } {
  const checked = checkParticipantPassword(
    slug,
    participantId,
    password,
    "削除には正しいパスワードが必要です。",
  );
  return inTransaction((db) => {
    db.prepare("DELETE FROM participants WHERE id = ?").run(checked.id);
    return { name: checked.name };
  });
}

export function updateParticipantVisibility(
  slug: string,
  participantId: number,
  hiddenInMatrix: boolean,
): { name: string; hiddenInMatrix: boolean } {
  return inTransaction((db) => {
    const event = requireEventRow(db, slug);
    const row = db
      .prepare("SELECT id, name FROM participants WHERE id = ? AND event_id = ?")
      .get(participantId, event.id) as { id: number; name: string } | undefined;
    if (!row) {
      throw notFound("参加者が見つかりません。");
    }
    // updated_at も row_version も触らない。
    // 並びが動くのは意図しない副作用だし、版を進めると **他人が目玉を押しただけで**
    // その人の予定表を開いている本人の保存が 409 になる（内容は誰も変えていない）。
    // 他の端末への伝播は getEventRevision の hidden_in_matrix の合計が拾う。
    db.prepare("UPDATE participants SET hidden_in_matrix = ? WHERE id = ?").run(
      hiddenInMatrix ? 1 : 0,
      row.id,
    );
    return { name: row.name, hiddenInMatrix };
  });
}

/** 送られてきたコマから、いま存在するコマだけを残す（重複も落とす）。 */
function sanitizeBusyCells(
  event: EventRow,
  busyCells: { columnKey: string; slot: number }[],
): { columnKey: string; slot: number }[] {
  const validColumns = new Set(columnsOf(event).map((column) => column.key));
  const slotCount = slotDefinitionsOf(event).length;
  const seen = new Set<string>();
  const sanitized: { columnKey: string; slot: number }[] = [];
  for (const cell of busyCells) {
    const key = `${cell.columnKey}:${cell.slot}`;
    if (
      !validColumns.has(cell.columnKey) ||
      cell.slot < 1 ||
      cell.slot > slotCount ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    sanitized.push(cell);
  }
  return sanitized;
}

/** 予定表を書き換えて、新しい更新時刻を返す。呼び出し側のトランザクションの中で使う。 */
function writeAvailability(
  db: Db,
  event: EventRow,
  participantId: number,
  busyCells: { columnKey: string; slot: number }[],
): { cellCount: number; updatedAt: string } {
  const sanitized = sanitizeBusyCells(event, busyCells);
  const timestamp = nowIso();
  // 変わったマスだけを書く。全消し→全挿入だと、期間指定の表では 1 回の保存で数千行を書き、
  // 1 日の書き込み行数の枠（無料プラン）を数十回の保存で使い切る。
  const current = db
    .prepare("SELECT day, slot FROM availability WHERE participant_id = ?")
    .all(participantId) as { day: string; slot: number }[];
  const wanted = new Set(sanitized.map((cell) => cellKey(cell.columnKey, cell.slot)));
  const kept = new Set<string>();
  const remove = db.prepare(
    "DELETE FROM availability WHERE participant_id = ? AND day = ? AND slot = ?",
  );
  for (const cell of current) {
    const key = cellKey(cell.day, cell.slot);
    if (wanted.has(key)) {
      kept.add(key);
    } else {
      remove.run(participantId, cell.day, cell.slot);
    }
  }
  const insert = db.prepare(
    "INSERT INTO availability (participant_id, event_id, day, slot, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const cell of sanitized) {
    if (!kept.has(cellKey(cell.columnKey, cell.slot))) {
      insert.run(participantId, event.id, cell.columnKey, cell.slot, timestamp);
    }
  }
  return { cellCount: sanitized.length, updatedAt: timestamp };
}

export interface SaveScheduleInput {
  slug: string;
  participantId: number;
  editKey: string;
  /**
   * 予定表を開いたときの版。合わなければ、開いているあいだに誰かが
   * 同じ人の予定を保存している。null なら照合しない。
   */
  expectedVersion: number | null;
  name: string;
  /** 省略＝変更しない。 */
  groupIds?: number[];
  gradeId?: number | null;
  note?: string | null;
  busyCells: { columnKey: string; slot: number }[];
}

/**
 * 予定表の保存。**属性と予定を 1 つのトランザクションで書く。**
 *
 * 分けて 2 回呼ぶと、片方だけ通って片方が落ちる状態が起きる（名前だけ変わって予定は元のまま、
 * のような食い違いが残る）。同時に何人も触る前提なので、ここは 1 回で決める。
 *
 * `expectedVersion` が合わないときは何も書かずに 409 を返す。パスワード無しの運用では
 * 同じ人の予定表を 2 人が開けてしまうので、後から保存したほうが黙って上書きするのを防ぐ。
 */
export function saveParticipantSchedule(input: SaveScheduleInput): {
  version: number;
  cellCount: number;
} {
  const name = input.name.trim();
  if (!name) {
    throw badRequest("名前を入力してください。");
  }
  return inTransaction((db) => {
    const event = requireEventRow(db, input.slug);
    const existing = db
      .prepare(`
        SELECT id, note, grade_id, row_version
        FROM participants
        WHERE id = ? AND event_id = ? AND edit_key = ?
      `)
      .get(input.participantId, event.id, input.editKey) as
      | { id: number; note: string; grade_id: number | null; row_version: number }
      | undefined;
    if (!existing) {
      throw forbidden("この参加者情報は更新できません。");
    }
    if (input.expectedVersion !== null && input.expectedVersion !== existing.row_version) {
      throw conflict(
        "開いているあいだに、この予定表が別の端末から保存されました。もう一度押すと、いま開いている内容で上書きします。",
      );
    }

    const duplicate = db
      .prepare(
        "SELECT 1 AS found FROM participants WHERE event_id = ? AND LOWER(name) = LOWER(?) AND id <> ?",
      )
      .get(event.id, name, existing.id);
    if (duplicate) {
      throw conflict("同じ名前のメンバーが登録済みです。");
    }

    const { cellCount, updatedAt } = writeAvailability(db, event, existing.id, input.busyCells);

    const groupIds = input.groupIds ? sanitizeGroupIds(db, event.id, input.groupIds) : null;
    if (groupIds) {
      db.prepare("DELETE FROM participant_groups WHERE participant_id = ?").run(existing.id);
      const link = db.prepare(
        "INSERT INTO participant_groups (participant_id, group_id) VALUES (?, ?)",
      );
      for (const groupId of groupIds) {
        link.run(existing.id, groupId);
      }
    }

    db.prepare(
      "UPDATE participants SET name = ?, note = ?, grade_id = ?, updated_at = ?, row_version = row_version + 1, responded = 1 WHERE id = ?",
    ).run(
      name,
      input.note === null || input.note === undefined ? existing.note : input.note.trim(),
      input.gradeId === undefined
        ? existing.grade_id
        : sanitizeGradeId(db, event.id, input.gradeId),
      updatedAt,
      existing.id,
    );

    return { version: existing.row_version + 1, cellCount };
  });
}
