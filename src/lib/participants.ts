import type { ParticipantListItem } from "./types";

/**
 * その人が予定を入力したか。
 *
 * 「0 コマ」だけでは判断できない（本当に 1 つも予定が無い人と、まだ触っていない人が
 * 同じ見た目になる）。更新時刻でも判断できない — 予定表を開くだけで動くので、
 * 開いて何も保存せずに閉じた人まで入力済みになってしまう。
 * サーバーが保存のときだけ立てる `responded` を見る。
 */
export function hasResponded(participant: ParticipantListItem): boolean {
  return participant.responded || participant.busyCount > 0;
}

export type MemberSort = "name" | "grade";

/** 並び替えの選択肢。区分の呼び名は設定で変わるので、見出しは画面側で組む。 */
export const MEMBER_SORTS: MemberSort[] = ["name", "grade"];

/**
 * 一覧の並び替え。元の配列は名前順で届くので、それを土台にする。
 * 同点のときは名前順に落として、並びが呼び出しごとに揺れないようにする。
 */
export function sortParticipants(
  participants: ParticipantListItem[],
  sort: MemberSort,
): ParticipantListItem[] {
  const byName = (a: ParticipantListItem, b: ParticipantListItem) =>
    a.name.localeCompare(b.name, "ja");

  return [...participants].sort((a, b) => {
    if (sort === "grade") {
      // 区分が未選択の人は最後に回す（区分で探しているときに邪魔になるため）。
      const left = a.gradeId ?? Number.MAX_SAFE_INTEGER;
      const right = b.gradeId ?? Number.MAX_SAFE_INTEGER;
      return left - right || byName(a, b);
    }
    return byName(a, b);
  });
}
