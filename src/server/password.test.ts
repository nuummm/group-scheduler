import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("verifyPassword", () => {
  it("scrypt 形式を検証できる", () => {
    const encoded = hashPassword("みんなの合言葉");
    expect(verifyPassword("みんなの合言葉", encoded)).toBe(true);
    expect(verifyPassword("ちがう", encoded)).toBe(false);
  });

  it("同じパスワードでも保存のたびに別の文字列になる（ソルトが効いている）", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("空の保存値や壊れた値は常に不一致にする", () => {
    expect(verifyPassword("", "")).toBe(false);
    expect(verifyPassword("何か", "こわれた値")).toBe(false);
    expect(verifyPassword("何か", "scrypt$")).toBe(false);
  });

  it("digest が空に解ける壊れた値でも、どのパスワードも通さない", () => {
    expect(verifyPassword("何でも", "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$!!!!")).toBe(false);
    expect(verifyPassword("", "scrypt$AAAA$")).toBe(false);
  });

  it("scrypt 以外の形式（PBKDF2 など）は通さない", () => {
    expect(verifyPassword("なんでも", "c2FsdHNhbHRzYWx0c2FsdA==:ZGlnZXN0")).toBe(false);
  });
});
