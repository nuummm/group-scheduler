import { Bell, BellOff, Eraser, History, LayoutGrid, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { ArrivalCelebration, AttendanceView, Island, Seat, SeatStatus } from "@/lib/types";
import { Button, Card, EmptyState, Field, inputClass, Modal } from "../../_components/ui";
import { useConfirm } from "../../_components/use-confirm";
import { ApiRequestError, api } from "../../_lib/api-client";
import { useIslandStore } from "../../_stores/island-store";
import { AttendanceLog } from "./AttendanceLog";
import { HighlightTicker } from "./HighlightTicker";
import { SeatCard } from "./SeatCard";
import { StreakCelebration } from "./StreakCelebration";

/**
 * 在室状況の盤面。
 *
 * ## 誤タップへの備え
 * 他人の席を間違って押したときに困るのは「Slack に間違った通知が出てしまう」ことなので、
 * サーバーは在室のお知らせを数秒ぶん保留してから送る。この画面は保留のあいだ島に「取り消す」を
 * 残り秒数つきで出し続ける。押し直して不在に戻しても保留は消えるため、
 * どちらの直し方でも通知は外へ出ない。
 *
 * ## 表示の更新
 * 盤面は数秒ごとに取り直すが、内容ハッシュ（revision）が同じなら state を触らない。
 * 毎回作り直すと、変化がなくてもアニメーションが飛び、操作中の状態も巻き込まれる。
 */

const POLL_INTERVAL_MS = 5_000;

/** 「そっと入る」の設定は端末ごとに覚える（本人の好みなので共有しない）。 */
const SILENT_MODE_KEY = "group-scheduler:silent-mode";

export function AttendanceBoard({ initialView }: { initialView: AttendanceView }) {
  const [view, setView] = useState(initialView);
  const [editingLayout, setEditingLayout] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Seat | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [islandRenameTarget, setIslandRenameTarget] = useState<Island | null>(null);
  const [islandRenameValue, setIslandRenameValue] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  // 自分の席を押した本人にだけ出すお祝い。盤面には残さない。
  const [celebration, setCelebration] = useState<ArrivalCelebration | null>(null);
  // Slack に知らせずに在室にするモード。既定は知らせる。
  const [silentMode, setSilentMode] = useState(false);
  const showIsland = useIslandStore((state) => state.show);
  const dismissIsland = useIslandStore((state) => state.dismiss);
  const { confirm, confirmDialog } = useConfirm();

  // 楽観更新の直後にポーリング結果で上書きされないよう、進行中の書き込みを数える。
  const inflightRef = useRef(0);
  // 書き込みが終わるたびに進む世代。GET の往復のあいだに書き込みが「始まって終わった」
  // ときは inflight が 0 に戻っているので、数を見るだけでは巻き戻りを止められない。
  const mutationSeqRef = useRef(0);
  // 自分が最後に出した通知の id。取り消しのときに他人のぶんを消さないために覚える。
  const noticeIdRef = useRef<number | null>(null);
  // その通知が指している席。保留が消えたら「取り消す」も引っ込めるために覚える。
  const noticeSeatRef = useRef<string | null>(null);
  // 更新は applyView が行う。描画中に書くと副作用になるのでここでは初期値だけ。
  const revisionRef = useRef(initialView.revision);

  // 端末ごとの好みなので、読み込みは初回だけ。
  useEffect(() => {
    try {
      setSilentMode(localStorage.getItem(SILENT_MODE_KEY) === "1");
    } catch {
      /* localStorage が使えない環境では既定（知らせる）のまま */
    }
  }, []);

  const toggleSilentMode = () => {
    setSilentMode((current) => {
      const next = !current;
      try {
        localStorage.setItem(SILENT_MODE_KEY, next ? "1" : "0");
      } catch {
        /* 保存できなくてもこの画面のあいだは効く */
      }
      return next;
    });
  };

  const applyView = useCallback(
    (next: AttendanceView) => {
      revisionRef.current = next.revision;
      setView(next);
      // 出しっぱなしの「取り消す」を、盤面の実態に追従させる。
      //
      // 保留が消える理由は取り消しだけではない。全部空席にする・席を消す・
      // 席なしにする・他の人が同じ席を触る・猶予が切れて送信済みになる、など。
      // 追従させないと、**もう戻せないものに対して「取り消す」が押せる**まま残り、
      // 押すと「その席の最後の変更」を巻き戻して盤面が部分的に壊れる。
      const seatKey = noticeSeatRef.current;
      const noticeId = noticeIdRef.current;
      if (seatKey && noticeId !== null && !next.pending.some((item) => item.seatKey === seatKey)) {
        dismissIsland(noticeId);
        noticeIdRef.current = null;
        noticeSeatRef.current = null;
      }
    },
    [dismissIsland],
  );

  const reportError = useCallback(
    (error: unknown) => {
      const message = error instanceof ApiRequestError ? error.message : "通信に失敗しました。";
      showIsland({ tone: "danger", title: message });
    },
    [showIsland],
  );

  /** 書き込み系はすべてここを通す（楽観更新の巻き戻しと在庫カウントを 1 箇所に集める）。 */
  const mutate = useCallback(
    async (run: () => Promise<AttendanceView>, optimistic?: () => void) => {
      inflightRef.current += 1;
      optimistic?.();
      try {
        applyView(await run());
      } catch (error) {
        reportError(error);
        // 手元のスナップショットへ戻すと、並行して成功した別の書き込みまで巻き戻る。
        // サーバーの現在値を取り直すのが確実。
        //
        // ただし取り直しの往復中にも別の書き込みは走りうる。取り直した値のほうが
        // 古くなっている場合があるので、世代を見て、動いていたら捨てる。
        const seq = mutationSeqRef.current;
        try {
          const latest = await api.get<AttendanceView>("/api/attendance");
          if (mutationSeqRef.current === seq) {
            applyView(latest);
          }
        } catch {
          /* 取り直しにも失敗したら、いま出ている盤面のまま次のポーリングに任せる */
        }
      } finally {
        inflightRef.current -= 1;
        mutationSeqRef.current += 1;
      }
    },
    [applyView, reportError],
  );

  useEffect(() => {
    const refresh = async () => {
      if (document.visibilityState === "hidden" || inflightRef.current > 0 || editingLayout) {
        return;
      }
      const seq = mutationSeqRef.current;
      try {
        const next = await api.get<AttendanceView>("/api/attendance");
        // 待っているあいだに書き込みが動いていたら、古い結果で上書きしない。
        if (inflightRef.current > 0 || mutationSeqRef.current !== seq) {
          return;
        }
        // 内容が変わっていないなら再描画しない。
        if (next.revision !== revisionRef.current) {
          applyView(next);
        }
      } catch {
        // 一時的な失敗は握りつぶし、いま出ている盤面を維持する。
      }
    };
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    // 隠れているあいだは取り直さないので、戻った瞬間の盤面は古い。
    // 次の周期を待つと、壁の表示を点けてから最大 5 秒、隠れる前の在室が出たままになる。
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyView, editingLayout]);

  const undoSeat = useCallback(
    async (seatKey: string, eventId: number) => {
      // 他の書き込みと同じように数える。数えないと、取り消しの直前に飛んでいた
      // ポーリングの応答（取り消し前の盤面）が後から届いて上書きし、
      // 「取り消しが効かなかった」ように見える。
      inflightRef.current += 1;
      try {
        applyView(
          await api.post<AttendanceView>(`/api/attendance/seats/${seatKey}/undo`, { eventId }),
        );
        showIsland({ tone: "neutral", title: "取り消しました", detail: "Slack には送られません" });
      } catch (error) {
        reportError(error);
      } finally {
        inflightRef.current -= 1;
        mutationSeqRef.current += 1;
      }
    },
    [applyView, reportError, showIsland],
  );

  // 送信中の席。トグルなので、返事を待たずに 2 回押すと元に戻ってしまう。
  const seatInflightRef = useRef(new Set<string>());

  const toggleSeat = useCallback(
    async (seat: Seat) => {
      if (seatInflightRef.current.has(seat.key)) {
        return;
      }
      seatInflightRef.current.add(seat.key);
      const nextStatus: SeatStatus = seat.status === "present" ? "offsite" : "present";
      inflightRef.current += 1;
      setView((current) => withSeatStatus(current, seat.key, nextStatus));
      try {
        const next = await api.post<AttendanceView & { arrival?: ArrivalCelebration }>(
          `/api/attendance/seats/${seat.key}`,
          { silent: silentMode },
        );
        applyView(next);
        // 在室にしたときだけ返る。連続日数などが何も無い日は出さない（中で判定）。
        setCelebration(next.arrival ?? null);

        const pending = next.pending.find((item) => item.seatKey === seat.key);
        if (pending) {
          // サーバーが測った残りを、自分の時計に載せ替える。
          // 絶対時刻をそのまま使うと、端末の時計のずれがそのまま出る。
          const expiresAt = Date.now() + pending.remainingMs;
          noticeIdRef.current = showIsland({
            tone: "success",
            title: `${seat.label} を在室中にしました`,
            detail: "この間に取り消せば Slack には出ません",
            expiresAt,
            action: {
              label: "取り消す",
              // どの変更を戻すかを名指しする。名指ししないと、押したあとに
              // 他の人が同じ席を触っていた場合にその操作を巻き戻してしまう。
              run: () => void undoSeat(seat.key, pending.eventId),
            },
          });
          noticeSeatRef.current = seat.key;
        } else {
          // 自分が出した通知だけを引っ込める（他の席の「取り消す」を巻き込まない）。
          // id を渡さない dismiss は「いま出ているものを無条件に消す」なので、
          // 自分の通知が無いときは何もしない。
          if (noticeIdRef.current !== null) {
            dismissIsland(noticeIdRef.current);
          }
          noticeIdRef.current = showIsland({
            tone: "neutral",
            title: `${seat.label} を${nextStatus === "present" ? "在室中" : "不在"}にしました`,
            detail:
              nextStatus === "present" && silentMode ? "Slack には知らせていません" : undefined,
          });
          // 取り消せる通知ではないので、追従の対象から外す。
          noticeSeatRef.current = null;
        }
      } catch (error) {
        reportError(error);
        try {
          applyView(await api.get<AttendanceView>("/api/attendance"));
        } catch {
          /* 取り直せなければ次のポーリングで揃う */
        }
      } finally {
        seatInflightRef.current.delete(seat.key);
        inflightRef.current -= 1;
        mutationSeqRef.current += 1;
      }
    },
    [applyView, dismissIsland, reportError, showIsland, silentMode, undoSeat],
  );

  const toggleAway = (seat: Seat) => {
    if (seat.status === "away") {
      // 離席をやめる。戻り先（在室 or 不在）は**サーバーが履歴から決める**。
      // ここで決め打ちにすると、不在から離席にした人まで在室にしてしまう。
      // 楽観更新もしない（どちらに転ぶか、こちらでは分からない）。
      void mutate(() =>
        api.patch<AttendanceView>(`/api/attendance/seats/${seat.key}`, { status: "clear-away" }),
      );
      return;
    }
    void mutate(
      () => api.patch<AttendanceView>(`/api/attendance/seats/${seat.key}`, { status: "away" }),
      () => setView((current) => withSeatStatus(current, seat.key, "away")),
    );
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const label = renameValue.trim();
    setRenameTarget(null);
    // 空欄は「既定名に戻す」。黙って捨てると、抜けた人の名前を消せない。
    if (label === renameTarget.label) return;
    await mutate(() =>
      api.patch<AttendanceView>(`/api/attendance/seats/${renameTarget.key}`, { label }),
    );
  };

  const submitIslandRename = async () => {
    if (!islandRenameTarget) return;
    const target = islandRenameTarget;
    const label = islandRenameValue.trim();
    setIslandRenameTarget(null);
    if (label === target.title) return;
    await mutate(() =>
      api.patch<AttendanceView>(`/api/attendance/islands/${target.key}`, { label }),
    );
  };

  /** 盤面全体を不在に戻す。帰り際の押し忘れをまとめて片付けるための操作。 */
  const clearAll = async () => {
    const occupied = view.summary.presentCount + view.summary.awayCount;
    if (occupied === 0) return;
    const ok = await confirm({
      title: "全部空席にしますか？",
      message: `${occupied} 席を不在に戻します。保留中のお知らせがあれば取り消されます。`,
      confirmLabel: "空席にする",
    });
    if (!ok) return;
    await mutate(() => api.post<AttendanceView>("/api/attendance/clear"));
  };

  /** 島のマスをまとめて席 / 席なしに切り替える。使っていない島を畳むための操作。 */
  const setIslandKind = async (island: Island, seatKind: "seat" | "void") => {
    if (seatKind === "void") {
      const ok = await confirm({
        title: `${island.title} を席なしにしますか？`,
        message: "この島のマスをすべて席なしにします。あとから座席に戻せます。",
        confirmLabel: "席なしにする",
      });
      if (!ok) return;
    }
    await mutate(() =>
      api.patch<AttendanceView>(`/api/attendance/islands/${island.key}`, { seatKind }),
    );
  };

  /**
   * 席 ↔ 席なしマスの切り替え。
   *
   * 席なしにすると在室状態も消える。削除と同じ重さなのに確認が無いと、
   * 隣り合った小さなアイコンの押し間違いで、居る人が黙って消える。
   */
  const changeSeatKind = async (seat: Seat, kind: "seat" | "void") => {
    if (kind === "void") {
      const ok = await confirm({
        title: "席なしのマスにしますか？",
        message:
          seat.status === "offsite"
            ? `「${seat.label}」を席なしのマスにします。あとから座席に戻せます。`
            : `「${seat.label}」はいま${seat.status === "present" ? "在室中" : "離席中"}です。席なしにすると不在に戻ります。`,
        confirmLabel: "席なしにする",
      });
      if (!ok) return;
    }
    await mutate(() =>
      api.patch<AttendanceView>(`/api/attendance/seats/${seat.key}`, { seatKind: kind }),
    );
  };

  const removeSeat = async (seat: Seat) => {
    const ok = await confirm({
      title: "席を削除しますか？",
      message:
        seat.status === "offsite"
          ? `「${seat.label}」を座席表から取り除きます。`
          : `「${seat.label}」はいま${seat.status === "present" ? "在室中" : "離席中"}です。座席表から取り除きます。`,
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    await mutate(() => api.delete<AttendanceView>(`/api/attendance/seats/${seat.key}`));
  };

  const removeIsland = async (islandKey: string, title: string) => {
    const ok = await confirm({
      title: "島を削除しますか？",
      message: `${title} の席をまとめて取り除きます。この操作は元に戻せません。`,
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    await mutate(() => api.delete<AttendanceView>(`/api/attendance/islands/${islandKey}`));
  };

  const pendingSeatKeys = new Set(view.pending.map((item) => item.seatKey));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <StatChip label="在室中" value={view.summary.presentCount} tone="present" />
        <StatChip label="離席中" value={view.summary.awayCount} tone="away" />
        <StatChip label="席数" value={view.summary.totalSeatCount} tone="neutral" />
        <div className="ml-auto flex items-center gap-2">
          {/* 誰も居ないときは出さない（押しても何も起きないボタンを置かない）。 */}
          {view.summary.presentCount + view.summary.awayCount > 0 && (
            <Button size="sm" onClick={() => void clearAll()}>
              <Eraser className="size-3.5" aria-hidden />
              全部空席にする
            </Button>
          )}
          {/* そっと入るモード。押した時点の設定が効くので、状態が一目で分かるようにする。 */}
          <Button
            size="sm"
            variant={silentMode ? "primary" : "secondary"}
            aria-pressed={silentMode}
            title={
              silentMode
                ? "いまは Slack に知らせずに在室にします"
                : "押すと Slack に知らせずに在室にできます"
            }
            onClick={toggleSilentMode}
          >
            {silentMode ? (
              <BellOff className="size-3.5" aria-hidden />
            ) : (
              <Bell className="size-3.5" aria-hidden />
            )}
            {silentMode ? "そっと入る" : "知らせる"}
          </Button>
          <Button size="sm" onClick={() => setLogOpen(true)}>
            <History className="size-3.5" aria-hidden />
            履歴
          </Button>
          {/* 編集中の「終える」だけは画面に固定する。座席表は縦に長く、
              下までスクロールすると抜け出す口が見えなくなるため。 */}
          <Button
            size="sm"
            variant={editingLayout ? "primary" : "secondary"}
            onClick={() => setEditingLayout((value) => !value)}
            className={
              editingLayout
                ? "fixed right-4 bottom-4 z-30 h-10 px-4 shadow-[var(--shadow-float)] sm:right-6 sm:bottom-6"
                : undefined
            }
          >
            <LayoutGrid className="size-3.5" aria-hidden />
            {editingLayout ? "編集を終える" : "レイアウト編集"}
          </Button>
        </div>
      </div>

      <HighlightTicker highlights={view.highlights} />

      {/* 送信待ちを知らせる帯は置かない。在室にするたびに要素が増えて座席表が下へずれ、
          続けて押すときに狙いが動いてしまう。取り消し口はアプリ島（猶予のあいだ出続ける）と、
          席カードの光る枠で足りている。 */}

      {editingLayout && (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
          <p className="copy-block text-ink-muted text-xs">
            {
              "島の追加・削除、島名の変更、席の増減、席なしマスへの切り替えができます。入口の位置は固定です。"
            }
          </p>
        </Card>
      )}

      <Card className="p-4 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
          {view.islands.map((island) => (
            <section
              key={island.key}
              className={cn(
                "rounded-[var(--radius-card)] border p-3 transition-colors",
                editingLayout
                  ? "border-accent/40 bg-accent-soft/30"
                  : "border-line bg-surface-muted/40",
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <h3 className="font-medium text-ink text-xs">{island.title}</h3>
                {/* 名前の編集は見出しのすぐ隣に置く。右端の操作群へ混ぜると、
                    何に対する鉛筆なのかが読み取れない。 */}
                {editingLayout && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${island.title} の名前を変更`}
                    title="島の名前を変更"
                    className="-my-1 h-6 px-1"
                    onClick={() => {
                      setIslandRenameTarget(island);
                      setIslandRenameValue(island.title);
                    }}
                  >
                    <Pencil className="size-3" aria-hidden />
                  </Button>
                )}
                <span className="text-ink-subtle text-xs">{island.seatCount} 席</span>
                {editingLayout ? (
                  <div className="ml-auto flex flex-wrap justify-end gap-1">
                    {/* マスが 1 つも無い島には出さない（押しても何も起きないため）。 */}
                    {island.seats.length > 0 &&
                      (island.seatCount > 0 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void setIslandKind(island, "void")}
                        >
                          島ごと席なし
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void setIslandKind(island, "seat")}
                        >
                          島ごと座席に戻す
                        </Button>
                      ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={() => void removeIsland(island.key, island.title)}
                    >
                      島を削除
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {island.seats.map((seat) => (
                  <SeatCard
                    key={seat.key}
                    seat={seat}
                    editingLayout={editingLayout}
                    pendingUndo={pendingSeatKeys.has(seat.key)}
                    onToggle={() => void toggleSeat(seat)}
                    onToggleAway={() => toggleAway(seat)}
                    onRename={() => {
                      setRenameTarget(seat);
                      setRenameValue(seat.label);
                    }}
                    onChangeKind={(kind) => void changeSeatKind(seat, kind)}
                    onRemove={() => void removeSeat(seat)}
                  />
                ))}

                {/* 席の追加口も、追加された席が現れる場所そのものに置く（島の追加と同じ流儀）。 */}
                {editingLayout && (
                  <button
                    type="button"
                    onClick={() =>
                      void mutate(() =>
                        api.post<AttendanceView>("/api/attendance/seats", {
                          islandKey: island.key,
                        }),
                      )
                    }
                    className={cn(
                      "flex min-h-[5.5rem] flex-col items-center justify-center gap-1",
                      "rounded-[var(--radius-control)] border border-accent/40 border-dashed",
                      "bg-accent-soft/30 text-accent-ink transition-colors",
                      "hover:border-accent hover:bg-accent-soft/60",
                    )}
                  >
                    <Plus className="size-4" aria-hidden />
                    <span className="font-medium text-xs">席を追加</span>
                  </button>
                )}
              </div>
            </section>
          ))}

          {/* 追加の入り口は、追加された島が現れる場所そのものに置く。
              ツールバーの端に置くと盤面から離れすぎて、何を追加するボタンなのか読み取れない。 */}
          {editingLayout && (
            <button
              type="button"
              onClick={() => void mutate(() => api.post<AttendanceView>("/api/attendance/islands"))}
              className={cn(
                "flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-card)]",
                "border border-accent/40 border-dashed bg-accent-soft/30 text-accent-ink",
                "transition-colors hover:border-accent hover:bg-accent-soft/60",
              )}
            >
              <Plus className="size-5" aria-hidden />
              <span className="font-medium text-xs">島を追加</span>
              <span className="text-ink-subtle text-[11px]">4 席の島がここに増えます</span>
            </button>
          )}
        </div>
        {view.islands.length === 0 && !editingLayout && (
          <EmptyState>座席がまだ登録されていません。</EmptyState>
        )}
        <p className="mt-4 text-center text-ink-subtle text-xs tracking-widest">入口</p>
      </Card>

      <Modal
        open={renameTarget !== null}
        title="席の名前を変更"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)}>キャンセル</Button>
            <Button variant="primary" onClick={() => void submitRename()}>
              保存
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <Field
            label="席名"
            hint="空欄にすると「空席 A」のような既定名に戻ります。既定名の席は Slack 通知に名前が出ません。"
          >
            <input
              className={inputClass}
              maxLength={24}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={islandRenameTarget !== null}
        title="島の名前を変更"
        onClose={() => setIslandRenameTarget(null)}
        footer={
          <>
            <Button onClick={() => setIslandRenameTarget(null)}>キャンセル</Button>
            <Button variant="primary" onClick={() => void submitIslandRename()}>
              保存
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitIslandRename();
          }}
        >
          <Field label="島の名前" hint="空欄にすると「島 1」のような自動の名前に戻ります。">
            <input
              className={inputClass}
              maxLength={20}
              placeholder="例: 窓側 / 島 A"
              value={islandRenameValue}
              onChange={(event) => setIslandRenameValue(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal open={logOpen} title="在室の記録" onClose={() => setLogOpen(false)} wide>
        <AttendanceLog />
      </Modal>

      {/* 押した本人にだけ出るお祝い。数秒で自動的に消える。 */}
      <StreakCelebration arrival={celebration} onDone={() => setCelebration(null)} />

      {/* 確認ダイアログは最後に置く。Modal はどれも同じ z-index の固定レイヤーなので、
        先に置くと後ろの Modal に隠れて見えなくなる。 */}
      {confirmDialog}
    </div>
  );
}

/** 楽観更新: 指定した席の状態だけを差し替えた新しいビューを返す。 */
function withSeatStatus(view: AttendanceView, seatKey: string, status: SeatStatus): AttendanceView {
  const islands = view.islands.map((island) => ({
    ...island,
    seats: island.seats.map((seat) => (seat.key === seatKey ? { ...seat, status } : seat)),
  }));
  const seats = islands
    .flatMap((island) => island.seats)
    .filter((seat) => seat.seatKind === "seat");
  return {
    ...view,
    islands,
    summary: {
      ...view.summary,
      presentCount: seats.filter((seat) => seat.status === "present").length,
      awayCount: seats.filter((seat) => seat.status === "away").length,
    },
  };
}

function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "present" | "away" | "neutral";
}) {
  return (
    <div className="flex items-baseline gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5">
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "present" && "bg-present",
          tone === "away" && "bg-away",
          tone === "neutral" && "bg-ink-subtle/40",
        )}
        aria-hidden
      />
      <span className="font-semibold text-ink text-lg tabular-nums leading-none">{value}</span>
      <span className="text-ink-muted text-xs">{label}</span>
    </div>
  );
}
