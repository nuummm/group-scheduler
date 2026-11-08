import { slotHeading } from "@/lib/schedule";
import type { EventDetail, EventSummary, SummaryCell } from "@/lib/types";
import { drawGrid, finishCanvas, GRID, startCanvas } from "./canvas-grid";

/**
 * 全体の予定表を画像にする。画面と同じ塗り分け（緑 = 全員が空き / 赤 = 予定がある人数）で、
 * 横スクロールで隠れている列も含めて 1 枚に収める。
 *
 * 色は画面のトークンに合わせた近似値。canvas は oklch の color-mix を解釈しないので、
 * 白地に重ねた rgba として持つ。
 */

const FREE_RGB = "67, 168, 107";
const BUSY_RGB = "226, 87, 76";

function cellFill(busyCount: number, matchedCount: number, usable: boolean): string {
  if (matchedCount === 0) return "#ffffff";
  if (busyCount === 0) {
    return `rgba(${FREE_RGB}, ${usable ? 0.58 : 0.2})`;
  }
  const ratio = busyCount / matchedCount;
  return `rgba(${BUSY_RGB}, ${(10 + ratio * 42) / 100})`;
}

export interface MatrixImageInput {
  event: EventDetail;
  summary: EventSummary;
  /** 必要な連続コマ数。1 なら続き具合は問わない。 */
  requiredSpan: number;
  /** 何で絞り込んだ表なのか。空なら絞り込みなし。 */
  filterLabel: string;
}

/** 画像 1 枚ぶんの PNG を作る。ブラウザでしか動かない（canvas を使う）。 */
export async function renderMatrixImage(input: MatrixImageInput): Promise<Blob> {
  const { event, summary, requiredSpan, filterLabel } = input;
  const columns = event.columns;
  const slots = event.slotDefinitions;

  const cellByKey = new Map<string, SummaryCell>();
  for (const cell of summary.cells) {
    cellByKey.set(`${cell.columnKey}:${cell.slot}`, cell);
  }
  // 色はグループそのものから持ってくる。名前で引き直すと、同じ名前のグループがあったときに
  // 別のグループの色で塗ってしまう。
  const fixedByCell = new Map<string, { name: string; color: string }[]>();
  for (const group of event.groups) {
    if (!group.fixed || !group.pinned) continue;
    for (let slot = group.fixed.startSlot; slot <= group.fixed.endSlot; slot += 1) {
      const key = `${group.fixed.columnKey}:${slot}`;
      fixedByCell.set(key, [
        ...(fixedByCell.get(key) ?? []),
        { name: group.name, color: group.color },
      ]);
    }
  }

  // 「必要なコマ数だけ続けて空いているか」は画面と同じ判定にそろえる。
  const usable = new Set<string>();
  const span = Math.max(1, requiredSpan);
  const numbers = slots.map((slot) => slot.slot);
  for (const column of columns) {
    for (let index = 0; index + span <= numbers.length; index += 1) {
      // 変数名を window にしないこと（グローバルの window を隠す）。
      const run = numbers.slice(index, index + span);
      const contiguous = run.every((slot, offset) => slot === (run[0] as number) + offset);
      const allFree = run.every(
        (slot) =>
          summary.matchedCount > 0 &&
          (cellByKey.get(`${column.key}:${slot}`)?.busyCount ?? 0) === 0,
      );
      if (!contiguous || !allFree) continue;
      for (const slot of run) {
        usable.add(`${column.key}:${slot}`);
      }
    }
  }

  const caption = [
    filterLabel || "全員",
    `${summary.matchedCount} 人`,
    span > 1 ? `${span} コマ続きで判定` : "",
    "緑 = 全員が空き / 赤の数字 = 予定がある人数",
  ]
    .filter(Boolean)
    .join(" ・ ");

  const { ctx, canvas, width, height, gridTop, font } = startCanvas({
    columnCount: columns.length,
    rowCount: slots.length,
    title: event.title,
    caption,
  });

  // 列見出し
  ctx.fillStyle = GRID.headerFill;
  ctx.fillRect(GRID.padding, gridTop, width - GRID.padding * 2, GRID.headerHeight);
  ctx.fillStyle = GRID.ink;
  ctx.font = font(12, "600");
  ctx.textAlign = "center";
  ctx.fillText(
    event.scheduleMode === "weekly" ? "時限" : "時間",
    GRID.padding + GRID.slotColumnWidth / 2,
    gridTop + GRID.headerHeight / 2,
  );
  columns.forEach((column, index) => {
    const x =
      GRID.padding + GRID.slotColumnWidth + GRID.dayColumnWidth * index + GRID.dayColumnWidth / 2;
    ctx.fillText(column.shortLabel, x, gridTop + GRID.headerHeight / 2);
  });

  slots.forEach((definition, rowIndex) => {
    const y = gridTop + GRID.headerHeight + GRID.rowHeight * rowIndex;

    ctx.fillStyle = GRID.headerFill;
    ctx.fillRect(GRID.padding, y, GRID.slotColumnWidth, GRID.rowHeight);
    ctx.fillStyle = GRID.ink;
    ctx.font = font(12, "500");
    ctx.textAlign = "center";
    const heading = slotHeading(definition, event.scheduleMode);
    if (event.scheduleMode === "weekly") {
      // コマの名前は 12 文字まで書ける。列の幅に収める。
      ctx.fillText(
        heading,
        GRID.padding + GRID.slotColumnWidth / 2,
        y + GRID.rowHeight / 2 - 8,
        GRID.slotColumnWidth - 8,
      );
      ctx.fillStyle = GRID.inkSubtle;
      ctx.font = font(10);
      ctx.fillText(
        `${definition.start}〜${definition.end}`,
        GRID.padding + GRID.slotColumnWidth / 2,
        y + GRID.rowHeight / 2 + 9,
        GRID.slotColumnWidth - 8,
      );
    } else {
      ctx.fillText(
        heading,
        GRID.padding + GRID.slotColumnWidth / 2,
        y + GRID.rowHeight / 2,
        GRID.slotColumnWidth - 8,
      );
    }

    columns.forEach((column, columnIndex) => {
      const key = `${column.key}:${definition.slot}`;
      const x = GRID.padding + GRID.slotColumnWidth + GRID.dayColumnWidth * columnIndex;
      const busyCount = cellByKey.get(key)?.busyCount ?? 0;
      const fixedHere = fixedByCell.get(key) ?? [];

      if (fixedHere.length > 0) {
        // 仮決め済みのマスはグループの色で塗りつぶす（画面と同じで、空き人数は出さない）。
        // 複数あるときは画面と同じく帯を積む。
        const bandHeight = GRID.rowHeight / fixedHere.length;
        fixedHere.forEach((item, bandIndex) => {
          const bandY = y + bandHeight * bandIndex;
          ctx.fillStyle = item.color;
          ctx.fillRect(x, bandY, GRID.dayColumnWidth, bandHeight);
          ctx.fillStyle = "#ffffff";
          ctx.font = font(11, "600");
          ctx.textAlign = "center";
          ctx.fillText(
            item.name,
            x + GRID.dayColumnWidth / 2,
            bandY + bandHeight / 2,
            GRID.dayColumnWidth - 10,
          );
        });
      } else {
        ctx.fillStyle = cellFill(busyCount, summary.matchedCount, usable.has(key));
        ctx.fillRect(x, y, GRID.dayColumnWidth, GRID.rowHeight);
        ctx.textAlign = "center";
        if (summary.matchedCount > 0 && busyCount === 0) {
          if (usable.has(key)) {
            ctx.fillStyle = GRID.ink;
            ctx.font = font(16, "600");
            ctx.fillText("✓", x + GRID.dayColumnWidth / 2, y + GRID.rowHeight / 2);
          } else {
            ctx.fillStyle = GRID.inkSubtle;
            ctx.font = font(10);
            ctx.fillText(`${span} コマ続かず`, x + GRID.dayColumnWidth / 2, y + GRID.rowHeight / 2);
          }
        } else {
          ctx.fillStyle = GRID.ink;
          ctx.font = font(15, "600");
          ctx.fillText(String(busyCount), x + GRID.dayColumnWidth / 2, y + GRID.rowHeight / 2);
        }
      }
    });
  });

  drawGrid(ctx, {
    width,
    height,
    gridTop,
    columnCount: columns.length,
    rowCount: slots.length,
  });
  return await finishCanvas(canvas);
}
