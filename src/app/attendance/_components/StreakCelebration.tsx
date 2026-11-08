import { Flame, PartyPopper, Sparkles, Trophy } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import type { ArrivalCelebration } from "@/lib/types";

/**
 * カードを押した本人にだけ出るお祝い。
 *
 * 盤面には出さない。**押した人の画面に一瞬出て消えるだけ**なので、
 * 誰が何日来ているかが常時見える状態にはならない（テロップの方針と同じ）。
 * 2 位との差は出すが相手の名前は出さない — 「来ていない人」を指させないため。
 *
 * 賑やかさは 3 つで決まる。連続日数、今月いちばんかどうか、今年度いちばんかどうか。
 * ただし何も無い日は何も出さない — 毎回出ると邪魔なだけで、続いたときの嬉しさも薄れる。
 */

const AUTO_DISMISS_MS = 3400;

interface Tier {
  /** この日数以上で適用。 */
  min: number;
  label: (days: number) => string;
  note: string;
  icon: typeof Flame;
  /** 紙吹雪の枚数。0 なら出さない。 */
  confetti: number;
  accent: string;
}

/** 続くほど賑やかになる段階。境目は「そろそろ言われたい」と思うあたりに置く。 */
const TIERS: Tier[] = [
  {
    min: 30,
    label: (days) => `${days} 日連続`,
    note: "ここまで来ると、もうこの場所の一部です",
    icon: Trophy,
    confetti: 90,
    accent: "#eab308",
  },
  {
    min: 14,
    label: (days) => `${days} 日連続`,
    note: "2 週間ぶっ通し。おつかれさまです",
    icon: Trophy,
    confetti: 60,
    accent: "#f97316",
  },
  {
    min: 7,
    label: (days) => `${days} 日連続`,
    note: "1 週間つづきました",
    icon: PartyPopper,
    confetti: 36,
    accent: "#ec4899",
  },
  {
    min: 4,
    label: (days) => `${days} 日連続`,
    note: "いい流れです",
    icon: Flame,
    confetti: 18,
    accent: "#8b5cf6",
  },
  {
    min: 2,
    label: (days) => `${days} 日連続`,
    note: "つづいています",
    icon: Sparkles,
    confetti: 0,
    accent: "#14b8a6",
  },
];

/**
 * 段階を名前で取り出しておく。`find` で毎回引くと、段階を編集したときに
 * 型は通るのに実行時に undefined を読む。
 */
const WEEK_TIER = TIERS.find((tier) => tier.min === 7) as Tier;
const HALF_WEEK_TIER = TIERS.find((tier) => tier.min === 4) as Tier;

function tierFor(days: number): Tier | null {
  return TIERS.find((tier) => days >= tier.min) ?? null;
}

/**
 * 出す内容を決める。
 *
 * 年度いちばんの人は、連続していなくても一段良い演出にする（そこまで通った人への礼）。
 * 今月いちばんの人には 2 位との差を添える。
 */
function celebrationFor(arrival: ArrivalCelebration): {
  tier: Tier;
  headline: string;
  notes: string[];
} | null {
  const streakTier = arrival.streakDays >= 2 ? tierFor(arrival.streakDays) : null;
  // 年度いちばんは下限を 7 日連続と同じ賑やかさに引き上げる。
  const floorTier = arrival.yearlyTop ? WEEK_TIER : null;
  const base =
    streakTier && floorTier
      ? streakTier.confetti >= floorTier.confetti
        ? streakTier
        : floorTier
      : (streakTier ?? floorTier);
  if (!base && !arrival.monthlyLead) {
    return null;
  }
  const tier = base ?? HALF_WEEK_TIER;
  const notes: string[] = [];
  if (arrival.monthlyLead) {
    notes.push(`今月いちばん（2 位に ${arrival.monthlyLead.lead} 日差）`);
  }
  if (arrival.yearlyTop) {
    notes.push("今年度いちばん");
  }
  if (streakTier) {
    notes.push(streakTier.note);
  }
  return {
    // 年度いちばんの人は金色で固定。他と見た目が違うこと自体がご褒美。
    tier: arrival.yearlyTop ? { ...tier, accent: "#eab308", icon: Trophy } : tier,
    headline: streakTier
      ? streakTier.label(arrival.streakDays)
      : arrival.monthlyLead
        ? `今月 ${arrival.monthlyLead.days} 日目`
        : "おかえりなさい",
    notes,
  };
}

export function StreakCelebration({
  arrival,
  onDone,
}: {
  arrival: ArrivalCelebration | null;
  onDone: () => void;
}) {
  const celebration = arrival ? celebrationFor(arrival) : null;

  // 呼び出し側はその場で関数を作るので、依存に入れると再描画のたびに
  // タイマーが張り直される（混んでいる時間帯は巡回で数秒ごとに再描画される）。
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 依存は arrival だけ。API の応答ごとの新しいオブジェクトが、そのまま
  // 「新しいお祝い」の目印になる。
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => onDoneRef.current(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [arrival]);

  if (!arrival || !celebration) {
    return null;
  }

  const { tier, headline, notes } = celebration;
  const Icon = tier.icon;
  return (
    <div
      // 全面をボタンにすると、続けて次の人が席を押したときに、そのタップが
      // 「お祝いを閉じる」に食われて 1 回空振りする。閉じるのは中央の札だけ。
      // 層は島（z-50）とダイアログ（z-40）より下。押し間違いを戻す「取り消す」は
      // 数秒しか出ないので、お祝いで覆うと、いちばん効かせたい数秒が死ぬ。
      className="pointer-events-none fixed inset-0 z-35 flex items-center justify-center bg-canvas/70 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      {tier.confetti > 0 && (
        <span aria-hidden className="absolute inset-0 overflow-hidden">
          {Array.from({ length: tier.confetti }, (_, index) => {
            // 位置と速さは index から決める（描画のたびに散らばりが変わらないように）。
            const left = ((index * 37) % 100) + (index % 3);
            const delay = ((index * 53) % 900) / 1000;
            const duration = 1.5 + ((index * 17) % 90) / 100;
            const size = 5 + (index % 4) * 2;
            const hue = [tier.accent, "#3b82f6", "#22c55e", "#eab308", "#ec4899"][index % 5];
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 枚数だけで作る固定の並びで、増減も入れ替えも起きない
                key={index}
                className="confetti-piece absolute top-[-6%] block rounded-[2px]"
                style={{
                  left: `${left}%`,
                  width: size,
                  height: size * 2,
                  backgroundColor: hue,
                  animationDelay: `${delay}s`,
                  animationDuration: `${duration}s`,
                }}
              />
            );
          })}
        </span>
      )}

      <button
        type="button"
        // 押せば即座に消える。数秒とはいえ、盤面を触りたいときに待たされたくない。
        onClick={onDone}
        title="押すと閉じます"
        className="celebration-pop pointer-events-auto relative flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius-card)] bg-surface px-10 py-8 shadow-[var(--shadow-float)]"
      >
        <Icon className="size-9" style={{ color: tier.accent }} aria-hidden />
        <span className="font-semibold text-ink text-sm">{arrival.seatLabel}</span>
        <span
          className={cn(
            "font-bold tabular-nums leading-none",
            arrival.streakDays >= 14 || arrival.yearlyTop ? "text-4xl" : "text-3xl",
          )}
          style={{ color: tier.accent }}
        >
          {headline}
        </span>
        {notes.map((note) => (
          <span key={note} className="text-ink-muted text-xs">
            {note}
          </span>
        ))}
      </button>
    </div>
  );
}
