import { randomBytes } from "node:crypto";
import { serverConfig } from "./config";
import type { Db } from "./db";
import { buildDemoData, DEMO_SEED } from "./demo-data";
import { claimOnce } from "./migrations";

/**
 * 使い方が分かる見本のイベント。**DB にイベントが 1 件も無いときだけ**入れる。
 *
 * 何もない画面を渡されても、どう埋めればいいのか分からない。顔ぶれと予定が最初から
 * 入っていれば、色の意味・掛け持ちの扱い・仮決めの動きを触って確かめられる。
 * 中身は seed から作る架空のデータ（demo-data.ts）。
 *
 * 入れ直しはしない。消したという意思を毎回踏み潰さないため。
 */

const DEMO_SLUG = "demo";
const DEMO_TITLE = "グループの開催枠を決める（デモ）";
const DEMO_DESCRIPTION =
  "使い方の見本です。架空のメンバー 15 人で、5 つのグループの開催枠を決めます。自由に触って構いません。";

const DEMO_COLORS = ["#3b82f6", "#f97316", "#14b8a6", "#8b5cf6", "#ef4444"];

/**
 * 見本のイベントを入れる。**この DB で一度だけ**。
 *
 * 「イベントが 0 件なら入れる」だけだと、消してから再起動するたびに戻ってくる。
 * 期の切れ目に全部片付けたのに、翌朝いきなり架空の 15 人が現れることになる。
 */
export function seedDemoEvent(db: Db, now: string): void {
  // 印を先に取る。件数を先に見て return すると、既にイベントがある DB に印が残らず、
  // 全部消したあとに DO が起き直した瞬間に見本が現れる。
  if (!claimOnce(db, "seed-demo-event")) {
    return;
  }
  const existing = db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
  if (existing.count > 0) {
    return;
  }

  const { weeklySlots, weekdays, defaultRoles, ownerRole } = serverConfig();
  const data = buildDemoData(DEMO_SEED, weekdays, weeklySlots.length, defaultRoles.length);

  const event = db
    .prepare(`
      INSERT INTO events (slug, title, description, schedule_mode, start_date, end_date,
                          weekly_slots, weekdays, created_at)
      VALUES (?, ?, ?, 'weekly', '', '', ?, ?, ?)
    `)
    .run(
      DEMO_SLUG,
      DEMO_TITLE,
      DEMO_DESCRIPTION,
      JSON.stringify(weeklySlots.map(({ label, start, end }) => ({ label, start, end }))),
      JSON.stringify(weekdays),
      now,
    );
  const eventId = Number(event.lastInsertRowid);

  const insertGrade = db.prepare(
    "INSERT INTO event_grades (event_id, name, position, owner) VALUES (?, ?, ?, ?)",
  );
  const roleIds = defaultRoles.map((name, index) =>
    Number(insertGrade.run(eventId, name, index, 0).lastInsertRowid),
  );
  const ownerId = Number(insertGrade.run(eventId, ownerRole, roleIds.length, 1).lastInsertRowid);

  const insertGroup = db.prepare(`
    INSERT INTO event_groups (event_id, name, color, position, slot_span, required_grade_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const groupIds = new Map<string, number>();
  data.groups.forEach((group, index) => {
    const created = insertGroup.run(
      eventId,
      group.name,
      DEMO_COLORS[index % DEMO_COLORS.length] as string,
      index,
      group.slotSpan,
      group.requiresOwner ? ownerId : null,
    );
    groupIds.set(group.name, Number(created.lastInsertRowid));
  });

  const insertMember = db.prepare(`
    INSERT INTO participants
      (event_id, name, edit_key, password_hash, grade_id, note, row_version, responded, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, '', 1, 1, ?, ?)
  `);
  const link = db.prepare(
    "INSERT INTO participant_groups (participant_id, group_id) VALUES (?, ?)",
  );
  const insertBusy = db.prepare(
    "INSERT INTO availability (participant_id, event_id, day, slot, updated_at) VALUES (?, ?, ?, ?, ?)",
  );

  for (const member of data.members) {
    const created = insertMember.run(
      eventId,
      member.name,
      randomBytes(18).toString("base64url"),
      member.owner ? ownerId : (roleIds[member.roleIndex] ?? null),
      now,
      now,
    );
    const memberId = Number(created.lastInsertRowid);
    for (const name of member.groups) {
      const groupId = groupIds.get(name);
      if (groupId) {
        link.run(memberId, groupId);
      }
    }
    for (const cell of member.busy) {
      const [day, slot] = cell.split(":");
      insertBusy.run(memberId, eventId, day ?? "", Number(slot), now);
    }
  }
}
