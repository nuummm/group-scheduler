import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clientAddressKey, LOCKOUT_POLICY, lockedUntil, recordFailure } from "@/server/auth-guard";
import { readConfig } from "@/server/config";
import { createDb } from "@/server/db";
import { runWithRuntime } from "@/server/runtime";
import { store } from "./helpers";

/** DO の中で、時刻を引数で与えてロックアウトの記録を直接たたく。 */
function inStore<T>(task: () => T): Promise<T> {
  return runInDurableObject(store(), (_instance, state) =>
    runWithRuntime(
      {
        storage: state.storage,
        db: createDb(state.storage.sql),
        config: readConfig(env),
        memo: new Map(),
      },
      task,
    ),
  );
}

describe("ロックアウトの時間経過", () => {
  const { maxFailures, windowMs, lockMs } = LOCKOUT_POLICY;

  it("窓を過ぎた失敗は数えず、ロックは期限で解け、解けたあとは数え直す", async () => {
    await inStore(() => {
      const key = "test:expiry";
      const t0 = 1_000_000_000_000;
      for (let count = 1; count < maxFailures; count += 1) {
        expect(recordFailure(key, t0)).toBeNull();
      }
      // 窓の外に出た 9 回は消え、この 1 回だけが残る。
      const t1 = t0 + windowMs + 1;
      expect(recordFailure(key, t1)).toBeNull();
      for (let count = 2; count < maxFailures; count += 1) {
        expect(recordFailure(key, t1)).toBeNull();
      }
      const until = t1 + lockMs;
      expect(recordFailure(key, t1)).toBe(until);

      // ロック中の失敗は同じ解除時刻を返し、延長しない。
      expect(recordFailure(key, t1 + 1)).toBe(until);
      expect(lockedUntil(key, until - 1)).toBe(until);

      expect(lockedUntil(key, until)).toBeNull();
      expect(recordFailure(key, until)).toBeNull();
    });
  });
});

describe("送り元のキー", () => {
  it("IPv6 は /64 にまとめ、IPv4 はアドレスごとに分ける", () => {
    const key = clientAddressKey("2001:db8:1:2::1");
    expect(key).toBe("ip:2001:db8:1:2::/64");
    expect(clientAddressKey("2001:0DB8:0001:0002:ffff:0:0:9")).toBe(key);
    expect(clientAddressKey("2001:db8:1:3::1")).not.toBe(key);
    expect(clientAddressKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
    expect(clientAddressKey("203.0.113.1")).toBe("ip:203.0.113.1");
    expect(clientAddressKey("::ffff:203.0.113.1")).toBe("ip:203.0.113.1");
    expect(clientAddressKey(null)).toBe("ip:local");
  });
});
