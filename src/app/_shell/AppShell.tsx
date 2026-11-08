import { Armchair, CalendarDays } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { AppIsland } from "../_components/AppIsland";
import { appConfig } from "../_lib/app-config";
import { readLastEventPath } from "../_lib/last-event";
import { isNavItemActive, NAV_ITEMS, type NavIcon } from "./nav";

/**
 * アプリ全体の外枠。細いヘッダー 1 本と、その下の本文だけ。
 *
 * 機能が 3 つしかないので常設サイドバーは置かない（画面幅は表に回す）。
 * タブはセグメント型にして「いまどちらを見ているか」を色ではなく面で示す。
 */

const ICONS: Record<NavIcon, typeof CalendarDays> = {
  calendar: CalendarDays,
  seat: Armchair,
};

/**
 * 最後に開いていたイベントのパス。
 *
 * 在室状況を見て戻ってきたときに一覧からやり直すのは無駄なので、日程調整タブは
 * その続きへ戻す。ただし日程調整タブを見ているあいだは一覧への出口として使いたいので、
 * そのときは既定の `/` のまま。
 *
 * **ここでは読むだけ。書くのはイベントが実在して開けたときだけ**（`EventWorkspace`）。
 * ここで `/events/...` を見た瞬間に書くと、404 の画面が「忘れる」処理をした直後に
 * 親のこの effect が書き戻し、消えたイベントへ延々と連れ戻される。
 */
function useLastEventPath(pathname: string): string | null {
  const [lastPath, setLastPath] = useState<string | null>(null);

  useEffect(() => {
    // pathname を依存に入れるのは、画面を移ったときに読み直したいから
    // （イベントを開いた直後にタブを移ると、覚えたばかりの続きを拾える）。
    void pathname;
    setLastPath(readLastEventPath());
  }, [pathname]);

  return lastPath;
}

/**
 * タブの下敷き（緑の面）の位置と幅。
 *
 * タブごとに背景を塗ると、切り替わった瞬間に色が飛び移るだけで、どこから
 * どこへ移ったのかが読めない。面を 1 枚だけ置いて滑らせると、移動そのものが見える。
 *
 * 幅は文字の長さで変わるので、レイアウトから測る。フォントの差し替えや
 * 画面幅の変化でずれるため、`ResizeObserver` で測り直す。
 */
function useTabIndicator(pathname: string) {
  // 下敷きを置く箱（nav）を基準に測る。タブの箱そのものを写し取るので、
  // 縦位置や高さを CSS 側で当て込み直す必要がない。
  const listRef = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>("[aria-current='page']");
    if (!list || !active) {
      setBox(null);
      return;
    }
    const listBox = list.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    setBox({
      left: activeBox.left - listBox.left,
      top: activeBox.top - listBox.top,
      width: activeBox.width,
      height: activeBox.height,
    });
  }, []);

  // 描画のあとではなく確定前に測る。useEffect だと 1 フレーム分ずれた位置が見える。
  // pathname を依存に入れるのは、タブが変われば当たる位置も変わるから。
  useLayoutEffect(() => {
    void pathname;
    measure();
  }, [measure, pathname]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    // 中身の幅が変わる（フォントの差し替え、札の出し入れ）ときも測り直す。
    for (const link of list.querySelectorAll("a")) {
      observer.observe(link);
    }
    return () => observer.disconnect();
  }, [measure]);

  return { listRef, box };
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const lastEventPath = useLastEventPath(pathname);
  const { listRef, box } = useTabIndicator(pathname);
  // 初回だけは滑らせない（読み込み直後に左端から飛んでくるのを避ける）。
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (box) setSettled(true);
  }, [box]);

  return (
    <div className="min-h-dvh">
      <AppIsland />
      <header className="sticky top-0 z-30 border-line border-b bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="min-w-0 shrink-0">
            <span className="block truncate font-semibold text-ink text-sm">
              {appConfig().appName}
            </span>
          </Link>
          <nav aria-label="機能切り替え" className="relative ml-auto" ref={listRef}>
            {/* 下敷き。タブそのものは透明のままにして、この 1 枚だけが動く。
                ul の中には li 以外を置けないので、外側に重ねる。 */}
            {box && (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute top-0 left-0 rounded-full bg-accent",
                  settled && "transition-[transform,width] duration-300 ease-[var(--ease-swift)]",
                )}
                style={{
                  transform: `translate(${box.left}px, ${box.top}px)`,
                  width: box.width,
                  height: box.height,
                }}
              />
            )}
            <ul className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
              {NAV_ITEMS.map((item) => {
                const Icon = ICONS[item.icon];
                const active = isNavItemActive(item, pathname);
                // 日程調整タブは、他のタブから戻るときだけ「続き」へ寄せる。
                const href =
                  item.href === "/" && !active && lastEventPath ? lastEventPath : item.href;
                return (
                  <li key={item.href}>
                    <Link
                      to={href}
                      aria-current={active ? "page" : undefined}
                      title={item.description}
                      className={cn(
                        // 下敷きより手前に出す。同じ層だと緑の面に文字が隠れる。
                        "relative flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-xs transition-colors",
                        active
                          ? "text-white"
                          : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {item.label}
                      {item.badge && (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-px text-[9px] leading-tight",
                            active ? "bg-white/25" : "bg-surface-muted text-ink-subtle",
                          )}
                        >
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
