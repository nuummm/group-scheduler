import {
  CalendarCheck,
  CircleDashed,
  ImageDown,
  Loader2,
  Move,
  Pin,
  PinOff,
  RefreshCw,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import type { AssignmentResult } from "@/lib/assignment";
import { cn } from "@/lib/cn";
import {
  type ColumnDefinition,
  type ScheduleMode,
  type SlotDefinition,
  slotHeading,
} from "@/lib/schedule";
import type { GradeSummary, GroupSummary } from "@/lib/types";
import { Button, Card, CardHeader, EmptyState } from "../../../_components/ui";
import { terms } from "../../../_lib/app-config";
import { PlanCalendar } from "./PlanCalendar";
import type { DragTarget } from "./use-seminar-drag";

/**
 * グループ日程の最適化結果。
 *
 * グループ単体の「空いている枠」を並べるだけでは足りない。1 人が複数のグループに
 * 入っているので、あるグループをそこに置くと掛け持ちの人が別のグループに出られなくなる。
 * 部屋も主宰者も 1 つなので、同じコマに 2 つのグループは置けない。
 * ここに出るのは、**全グループを同時に置いてそれらの衝突が無いことを確かめた結果**。
 *
 * 結果は自動で更新される（予定を保存するたびに解き直す）。決定ではなく解の 1 つなので、
 * 出られない人がいるならその名前もそのまま見せる。
 * 日程が決まったグループは「仮決め」しておくと、以降その枠は所与として残りを解き直す。
 */
export function SeminarPlan({
  groups,
  grades,
  assignment,
  searching,
  columns,
  slotDefinitions,
  scheduleMode,
  onChangeRequiredGrade,
  onConfirm,
  onRelease,
  onCopyImage,
  onMove,
  onResolve,
}: {
  groups: GroupSummary[];
  grades: GradeSummary[];
  assignment: AssignmentResult | null;
  /** 組み合わせを探し直している最中か。 */
  searching: boolean;
  columns: ColumnDefinition[];
  slotDefinitions: SlotDefinition[];
  scheduleMode: ScheduleMode;
  onChangeRequiredGrade: (groupId: number, gradeId: number | null) => void;
  onConfirm: (groupId: number, columnKey: string, startSlot: number) => void;
  onRelease: (groupId: number) => void;
  onCopyImage: () => void;
  onMove: (groupId: number, target: DragTarget) => void;
  onResolve: () => void;
}) {
  const { group: groupTerm } = terms();
  const slotLabel = (slot: number) => {
    const definition = slotDefinitions.find((item) => item.slot === slot);
    return definition ? slotHeading(definition, scheduleMode) : String(slot);
  };

  const timeLabel = (startSlot: number, endSlot: number) =>
    startSlot === endSlot
      ? slotLabel(startSlot)
      : `${slotLabel(startSlot)} 〜 ${slotLabel(endSlot)}`;

  const groupById = new Map(groups.map((group) => [group.id, group]));
  // 案に出ないグループ（メンバー不在など）の仮決めも数える。表には帯が出ているので、
  // 数えないと「表には 📌 があるのに 0 件」という食い違いになる。
  const fixedCount = groups.filter((group) => group.fixed !== null && group.pinned).length;

  /**
   * 一覧の行から 1 タップで紐付けられる区分。
   *
   * 「必ず参加」は事実上ほとんどが主宰者なので、その候補だけを行に出す。
   * 人数のいる区分をここに並べると「その区分の全員が空く枠だけ」という
   * まず成立しない条件をうっかり付けてしまう。
   */
  const keyGrades = grades.filter(
    (grade) => grade.memberCount > 0 && (grade.locked || grade.memberCount === 1),
  );

  return (
    <Card>
      <CardHeader
        title={`${groupTerm}の日程の最適化結果`}
        description={`全員の予定と掛け持ちを制約として、全${groupTerm}の開催枠を同時に解いた結果です。仮決めした枠は動かさず、残りを組み直します。`}
        action={
          <span className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              disabled={searching}
              title="仮決めしていない枠の位置を捨てて、いまの予定でもう一度解き直します（仮決めした枠はそのまま）"
              onClick={onResolve}
            >
              <RefreshCw className={cn("size-3.5", searching && "animate-spin")} aria-hidden />
              解き直す
            </Button>
            <Button size="sm" onClick={onCopyImage}>
              <ImageDown className="size-3.5" aria-hidden />
              画像でコピー
            </Button>
          </span>
        }
      />

      {/* 探索中は結果を薄くして重ねる。差し替えで高さが変わると、
          設定を 1 つ触るたびにページ全体が跳ねる。 */}
      <div className="relative">
        {searching && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-6">
            <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-ink-muted text-xs shadow-[var(--shadow-card)]">
              <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
              重ならない組み合わせを探しています…
            </span>
          </div>
        )}
        <div
          className={cn("space-y-3 p-4 transition-opacity", searching && "opacity-40")}
          aria-busy={searching}
        >
          {!assignment ||
          (assignment.placements.length === 0 && assignment.unplaced.length === 0) ? (
            <EmptyState>{groupTerm}を登録すると、開催できる枠の案がここに出ます。</EmptyState>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  <CalendarCheck className="size-3.5 text-accent" aria-hidden />
                  全員が出られる{groupTerm}
                </span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    // 分母は置けなかったぶんも含めた総数。置けていないのに満点に見せない。
                    assignment.fullyAttendedCount === assignment.totalCount
                      ? "text-free"
                      : "text-busy",
                  )}
                >
                  {assignment.fullyAttendedCount} / {assignment.totalCount}
                </span>
                {fixedCount > 0 && (
                  <span className="flex items-center gap-1 text-accent-ink">
                    <Pin className="size-3" aria-hidden />
                    <span className="tabular-nums">{fixedCount} 件</span>
                    は仮決め済み（動かさずに残りを組んでいます）
                  </span>
                )}
                {assignment.truncated && (
                  <span className="text-ink-subtle">
                    組み合わせが多いため、探索を途中で打ち切った案です
                  </span>
                )}
              </div>

              {/* 仮決めどうしがぶつかっている場合は解けないので、そのまま伝える。
                  決めたことを勝手に外して「解けました」と出すほうが害が大きい。 */}
              {assignment.fixedConflicts.map((conflict) => (
                <p
                  key={conflict.groupNames.join("/")}
                  className="flex items-start gap-2 rounded-[var(--radius-control)] border border-busy/30 bg-busy-soft px-3 py-2 text-xs"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-busy" aria-hidden />
                  <span className="copy-block text-ink">
                    {`「${conflict.groupNames[0]}」と「${conflict.groupNames[1]}」が同じコマに置かれています。同時には開けません。どちらかを掴んで別の枠へ動かすか、「解き直す」で自動に戻してください。`}
                  </span>
                </p>
              ))}

              {/* 時間割で見せる。「月 5〜6 限」を頭の中で並べ直さずに済むので、
                週のどこが埋まっていてどこが空いているかが一目で分かる。 */}
              <PlanCalendar
                columns={columns}
                slotDefinitions={slotDefinitions}
                scheduleMode={scheduleMode}
                placements={assignment.placements}
                placeableStarts={assignment.placeableStarts}
                onMove={onMove}
                onToggleFixed={(placement) =>
                  placement.fixed
                    ? onRelease(placement.groupId)
                    : onConfirm(placement.groupId, placement.columnKey, placement.startSlot)
                }
              />
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-subtle text-[11px]">
                <span className="flex items-center gap-1">
                  <span
                    className="flex h-4 w-8 items-center justify-center rounded-[3px] border border-accent border-dashed bg-accent-soft text-accent"
                    aria-hidden
                  >
                    <CircleDashed className="size-2.5" />
                  </span>
                  自動で決まった枠
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="flex h-4 w-8 items-center justify-center rounded-[3px] border border-accent bg-accent-soft text-accent"
                    aria-hidden
                  >
                    <Move className="size-2.5" />
                  </span>
                  仮決めを外した枠
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="flex h-4 w-8 items-center justify-center rounded-[3px] bg-accent text-white"
                    aria-hidden
                  >
                    <Pin className="size-2.5" />
                  </span>
                  仮決めした枠
                </span>
              </p>
              <p className="copy-block text-ink-subtle text-[11px] leading-relaxed">
                {
                  "押すか、長押しで掴んで別のコマへ動かすと、その枠で仮決めになります。仮決めを外しても場所はそのまま残り、「解き直す」を押したときだけ組み直されます。"
                }
              </p>

              {/*
                行ごとに折り返すと、グループ名の長さの違いがそのまま右のガタつきになる。
                列を親で 1 度だけ決めて、各行は subgrid でそこへ乗せる
                （＝いちばん長いグループ名に全行が揃う）。
                列は「グループ名 / 必須の指定 / 日時 / 枠の状態 / 参加の可否 / 操作」。
              */}
              <ul
                // 狭い画面では列に分けない。max-content の列が 4 つあるので、
                // 揃えたまま縮めることはできず、ページごと横に溢れる。
                className="grid gap-y-1.5 sm:grid-cols-[max-content_max-content_max-content_max-content_minmax(8rem,1fr)_max-content]"
                // biome-ignore lint/a11y/noRedundantRoles: display:grid を当てると Safari / VoiceOver が一覧として読まなくなる
                role="list"
              >
                {assignment.placements.map((placement) => (
                  <li
                    key={placement.groupId}
                    // biome-ignore lint/a11y/noRedundantRoles: 親と同じ理由（grid で一覧の意味が消えるのを戻す）
                    role="listitem"
                    className={cn(
                      "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-control)] border px-3 py-2 text-xs",
                      "sm:col-span-full sm:grid sm:grid-cols-subgrid sm:gap-y-0",
                      placement.fixed
                        ? "border-accent/40 bg-accent-soft"
                        : "border-line bg-surface-muted/50",
                    )}
                  >
                    <span
                      // 長いグループ名（40 文字まで）でカードを突き破らないように。
                      // 受け皿が無いのでページ本体に横スクロールが出てしまう。
                      className="min-w-0 max-w-[14rem] truncate rounded-full px-2 py-0.5 text-center font-medium"
                      style={{
                        backgroundColor: `${placement.groupColor}1f`,
                        color: placement.groupColor,
                      }}
                    >
                      {placement.groupName}
                    </span>
                    {/* 「主宰者が来ないと始まらない」グループは多い。設定画面まで行かずに
                      ここで 1 タップで紐付けられるようにする。
                      複数あっても 1 列に収める（列の数を行ごとに変えない）。 */}
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                      {keyGrades.map((grade) => {
                        const required =
                          groupById.get(placement.groupId)?.requiredGradeId === grade.id;
                        return (
                          <button
                            key={grade.id}
                            type="button"
                            aria-pressed={required}
                            title={
                              required
                                ? `${grade.name} の参加を必須から外す`
                                : `${grade.name} が出られる枠だけを候補にする`
                            }
                            onClick={() =>
                              onChangeRequiredGrade(placement.groupId, required ? null : grade.id)
                            }
                            className={cn(
                              "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                              required
                                ? "border-transparent bg-accent font-medium text-white"
                                : "border-line text-ink-subtle hover:border-ink-subtle hover:text-ink",
                            )}
                          >
                            <UserCheck className="size-3" aria-hidden />
                            {required ? `${grade.name} 必須` : `${grade.name} を必須に`}
                          </button>
                        );
                      })}
                    </span>
                    <span className="whitespace-nowrap font-medium text-ink">
                      {placement.columnLabel} {timeLabel(placement.startSlot, placement.endSlot)}
                    </span>
                    {/* 時間割と同じ 3 状態をここでも出す。片方だけ 2 状態だと、
                      同じ枠が画面の場所によって違う意味に見える。
                      無い行でも空の列として置く（置かないと右が 1 つずつ詰まって崩れる）。 */}
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      {placement.fixed ? (
                        <>
                          <Pin className="size-3 text-accent-ink" aria-hidden />
                          <span className="font-medium text-accent-ink">仮決めした枠です</span>
                        </>
                      ) : placement.moved ? (
                        <>
                          <Move className="size-3 text-ink-muted" aria-hidden />
                          <span className="text-ink-muted">場所だけ残っています</span>
                        </>
                      ) : null}
                    </span>
                    <span className="min-w-0">
                      {placement.conflictsWith.length > 0 ? (
                        <span className="font-medium text-busy">
                          {`${placement.conflictsWith.join("、")} と同じコマです`}
                        </span>
                      ) : placement.busyNames.length === 0 ? (
                        <span className="text-free">全員参加できます</span>
                      ) : (
                        <span className="text-ink-muted tabular-nums">
                          {`${placement.freeNames.length} / ${placement.memberCount} 人 ・ 出られない: ${placement.busyNames.join("、")}`}
                        </span>
                      )}
                    </span>
                    {placement.fixed ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() => onRelease(placement.groupId)}
                      >
                        <PinOff className="size-3" aria-hidden />
                        仮決めを外す
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() =>
                          onConfirm(placement.groupId, placement.columnKey, placement.startSlot)
                        }
                      >
                        <Pin className="size-3" aria-hidden />
                        この枠に仮決め
                      </Button>
                    )}
                  </li>
                ))}
              </ul>

              {assignment.unplaced.length > 0 && (
                <ul className="space-y-1">
                  {assignment.unplaced.map((item) => (
                    <li
                      key={item.groupId}
                      className="flex items-center gap-2 rounded-[var(--radius-control)] border border-busy/30 bg-busy-soft px-3 py-2 text-xs"
                    >
                      <TriangleAlert className="size-3.5 shrink-0 text-busy" aria-hidden />
                      <span className="font-medium text-ink">{item.groupName}</span>
                      <span className="text-ink-muted">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
