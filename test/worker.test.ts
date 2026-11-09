import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AttendanceView, EventView } from "@/lib/types";
import { LOCKOUT_POLICY } from "@/server/auth-guard";
import { checkBasicAuth } from "@/worker/auth";
import { BASIC_USER, basicAuth, call, json, send, store } from "./helpers";

describe("入口の合言葉", () => {
  it("合言葉なしは 401 で、ブラウザに入力欄を出させる", async () => {
    const response = await call("/api/attendance", { headers: { authorization: "" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(await response.json()).toEqual({ error: "合言葉が必要です。" });
  });

  it("違う合言葉も 401、正しければ通る", async () => {
    const wrong = await call("/api/attendance", {
      headers: { authorization: basicAuth(BASIC_USER, "nope") },
    });
    expect(wrong.status).toBe(401);
    expect((await call("/api/attendance")).status).toBe(200);
  });

  it("画面の HTML も合言葉の内側にある", async () => {
    const response = await call("/attendance", { headers: { authorization: "" } });
    expect(response.status).toBe(401);
  });

  it("死活監視だけは合言葉なしで通る（GET と HEAD だけ）", async () => {
    const response = await call("/api/healthz", { headers: { authorization: "" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    const head = await call("/api/healthz", { method: "HEAD", headers: { authorization: "" } });
    expect(head.status).toBe(200);
    const post = await call("/api/healthz", { method: "POST", headers: { authorization: "" } });
    expect(post.status).toBe(401);
  });

  it("他サイトからのフォーム送信では書き込めない", async () => {
    const form = await call("/api/attendance/clear", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(form.status).toBe(403);
    const crossSite = await call("/api/attendance/clear", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    const sameSite = await call("/api/attendance/clear", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    expect(sameSite.status).toBe(200);
  });

  it("合言葉が未設定なら誰も通さない（設定し忘れで全公開にしない）", () => {
    const request = new Request("https://app.test/", { headers: { authorization: basicAuth() } });
    const denied = checkBasicAuth(request, { ...env, SCHEDULER_BASIC_PASSWORD: "" });
    expect(denied?.status).toBe(503);
  });

  it("日本語の合言葉も通る（UTF-8 で読む）", () => {
    const request = new Request("https://app.test/", {
      headers: { authorization: basicAuth(BASIC_USER, "みんなの合言葉") },
    });
    expect(checkBasicAuth(request, { ...env, SCHEDULER_BASIC_PASSWORD: "みんなの合言葉" })).toBe(
      null,
    );
  });

  it("応答にセキュリティ用のヘッダーが付く", async () => {
    const response = await call("/api/attendance");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("API の振り分け", () => {
  it("無い経路は JSON の 404、合わないメソッドは 405", async () => {
    const missing = await json("/api/nothing-here");
    expect(missing.status).toBe(404);
    expect(missing.body).toHaveProperty("error");
    expect((await call("/api/attendance", { method: "PUT", body: "{}" })).status).toBe(405);
  });

  it("画面の設定を返す（呼び名と時間割は wrangler.jsonc の vars から）", async () => {
    const { body } = await json<Record<string, unknown>>("/api/config");
    expect(body).toMatchObject({
      appName: "Group Scheduler",
      placeName: "部屋",
      terms: { group: "グループ", role: "区分" },
      timeZone: "Asia/Tokyo",
      notifyDelayMs: 5000,
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
    });
    expect(body.weeklySlots).toHaveLength(6);
  });
});

describe("初期データ", () => {
  it("空の DB には 4 島 16 席と見本のイベントが入る", async () => {
    const attendance = await json<AttendanceView>("/api/attendance");
    expect(attendance.body.islands).toHaveLength(4);
    expect(attendance.body.summary.totalSeatCount).toBe(16);
    const events = await json<{ events: { slug: string }[] }>("/api/events");
    expect(events.body.events.map((event) => event.slug)).toContain("demo");
  });
});

async function createWeeklyEvent(title: string): Promise<string> {
  const created = await send("POST", "/api/events", { title, scheduleMode: "weekly" });
  expect(created.status).toBe(201);
  return (created.body as { slug: string }).slug;
}

describe("日程調整", () => {
  it("登録・予定の保存・本人の取り直しが通り、保存すると版が変わる", async () => {
    const slug = await createWeeklyEvent("テスト用の調整");
    const before = await json<{ revision: string }>(`/api/events/${slug}/revision`);

    const joined = await send("POST", `/api/events/${slug}/participants`, { name: "やまと" });
    expect(joined.status).toBe(201);
    const { participantId, editKey } = joined.body as { participantId: number; editKey: string };

    const saved = await send("PUT", `/api/events/${slug}/schedule`, {
      participantId,
      editKey,
      name: "やまと",
      busyCells: [{ columnKey: "mon", slot: 1 }],
    });
    expect(saved.status).toBe(200);

    const after = await json<{ revision: string }>(`/api/events/${slug}/revision`);
    expect(after.body.revision).not.toBe(before.body.revision);

    // 編集キーはヘッダーで渡す。URL には載せない。
    const mine = await json<EventView>(`/api/events/${slug}?participantId=${participantId}`, {
      headers: { "X-Edit-Key": editKey },
    });
    expect(mine.body.currentParticipant?.name).toBe("やまと");
    expect(mine.body.revision).toBe(after.body.revision);
    const cell = mine.body.summary.cells.find((c) => c.columnKey === "mon" && c.slot === 1);
    expect(cell?.busyCount).toBe(1);

    // 予定を入れ替えても、残したマス・外したマス・足したマスが正しく反映される（差分で書く）。
    const resaved = await send("PUT", `/api/events/${slug}/schedule`, {
      participantId,
      editKey,
      name: "やまと",
      busyCells: [
        { columnKey: "tue", slot: 2 },
        { columnKey: "wed", slot: 3 },
      ],
    });
    expect(resaved.status).toBe(200);
    const reread = await json<EventView>(`/api/events/${slug}?participantId=${participantId}`, {
      headers: { "X-Edit-Key": editKey },
    });
    expect(
      reread.body.currentParticipant?.busyCells.map((c) => `${c.columnKey}:${c.slot}`).sort(),
    ).toEqual(["tue:2", "wed:3"]);

    const anonymous = await json<EventView>(`/api/events/${slug}?participantId=${participantId}`);
    expect(anonymous.body.currentParticipant).toBeNull();
  });

  it("パスワード付きの参加者は、正しいパスワードでだけ開ける（workerd の scrypt で照合）", async () => {
    const slug = await createWeeklyEvent("パスワードの確認");
    const joined = await send("POST", `/api/events/${slug}/participants`, {
      name: "さとし",
      password: "ひみつ",
    });
    const { participantId } = joined.body as { participantId: number };
    const wrong = await send("POST", `/api/events/${slug}/participants/access`, {
      participantId,
      password: "ちがう",
    });
    expect(wrong.status).toBe(403);
    const right = await send("POST", `/api/events/${slug}/participants/access`, {
      participantId,
      password: "ひみつ",
    });
    expect(right.status).toBe(200);
  });

  it("消したイベントは 404 になる（控えが残らない）", async () => {
    const slug = await createWeeklyEvent("消すイベント");
    expect((await json(`/api/events/${slug}`)).status).toBe(200);
    expect((await send("DELETE", `/api/events/${slug}`)).status).toBe(200);
    expect((await json(`/api/events/${slug}`)).status).toBe(404);
    expect((await json(`/api/events/${slug}/revision`)).status).toBe(404);
  });
});

async function pendingCount(): Promise<number> {
  return runInDurableObject(store(), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_notifications")
      .one();
    return row.count;
  });
}

describe("在室のお知らせの保留", () => {
  it("在室にすると保留と alarm が入り、押し直すと両方消える", async () => {
    const seatKey = "northwest-1";
    const arrived = await send("POST", `/api/attendance/seats/${seatKey}`, {});
    expect(arrived.status).toBe(200);
    expect((arrived.body as unknown as AttendanceView).pending).toHaveLength(1);
    expect(await pendingCount()).toBe(1);
    expect(await runInDurableObject(store(), (_i, state) => state.storage.getAlarm())).not.toBe(
      null,
    );

    await send("POST", `/api/attendance/seats/${seatKey}`, {});
    expect(await pendingCount()).toBe(0);
    expect(await runInDurableObject(store(), (_i, state) => state.storage.getAlarm())).toBe(null);
  });

  it("期限が来た保留は alarm で掃き出される", async () => {
    const seatKey = "northwest-2";
    await send("POST", `/api/attendance/seats/${seatKey}`, {});
    // 送信予定を過去へずらして、alarm を今すぐ鳴らす。
    await runInDurableObject(store(), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE pending_notifications SET send_at = ?",
        `${new Date(Date.now() - 1000).toISOString().slice(0, 19)}Z`,
      );
    });
    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect(await pendingCount()).toBe(0);
    await send("POST", `/api/attendance/seats/${seatKey}`, {});
  });

  it("取り消すと席が戻り、保留も消える", async () => {
    const seatKey = "northwest-3";
    const arrived = await send("POST", `/api/attendance/seats/${seatKey}`, {});
    const eventId = (arrived.body as unknown as AttendanceView).pending[0]?.eventId;
    const undone = await send("POST", `/api/attendance/seats/${seatKey}/undo`, { eventId });
    expect(undone.status).toBe(200);
    const seat = (undone.body as unknown as AttendanceView).islands
      .flatMap((island) => island.seats)
      .find((s) => s.key === seatKey);
    expect(seat?.status).toBe("offsite");
    expect(await pendingCount()).toBe(0);
  });

  it("盤面の取り直しは、書き込みのたびに新しい状態になる", async () => {
    const first = await json<AttendanceView>("/api/attendance");
    await send("PATCH", "/api/attendance/seats/northeast-1", { label: "新しい席名" });
    const second = await json<AttendanceView>("/api/attendance");
    expect(second.body.revision).not.toBe(first.body.revision);
    const seat = second.body.islands.flatMap((i) => i.seats).find((s) => s.key === "northeast-1");
    expect(seat?.label).toBe("新しい席名");
  });
});

describe("区分", () => {
  it("新しいイベントには既定の区分と、消せない主宰者の区分が入る", async () => {
    const slug = await createWeeklyEvent("区分の確認");
    const view = await json<EventView>(`/api/events/${slug}`);
    const grades = view.body.event.grades;
    expect(grades.map((grade) => grade.name)).toEqual(["メンバー", "リーダー"]);
    const owner = grades.find((grade) => grade.locked);
    expect(owner?.name).toBe("リーダー");

    const removed = await send("DELETE", `/api/events/${slug}/grades/${owner?.id}`);
    expect(removed.status).toBe(400);
    const renamed = await send("PATCH", `/api/events/${slug}/grades/${owner?.id}`, {
      name: "別の名前",
    });
    expect(renamed.status).toBe(400);
  });

  it("イベントは作った時点の時間割を持つ", async () => {
    const slug = await createWeeklyEvent("時間割の確認");
    const view = await json<EventView>(`/api/events/${slug}`);
    expect(view.body.event.columns.map((column) => column.key)).toEqual([
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
    ]);
    expect(view.body.event.slotDefinitions.map((slot) => slot.label)).toEqual([
      "1限",
      "2限",
      "3限",
      "4限",
      "5限",
      "6限",
    ]);
  });

  it("追加コマは基本のコマの終わりより後にしか置けない", async () => {
    const slug = await createWeeklyEvent("追加コマの確認");
    const early = await send("PATCH", `/api/events/${slug}`, {
      extraSlots: [{ label: "7限", start: "19:00", end: "20:00" }],
    });
    expect(early.status).toBe(400);
    const late = await send("PATCH", `/api/events/${slug}`, {
      extraSlots: [{ label: "7限", start: "19:40", end: "21:10" }],
    });
    expect(late.status).toBe(200);
  });
});

describe("認証失敗のロックアウト", () => {
  const max = LOCKOUT_POLICY.maxFailures;

  function from(ip: string, authorization = basicAuth()) {
    return { headers: { "cf-connecting-ip": ip, authorization } };
  }

  it(`同じ送り元から ${max} 回失敗すると、正しい合言葉でも 429 になる`, async () => {
    const ip = "203.0.113.10";
    for (let attempt = 1; attempt < max; attempt += 1) {
      const wrong = await call("/api/attendance", from(ip, basicAuth(BASIC_USER, "nope")));
      expect(wrong.status).toBe(401);
    }
    const last = await call("/api/attendance", from(ip, basicAuth(BASIC_USER, "nope")));
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);

    const right = await call("/api/attendance", from(ip));
    expect(right.status).toBe(429);
    // 誤答も同じ 429。応答の違いで正答が分かってはいけない。
    const wrongWhileLocked = await call("/api/attendance", from(ip, basicAuth(BASIC_USER, "nope")));
    expect(wrongWhileLocked.status).toBe(429);
    // 画面（静的ファイル）も同じ扱い。
    expect((await call("/attendance", from(ip))).status).toBe(429);
    // 別の送り元は巻き込まない。
    expect((await call("/api/attendance", from("203.0.113.11"))).status).toBe(200);
    // 死活監視は合言葉の外なので止めない。
    expect((await call("/api/healthz", from(ip, ""))).status).toBe(200);
  });

  it("IPv6 では同じ /64 の中でアドレスを替えても数え直さない", async () => {
    for (let attempt = 1; attempt <= max; attempt += 1) {
      await call(
        "/api/attendance",
        from(`2001:db8:10:20::${attempt}`, basicAuth(BASIC_USER, "nope")),
      );
    }
    expect((await call("/api/attendance", from("2001:db8:10:20::ffff"))).status).toBe(429);
    expect((await call("/api/attendance", from("2001:db8:10:21::1"))).status).toBe(200);
  });

  it("合言葉を付けていない要求と、成功した要求は数えない", async () => {
    const ip = "203.0.113.20";
    for (let attempt = 0; attempt < max * 2; attempt += 1) {
      expect((await call("/api/attendance", from(ip, ""))).status).toBe(401);
      expect((await call("/api/attendance", from(ip))).status).toBe(200);
    }
    for (let attempt = 1; attempt < max; attempt += 1) {
      await call("/api/attendance", from(ip, basicAuth(BASIC_USER, "nope")));
    }
    expect((await call("/api/attendance", from(ip))).status).toBe(200);
  });

  it("外から照合用のヘッダーを付けても、別の送り元のロックを外せない", async () => {
    const ip = "203.0.113.30";
    for (let attempt = 0; attempt < max; attempt += 1) {
      await call("/api/attendance", from(ip, basicAuth(BASIC_USER, "nope")));
    }
    const spoofed = await call("/api/attendance", {
      headers: { "cf-connecting-ip": ip, authorization: basicAuth(), "x-guard-key": "ip:other" },
    });
    expect(spoofed.status).toBe(429);
  });

  it("参加者のパスワードにも効き、ロック中は正しいパスワードでも 429", async () => {
    const slug = await createWeeklyEvent("パスワードのロック");
    const joined = await send("POST", `/api/events/${slug}/participants`, {
      name: "みなと",
      password: "ひみつ",
    });
    const { participantId } = joined.body as { participantId: number };
    const attempt = (password: string) =>
      send("POST", `/api/events/${slug}/participants/access`, { participantId, password });

    for (let count = 1; count < max; count += 1) {
      expect((await attempt("ちがう")).status).toBe(403);
    }
    const last = await attempt("ちがう");
    expect(last.status).toBe(429);
    expect((await attempt("ひみつ")).status).toBe(429);
    // 削除の経路も同じ鍵で止まる。
    const removed = await send("DELETE", `/api/events/${slug}/participants/${participantId}`, {
      password: "ひみつ",
    });
    expect(removed.status).toBe(429);
  });
});
