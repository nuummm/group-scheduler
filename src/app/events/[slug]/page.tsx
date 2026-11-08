import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { PageLoadError, PageLoading } from "@/app/_components/PageState";
import { ApiRequestError, api } from "@/app/_lib/api-client";
import { readParticipantAuth } from "@/app/_lib/participant-auth";
import { useDocumentTitle } from "@/app/_lib/use-document-title";
import NotFound from "@/app/not-found";
import { EDIT_KEY_HEADER } from "@/lib/http";
import type { EventView } from "@/lib/types";
import { EventWorkspace } from "./_components/EventWorkspace";

type LoadState =
  | { status: "ready"; view: EventView }
  | { status: "missing" }
  | { status: "failed"; message: string };

export default function EventPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  // 結果はどの slug のものかと一緒に持つ。/events/a から /events/b へ移った直後の描画で、
  // a の表を b の作業画面として組み立てないため。
  const [loaded, setLoaded] = useState<{ slug: string; state: LoadState } | null>(null);
  // 最後に始めた読み込みだけを採る。移った直後に a の応答が遅れて届いても b を上書きしない。
  const seqRef = useRef(0);

  // 保存済みの編集キーもここで載せる。初回の 1 回で「自分」まで揃えておけば、
  // 作業画面が開いた直後にもう一度取り直さずに済む。
  const load = useCallback(async () => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoaded(null);
    const auth = readParticipantAuth(slug);
    let state: LoadState;
    try {
      const view = await api.get<EventView>(
        `/api/events/${encodeURIComponent(slug)}${auth ? `?participantId=${auth.participantId}` : ""}`,
        auth ? { [EDIT_KEY_HEADER]: auth.editKey } : undefined,
      );
      state = { status: "ready", view };
    } catch (error) {
      state =
        error instanceof ApiRequestError && error.status === 404
          ? { status: "missing" }
          : {
              status: "failed",
              message:
                error instanceof ApiRequestError
                  ? error.message
                  : "イベントを読み込めませんでした。",
            };
    }
    if (seqRef.current === seq) {
      setLoaded({ slug, state });
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = loaded?.slug === slug ? loaded.state : null;
  useDocumentTitle(
    state?.status === "ready"
      ? state.view.event.title
      : state?.status === "missing"
        ? "イベントが見つかりません"
        : null,
  );

  if (!state) {
    return <PageLoading />;
  }
  if (state.status === "missing") {
    return <NotFound />;
  }
  if (state.status === "failed") {
    return <PageLoadError message={state.message} onRetry={() => void load()} />;
  }
  // key で作り直す。同じ経路のあいだは部品が使い回され、作業画面は初期表示を
  // state と ref に抱えたままなので、別のイベントへ移っても前の表が残る。
  return <EventWorkspace key={slug} initialView={state.view} />;
}
