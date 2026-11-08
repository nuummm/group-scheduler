/**
 * 組織ごとに変わる呼び名。サーバーが設定（wrangler の vars）から組み、画面へは
 * `/api/config` で渡す。画面とサーバーで同じ言葉を使うよう、既定値はここ 1 か所に置く。
 */

export interface SiteTerms {
  /** 開催枠を割り当てる単位（ゼミ・勉強会・定例など）。1 人が複数に属せる。 */
  group: string;
  /** 1 人 1 つだけ持つ区分（学年・職位・チームなど）。 */
  role: string;
}

export interface SiteSettings {
  /** ヘッダーとタブの題名に出す名前。 */
  appName: string;
  /** 在室ボードが指す場所の呼び名（部屋・ラボ・オフィスなど）。お知らせの文に入る。 */
  placeName: string;
  terms: SiteTerms;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  appName: "Group Scheduler",
  placeName: "部屋",
  terms: { group: "グループ", role: "区分" },
};

/** 区分の既定値。イベントを作るたびにこの並びで入る。 */
export const DEFAULT_ROLES = ["メンバー"];

/** どのグループにも関わる役割。消せない区分として必ず 1 つ入る。 */
export const DEFAULT_OWNER_ROLE = "リーダー";

/** `a, b ,,c` を `["a", "b", "c"]` にする。空なら既定値を返す。 */
export function parseList(text: string | undefined, fallback: string[]): string[] {
  const items = (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : fallback;
}
