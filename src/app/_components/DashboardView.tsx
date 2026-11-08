import { CalendarRange, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import {
  describeWeeklyLayout,
  formatDisplayDate,
  type ScheduleMode,
  weekdayColumns,
} from "@/lib/schedule";
import type { EventListItem } from "@/lib/types";
import { ApiRequestError, api } from "../_lib/api-client";
import { appConfig } from "../_lib/app-config";
import { isSubmitEnter } from "../_lib/ime";
import { clearLastEventPath, readLastEventPath } from "../_lib/last-event";
import { useIslandStore } from "../_stores/island-store";
import { Button, Card, CardHeader, EmptyState, Field, inputClass, Message } from "./ui";
import { useConfirm } from "./use-confirm";

/**
 * 日付はアプリの設定の時計（既定 Asia/Tokyo）で読む。
 *
 * `getFullYear()` などは端末のローカル時刻で解決される。時計の設定がアプリの設定と違う端末
 * （海外出張中のノート PC など）で開くと、日付が 1 日ずれる。表示も初期値もここを通す。
 *
 * 返す書式は `YYYY-MM-DD`（en-CA の並び）。
 */
function localDateFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 今日から数えた日付を `YYYY-MM-DD` で返す（期間指定モードの初期値）。 */
function dateAfter(format: Intl.DateTimeFormat, days: number): string {
  return format.format(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

/** 作成日。年は今年なら省く（並びの目安として添えるだけなので短いほうがよい）。 */
function createdLabel(format: Intl.DateTimeFormat, createdAt: string): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return "";
  }
  const [year, month, day] = format.format(created).split("-");
  const thisYear = format.format(new Date()).slice(0, 4);
  const monthDay = `${Number(month)}/${Number(day)}`;
  return year === thisYear ? `${monthDay} 作成` : `${year}/${monthDay} 作成`;
}

function periodLabel(event: EventListItem): string {
  return event.scheduleMode === "weekly"
    ? "毎週固定"
    : `${formatDisplayDate(event.startDate)} - ${formatDisplayDate(event.endDate)}`;
}

export function DashboardView({
  events,
  onChanged,
}: {
  events: EventListItem[];
  /** 一覧が変わったとき（削除のあと）に呼ぶ。取り直すのは親の役目。 */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const { timeZone, terms, weekdays, weeklySlots } = appConfig();
  const dateFormat = useMemo(() => localDateFormat(timeZone), [timeZone]);
  const showIsland = useIslandStore((state) => state.show);
  const { confirm, confirmDialog } = useConfirm();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("weekly");
  // 設定を読み終える前の初回描画で決まる（既定の時計で数える）。ずれても 1 日で、手で直せる。
  const [startDate, setStartDate] = useState(() => dateAfter(dateFormat, 1));
  const [endDate, setEndDate] = useState(() => dateAfter(dateFormat, 7));
  const [groups, setGroups] = useState<string[]>([]);
  const [groupDraft, setGroupDraft] = useState("");
  // 区分とグループを引き継ぐ元。空なら引き継がない。
  const [copyFromSlug, setCopyFromSlug] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" }>({
    text: "",
    tone: "info",
  });
  const [submitting, setSubmitting] = useState(false);

  const addGroup = () => {
    const value = groupDraft.trim();
    if (!value) return;
    if (groups.some((group) => group.toLowerCase() === value.toLowerCase())) {
      setMessage({ text: `同じ${terms.group}名は追加できません。`, tone: "error" });
      return;
    }
    setGroups((current) => [...current, value]);
    setGroupDraft("");
    setMessage({ text: "", tone: "info" });
  };

  const submit = async () => {
    setSubmitting(true);
    setMessage({ text: "作成中...", tone: "info" });
    try {
      const created = await api.post<{ slug: string }>("/api/events", {
        title,
        description,
        scheduleMode,
        startDate: scheduleMode === "date_range" ? startDate : "",
        endDate: scheduleMode === "date_range" ? endDate : "",
        groups,
        copyFromSlug,
      });
      navigate(`/events/${created.slug}`);
    } catch (error) {
      setMessage({
        text: error instanceof ApiRequestError ? error.message : "作成に失敗しました。",
        tone: "error",
      });
      setSubmitting(false);
    }
  };

  const remove = async (event: EventListItem) => {
    const ok = await confirm({
      title: "イベントを削除しますか？",
      message: (
        <>
          「{event.title}」と、登録済みの {event.participantCount}{" "}
          人ぶんの予定をまとめて削除します。 この操作は元に戻せません。
        </>
      ),
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/events/${encodeURIComponent(event.slug)}`);
      // 覚えている「続き」が今消したイベントなら忘れる（次にタブを押すと 404 になる）。
      if (readLastEventPath() === `/events/${event.slug}`) {
        clearLastEventPath();
      }
      showIsland({ tone: "neutral", title: `「${event.title}」を削除しました` });
      onChanged();
    } catch (error) {
      showIsland({
        tone: "danger",
        title: error instanceof ApiRequestError ? error.message : "削除に失敗しました。",
      });
    }
  };

  return (
    <div className="space-y-6">
      {confirmDialog}

      <header className="space-y-1.5">
        <h1 className="font-semibold text-ink text-xl">日程調整</h1>
        <p className="copy-block max-w-3xl text-ink-muted text-sm leading-relaxed">
          {`URL を配って予定を集め、${terms.role}や${terms.group}で絞り込みながら空きコマを探せます。`}
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <Card>
          <CardHeader title="作成済みイベント" description={`${events.length} 件`} />
          <div className="p-4">
            {events.length === 0 ? (
              <EmptyState>
                {"まだイベントはありません。右のフォームから 1 件作成してください。"}
              </EmptyState>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {events.map((event) => (
                  <li key={event.slug}>
                    <div className="group relative h-full rounded-[var(--radius-card)] border border-line bg-surface-muted/40 p-4 transition-colors hover:border-accent/50">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${event.title} を削除`}
                        onClick={() => void remove(event)}
                        className="absolute top-2 right-2 text-ink-subtle opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-danger"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                      <Link to={`/events/${event.slug}`} className="block">
                        <h3 className="pr-8 font-semibold text-ink text-sm">{event.title}</h3>
                        <p className="mt-1 line-clamp-2 text-ink-muted text-xs leading-relaxed">
                          {event.description || "説明なし"}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-ink-subtle text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5">
                            <CalendarRange className="size-3" aria-hidden />
                            {periodLabel(event)}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5">
                            <Users className="size-3" aria-hidden />
                            {event.participantCount} 人
                          </span>
                          {/* 作成日は主役ではないので、囲みを付けず地の文として添える。 */}
                          <time className="text-ink-subtle/80" dateTime={event.createdAt}>
                            {createdLabel(dateFormat, event.createdAt)}
                          </time>
                        </div>
                        {event.groups.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {event.groups.map((group) => (
                              <span
                                key={group.id}
                                className="rounded-full px-2 py-0.5 font-medium text-[11px]"
                                style={{ backgroundColor: `${group.color}1f`, color: group.color }}
                              >
                                {group.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="新しい日程調整を作成" />
          <form
            className="space-y-4 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="イベント名">
              <input
                required
                maxLength={80}
                className={inputClass}
                placeholder="例: 4月の定例の日程調整"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>

            <fieldset>
              <legend className="mb-1.5 font-medium text-ink text-xs">日程モード</legend>
              <div className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] border border-line bg-surface-muted p-1">
                {(
                  [
                    {
                      value: "weekly",
                      label: "毎週固定",
                      hint: describeWeeklyLayout(weekdayColumns(weekdays), weeklySlots),
                    },
                    { value: "date_range", label: "期間指定", hint: "日付 × 1時間刻み" },
                  ] as const
                ).map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      "cursor-pointer rounded-[6px] px-3 py-2 text-center transition-colors",
                      scheduleMode === option.value
                        ? "bg-surface shadow-[var(--shadow-card)]"
                        : "hover:bg-surface/60",
                    )}
                  >
                    <input
                      type="radio"
                      name="scheduleMode"
                      className="sr-only"
                      checked={scheduleMode === option.value}
                      onChange={() => setScheduleMode(option.value)}
                    />
                    <span className="block font-medium text-ink text-xs">{option.label}</span>
                    <span className="block text-[10px] text-ink-subtle">{option.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {scheduleMode === "date_range" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="開始日">
                  <input
                    type="date"
                    required
                    className={inputClass}
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </Field>
                <Field label="終了日">
                  <input
                    type="date"
                    required
                    className={inputClass}
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </Field>
              </div>
            )}

            <Field label="説明">
              <textarea
                rows={3}
                maxLength={500}
                className={inputClass}
                placeholder="例: 新しい期の開催枠を決めます。全員入力してください。"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>

            <div>
              <span className="mb-1.5 block font-medium text-ink text-xs">
                開催する{terms.group}
              </span>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder="例: 定例 / 勉強会"
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // 変換確定の Enter は無視する（1 回目で登録されてしまわないように）。
                    if (!isSubmitEnter(event)) return;
                    // フォーム全体の submit を巻き込まずに、グループだけ足す。
                    event.preventDefault();
                    addGroup();
                  }}
                />
                <Button onClick={addGroup} aria-label={`${terms.group}を追加`}>
                  <Plus className="size-4" aria-hidden />
                </Button>
              </div>
              {groups.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {groups.map((group, index) => (
                    <span
                      key={group}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-ink text-xs"
                    >
                      {group}
                      <button
                        type="button"
                        aria-label={`${group} を外す`}
                        className="text-ink-subtle hover:text-danger"
                        onClick={() =>
                          setGroups((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <span className="copy-block mt-1 block text-ink-subtle text-xs">
                {`参加者が自分の所属として選べます。${terms.role}は既定のものが自動で用意されるので、ここでは${terms.group}だけ足してください。`}
              </span>
            </div>

            {/* 期ごとに同じ顔ぶれで作り直すので、前回の区分とグループをそのまま引ける入り口。 */}
            {events.length > 0 && (
              <Field
                label="前のイベントから引き継ぐ（任意）"
                hint={`選んだイベントの${terms.role}と${terms.group}（1 回の長さと「必ず参加」も含む）を写します。参加者や予定は持ってきません。`}
              >
                <select
                  className={inputClass}
                  value={copyFromSlug}
                  onChange={(event) => setCopyFromSlug(event.target.value)}
                >
                  <option value="">引き継がない</option>
                  {events.map((event) => (
                    <option key={event.slug} value={event.slug}>
                      {event.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={submitting || !title.trim()}>
                イベントを作成
              </Button>
              <Message text={message.text} tone={message.tone} />
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
