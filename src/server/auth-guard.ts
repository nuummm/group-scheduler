import { ApiError } from "./api";
import { getDb, inTransaction } from "./db";
import { memo } from "./runtime";

/**
 * 認証失敗のロックアウト（入口の合言葉と、参加者ごとのパスワードの両方）。
 *
 * **数えるのは失敗だけ。** 画面は数秒ごとに取り直しに来るので、成功まで数えると開いて
 * いるだけで枠を食い、同じ NAT の後ろにいる全員が締め出される。失敗だけなら、
 * 正しく入れている人の巡回は何回来ても影響しない（書き込みも起きない）。
 *
 * **ロック中は正しい合言葉でも通さない。** 通すと、ロック中も試し続けた中に当たりが
 * あったことが応答の違いで分かり、ロックが総当たりの速度制限にならない。
 */

/** Worker が DO へ渡す、入口の照合に使ったキー。外から来た同名のヘッダーは Worker が捨てる。 */
export const GUARD_KEY_HEADER = "x-guard-key";

export const LOCKOUT_POLICY = {
  maxFailures: 10,
  windowMs: 10 * 60_000,
  lockMs: 15 * 60_000,
} as const;

/** ロックが外れる時刻（ミリ秒）。ロックされていなければ null。 */
export function lockedUntil(key: string, now = Date.now()): number | null {
  // 巡回のたびに来る読み取り。書き込み（＝失敗の記録）があるまでは控えを使う。
  const until = memo(`auth-lock:${key}`, () => {
    const row = getDb().prepare("SELECT locked_until FROM auth_locks WHERE key = ?").get(key) as
      | { locked_until: number }
      | undefined;
    return row ? Number(row.locked_until) : null;
  });
  return until !== null && until > now ? until : null;
}

/**
 * 失敗を 1 回記録し、ロック中（この失敗で入った場合を含む）ならその解除時刻を返す。
 *
 * 呼ぶ側のトランザクションの外で呼ぶこと。失敗を知らせる例外で巻き戻ると、
 * 記録ごと消えて何回でも試せてしまう。
 */
export function recordFailure(key: string, now = Date.now()): number | null {
  return inTransaction((db) => {
    // ロック中の誤答も 429 にする。401 を返すと、正答だけが 429 になり応答で当たりが分かる。
    const active = db
      .prepare("SELECT locked_until FROM auth_locks WHERE key = ? AND locked_until > ?")
      .get(key, now) as { locked_until: number } | undefined;
    if (active) {
      return Number(active.locked_until);
    }
    const since = now - LOCKOUT_POLICY.windowMs;
    // 古い記録はここで掃除する（失敗が無ければ表は増えないので、別の掃除役は要らない）。
    db.prepare("DELETE FROM auth_failures WHERE failed_at < ?").run(since);
    db.prepare("DELETE FROM auth_locks WHERE locked_until <= ?").run(now);
    db.prepare("INSERT INTO auth_failures (key, failed_at) VALUES (?, ?)").run(key, now);
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM auth_failures WHERE key = ? AND failed_at >= ?")
      .get(key, since) as { count: number };
    if (count < LOCKOUT_POLICY.maxFailures) {
      return null;
    }
    const until = now + LOCKOUT_POLICY.lockMs;
    db.prepare(
      "INSERT INTO auth_locks (key, locked_until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET locked_until = excluded.locked_until",
    ).run(key, until);
    // 解けたあとは数え直す。残すと、解けた直後の 1 回の打ち間違いでまたロックに入る。
    db.prepare("DELETE FROM auth_failures WHERE key = ?").run(key);
    return until;
  });
}

export function retryAfterSeconds(until: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

export function tooManyAttempts(until: number): ApiError {
  return new ApiError(
    429,
    "失敗が続いたため、しばらく受け付けを止めています。時間をおいて試してください。",
    { "Retry-After": String(retryAfterSeconds(until)) },
  );
}

/** ロック中なら 429 を投げる。 */
export function assertNotLocked(key: string): void {
  const until = lockedUntil(key);
  if (until !== null) {
    throw tooManyAttempts(until);
  }
}

/** 失敗を記録し、ロックに入ったなら 429、まだなら `otherwise` を投げる。 */
export function failAttempt(key: string, otherwise: ApiError): never {
  const until = recordFailure(key);
  throw until === null ? otherwise : tooManyAttempts(until);
}
