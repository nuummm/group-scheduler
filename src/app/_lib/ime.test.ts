import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { isSubmitEnter } from "./ime";

/**
 * 日本語入力の変換確定で押した Enter を実行と取り違えないこと。
 *
 * 取り違えると「変換を確定しただけ」の 1 打で登録まで走り、
 * 本人は 2 回目を押すつもりでいるのに結果だけ先に出る。
 */

function keyEvent(init: { key: string; isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return {
    key: init.key,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 },
  } as unknown as KeyboardEvent;
}

describe("isSubmitEnter", () => {
  it("変換していない Enter は実行として扱う", () => {
    expect(isSubmitEnter(keyEvent({ key: "Enter" }))).toBe(true);
  });

  it("変換中の Enter は実行として扱わない", () => {
    expect(isSubmitEnter(keyEvent({ key: "Enter", isComposing: true }))).toBe(false);
  });

  it("isComposing を持たない環境でも keyCode 229 で弾く", () => {
    expect(isSubmitEnter(keyEvent({ key: "Enter", keyCode: 229 }))).toBe(false);
  });

  it("Enter 以外は対象外", () => {
    expect(isSubmitEnter(keyEvent({ key: "a" }))).toBe(false);
    expect(isSubmitEnter(keyEvent({ key: "Escape" }))).toBe(false);
  });
});
