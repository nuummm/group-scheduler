/**
 * 最後に開いていたイベントのパス。
 *
 * 在室状況を見て戻ってきたときに、一覧からやり直さずに済むよう覚えておく。
 * 覚えっぱなしにすると、そのイベントが消えたあと日程調整タブが 404 へ連れて行くので、
 * **見つからなかった時点で忘れる**（`clearLastEventPath`）。
 */

const KEY = "group-scheduler:last-event-path";

export function readLastEventPath(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeLastEventPath(path: string): void {
  try {
    window.localStorage.setItem(KEY, path);
  } catch {
    /* localStorage が使えない環境では覚えないだけ */
  }
}

export function clearLastEventPath(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}
