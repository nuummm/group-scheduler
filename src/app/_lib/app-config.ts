import { DEFAULT_WEEKDAYS, DEFAULT_WEEKLY_SLOTS, type SlotDefinition } from "@/lib/schedule";
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from "@/lib/site-config";
import { api } from "./api-client";

/**
 * デプロイ先の設定のうち、画面にも要るもの。ビルドに埋め込まず API から読む
 * （組織ごとの呼び名や時間割を変えたときに、作り直さなくて済むように）。
 */
export interface AppConfig extends SiteSettings {
  timeZone: string;
  notifyDelayMs: number;
  /** 新しく作るイベントの基本のコマと曜日。既存のイベントは自分の分を持っている。 */
  weeklySlots: SlotDefinition[];
  weekdays: string[];
}

/** 読めなかったときに使う値（wrangler.jsonc の既定と同じ）。 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  ...DEFAULT_SITE_SETTINGS,
  timeZone: "Asia/Tokyo",
  notifyDelayMs: 5_000,
  weeklySlots: DEFAULT_WEEKLY_SLOTS,
  weekdays: DEFAULT_WEEKDAYS,
};

let current: AppConfig = DEFAULT_APP_CONFIG;

/**
 * 最初の描画の前に 1 度だけ読む（main.tsx）。
 *
 * 描画のあとで読むと、見出しやボタンの呼び名が既定値から設定値へ一瞬で切り替わる。
 * 読めなくても画面は出す（既定の呼び名で動かす）。
 */
export async function loadAppConfig(): Promise<void> {
  try {
    current = { ...DEFAULT_APP_CONFIG, ...(await api.get<Partial<AppConfig>>("/api/config")) };
  } catch {
    current = DEFAULT_APP_CONFIG;
  }
}

export function appConfig(): AppConfig {
  return current;
}

/** 画面での呼び名（グループ / 区分）。 */
export function terms(): SiteSettings["terms"] {
  return current.terms;
}
