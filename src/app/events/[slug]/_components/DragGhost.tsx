import { GripVertical } from "lucide-react";
import type { SeminarDragState } from "./use-seminar-drag";

/**
 * 掴んでいるグループの札。指の少し先に浮かせて追従させる。
 *
 * これが無いと、色が変わるだけで「掴んでいる」感触が出ない。表そのものは動かさず、
 * 札だけを動かすので、置く前と後で盤面が跳ねることもない。
 */
export function DragGhost({ state }: { state: SeminarDragState }) {
  if (!state.source || !state.pointer) {
    return null;
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none fixed z-50 flex items-center gap-1 rounded-full px-2.5 py-1 font-medium text-[11px] text-white shadow-[var(--shadow-card)]"
      style={{
        backgroundColor: state.source.color,
        left: state.pointer.x + 12,
        top: state.pointer.y + 12,
        // 落とせない場所にいるあいだは薄くして、離しても何も起きないことを先に伝える。
        opacity: state.hoveredStart ? 1 : 0.55,
      }}
    >
      <GripVertical className="size-3 shrink-0" />
      {state.source.label}
    </span>
  );
}
