import { Link2, QrCode } from "lucide-react";
import qrcode from "qrcode-generator";
import { useEffect, useState } from "react";
import { Button, Modal } from "../../../_components/ui";
import { useIslandStore } from "../../../_stores/island-store";

/**
 * このイベントの URL を配るための入り口。
 *
 * 配り方は 2 つ。**貼る**（コピー）と **見せる**（QR）。
 * 会の最中に口頭で伝える場面が多いので、画面を向けるだけで済む道を用意する。
 *
 * QR に入れるのは `window.location.href`。手元で `127.0.0.1` を見ている人が
 * それを配っても誰も開けないので、**いま自分が開いている URL をそのまま**渡す
 * （公開 URL 越しに見ていれば、その URL が入る）。
 */

/** 誤り訂正は M。印刷して貼ることは想定していないので、密度より読み取りやすさを優先。 */
const ERROR_CORRECTION = "M";

/** 静かな余白（モジュール数）。規格上 4 以上。詰めると読めない端末が出る。 */
const QUIET_ZONE = 4;

function buildPath(text: string): { path: string; size: number } | null {
  try {
    // 0 = 入る中でいちばん小さい型を自動で選ぶ。
    const qr = qrcode(0, ERROR_CORRECTION);
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) {
          // 1 マスを 1 単位として、まとめて 1 本の path にする
          // （マスごとに要素を作ると、41×41 で 1,600 個を超える）。
          parts.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
        }
      }
    }
    return { path: parts.join(""), size: count + QUIET_ZONE * 2 };
  } catch {
    // URL が長すぎて入らないなど。出せないなら何も出さない。
    return null;
  }
}

export function ShareLink() {
  const showIsland = useIslandStore((state) => state.show);
  const [url, setUrl] = useState("");
  const [qrOpen, setQrOpen] = useState(false);

  // location はサーバーには無い。描画のあとで読む。
  useEffect(() => {
    setUrl(window.location.href);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showIsland({ tone: "neutral", title: "URL をコピーしました" });
    } catch {
      showIsland({ tone: "danger", title: "URL のコピーに失敗しました" });
    }
  };

  const code = qrOpen && url ? buildPath(url) : null;
  // 127.0.0.1 / localhost は「読み取った端末自身」を指す。この QR をスマホで読んでも
  // 何も開けないので、出す前にはっきり言う（黙って出すと必ず一度は踏む）。
  const localOnly = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button onClick={() => void copy()}>
          <Link2 className="size-4" aria-hidden />
          URL をコピー
        </Button>
        <Button
          onClick={() => setQrOpen(true)}
          title="QR コードで見せる（読み取るとこのページが開きます）"
          aria-label="QR コードで見せる"
        >
          <QrCode className="size-4" aria-hidden />
          QR
        </Button>
      </span>

      <Modal open={qrOpen} title="読み取ってもらう" onClose={() => setQrOpen(false)}>
        <div className="flex flex-col items-center gap-3">
          {code ? (
            <svg
              viewBox={`0 0 ${code.size} ${code.size}`}
              // 端末のカメラで読める大きさ。小さすぎると寄らないと読めない。
              className="h-auto w-full max-w-[16rem] rounded-[var(--radius-control)] bg-white p-2"
              role="img"
              aria-label="このページの URL の QR コード"
              shapeRendering="crispEdges"
            >
              <title>このページの URL の QR コード</title>
              <path d={code.path} fill="#000000" />
            </svg>
          ) : (
            <p className="text-ink-muted text-sm">QR コードを作れませんでした。</p>
          )}
          <p className="break-all text-center text-ink-muted text-xs">{url}</p>
          {localOnly ? (
            <p className="copy-block rounded-[var(--radius-control)] bg-away-soft px-3 py-2 text-center text-[11px] text-away leading-relaxed">
              {
                "この QR は、いまこの画面を開いている端末でしか開けません（127.0.0.1 は「その端末自身」という意味です）。他の人に配るには、公開用の URL でこの画面を開き直してから QR を出してください。"
              }
            </p>
          ) : (
            <p className="copy-block text-center text-[11px] text-ink-subtle leading-relaxed">
              {"スマートフォンのカメラを向けると、このページが開きます。"}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
