import type { KeyboardEvent } from "react";

/**
 * 日本語入力の変換確定で押された Enter かどうか。
 *
 * 変換中の Enter は「候補を確定する」ための打鍵で、送信や追加の意思ではない。
 * ここで弾かないと、変換を確定した瞬間に登録まで走ってしまう
 * （確定するつもりの 1 回目で登録され、本人は 2 回目を押すつもりでいる）。
 *
 * `isComposing` は変換中の keydown で true になる。`keyCode === 229` は
 * それを実装していない環境向けの保険。
 */
function isCompositionEnter(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

/** Enter が「確定ではなく実行」の打鍵ならば true。 */
export function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !isCompositionEnter(event);
}
