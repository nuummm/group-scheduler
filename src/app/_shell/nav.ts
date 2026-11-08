/** 画面の一覧。ヘッダーのタブはここだけを見る（増減のたびに複数箇所を直さない）。 */

export type NavIcon = "calendar" | "seat";

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
  description: string;
  /** 完成していない機能に添える札。付いているあいだは作りかけだと分かるようにする。 */
  badge?: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "日程調整",
    href: "/",
    icon: "calendar",
    description: "イベントごとに URL を配って空きコマを集める",
  },
  {
    label: "在室状況",
    href: "/attendance",
    icon: "seat",
    description: "いまその場にいる人を席ベースで共有する",
  },
];

/** 現在地の判定。`/events/...` は日程調整タブの配下として扱う。 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") {
    return pathname === "/" || pathname.startsWith("/events");
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
