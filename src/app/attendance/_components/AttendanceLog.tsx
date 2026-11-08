import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { AttendanceLogEntry } from "@/lib/types";
import { EmptyState } from "../../_components/ui";
import { api } from "../../_lib/api-client";

/**
 * 在室の記録。
 *
 * 「いまの状態」だけでは後から振り返れないので、状態が変わるたびに 1 行を積む。
 */

const STATUS_LABEL = {
  present: "来た",
  away: "離席",
  offsite: "帰った",
} as const;

const STATUS_CLASS = {
  present: "bg-present-soft text-present",
  away: "bg-away-soft text-away",
  offsite: "bg-surface-muted text-ink-muted",
} as const;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function AttendanceLog() {
  const [entries, setEntries] = useState<AttendanceLogEntry[] | null>(null);

  // Modal は閉じているあいだ children を描画しないので、マウント時に取りに行けばよい。
  useEffect(() => {
    let active = true;
    api
      .get<{ entries: AttendanceLogEntry[] }>("/api/attendance/log?limit=100")
      .then((payload) => {
        if (active) setEntries(payload.entries);
      })
      .catch(() => {
        if (active) setEntries([]);
      });
    return () => {
      active = false;
    };
  }, []);

  if (entries === null) {
    return <p className="py-6 text-center text-ink-subtle text-sm">読み込み中...</p>;
  }
  if (entries.length === 0) {
    return <EmptyState>まだ記録がありません。</EmptyState>;
  }

  return (
    <ul className="divide-y divide-line">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-3 py-2.5">
          <time
            className="w-24 shrink-0 text-ink-subtle text-xs tabular-nums"
            dateTime={entry.createdAt}
          >
            {formatTimestamp(entry.createdAt)}
          </time>
          <span className="min-w-0 flex-1 truncate text-ink text-sm">{entry.seatLabel}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 font-medium text-xs",
              STATUS_CLASS[entry.status],
            )}
          >
            {STATUS_LABEL[entry.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}
