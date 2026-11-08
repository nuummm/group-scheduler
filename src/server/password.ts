import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 参加者の任意パスワード。scrypt（Node の既定値 N=16384, r=8, p=1）で保存する。
 *
 * PBKDF2 にしないのは、Workers の本番環境が 100,000 回を超える PBKDF2 を拒否するため
 * （手元の開発環境では通ってしまい、気づけない）。scrypt 以外の形式は常に不一致にする。
 */

const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (!encoded.startsWith("scrypt$")) {
    return false;
  }
  try {
    const [, saltText, digestText] = encoded.split("$");
    const salt = Buffer.from(saltText ?? "", "base64");
    const expected = Buffer.from(digestText ?? "", "base64");
    // 長さの下限を見る。digest が 0 バイトに解ける壊れた値だと、空どうしの比較が
    // 一致してしまい「どのパスワードでも通る」になる。
    if (salt.length < SALT_LENGTH || expected.length < SCRYPT_KEY_LENGTH) {
      return false;
    }
    return safeEqual(scryptSync(password, salt, expected.length), expected);
  } catch {
    return false;
  }
}
