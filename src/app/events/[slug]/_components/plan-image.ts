import type { SeminarPlacement } from "@/lib/assignment";
import {
  type ColumnDefinition,
  type ScheduleMode,
  type SlotDefinition,
  slotHeading,
} from "@/lib/schedule";
import { drawGrid, finishCanvas, GRID, startCanvas } from "./canvas-grid";

/**
 * 割り当て結果を時間割の画像にする。
 *
 * 全体の予定表と同じ描き方（同じデータから canvas に描き直す）。Slack へ貼るときは
 * 「誰がいつ空いているか」より「どのグループがいつになったか」を配りたいことが多い。
 */
export function renderPlanImage(input: {
  title: string;
  columns: ColumnDefinition[];
  slotDefinitions: SlotDefinition[];
  scheduleMode: ScheduleMode;
  placements: SeminarPlacement[];
  /**
   * 画像の下に添える 1 行。「全員が出られるグループの数 / グループの総数」に、
   * 置けなかった件数や重なりの件数、3 つの枠の見分け方が連結される。
   * 分母は総数なので、置けなかったグループも入る。
   */
  caption: string;
}): Promise<Blob> {
  const { title, columns, slotDefinitions, scheduleMode, placements, caption } = input;

  const byCell = new Map<string, SeminarPlacement[]>();
  for (const placement of placements) {
    for (let slot = placement.startSlot; slot <= placement.endSlot; slot += 1) {
      const key = `${placement.columnKey}:${slot}`;
      byCell.set(key, [...(byCell.get(key) ?? []), placement]);
    }
  }

  const { ctx, canvas, width, height, gridTop, font } = startCanvas({
    columnCount: columns.length,
    rowCount: slotDefinitions.length,
    title,
    caption,
  });

  ctx.fillStyle = GRID.headerFill;
  ctx.fillRect(GRID.padding, gridTop, width - GRID.padding * 2, GRID.headerHeight);
  ctx.fillStyle = GRID.ink;
  ctx.font = font(12, "600");
  ctx.textAlign = "center";
  ctx.fillText(
    scheduleMode === "weekly" ? "時限" : "時間",
    GRID.padding + GRID.slotColumnWidth / 2,
    gridTop + GRID.headerHeight / 2,
  );
  columns.forEach((column, index) => {
    ctx.fillText(
      column.shortLabel,
      GRID.padding + GRID.slotColumnWidth + GRID.dayColumnWidth * index + GRID.dayColumnWidth / 2,
      gridTop + GRID.headerHeight / 2,
    );
  });

  slotDefinitions.forEach((definition, rowIndex) => {
    const y = gridTop + GRID.headerHeight + GRID.rowHeight * rowIndex;
    ctx.fillStyle = GRID.headerFill;
    ctx.fillRect(GRID.padding, y, GRID.slotColumnWidth, GRID.rowHeight);
    ctx.fillStyle = GRID.ink;
    ctx.font = font(12, "500");
    ctx.textAlign = "center";
    const heading = slotHeading(definition, scheduleMode);
    if (scheduleMode === "weekly") {
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
      const here = byCell.get(`${column.key}:${definition.slot}`) ?? [];
      if (here.length === 0) return;
      const x = GRID.padding + GRID.slotColumnWidth + GRID.dayColumnWidth * columnIndex;
      const bandHeight = GRID.rowHeight / here.length;
      here.forEach((placement, bandIndex) => {
        const bandY = y + bandHeight * bandIndex;
        // 画面と同じ描き分け。仮決めは塗りつぶし、案のままは破線の縁取り。
        // 濃さの違いだけだと、色によって差が出たり出なかったりする。
        if (placement.fixed) {
          ctx.fillStyle = placement.groupColor;
          ctx.fillRect(x, bandY, GRID.dayColumnWidth, bandHeight);
          ctx.fillStyle = "#ffffff";
        } else {
          // 仮決めを外して場所だけ残っている枠は実線、自動で決まった枠は破線。画面と同じ見分け方。
          ctx.strokeStyle = placement.groupColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash(placement.moved ? [] : [4, 3]);
          ctx.strokeRect(x + 3, bandY + 3, GRID.dayColumnWidth - 6, bandHeight - 6);
          ctx.setLineDash([]);
          ctx.fillStyle = placement.groupColor;
        }
        ctx.font = font(11, "600");
        ctx.textAlign = "center";
        ctx.fillText(
          placement.fixed ? `📌 ${placement.groupName}` : placement.groupName,
          x + GRID.dayColumnWidth / 2,
          bandY + bandHeight / 2,
          GRID.dayColumnWidth - 10,
        );
      });
    });
  });

  drawGrid(ctx, {
    width,
    height,
    gridTop,
    columnCount: columns.length,
    rowCount: slotDefinitions.length,
  });
  return finishCanvas(canvas);
}
