/**
 * 入口の合言葉（Basic 認証）。
 *
 * このアプリはリンクを知っていれば誰でも編集できる作りで、公開 URL のまま置くと
 * 「いま誰が部屋にいるか」まで実名で見えてしまう。最低限の目隠しとして全経路に掛ける。
 *
 * 合言葉は 1 つを全員で共有する。**誰が触ったかは分からない**し、配った相手からは
 * 変えるまで入り続けられる。人ごとに分けたいなら、この層ではなく Cloudflare Access の
 * ような入口サービスを前に置くこと。
 *
 * **合言葉が未設定なら誰も通さない。** Workers は最初からインターネットに出ているので、
 * 「空なら素通し」にすると設定し忘れがそのまま全公開になる。
 */

/** 早期 return で桁数が漏れないよう、長さが違っても最後まで回す。 */
export function matches(given: string, expected: string): boolean {
  const length = Math.max(given.length, expected.length);
  let diff = given.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (given.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export function jsonError(
  status: number,
  error: string,
  headers: Record<string, string> = {},
): Response {
  // 本文は API と同じ形にする。開きっぱなしの画面から API を叩いたときに、
  // 素のテキストだと読めず「通信に失敗しました。」という別の理由に化ける。
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function unauthorized(): Response {
  return jsonError(401, "合言葉が必要です。", {
    // realm は ASCII だけにする（日本語を入れるとヘッダとして壊れる環境がある）。
    "WWW-Authenticate": 'Basic realm="Group Scheduler", charset="UTF-8"',
  });
}

/**
 * 合言葉の照合結果。
 *
 * - `missing` … 資格情報が付いていない。ブラウザの最初の要求は必ずこれなので、失敗として数えない
 * - `invalid` … 付いているが違う。ロックアウトの失敗として数える
 */
export type BasicAuthResult = "ok" | "missing" | "invalid" | "unconfigured";

export function verifyBasicAuth(request: Request, env: Cloudflare.Env): BasicAuthResult {
  const expectedUser = env.SCHEDULER_BASIC_USER ?? "";
  const expectedPassword = env.SCHEDULER_BASIC_PASSWORD ?? "";
  if (!expectedPassword) {
    return "unconfigured";
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header) {
    return "missing";
  }
  const match = /^basic\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) {
    return "invalid";
  }
  let decoded = "";
  try {
    // atob は latin-1 の文字列を返すので、そのままでは日本語の合言葉が化けて
    // **永久に入れなくなる**。バイト列に戻してから UTF-8 として読む。
    decoded = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
  } catch {
    return "invalid";
  }
  // パスワード側に : が入っていても壊れないよう、最初の : だけで割る。
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return "invalid";
  }
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // 両方を必ず比べる（片方で打ち切ると、ユーザー名が合っているかが時間で漏れる）。
  const userOk = matches(user, expectedUser);
  const passwordOk = matches(password, expectedPassword);
  return userOk && passwordOk ? "ok" : "invalid";
}

/** 通してよければ null、断るならその応答を返す（ロックアウトを見ない、照合だけの版）。 */
export function checkBasicAuth(request: Request, env: Cloudflare.Env): Response | null {
  const result = verifyBasicAuth(request, env);
  if (result === "unconfigured") {
    return jsonError(503, "合言葉がまだ設定されていません。管理者に連絡してください。");
  }
  return result === "ok" ? null : unauthorized();
}
