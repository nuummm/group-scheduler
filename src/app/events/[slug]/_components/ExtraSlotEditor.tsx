import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { type ExtraSlot, MAX_EXTRA_SLOTS, type SlotDefinition } from "@/lib/schedule";
import { Button, inputClass } from "../../../_components/ui";

/**
 * 基本のコマのあとに続く枠の編集。
 *
 * 名前も時刻も自由に決められる。番号は並び順がそのままコマ番号になるので、
 * 途中への挿し込みはできない（末尾に足す / 末尾から消すだけ）。
 */

/** 1 日の終わり。ここを越える初期値は作らない。 */
const END_OF_DAY = 24 * 60 - 1;

/**
 * 直前のコマの終わりから 10 分あけて、1 コマ 75 分ぶんを初期値にする。
 *
 * 日をまたがせない。分を 1440 で折り返すと、足していくうちに `23:50〜01:05` という
 * 「終わりが始まりより前」の値が既定で入り、**押しただけで保存できなくなる**。
 */
export function nextExtraSlot(existing: ExtraSlot[], baseSlots: SlotDefinition[]): ExtraSlot {
  const previousEnd = existing.at(-1)?.end ?? baseSlots.at(-1)?.end ?? "18:00";
  const [hourText, minuteText] = previousEnd.split(":");
  const previousMinutes = Number(hourText) * 60 + Number(minuteText);
  // 直前が 23:59 まで詰まっているときは、それ以上ずらせない（人が直す前提）。
  const startMinutes = Math.min(previousMinutes + 10, END_OF_DAY - 1);
  const endMinutes = Math.min(startMinutes + 75, END_OF_DAY);
  const format = (total: number) =>
    `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return {
    label: `${baseSlots.length + existing.length + 1}限`,
    start: format(startMinutes),
    end: format(endMinutes),
  };
}

export function ExtraSlotEditor({
  slots,
  baseSlots,
  onChange,
}: {
  slots: ExtraSlot[];
  /** このイベントの基本のコマ。追加コマはこの後ろに続く。 */
  baseSlots: SlotDefinition[];
  onChange: (next: ExtraSlot[]) => void;
}) {
  const patch = (index: number, value: Partial<ExtraSlot>) => {
    onChange(slots.map((slot, position) => (position === index ? { ...slot, ...value } : slot)));
  };

  return (
    <div className="space-y-3">
      <p className="copy-block text-ink-muted text-xs">
        {`このイベントの基本のコマは ${baseSlots[0]?.label ?? ""}〜${baseSlots.at(-1)?.label ?? ""}（${baseSlots[0]?.start ?? ""}〜${baseSlots.at(-1)?.end ?? ""}）です。夜の会など、これに収まらない枠をここで足せます。`}
      </p>

      {slots.length > 0 && (
        <ul className="space-y-2">
          {slots.map((slot, index) => (
            <li
              // 並び順そのものがコマ番号なので、位置を識別子にしてよい
              // biome-ignore lint/suspicious/noArrayIndexKey: 位置が識別子を兼ねる
              key={index}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                className={cn(inputClass, "w-20")}
                maxLength={12}
                aria-label={`${index + 1} 個目の追加コマの名前`}
                placeholder="7限"
                value={slot.label}
                onChange={(event) => patch(index, { label: event.target.value })}
              />
              <input
                className={cn(inputClass, "w-24")}
                aria-label={`${index + 1} 個目の追加コマの開始時刻`}
                placeholder="18:10"
                value={slot.start}
                onChange={(event) => patch(index, { start: event.target.value })}
              />
              <span className="text-ink-subtle text-xs">〜</span>
              <input
                className={cn(inputClass, "w-24")}
                aria-label={`${index + 1} 個目の追加コマの終了時刻`}
                placeholder="19:25"
                value={slot.end}
                onChange={(event) => patch(index, { end: event.target.value })}
              />
              {/* 削除は末尾だけ。コマ番号は配列の位置そのものなので、途中を抜くと
                  後ろのコマに入っていた予定が別のコマへずれてしまう。 */}
              {index === slots.length - 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${slot.label || "追加コマ"} を削除`}
                  className="hover:text-danger"
                  onClick={() => onChange(slots.slice(0, -1))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Button
        size="sm"
        disabled={slots.length >= MAX_EXTRA_SLOTS}
        onClick={() => onChange([...slots, nextExtraSlot(slots, baseSlots)])}
      >
        <Plus className="size-3.5" aria-hidden />
        コマを追加
      </Button>

      {slots.length > 0 && (
        <p className="text-ink-subtle text-xs">
          {
            "消せるのは最後のコマだけです（途中を抜くと予定がずれるため）。減らすと、そのコマに入っていた予定も消えます。"
          }
        </p>
      )}
    </div>
  );
}
