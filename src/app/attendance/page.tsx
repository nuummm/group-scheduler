import { useCallback, useEffect, useState } from "react";
import type { AttendanceView } from "@/lib/types";
import { PageLoadError, PageLoading } from "../_components/PageState";
import { ApiRequestError, api } from "../_lib/api-client";
import { appConfig } from "../_lib/app-config";
import { useDocumentTitle } from "../_lib/use-document-title";
import { AttendanceBoard } from "./_components/AttendanceBoard";

const RETRY_AFTER_ERROR_MS = 30_000;

/**
 * 盤面は最初の 1 回を取ってから組む。
 * 空の盤面を先に出すと、開いた瞬間だけ全員が不在に見える。
 */
export default function AttendancePage() {
  useDocumentTitle("在室状況");
  const { notifyDelayMs, placeName } = appConfig();
  const [view, setView] = useState<AttendanceView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await api.get<AttendanceView>("/api/attendance"));
    } catch (error) {
      setLoadError(
        error instanceof ApiRequestError ? error.message : "在室状況を読み込めませんでした。",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 常設の表示 PC は、開いたときに一度つながらなかっただけでエラーのまま残らないよう、
  // 読めるまで間を空けて取り直す（タブに戻ったときもすぐ試す）。
  useEffect(() => {
    if (!loadError) {
      return;
    }
    const timer = setTimeout(() => void load(), RETRY_AFTER_ERROR_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadError, load]);

  const undoSeconds = Math.round(notifyDelayMs / 1000);

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="font-semibold text-ink text-xl">在室状況</h1>
        <p className="copy-block max-w-3xl text-ink-muted text-sm leading-relaxed">
          {`いま${placeName}にいる人を、席をタップして共有します。ゆるい自己申告なので、気が向いたときだけで大丈夫です。`}
        </p>
        <p className="text-ink-subtle text-xs leading-relaxed">
          {`Slack へのお知らせは ${undoSeconds} 秒待ってから送ります。押し間違えても、その間に取り消せば何も届きません。`}
        </p>
        <p className="text-ink-subtle text-xs leading-relaxed">
          {
            "右上のベルは Slack へのお知らせの切り替えです。「そっと入る」にしておくと、記録は残しつつ Slack には知らせません。"
          }
        </p>
      </header>
      {view ? (
        <AttendanceBoard initialView={view} />
      ) : loadError ? (
        <PageLoadError message={loadError} onRetry={() => void load()} />
      ) : (
        <PageLoading />
      )}
    </div>
  );
}
