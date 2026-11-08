import { DurableObject } from "cloudflare:workers";
import { handle } from "./api";
import { GUARD_KEY_HEADER, lockedUntil, recordFailure, tooManyAttempts } from "./auth-guard";
import { readConfig } from "./config";
import { applySchema, createDb } from "./db";
import { dispatch, type Route, systemRoutes } from "./router";
import { apiRoutes } from "./routes";
import { type Runtime, runWithRuntime } from "./runtime";
import { nextNoticeAt, postToSlack, takeDueNotification } from "./slack";

const ROUTES: Route[] = [...systemRoutes, ...apiRoutes];

/**
 * アプリのデータを持つ唯一の Durable Object（名前は `main` に固定）。
 *
 * DB はこの中の SQLite で、触るのはこのクラスから呼ばれる `src/server/` のコードだけ。
 * DO は 1 本のスレッドで動き、SQL も同期なので、「見てから書く」処理は
 * `inTransaction()` の中で他の要求に割り込まれない。
 *
 * アクセスが無いと眠り、要求か alarm で起きる。起きるたびに constructor が走るので、
 * スキーマの適用もここで毎回行う（何度流しても同じ結果になる作り）。
 */
export class AppStore extends DurableObject<Cloudflare.Env> {
  private readonly runtime: Runtime;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.runtime = {
      storage: ctx.storage,
      db: createDb(ctx.storage.sql),
      config: readConfig(env),
      memo: new Map(),
    };
    void ctx.blockConcurrencyWhile(async () => {
      this.run(() => applySchema());
      // デプロイをまたいで alarm が外れていても、保留が残っていれば張り直す。
      await this.syncAlarm();
    });
  }

  private run<T>(task: () => T): T {
    return runWithRuntime(this.runtime, task);
  }

  override async fetch(request: Request): Promise<Response> {
    // 入口の合言葉は通ったが、その送り元がロック中なら正しくても断る（auth-guard.ts）。
    const guardKey = request.headers.get(GUARD_KEY_HEADER);
    const until = guardKey ? this.run(() => lockedUntil(guardKey)) : null;
    if (until !== null) {
      return handle(() => {
        throw tooManyAttempts(until);
      });
    }
    const response = await this.run(() => dispatch(request, ROUTES));
    if (request.method !== "GET" && request.method !== "HEAD") {
      // 読み取りの控えは inTransaction が書き込みのたびに捨てる（ここでは捨てない。
      // 断った要求でも捨てると、称号の集計を外から何度でもやり直させられる）。
      // 保留の通知が増減した書き込みのあとは、alarm を張り直す。
      await this.syncAlarm();
    }
    return response;
  }

  /** 入口の合言葉の失敗を記録する（Worker から RPC で呼ぶ）。ロックに入ったら解除時刻を返す。 */
  async recordAuthFailure(key: string): Promise<number | null> {
    return this.run(() => recordFailure(key));
  }

  /** 画面（静的ファイル）を返す前のロック確認。API は fetch の中で確かめる。 */
  async authLockedUntil(key: string): Promise<number | null> {
    return this.run(() => lockedUntil(key));
  }

  /** 保留の通知を送る。期限が来た分をまとめて 1 通にし、次の保留に合わせて鳴らし直す。 */
  override async alarm(): Promise<void> {
    // 保留の行を消すだけなので控えは捨てない（保留は控えに入れていない）。
    const text = this.run(() => takeDueNotification());
    if (text) {
      await this.run(() => postToSlack(text));
    }
    await this.syncAlarm();
  }

  /**
   * alarm を「保留の中で最も早い送信予定」に合わせる。DO の alarm は 1 本だけで上書き式。
   *
   * 張り直しも 1 行の書き込みとして数えられるので、同じ時刻なら触らない。
   * まとめ処理は送信予定を後ろへ動かすだけなので、早く鳴っても空振りして張り直すだけで害は無い。
   */
  private async syncAlarm(): Promise<void> {
    const next = this.run(() => nextNoticeAt());
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    if (current !== next) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
