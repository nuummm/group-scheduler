import { parseWeekdays, parseWeeklySlots, type SlotDefinition } from "@/lib/schedule";
import {
  DEFAULT_OWNER_ROLE,
  DEFAULT_ROLES,
  DEFAULT_SITE_SETTINGS,
  parseList,
  type SiteSettings,
} from "@/lib/site-config";
import { getRuntime } from "./runtime";

/**
 * 設定値。wrangler.jsonc の `vars` と、`wrangler secret` で入れた値から組む。
 *
 * モジュールの読み込み時ではなく DO の生成時に env から作る（Workers では env を
 * 受け取るのが DO の constructor なので、そこを唯一の入口にする）。
 */
export interface ServerConfig {
  site: SiteSettings;
  /** イベントを作るときに入れる区分。末尾に {@link ownerRole} が足される。 */
  defaultRoles: string[];
  /** 消せない区分の名前。グループの「必ず参加」の指し先として、どのイベントにも 1 つ入る。 */
  ownerRole: string;
  /** 毎週固定モードの基本のコマと曜日。イベントを作った時点の値をイベント側に写して使う。 */
  weeklySlots: SlotDefinition[];
  weekdays: string[];
  timeZone: string;
  /** Slack へのお知らせを保留して取り消せる時間。 */
  notifyDelayMs: number;
  /** 送信予定をこれ以上過ぎた保留は、送らずに捨てる。 */
  staleNoticeMs: number;
  /**
   * まとめを待つ上限。続けて来た人を 1 通にまとめるため先客の期限を後ろへ揃えるが、
   * 人が途切れず来続けると押され続けて送られないので、最初に押してからこの時間で打ち切る。
   */
  maxGroupWaitMs: number;
  slackWebhookUrl: string;
  /**
   * Slack に出る表示名とアイコン。Webhook の payload で上書きする
   * （Slack App 側で「名前とアイコンの変更」を許していない場合は無視される）。
   */
  slackBotName: string;
  slackBotEmoji: string;
}

const DEFAULT_NOTIFY_DELAY_MS = 5_000;
const MAX_NOTIFY_DELAY_MS = 10 * 60_000;

/**
 * 数値でないときは既定へ落とす。NaN のまま進むと送信予定時刻が Invalid Date になり、
 * 通知が二度と送られなくなる。空文字は Number("") === 0 なので未設定と同じ扱いにする
 * （`SLACK_NOTIFY_DELAY_MS=` と書いただけで猶予ゼロ＝即送信になるのを防ぐ）。
 * 上限を敷くのは、極端な値で送信予定時刻が Date の範囲を超え、すべてのチェックインが 500 になるため。
 */
function parseDelay(text: string | undefined): number {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return DEFAULT_NOTIFY_DELAY_MS;
  }
  const raw = Number(trimmed);
  return Number.isFinite(raw) && raw >= 0
    ? Math.min(raw, MAX_NOTIFY_DELAY_MS)
    : DEFAULT_NOTIFY_DELAY_MS;
}

function text(value: string | undefined, fallback: string): string {
  return (value ?? "").trim() || fallback;
}

export function readConfig(env: Cloudflare.Env): ServerConfig {
  const notifyDelayMs = parseDelay(env.SLACK_NOTIFY_DELAY_MS);
  const defaults = DEFAULT_SITE_SETTINGS;
  const site: SiteSettings = {
    appName: text(env.APP_NAME, defaults.appName),
    placeName: text(env.PLACE_NAME, defaults.placeName),
    terms: {
      group: text(env.TERM_GROUP, defaults.terms.group),
      role: text(env.TERM_ROLE, defaults.terms.role),
    },
  };
  const ownerRole = text(env.OWNER_ROLE, DEFAULT_OWNER_ROLE);
  return {
    site,
    // 消せない区分と同じ名前が並ぶと、どちらが「必ず参加」の指し先か見分けられない。
    defaultRoles: parseList(env.DEFAULT_ROLES, DEFAULT_ROLES).filter((name) => name !== ownerRole),
    ownerRole,
    weeklySlots: parseWeeklySlots(env.WEEKLY_SLOTS),
    weekdays: parseWeekdays(env.WEEKDAYS),
    timeZone: (env.SCHEDULER_TIME_ZONE ?? "").trim() || "Asia/Tokyo",
    notifyDelayMs,
    staleNoticeMs: Math.max(notifyDelayMs * 20, 5 * 60_000),
    maxGroupWaitMs: notifyDelayMs * 3,
    slackWebhookUrl: (env.SLACK_ATTENDANCE_WEBHOOK_URL ?? "").trim(),
    slackBotName: text(env.SLACK_BOT_NAME, site.appName),
    slackBotEmoji: text(env.SLACK_BOT_EMOJI, ":office:"),
  };
}

export function serverConfig(): ServerConfig {
  return getRuntime().config;
}
