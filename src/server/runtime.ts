import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerConfig } from "./config";
import type { Db } from "./db";

/**
 * Durable Object の中で処理が使う道具一式（DB・設定・読み取りの控え）。
 *
 * ドメインのモジュールは `getDb()` を引数なしで呼ぶ作りなので、どの DO の storage を
 * 使うかをここから引く。モジュール変数に 1 つ置く形にしないのは、同じ isolate に
 * 別の DO（テストで作るものなど）が載ったとき、`await` をまたいで取り違えるため。
 */
export interface Runtime {
  storage: DurableObjectStorage;
  db: Db;
  config: ServerConfig;
  /** 読み取り結果の控え。書き込みがあるたびに丸ごと捨てる（{@link memo}）。 */
  memo: Map<string, unknown>;
}

const current = new AsyncLocalStorage<Runtime>();

export function runWithRuntime<T>(runtime: Runtime, run: () => T): T {
  return current.run(runtime, run);
}

export function getRuntime(): Runtime {
  const runtime = current.getStore();
  if (!runtime) {
    throw new Error("Durable Object の外から DB を触ろうとしました。");
  }
  return runtime;
}

/**
 * 読み取り経路の結果を、次の書き込みまで使い回す。
 *
 * 無料枠は「1 日に読んだ行数」で数える。在室の盤面は数秒ごとに、日程調整の画面は
 * 開いている人数ぶん取り直しに来るので、毎回 DB を読むと枠をすぐ食い切る。
 * DB を変えるのはこの DO だけなので、書き込みのたびに全部捨てれば古い値は返らない。
 *
 * **トランザクションの中からは使わない**（未確定の内容が控えに残る）。
 */
export function memo<T>(key: string, compute: () => T): T {
  const store = getRuntime().memo;
  if (store.has(key)) {
    return store.get(key) as T;
  }
  const value = compute();
  store.set(key, value);
  return value;
}

/** 書き込みの中で組んだ値を、確定のあとに控えへ置く（次の取り直しで組み直させない）。 */
export function rememberMemo(key: string, value: unknown): void {
  getRuntime().memo.set(key, value);
}

export function invalidateMemo(): void {
  getRuntime().memo.clear();
}
