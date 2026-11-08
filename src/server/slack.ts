import { buildArrivalGroupMessage, buildArrivalMessage } from "@/lib/attendance-message";
import { serverConfig } from "./config";
import { getDb, nowIso } from "./db";

/**
 * Slack への在室のお知らせ。「送る前に消せる猶予」を持たせるのがこのモジュールの主題。
 *
 * 誤って他人の席を押したとき、即座に Webhook へ POST すると間違った通知がそのまま流れる。
 * Incoming Webhook は投稿後の削除ができないので、送信自体を
 * 設定した猶予（`SLACK_NOTIFY_DELAY_MS`）だけ遅らせ、その間に取り消されたら **最初から送らない**。
 *
 * 保留は `pending_notifications` テーブルに置く。メモリ上のタイマーだけに持たせると
 * DO が眠ったりデプロイし直したりしたときに通知が消えるうえ、外から状態が見えない。
 * 行が正本で、DO の alarm は行を掃き出す係（{@link nextNoticeAt} の時刻に鳴らす）。
 */

const SLACK_TIMEOUT_MS = 5_000;

/** `空席 A` のような既定名のままなら、通知に名前を出さない運用にできる。 */
const DEFAULT_LABEL_PATTERN = /^空席 [A-Z]+$/;

export function isDefaultSeatLabel(label: string): boolean {
  return DEFAULT_LABEL_PATTERN.test(label.trim());
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/**
 * その土地の「時」。サーバーの時計が UTC でも、その場所の朝はその場所の朝。
 * 使うのは言い方を決めるためだけで、文には出さない。
 */
function currentHour(): number {
  const { timeZone } = serverConfig();
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false });
    clocks.set(timeZone, clock);
  }
  const hour = Number(clock.format(new Date()));
  return Number.isFinite(hour) ? hour : 0;
}

function buildMessage(label: string, presentCount: number): string {
  return buildArrivalMessage({
    label,
    named: !isDefaultSeatLabel(label),
    presentCount,
    hour: currentHour(),
    place: serverConfig().site.placeName,
  });
}

/** 同じ猶予のあいだに溜まったぶんを 1 通にする。 */
function buildGroupMessage(labels: string[], presentCount: number): string {
  return buildArrivalGroupMessage({
    arrivals: labels.map((label) => ({ label, named: !isDefaultSeatLabel(label) })),
    presentCount,
    hour: currentHour(),
    place: serverConfig().site.placeName,
  });
}

export async function postToSlack(text: string): Promise<void> {
  const { slackWebhookUrl, slackBotName, slackBotEmoji } = serverConfig();
  if (!slackWebhookUrl) {
    console.info("[scheduler] Slack webhook 未設定のため送信をスキップ:", text);
    return;
  }
  try {
    const response = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(slackBotName ? { username: slackBotName } : {}),
        ...(slackBotEmoji ? { icon_emoji: slackBotEmoji } : {}),
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[scheduler] Slack 通知が失敗:", response.status, await response.text());
    }
  } catch (error) {
    // 通知の失敗で席の操作まで失敗させない（Slack が詰まっても席の操作は固まらない）。
    console.error("[scheduler] Slack 通知が失敗:", error);
  }
}

/**
 * 送信期限を過ぎた保留を取り出し、送る文面を返す（送るものが無ければ null）。
 * 送信そのものは呼び出し側（DO の alarm）が待つ。待たずに投げっぱなしにすると、
 * 送り終える前に DO が眠って通知が消えうる。
 *
 * 行を先に DELETE してから送る（取り出しと同時に所有権を取る）。送信中に届いた取り消しは
 * すでに間に合っていないので、ここで二重送信を防ぐ方を優先する。
 *
 * **同じ回で複数人ぶんが期限を迎えたら 1 通にまとめる。** 会の開始前などに数人が
 * 続けて席を押すと、1 人ずつ送っていては Slack が流れる。知りたいのは
 * 「いま行ったら誰かいるか」なので、人数ぶん通知が出ること自体には情報がない。
 *
 * 取り消しは行の DELETE なので、**まとめの対象になるのは猶予を生き延びた席だけ**。
 * 複数人が同時に来て 1 人だけ押し間違えて取り消した場合、その席は行ごと消えていて
 * ここには現れない（残りの人の通知は正しく出る）。
 */
export function takeDueNotification(): string | null {
  const db = getDb();
  const due = db
    .prepare("SELECT seat_key, seat_label, send_at FROM pending_notifications WHERE send_at <= ?")
    .all(nowIso()) as { seat_key: string; seat_label: string; send_at: string }[];
  if (due.length === 0) {
    return null;
  }
  const remove = db.prepare("DELETE FROM pending_notifications WHERE seat_key = ?");
  const presentCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM attendance_seats WHERE seat_kind = 'seat' AND status = 'present'",
      )
      .get() as { count: number }
  ).count;

  const staleBefore = Date.now() - serverConfig().staleNoticeMs;
  // 送る資格を取れた席だけを集める。DELETE が 0 件＝別の経路が先に取り消した／送った。
  const claimedLabels: string[] = [];
  for (const row of due) {
    const claimed = remove.run(row.seat_key);
    if (claimed.changes === 0) {
      continue;
    }
    if (Date.parse(row.send_at) < staleBefore) {
      console.info("[scheduler] 期限を大きく過ぎた在室のお知らせを破棄:", row.seat_label);
      continue;
    }
    claimedLabels.push(row.seat_label);
  }
  if (claimedLabels.length === 0) {
    return null;
  }
  return claimedLabels.length === 1 && claimedLabels[0] !== undefined
    ? buildMessage(claimedLabels[0], presentCount)
    : buildGroupMessage(claimedLabels, presentCount);
}

/** 次に送る保留の時刻（ミリ秒）。保留が無ければ null。DO の alarm はここに合わせる。 */
export function nextNoticeAt(): number | null {
  const row = getDb().prepare("SELECT MIN(send_at) AS next FROM pending_notifications").get() as {
    next: string | null;
  };
  return row.next ? Date.parse(row.next) : null;
}

/**
 * 在室のお知らせを予約する。同じ席の保留があれば置き換える
 * （在室 → 不在 → 在室を短時間で繰り返しても通知は 1 通に収まる）。
 */
export function scheduleCheckInNotice(seatKey: string, seatLabel: string, eventId: number): string {
  const { notifyDelayMs, maxGroupWaitMs } = serverConfig();
  // 保存は秒精度なので切り上げる。切り捨てると取り消せる猶予が最大 1 秒縮む。
  const sendAt = `${new Date(Math.ceil((Date.now() + notifyDelayMs) / 1000) * 1000).toISOString().slice(0, 19)}Z`;
  const db = getDb();

  // いま待っているグループの締め切り。最初のひとりが押した時刻で決まる。
  // 人が途切れず来続けても、ここまでで打ち切って送る。
  const oldest = (
    db
      .prepare("SELECT MIN(created_at) AS oldest FROM pending_notifications WHERE seat_key <> ?")
      .get(seatKey) as { oldest: string | null }
  ).oldest;

  db.prepare(`
      INSERT INTO pending_notifications (seat_key, seat_label, event_id, send_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(seat_key) DO UPDATE SET
        seat_label = excluded.seat_label,
        event_id = excluded.event_id,
        send_at = excluded.send_at,
        created_at = excluded.created_at
    `).run(seatKey, seatLabel, eventId, sendAt, nowIso());

  // 先に待っている人の期限を、いま来た人に合わせて後ろへ揃える。揃えないと
  // 別々の回に掃き出されて、続けて来ただけで通知が人数ぶん出る。
  //
  // **早める方向には動かさない**（送信が猶予より前に出ると取り消せなくなる）。
  // 待たされる側は猶予が延びるだけなので、取り消せる時間は縮まない。
  //
  // 締め切りに間に合わないなら、**先客には一切触らない**。行ごとに揃える / 揃えないを
  // 判じると、締め切りを越えた人から 1 人ずつこぼれて単独の通知になる（実測で確認）。
  // ここで手を引けば、先客はまとまったまま送られ、いま来た人は次のグループの起点になる。
  const withinDeadline =
    oldest === null || Date.parse(sendAt) <= Date.parse(oldest) + maxGroupWaitMs;
  if (withinDeadline) {
    db.prepare("UPDATE pending_notifications SET send_at = ? WHERE send_at < ?").run(
      sendAt,
      sendAt,
    );
  }
  return sendAt;
}

/** 保留中の通知を取り消す。まだ送っていなければ、Slack には何も残らない。 */
export function cancelPendingNotice(seatKey: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM pending_notifications WHERE seat_key = ?")
    .run(seatKey);
  return result.changes > 0;
}

export function listPendingNotices(): {
  seatKey: string;
  seatLabel: string;
  eventId: number;
  sendAt: string;
  remainingMs: number;
}[] {
  const rows = getDb()
    .prepare(
      "SELECT seat_key, seat_label, event_id, send_at FROM pending_notifications ORDER BY send_at ASC",
    )
    .all() as {
    seat_key: string;
    seat_label: string;
    event_id: number;
    send_at: string;
  }[];
  const now = Date.now();
  return rows.map((row) => ({
    seatKey: row.seat_key,
    seatLabel: row.seat_label,
    eventId: row.event_id,
    sendAt: row.send_at,
    // 端末の時計を当てにしない。こちらで測った残りを渡す。
    remainingMs: Math.max(0, Date.parse(row.send_at) - now),
  }));
}
