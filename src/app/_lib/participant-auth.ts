/**
 * 「このタブが誰として編集しているか」の控え。
 *
 * 正本はサーバーの edit_key で、ここに置くのは再訪時に自分の予定表をすぐ開くための写し。
 * 保存先はイベントごとに分ける（同じブラウザで複数のイベントを開いても混ざらないように）。
 *
 * **タブごとに分ける**（sessionStorage）。全タブで 1 つを共有すると、2 つ目のタブで
 * 別の人を開いた瞬間に 1 つ目のタブの「自分」が入れ替わる。共用 PC で 2 人が並んで
 * 入力する使い方が普通にあるので、ここは分ける。
 *
 * 次に来たとき用の写しは localStorage にも置き、タブ側が空のときだけ引き継ぐ。
 */

export interface ParticipantAuth {
  participantId: number;
  editKey: string;
}

function storageKey(slug: string): string {
  return `group-scheduler:${slug}:participant`;
}

export function readParticipantAuth(slug: string): ParticipantAuth | null {
  try {
    const key = storageKey(slug);
    let raw = sessionStorage.getItem(key);
    if (!raw) {
      // 前に来たときの写し。このタブへ引き継ぐ。
      raw = localStorage.getItem(key);
      if (raw) {
        sessionStorage.setItem(key, raw);
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ParticipantAuth>;
    if (typeof parsed.participantId !== "number" || typeof parsed.editKey !== "string") {
      return null;
    }
    return { participantId: parsed.participantId, editKey: parsed.editKey };
  } catch {
    // 壊れた値が残っていても読み出しは失敗させない。
    return null;
  }
}

export function writeParticipantAuth(slug: string, auth: ParticipantAuth): void {
  try {
    const value = JSON.stringify(auth);
    // このタブ用と、次に来たとき用の両方に置く。読むときは必ずタブ側が勝つ。
    sessionStorage.setItem(storageKey(slug), value);
    localStorage.setItem(storageKey(slug), value);
  } catch {
    /* プライベートモード等で保存できなくても操作自体は続けられる */
  }
}

export function clearParticipantAuth(slug: string): void {
  try {
    sessionStorage.removeItem(storageKey(slug));
    localStorage.removeItem(storageKey(slug));
  } catch {
    /* noop */
  }
}
