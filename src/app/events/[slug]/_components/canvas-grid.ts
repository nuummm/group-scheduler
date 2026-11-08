/**
 * 表を画像にするときの共通部分。
 *
 * DOM を写し取るのではなく、同じデータから canvas に描き直す。画面の見た目を撮る方式は
 * 外部ライブラリが要るうえ、横スクロールで隠れている列が欠ける。
 * 全体の予定表と割り当て結果で、寸法と罫線の引き方をここに揃える。
 */

export const GRID = {
  headerHeight: 34,
  rowHeight: 48,
  slotColumnWidth: 96,
  dayColumnWidth: 132,
  titleHeight: 58,
  padding: 16,
  line: "#e3e2df",
  ink: "#2b2a28",
  inkSubtle: "#8c8a86",
  headerFill: "#f4f3f1",
} as const;

/** 画素数の上限。これを超えると toBlob が null を返すブラウザがある。 */
const MAX_CANVAS_AREA = 16_000_000;

export interface CanvasHandle {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** 表の上端（見出しの下）。 */
  gridTop: number;
  font: (size: number, weight?: string) => string;
}

/** 白地のキャンバスを用意し、上に題と補足を書いた状態で返す。 */
export function startCanvas(input: {
  columnCount: number;
  rowCount: number;
  title: string;
  caption: string;
}): CanvasHandle {
  const width = GRID.padding * 2 + GRID.slotColumnWidth + GRID.dayColumnWidth * input.columnCount;
  const height =
    GRID.padding * 2 + GRID.titleHeight + GRID.headerHeight + GRID.rowHeight * input.rowCount;
  // 期間指定モードは 61 列になる。等倍でも面積が大きいので、倍率は面積で頭打ちにする。
  const scale = Math.min(
    2,
    window.devicePixelRatio || 1,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("画像を作れませんでした。");
  }
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "middle";

  const font = (size: number, weight = "400") =>
    `${weight} ${size}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;

  // 題も補足も長くなりうる（イベント名は 80 文字、補足は絞り込みの連結）。
  // 幅の上限を渡さないと、右端をはみ出して画像の外へ切れて出る。
  const textWidth = width - GRID.padding * 2;
  ctx.fillStyle = GRID.ink;
  ctx.font = font(16, "600");
  ctx.textAlign = "left";
  ctx.fillText(input.title, GRID.padding, GRID.padding + 12, textWidth);
  ctx.fillStyle = GRID.inkSubtle;
  ctx.font = font(11);
  ctx.fillText(input.caption, GRID.padding, GRID.padding + 34, textWidth);

  return { canvas, ctx, width, height, gridTop: GRID.padding + GRID.titleHeight, font };
}

/** 罫線を引く。塗りのあとに重ねると、マスの境目が均一になる。 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  input: { width: number; height: number; gridTop: number; columnCount: number; rowCount: number },
): void {
  const { width, height, gridTop, columnCount, rowCount } = input;
  ctx.strokeStyle = GRID.line;
  ctx.lineWidth = 1;
  for (let row = 0; row <= rowCount; row += 1) {
    const y = gridTop + GRID.headerHeight + GRID.rowHeight * row + 0.5;
    ctx.beginPath();
    ctx.moveTo(GRID.padding, y);
    ctx.lineTo(width - GRID.padding, y);
    ctx.stroke();
  }
  for (let index = 0; index <= columnCount; index += 1) {
    const x = GRID.padding + GRID.slotColumnWidth + GRID.dayColumnWidth * index + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, gridTop);
    ctx.lineTo(x, height - GRID.padding);
    ctx.stroke();
  }
  ctx.strokeRect(
    GRID.padding + 0.5,
    gridTop + 0.5,
    width - GRID.padding * 2 - 1,
    height - gridTop - GRID.padding,
  );
  ctx.beginPath();
  ctx.moveTo(GRID.padding, gridTop + GRID.headerHeight + 0.5);
  ctx.lineTo(width - GRID.padding, gridTop + GRID.headerHeight + 0.5);
  ctx.stroke();
}

export function finishCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("画像を作れませんでした。"));
      }
    }, "image/png");
  });
}

/**
 * 画像をクリップボードに置く。
 *
 * 受け取るのは Blob そのものではなく **Blob を返す約束**。画像を作り終えてから
 * clipboard.write を呼ぶと、ブラウザによっては「利用者の操作から離れた書き込み」と
 * 見なされて弾かれる。約束のまま渡せば、押した直後に書き込みを始めたことになる。
 * 対応していないブラウザではファイルとして保存に切り替える（何も起きないよりはよい）。
 */
export async function copyImageToClipboard(
  blob: Promise<Blob>,
  filename: string,
): Promise<"copy" | "save"> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "copy";
    } catch {
      /* 権限が無い等はダウンロードに落とす */
    }
  }
  const url = URL.createObjectURL(await blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  // クリックだけでは始まらないブラウザがあるので、いったん文書へ挿す。
  // 取り消しは次のタスクまで待つ（同期で消すと保存が始まる前に URL が失効する）。
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return "save";
}
