import { Crown, Flame, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { AttendanceHighlights, AwardKind } from "@/lib/types";
import { Card } from "../../_components/ui";
import { appConfig } from "../../_lib/app-config";

/**
 * 在室の称号を 1 枚ずつ入れ替えて見せる帯（ニュースのテロップ）。
 *
 * 一度に 1 件しか出さないのは、並べると順位表になってしまうから。
 * 高さは常に一定で、切り替えても座席表が上下にずれない。
 *
 * 出る内容はサーバーが選んだ称号だけで、日数や順位は含まれない。
 * 「載っていない人」が読み取れる情報にならないよう、該当者ゼロなら帯ごと出さない。
 */

const ROTATE_INTERVAL_MS = 5_000;

const AWARD_ICON: Record<AwardKind, typeof Crown> = {
  streak: Flame,
  monthly: Crown,
  yearly: Trophy,
};

const AWARD_TONE: Record<AwardKind, string> = {
  streak: "text-away",
  monthly: "text-accent",
  yearly: "text-present",
};

export function HighlightTicker({ highlights }: { highlights: AttendanceHighlights }) {
  const awards = highlights.awards;
  const [index, setIndex] = useState(0);

  // 称号が入れ替わって件数が減ったときに、範囲外を指したままにしない。
  const safeIndex = awards.length > 0 ? index % awards.length : 0;

  useEffect(() => {
    if (awards.length <= 1) {
      return;
    }
    const timer = setInterval(() => setIndex((current) => current + 1), ROTATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [awards.length]);

  if (awards.length === 0) {
    return null;
  }

  const award = awards[safeIndex];
  if (!award) {
    return null;
  }
  const Icon = AWARD_ICON[award.kind];

  return (
    <Card className="overflow-hidden px-4 py-2.5">
      {/* aria-live は出さない。称号は読み上げで割り込むほどの情報ではないうえ、
          5 秒ごとに読み上げが走ると本来の操作の邪魔になる。 */}
      <div className="flex h-6 items-center gap-2.5">
        <span className="shrink-0 font-medium text-ink-subtle text-[11px] tracking-wide">
          {appConfig().placeName}の常連
        </span>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            // key を変えて要素を作り直すことで、切り替えのたびに入場アニメーションが最初から走る
            key={`${award.kind}:${award.seatKey}`}
            className="ticker-item flex items-center gap-2 whitespace-nowrap"
          >
            <Icon className={cn("size-3.5 shrink-0", AWARD_TONE[award.kind])} aria-hidden />
            <span className={cn("shrink-0 font-semibold text-xs", AWARD_TONE[award.kind])}>
              {award.title}
            </span>
            <span className="truncate text-ink text-xs">{award.seatLabel}</span>
          </div>
        </div>
        {awards.length > 1 && (
          <span className="flex shrink-0 gap-1" aria-hidden>
            {awards.map((item, position) => (
              <span
                key={item.kind}
                className={cn(
                  "size-1 rounded-full transition-colors",
                  position === safeIndex ? "bg-ink-muted" : "bg-line-strong",
                )}
              />
            ))}
          </span>
        )}
      </div>
    </Card>
  );
}
