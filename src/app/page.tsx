import { useCallback, useEffect, useState } from "react";
import type { EventListItem } from "@/lib/types";
import { DashboardView } from "./_components/DashboardView";
import { PageLoadError, PageLoading } from "./_components/PageState";
import { ApiRequestError, api } from "./_lib/api-client";
import { useDocumentTitle } from "./_lib/use-document-title";

export default function HomePage() {
  useDocumentTitle("日程調整");
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setEvents((await api.get<{ events: EventListItem[] }>("/api/events")).events);
    } catch (error) {
      setLoadError(
        error instanceof ApiRequestError ? error.message : "イベントの一覧を読み込めませんでした。",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (events) {
    return <DashboardView events={events} onChanged={() => void load()} />;
  }
  return loadError ? (
    <PageLoadError message={loadError} onRetry={() => void load()} />
  ) : (
    <PageLoading />
  );
}
