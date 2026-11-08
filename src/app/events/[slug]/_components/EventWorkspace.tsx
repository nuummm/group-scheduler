import { ArrowLeft, Clock, CopyPlus, ImageDown, Pencil, Pin, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { EDIT_KEY_HEADER } from "@/lib/http";
import { hasResponded, type MemberSort } from "@/lib/participants";
import {
  describeWeeklyLayout,
  type ExtraSlot,
  formatDisplayDate,
  slotHeading,
} from "@/lib/schedule";
import type {
  CurrentParticipant,
  EventListItem,
  EventView,
  FilterMode,
  FixedSlot,
  ParticipantListItem,
} from "@/lib/types";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  inputClass,
  Message,
  Modal,
} from "../../../_components/ui";
import { useConfirm } from "../../../_components/use-confirm";
import { ApiRequestError, api } from "../../../_lib/api-client";
import { terms } from "../../../_lib/app-config";
import { writeLastEventPath } from "../../../_lib/last-event";
import {
  clearParticipantAuth,
  readParticipantAuth,
  writeParticipantAuth,
} from "../../../_lib/participant-auth";
import { useIslandStore } from "../../../_stores/island-store";
import { CategoryChips, nextSingleSelection } from "./CategoryChips";
import { copyImageToClipboard } from "./canvas-grid";
import type { CellRange } from "./cell-range";
import { EventNotes } from "./EventNotes";
import { ExtraSlotEditor } from "./ExtraSlotEditor";
import { MatrixTable } from "./MatrixTable";
import { MemberList } from "./MemberList";
import { renderMatrixImage } from "./matrix-image";
import { renderPlanImage } from "./plan-image";
import { cellId, type EditorDraft, ScheduleEditor } from "./ScheduleEditor";
import { SeminarPlan } from "./SeminarPlan";
import { ShareLink } from "./ShareLink";
import { SlotSpanPicker } from "./SlotSpanPicker";
import { isGrabbingSeminar } from "./use-seminar-drag";

/**
 * イベント 1 件の作業画面。
 *
 * 状態の持ち方は「サーバーが正本、画面は写し」。更新系 API は自分の結果だけを返し、
 * 画面は都度 GET で取り直す。更新のたびにマトリクス全体を返すと、
 * 1 セルの保存でも全参加者ぶんの集計が走る。
 */

/** 解き直しているあいだ、最低限これだけは出しておく。 */
const RECOMPUTE_MIN_MS = 450;

/** 他の端末の変更を見に行く間隔。10 人が同時に入力しても、軽い問い合わせなので負荷にならない。 */
const POLL_INTERVAL_MS = 5_000;

interface EditorState {
  participant: CurrentParticipant;
  draft: EditorDraft;
  dirty: boolean;
  /** 保存が弾かれた理由。ダイアログの中に出す（後ろの画面に出しても見えない）。 */
  conflict?: string;
}

export function EventWorkspace({ initialView }: { initialView: EventView }) {
  const { group: groupTerm, role: roleTerm } = terms();
  const slug = initialView.event.slug;
  const [view, setView] = useState(initialView);
  const [filterGroupIds, setFilterGroupIds] = useState<number[]>([]);
  const [filterGradeIds, setFilterGradeIds] = useState<number[]>([]);
  // 既定は「選んだ人を合わせて見る」。サーバー側の既定と同じにしておかないと、
  // 初回表示と最初の取り直しで表の中身が入れ替わる。
  const [filterMode, setFilterMode] = useState<FilterMode>("any");
  const [showNames, setShowNames] = useState(false);
  const [memberSort, setMemberSort] = useState<MemberSort>("name");
  // 保存の二重送信を止める。ref は同じ tick の連打を弾き、state はボタンの見た目に使う。
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // 選んだ時間帯。同じ列の連続したコマだけを持つ（1・2 限をまとめて見るための選択）。
  const [selection, setSelection] = useState<CellRange | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [accessTarget, setAccessTarget] = useState<ParticipantListItem | null>(null);
  // 削除の合言葉。window.prompt は見た目が揃わないうえ、ブロックされる環境がある。
  const [deleteTarget, setDeleteTarget] = useState<ParticipantListItem | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [accessPassword, setAccessPassword] = useState("");
  // null = 閉じている。開いているあいだは編集中の値を持つ。
  const [infoDraft, setInfoDraft] = useState<{ title: string; description: string } | null>(null);
  // null = 閉じている。追加コマの編集はイベント情報とは別のダイアログに分ける
  // （表のすぐ下から開けるようにするため）。
  const [slotDraft, setSlotDraft] = useState<ExtraSlot[] | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [selfGroupIds, setSelfGroupIds] = useState<number[]>([]);
  // 区分は 1 人 1 つ。未選択は null。
  const [selfGradeId, setSelfGradeId] = useState<number | null>(null);
  // 追加しようとしているグループの 1 回の長さ。登録してから設定を開き直さずに済むように持つ。
  const [newGroupSpan, setNewGroupSpan] = useState(1);
  // null = 閉じている。開いているあいだは引き継ぎ元の候補を持つ。
  const [copySources, setCopySources] = useState<EventListItem[] | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" }>({
    text: "",
    tone: "info",
  });

  const showIsland = useIslandStore((state) => state.show);
  const { confirm, confirmDialog } = useConfirm();

  const notifyError = useCallback(
    (error: unknown, fallback: string) => {
      const text = error instanceof ApiRequestError ? error.message : fallback;
      // 島にだけ出す。同じ文言をページ内にも出すと、同じ失敗が 2 箇所に並んで
      // 「2 回失敗した」ように読める。消せない入力の誤りだけは各フォームが出す。
      showIsland({ tone: "danger", title: text });
    },
    [showIsland],
  );

  // 取り直しの世代。連打したとき、先に投げた古い結果が後から届いて上書きするのを防ぐ。
  const refreshSeqRef = useRef(0);
  // 取り直しは割り当ての計算そのもの。走っているあいだは「解いている」と分かるようにする。
  const [recomputing, setRecomputing] = useState(false);
  const inFlightRef = useRef(0);
  const startedAtRef = useRef(0);
  // 消灯タイマーは 1 本だけ。前の取り直しのタイマーを残すと、次の取り直しの最中に
  // 発火してスピナーが一瞬消える（ちらつきを防ぐための仕組みが自分でちらつかせる）。
  const hideTimerRef = useRef(0);
  // スピナーの点灯状態は描画を待たずに読む（同じ tick で重なる取り直しを正しく数えるため）。
  const recomputingRef = useRef(false);
  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);
  // 最後に見た版。巡回でここと違う値が返ってきたときだけ本体を取り直す。
  const revisionRef = useRef<string | null>(initialView.revision);

  /** 現在のフィルタと保存済み認証を載せて、画面ぶんのデータを取り直す。 */
  const refresh = useCallback(
    async (silent = false): Promise<EventView | null> => {
      const seq = refreshSeqRef.current + 1;
      refreshSeqRef.current = seq;
      // 背景の巡回ではスピナーを出さない。自分が何もしていないのに画面が点滅すると気が散る。
      // 巡回中に自分の操作が始まったときは、そこから点ける（開始時刻も引き直す）。
      if (!silent && !recomputingRef.current) {
        window.clearTimeout(hideTimerRef.current);
        startedAtRef.current = performance.now();
        recomputingRef.current = true;
        setRecomputing(true);
      }
      // 巡回ぶんも数える。書き込みと同時に走ったときに古い結果で上書きしないため。
      inFlightRef.current += 1;
      const params = new URLSearchParams();
      if (filterGroupIds.length > 0) {
        params.set("groupIds", filterGroupIds.join(","));
      }
      if (filterGradeIds.length > 0) {
        params.set("gradeIds", filterGradeIds.join(","));
      }
      params.set("filterMode", filterMode);
      const auth = readParticipantAuth(slug);
      if (auth) {
        params.set("participantId", String(auth.participantId));
      }
      try {
        const next = await api.get<EventView>(
          `/api/events/${encodeURIComponent(slug)}?${params.toString()}`,
          auth ? { [EDIT_KEY_HEADER]: auth.editKey } : undefined,
        );
        // 自分より新しい取り直しが始まっていたら、その結果に任せる。
        if (refreshSeqRef.current !== seq) {
          return null;
        }
        setView(next);
        revisionRef.current = next.revision;
        return next;
      } catch (error) {
        // 巡回の失敗は黙って見送る。10 台が同時に開いている場面で、サーバーの再起動や
        // 一瞬の切断のたびに全員へ赤い帯が出るのは騒がしいだけ。
        if (!silent) {
          notifyError(error, "最新の状態を取得できませんでした。");
        }
        return null;
      } finally {
        inFlightRef.current -= 1;
        // 消すのは「最後に終わった取り直し」の責任。silent かどうかで分けると、
        // 巡回と操作が重なったときに、点けたまま誰も消さない状態が残る。
        if (inFlightRef.current === 0 && recomputingRef.current) {
          // ローカルの計算は速すぎて、素直に消すと一瞬ちらつくだけで終わる。
          // 「探している」と読めるだけの時間は出しておく。
          const wait = Math.max(0, RECOMPUTE_MIN_MS - (performance.now() - startedAtRef.current));
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = window.setTimeout(() => {
            if (inFlightRef.current > 0) return;
            recomputingRef.current = false;
            setRecomputing(false);
          }, wait);
        }
      }
    },
    [filterGroupIds, filterGradeIds, filterMode, notifyError, slug],
  );

  // 自分として認識されたら、入力欄を現在の登録内容に合わせる。
  // ここを空のままにしておくと「自分の予定表を開く」で区分とグループが空に上書きされる。
  //
  // 同期するのは「自分が変わったとき」だけ。毎回の再取得で流し込むと、
  // 入力中の名前や選び直しているチップが取得のたびに巻き戻る。
  const currentParticipant = view.currentParticipant;
  const syncedParticipantIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!currentParticipant || syncedParticipantIdRef.current === currentParticipant.id) {
      return;
    }
    syncedParticipantIdRef.current = currentParticipant.id;
    setName(currentParticipant.name);
    setSelfGroupIds(currentParticipant.groups.map((group) => group.id));
    setSelfGradeId(currentParticipant.gradeId);
  }, [currentParticipant]);

  // 絞り込みを変えたら集計を取り直す。「既定値と同じなら取りに行かない」という判定にすると、
  // 絞り込みを解除して既定へ戻したときに古い集計が残ってしまうので、識別子の変化で見る
  // （refresh はフィルタを閉じ込めた useCallback なので、条件が変わると識別子ごと変わる）。
  //
  // 初回は取りに行かない。初期表示はページが保存済みの編集キーも載せて取ってきたもので、
  // 「自分」まで揃っている。
  const initialFilterRef = useRef(true);
  useEffect(() => {
    if (initialFilterRef.current) {
      initialFilterRef.current = false;
      return;
    }
    void refresh();
  }, [refresh]);

  /**
   * 他の端末の変更を拾う。
   *
   * 全員が同じリンクを開いて一斉に入力する使い方なので、自分が操作したときしか
   * 更新しないと、手元の表だけが古いまま「空いている」ように見える。
   *
   * 毎回画面ぶんの JSON を取り直すのは重いので、まず軽い `/revision` で変化を見て、
   * 変わったときだけ本体を取りに行く。次の場合は見送る:
   * - タブが裏にある（見ていない画面のために回さない）
   * - 自分の書き込みが進行中（結果で上書きされる）
   * - 予定表を開いて編集中（入力中の内容が消えるのがいちばん困る）
   * - ダイアログを開いている（イベント情報やコマの編集が巻き戻る）
   */
  // 「続き」を覚えるのはここ。開けたイベントだけを覚えるので、消えたイベントの
  // パスが残って 404 へ連れ戻されることがない。
  useEffect(() => {
    writeLastEventPath(`/events/${slug}`);
  }, [slug]);

  const editorOpen = editor !== null;
  const dialogOpen =
    infoDraft !== null || slotDraft !== null || accessTarget !== null || deleteTarget !== null;
  // 巡回の途中（await のあと）でも今の状態を見たいので ref に写す。
  // クロージャに閉じ込めた値は、その回の巡回が始まった時点のもので古くなりうる。
  const busyRef = useRef(false);
  busyRef.current = editorOpen || dialogOpen;

  useEffect(() => {
    const checkRevision = async () => {
      // 掴んでいる最中かどうかは描画をまたがないので、巡回のたびに直接見る。
      if (
        document.visibilityState === "hidden" ||
        inFlightRef.current > 0 ||
        busyRef.current ||
        isGrabbingSeminar()
      ) {
        return;
      }
      try {
        const { revision } = await api.get<{ revision: string }>(
          `/api/events/${encodeURIComponent(slug)}/revision`,
        );
        if (revisionRef.current === revision) {
          return;
        }
        // 見送るときは版を記録しない（記録するのは refresh の中だけ）。
        // ここで進めてしまうと、見送ったぶんの変更を二度と取りに行かなくなる。
        if (inFlightRef.current > 0 || busyRef.current || isGrabbingSeminar()) {
          return;
        }
        await refresh(true);
      } catch {
        // 一時的な失敗は握りつぶす。次の巡回で揃う。
      }
    };
    const timer = setInterval(checkRevision, POLL_INTERVAL_MS);
    // 表に戻ったときは次の巡回を待たない。裏にいたあいだは見送っているので、
    // 待つと戻った直後の表が最大 5 秒古いまま「空いている」ように見える。
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkRevision();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, slug]);

  const openEditor = useCallback((participant: CurrentParticipant) => {
    setEditor({
      participant,
      draft: {
        busy: new Set(participant.busyCells.map((cell) => cellId(cell.columnKey, cell.slot))),
        groupIds: participant.groups.map((group) => group.id),
        gradeId: participant.gradeId,
        note: participant.note,
      },
      dirty: false,
    });
  }, []);

  const closeEditor = async (force = false) => {
    if (!force && editor?.dirty) {
      const ok = await confirm({
        title: "保存せずに閉じますか？",
        message: "入力した内容は保存されません。",
        confirmLabel: "閉じる",
        danger: true,
      });
      if (!ok) return;
    }
    setEditor(null);
  };

  // 「開く」の二重送信よけ。連打すると 2 通目が自分自身の名前とぶつかって 409 になる。
  const openingRef = useRef(false);

  /** 名前とパスワードから自分の予定表を開く（未登録なら同時に登録する）。 */
  const openMySchedule = async () => {
    const trimmed = name.trim();
    if (!trimmed || openingRef.current) return;
    openingRef.current = true;
    setMessage({ text: "予定表を開いています...", tone: "info" });
    const auth = readParticipantAuth(slug);
    const current = view.currentParticipant;
    // 同じ名前で戻ってきたときは、保存済みの編集キーで「更新」として扱う。
    const reuseCurrent =
      current && auth && current.name.trim().toLowerCase() === trimmed.toLowerCase();
    try {
      const saved = await api.post<{ participantId: number; editKey: string }>(
        `/api/events/${encodeURIComponent(slug)}/participants`,
        {
          participantId: reuseCurrent ? current.id : null,
          editKey: reuseCurrent ? current.editKey : null,
          name: trimmed,
          groupIds: selfGroupIds,
          gradeId: selfGradeId,
          password,
        },
      );
      writeParticipantAuth(slug, saved);
      setPassword("");
      const next = await refresh();
      // 「開いています...」は必ず消す。取り直しが後発に追い越されて null が返ることがあり、
      // 成功したときだけ消す書き方だと文言が出たままになる。
      setMessage({ text: "", tone: "info" });
      if (next?.currentParticipant) {
        openEditor(next.currentParticipant);
      }
    } catch (error) {
      notifyError(error, "予定表を開けませんでした。");
    } finally {
      openingRef.current = false;
    }
  };

  /** 登録メンバーの行から開く。パスワードがあるときだけダイアログを挟む。 */
  const openMember = async (participant: ParticipantListItem, providedPassword = "") => {
    try {
      const saved = await api.post<{ participantId: number; editKey: string }>(
        `/api/events/${encodeURIComponent(slug)}/participants/access`,
        { participantId: participant.id, password: providedPassword },
      );
      writeParticipantAuth(slug, saved);
      setAccessTarget(null);
      setAccessPassword("");
      const next = await refresh();
      if (next?.currentParticipant) {
        openEditor(next.currentParticipant);
      }
    } catch (error) {
      notifyError(error, "予定表を開けませんでした。");
    }
  };

  const saveEditor = async () => {
    if (!editor || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage({ text: "保存中...", tone: "info" });
    try {
      // 属性と予定は 1 回で送る。2 回に分けると、片方だけ通った中途半端な状態が残る。
      // expectedVersion は開いた時点の版。ほかの端末が先に保存していれば 409 で弾かれる。
      await api.put(`/api/events/${encodeURIComponent(slug)}/schedule`, {
        participantId: editor.participant.id,
        editKey: editor.participant.editKey,
        expectedVersion: editor.participant.version,
        name: editor.participant.name,
        groupIds: editor.draft.groupIds,
        gradeId: editor.draft.gradeId,
        note: editor.draft.note,
        busyCells: [...editor.draft.busy].map((value) => {
          const [columnKey, slot] = value.split(":");
          return { columnKey: columnKey ?? "", slot: Number(slot) };
        }),
      });
      setEditor(null);
      setMessage({ text: "", tone: "info" });
      // 予定表の中で区分とグループを変えた場合、サイドバーの選択も合わせる。
      // 同期の effect は「別人になったとき」しか走らないので、ここで明示的に入れ直す。
      if (currentParticipant?.id === editor.participant.id) {
        setSelfGroupIds(editor.draft.groupIds);
        setSelfGradeId(editor.draft.gradeId);
      }
      showIsland({
        tone: "success",
        title: `${editor.participant.name} の予定を保存しました`,
        detail: `${editor.draft.busy.size} コマ`,
      });
      await refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        // 同じ 409 でも、名前の重複は版を付け替えても直らない（何度押しても同じ）。
        // その場合は理由だけ出して、名前を直してもらう。
        if (error.message.includes("同じ名前")) {
          setEditor((current) => current && { ...current, conflict: error.message });
          showIsland({ tone: "danger", title: "保存できませんでした", detail: error.message });
          return;
        }
        // 入力は消さない。書いた内容が消えるのがいちばん困る。
        // 版だけ最新に付け替えるので、もう一度押せば「承知のうえで上書き」になる。
        const latest = await refresh(true);
        setEditor((current) =>
          current && latest?.currentParticipant?.id === current.participant.id
            ? { ...current, participant: latest.currentParticipant, conflict: error.message }
            : current && { ...current, conflict: error.message },
        );
        showIsland({ tone: "danger", title: "保存できませんでした", detail: error.message });
        return;
      }
      notifyError(error, "保存に失敗しました。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const deleteParticipant = async (participant: ParticipantListItem) => {
    const ok = await confirm({
      title: "メンバーを削除しますか？",
      message: `「${participant.name}」の登録と予定をまとめて削除します。この操作は元に戻せません。`,
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    if (participant.hasPassword) {
      setDeletePassword("");
      setDeleteTarget(participant);
      return;
    }
    await runDeleteParticipant(participant, "");
  };

  const runDeleteParticipant = async (participant: ParticipantListItem, password: string) => {
    try {
      await api.delete(`/api/events/${encodeURIComponent(slug)}/participants/${participant.id}`, {
        password,
      });
      const auth = readParticipantAuth(slug);
      if (auth?.participantId === participant.id) {
        clearParticipantAuth(slug);
      }
      setDeleteTarget(null);
      setDeletePassword("");
      setEditor(null);
      showIsland({ tone: "neutral", title: `「${participant.name}」を削除しました` });
      await refresh();
    } catch (error) {
      notifyError(error, "削除に失敗しました。");
    }
  };

  const toggleVisibility = async (participant: ParticipantListItem, hidden: boolean) => {
    try {
      await api.patch(`/api/events/${encodeURIComponent(slug)}/participants/${participant.id}`, {
        hiddenInMatrix: hidden,
      });
      await refresh();
    } catch (error) {
      notifyError(error, "表示設定を変更できませんでした。");
    }
  };

  /** グループを足す。1 回の長さは登録と同時に決められるようにする（既定は 1 コマ）。 */
  const addGroup = async (name: string, slotSpan: number) => {
    try {
      const created = await api.post<{ group: { id: number } }>(
        `/api/events/${encodeURIComponent(slug)}/groups`,
        { name },
      );
      if (slotSpan !== 1) {
        await api.patch(`/api/events/${encodeURIComponent(slug)}/groups/${created.group.id}`, {
          slotSpan,
        });
      }
      setNewGroupSpan(1);
      await refresh();
    } catch (error) {
      notifyError(error, `${groupTerm}を追加できませんでした。`);
    }
  };

  const addGrade = async (name: string) => {
    try {
      await api.post(`/api/events/${encodeURIComponent(slug)}/grades`, { name });
      await refresh();
    } catch (error) {
      notifyError(error, `${roleTerm}を追加できませんでした。`);
    }
  };

  /** 他のイベントの一覧を取ってきて、引き継ぎ元を選ぶダイアログを開く。 */
  const openCategoryCopy = async () => {
    try {
      const { events } = await api.get<{ events: EventListItem[] }>("/api/events");
      setCopySources(events.filter((item) => item.slug !== slug));
    } catch (error) {
      notifyError(error, "イベントの一覧を取得できませんでした。");
    }
  };

  const copyCategories = async (sourceSlug: string, sourceTitle: string) => {
    try {
      const result = await api.post<{ grades: number; groups: number; skippedByLimit: number }>(
        `/api/events/${encodeURIComponent(slug)}/categories`,
        { sourceSlug },
      );
      setCopySources(null);
      await refresh();
      const copied = result.grades + result.groups;
      // 上限で入らなかったぶんは必ず言う。黙って落とすと「同じ名前だったのだろう」と
      // 読まれ、足りないことに気づけない。
      const limitNote =
        result.skippedByLimit > 0
          ? `。上限に達したため ${result.skippedByLimit} 件は引き継げませんでした`
          : "";
      showIsland({
        tone: result.skippedByLimit > 0 ? "danger" : copied > 0 ? "success" : "neutral",
        title:
          copied > 0 ? `「${sourceTitle}」から引き継ぎました` : "引き継ぐものがありませんでした",
        detail:
          copied > 0
            ? `${roleTerm} ${result.grades} 件 / ${groupTerm} ${result.groups} 件（同じ名前は飛ばしました）${limitNote}`
            : `同じ名前の${roleTerm}と${groupTerm}がすでに揃っています${limitNote}`,
      });
    } catch (error) {
      notifyError(error, "引き継げませんでした。");
    }
  };

  const renameGrade = async (gradeId: number, name: string) => {
    try {
      await api.patch(`/api/events/${encodeURIComponent(slug)}/grades/${gradeId}`, { name });
      await refresh();
    } catch (error) {
      notifyError(error, `${roleTerm}の名前を変更できませんでした。`);
    }
  };

  const renameGroup = async (groupId: number, name: string) => {
    try {
      await api.patch(`/api/events/${encodeURIComponent(slug)}/groups/${groupId}`, { name });
      await refresh();
    } catch (error) {
      notifyError(error, `${groupTerm}の名前を変更できませんでした。`);
    }
  };

  const changeSlotSpan = async (groupId: number, slotSpan: number) => {
    const had = view.event.groups.find((group) => group.id === groupId)?.fixed !== null;
    try {
      const result = await api.patch<{ fixed: unknown | null }>(
        `/api/events/${encodeURIComponent(slug)}/groups/${groupId}`,
        { slotSpan },
      );
      await refresh();
      // 伸ばしたコマ数が入らなくなると、サーバーは断らずに置き場所を外す。
      // 黙って消えると「決めたはずのものが無い」になるので必ず言う。
      if (had && result.fixed === null) {
        showIsland({
          tone: "danger",
          title: `${groupName(groupId)} の開催枠を外しました`,
          detail: "伸ばしたコマ数がそのコマから収まらないためです",
        });
      }
    } catch (error) {
      notifyError(error, "1 回の長さを変更できませんでした。");
    }
  };

  const changeRequiredGrade = async (groupId: number, gradeId: number | null) => {
    try {
      await api.patch(`/api/events/${encodeURIComponent(slug)}/groups/${groupId}`, {
        requiredGradeId: gradeId,
      });
      await refresh();
    } catch (error) {
      notifyError(error, `必ず参加する${roleTerm}を変更できませんでした。`);
    }
  };

  /**
   * そのグループが、いま選んでいるコマに **仮決めされているか**。押すたびに付け外しするための判定。
   *
   * `pinned` まで見ないと、仮決めを外して場所だけ残っている枠を選んだときに
   * 「取り消す」と表示され、押しても何も起きないボタンになる。
   */
  const isFixedAtSelection = (group: { fixed: FixedSlot | null; pinned: boolean } | undefined) =>
    Boolean(
      selection &&
        group?.pinned &&
        group.fixed &&
        group.fixed.columnKey === selection.columnKey &&
        group.fixed.startSlot === selection.startSlot,
    );

  /**
   * グループの置き場所を変える。
   *
   * 位置（`fixed`）と「動かさない」（`pinned`）は別。掴んで動かしただけでは仮決めにせず、
   * 仮決めを外しても位置は残す。外したとたんに元の場所へ飛ぶのを防ぐため。
   */
  const setGroupSchedule = async (
    groupId: number,
    input: { fixed?: { columnKey: string; startSlot: number } | null; pinned?: boolean },
    notice?: string,
  ) => {
    try {
      await api.patch(`/api/events/${encodeURIComponent(slug)}/groups/${groupId}`, input);
      await refresh();
      if (notice) {
        showIsland({ tone: input.pinned ? "success" : "neutral", title: notice });
      }
    } catch (error) {
      notifyError(error, "開催日時を変更できませんでした。");
    }
  };

  const groupName = (groupId: number) =>
    view.event.groups.find((item) => item.id === groupId)?.name ?? groupTerm;

  const deleteGrade = async (gradeId: number, gradeName: string) => {
    // 「必ず参加」の指し先が消えると制約ごと消える。消えたことが画面に残らないので、
    // 何件のグループに効いているかを消す前に見せる。
    const requiredIn = view.event.groups.filter((group) => group.requiredGradeId === gradeId);
    const ok = await confirm({
      title: `${roleTerm}を削除しますか？`,
      message: `「${gradeName}」を削除します。選んでいたメンバーは未選択に戻ります。${
        requiredIn.length > 0
          ? `「必ず参加」に指定している ${requiredIn.length} 件の${groupTerm}（${requiredIn
              .map((group) => group.name)
              .join("、")}）からも外れます。`
          : ""
      }`,
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/events/${encodeURIComponent(slug)}/grades/${gradeId}`);
      setSelfGradeId((current) => (current === gradeId ? null : current));
      // フィルタから外すと refresh の識別子が変わり、effect 側が取り直す。
      // ここで明示的に呼ぶと、消したばかりの ID を含む古い条件で 1 回余計に飛ぶ。
      setFilterGradeIds((current) =>
        current.includes(gradeId) ? current.filter((id) => id !== gradeId) : current,
      );
      if (!filterGradeIds.includes(gradeId)) {
        await refresh();
      }
    } catch (error) {
      notifyError(error, `${roleTerm}を削除できませんでした。`);
    }
  };

  const deleteGroup = async (groupId: number, groupName: string) => {
    const ok = await confirm({
      title: `${groupTerm}を削除しますか？`,
      message: `「${groupName}」を削除します。メンバーの所属からも外れます。`,
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/events/${encodeURIComponent(slug)}/groups/${groupId}`);
      setFilterGroupIds((current) =>
        current.includes(groupId) ? current.filter((id) => id !== groupId) : current,
      );
      if (!filterGroupIds.includes(groupId)) {
        await refresh();
      }
    } catch (error) {
      notifyError(error, `${groupTerm}を削除できませんでした。`);
    }
  };

  const saveInfo = async () => {
    if (!infoDraft) return;
    try {
      const saved = await api.patch<{ title: string; description: string }>(
        `/api/events/${encodeURIComponent(slug)}`,
        { title: infoDraft.title, description: infoDraft.description },
      );
      setView((current) => ({
        ...current,
        event: { ...current.event, title: saved.title, description: saved.description },
      }));
      setInfoDraft(null);
    } catch (error) {
      notifyError(error, "イベント情報を保存できませんでした。");
    }
  };

  const openInfoEditor = () => {
    setInfoDraft({ title: view.event.title, description: view.event.description });
  };

  /**
   * 追加コマだけを保存する。イベント名と説明は送らない。
   * 手元の値を送り直すと、その間に誰かが名前を直していたときに巻き戻してしまう。
   */
  const saveSlots = async () => {
    if (!slotDraft) return;
    try {
      const result = await api.patch<{ clearedGroups: string[] }>(
        `/api/events/${encodeURIComponent(slug)}`,
        { extraSlots: slotDraft },
      );
      setSlotDraft(null);
      // 選んでいたコマが消えているかもしれないので選択も外す。残すと、
      // 存在しないコマに向かって仮決めを投げてしまう。
      setSelection(null);
      // コマの増減は表の形そのものが変わるので、作り直した定義を取り直す。
      await refresh();
      // 消したコマに置かれていた枠は外れる。黙って消すと、決めたはずのものが
      // 気づかないうちに無くなる。
      if (result.clearedGroups.length > 0) {
        showIsland({
          tone: "danger",
          title: `${result.clearedGroups.length} 件の開催枠を外しました`,
          detail: `${result.clearedGroups.join("、")}：置いていたコマが無くなったためです`,
        });
      }
    } catch (error) {
      notifyError(error, "コマを保存できませんでした。");
    }
  };

  /** 表を画像にしてクリップボードへ。Slack に貼って共有する用。 */
  const copyMatrixImage = async () => {
    try {
      // 画像を作り終える前に書き込みを始める（押した操作の続きとして扱わせるため）。
      const blob = renderMatrixImage({
        event: view.event,
        summary: view.summary,
        requiredSpan,
        filterLabel: filterLabels.join(filterMode === "all" ? " かつ " : " または "),
      });
      const result = await copyImageToClipboard(blob, `${view.event.slug}-予定表.png`);
      showIsland({
        tone: "neutral",
        title: result === "copy" ? "予定表を画像でコピーしました" : "予定表を画像で保存しました",
        detail: result === "copy" ? "そのまま貼り付けられます" : undefined,
      });
    } catch (error) {
      notifyError(error, "画像を作れませんでした。");
    }
  };

  /**
   * もう一度解き直す。
   *
   * 掴んで動かした位置は「なるべくそこ」として解に効いているので、捨てないと
   * 押しても同じ答えが返るだけになる。仮決めは決めたことなので残す。
   */
  const resolvePlan = async () => {
    try {
      const result = await api.delete<{ cleared: number }>(
        `/api/events/${encodeURIComponent(slug)}/groups/schedule?keep=pinned`,
      );
      await refresh();
      showIsland({
        tone: "neutral",
        title: "解き直しました",
        detail:
          result.cleared > 0
            ? `仮決めを外してあった ${result.cleared} 件の位置は捨てました`
            : "仮決めした枠はそのままです",
      });
    } catch (error) {
      notifyError(error, "解き直せませんでした。");
    }
  };

  /** 仮決めをまとめて解除する。組み直しを最初からやり直すための逃げ道。 */
  const resetSchedules = async () => {
    const ok = await confirm({
      title: "人が決めた枠をすべて外しますか？",
      message:
        "仮決めした枠も、仮決めを外して場所だけ残っている枠もすべて外して、最初から解き直します。予定そのものは消えません。",
      confirmLabel: "すべて外す",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.delete<{ cleared: number }>(
        `/api/events/${encodeURIComponent(slug)}/groups/schedule`,
      );
      await refresh();
      showIsland({ tone: "neutral", title: `${result.cleared} 件の開催枠を外しました` });
    } catch (error) {
      notifyError(error, "仮決めを解除できませんでした。");
    }
  };

  /** 割り当て結果の時間割を画像にしてクリップボードへ。 */
  const copyPlanImage = async () => {
    const assignment = view.assignment;
    if (!assignment) return;
    try {
      const blob = renderPlanImage({
        title: `${view.event.title}｜${groupTerm}の日程`,
        columns: view.event.columns,
        slotDefinitions: view.event.slotDefinitions,
        scheduleMode: view.event.scheduleMode,
        placements: assignment.placements,
        // 画像は決定として配られる。矛盾を伏せると、そのまま実行できない案が回る。
        caption: [
          `全員が出られる${groupTerm} ${assignment.fullyAttendedCount} / ${assignment.totalCount}`,
          assignment.unplaced.length > 0 ? `置けなかった ${assignment.unplaced.length} 件` : "",
          assignment.fixedConflicts.length > 0
            ? `同じコマの重なり ${assignment.fixedConflicts.length} 件`
            : "",
          // 受け取った人は凡例を見られない。3 つの見分け方を 1 行で添える。
          "📌＝仮決め・実線＝場所だけ残っている枠・破線＝自動",
        ]
          .filter(Boolean)
          .join("・"),
      });
      const result = await copyImageToClipboard(blob, `${view.event.slug}-plan.png`);
      showIsland({
        tone: "neutral",
        title:
          result === "copy"
            ? `${groupTerm}の日程を画像でコピーしました`
            : `${groupTerm}の日程を画像で保存しました`,
      });
    } catch (error) {
      notifyError(error, "画像を作れませんでした。");
    }
  };

  /**
   * 選んだ時間帯の内訳。
   *
   * 「通して空いている人」は、範囲内のどれか 1 コマでも予定がある人を除いた数。
   * 連続した時間で予定を置きたいときに知りたいのはこれ。
   */
  const selectionDetail = useMemo(() => {
    if (!selection) {
      return null;
    }
    const { event: currentEvent, summary: currentSummary } = view;
    const column = currentEvent.columns.find((item) => item.key === selection.columnKey);
    const slots = currentEvent.slotDefinitions.filter(
      (slot) => slot.slot >= selection.startSlot && slot.slot <= selection.endSlot,
    );
    const first = slots[0];
    const last = slots.at(-1);
    if (!column || !first || !last) {
      return null;
    }

    // 名前ごとに「選んだ範囲のどのコマが埋まっているか」を集める。
    // セルは 1 度だけ引けるようにしておく（期間指定モードでは千件を超えるので、
    // コマごとに線形探索するとドラッグのたびに効いてくる）。
    const cellByKey = new Map(
      currentSummary.cells.map((cell) => [`${cell.columnKey}:${cell.slot}`, cell]),
    );
    const busySlotsByName = new Map<string, Set<number>>();
    for (const slot of slots) {
      const cell = cellByKey.get(`${selection.columnKey}:${slot.slot}`);
      for (const participant of cell?.busyParticipants ?? []) {
        const set = busySlotsByName.get(participant.name) ?? new Set<number>();
        set.add(slot.slot);
        busySlotsByName.set(participant.name, set);
      }
    }

    // 予定が入っている人を上に出す。ここで知りたいのは「誰のせいで開催できないか」で、
    // 空いている人の一覧を上から読んでも次の一手にはつながらない。
    const people = currentSummary.matchedNames
      .map((name) => {
        const busy = busySlotsByName.get(name) ?? new Set<number>();
        return {
          name,
          freeBySlot: slots.map((slot) => !busy.has(slot.slot)),
          freeCount: slots.length - busy.size,
        };
      })
      .sort((a, b) => a.freeCount - b.freeCount || a.name.localeCompare(b.name, "ja"));

    return {
      columnLabel: column.label,
      timeLabel:
        first === last
          ? slotHeading(first, currentEvent.scheduleMode)
          : `${slotHeading(first, currentEvent.scheduleMode)} 〜 ${slotHeading(last, currentEvent.scheduleMode)}`,
      slotLabels: slots.map((slot) => slotHeading(slot, currentEvent.scheduleMode)),
      slotCount: slots.length,
      people,
      allFreeCount: people.filter((person) => person.freeCount === slots.length).length,
    };
  }, [selection, view]);

  const { event, summary, participants } = view;
  const baseSlots = event.slotDefinitions.slice(
    0,
    event.slotDefinitions.length - event.extraSlots.length,
  );
  const hiddenCount = participants.filter((participant) => participant.hiddenInMatrix).length;
  const pendingCount = participants.filter((participant) => !hasResponded(participant)).length;
  // 人が置いた枠の数。仮決めだけでなく、仮決めを外して場所だけ残っている枠も含める
  // （どちらもこのボタンで外れるので、含めないと押す手段が消える）。
  const fixedCount = event.groups.filter((group) => group.fixed !== null).length;
  const filterLabels = [
    ...event.grades.filter((grade) => filterGradeIds.includes(grade.id)).map((grade) => grade.name),
    ...event.groups.filter((group) => filterGroupIds.includes(group.id)).map((group) => group.name),
  ];
  /**
   * 表で「続いているか」を判断するときの基準になるコマ数。
   *
   * グループで絞り込んでいるときは、そのグループが 1 回に必要とするコマ数。複数選んでいるなら
   * いちばん長いものに合わせる（短いほうはそれで自動的に満たされる）。絞っていないときは 1 で、
   * 続き具合は問わない（誰のための表なのかが決まらないため）。
   */
  const requiredSpan =
    filterGroupIds.length === 0
      ? 1
      : Math.max(
          1,
          ...event.groups
            .filter((group) => filterGroupIds.includes(group.id))
            .map((group) => group.slotSpan),
        );

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-ink-muted text-xs hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          イベント一覧へ
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-semibold text-ink text-xl">{event.title}</h1>
              <Button
                size="sm"
                variant="ghost"
                aria-label="イベント名と説明を編集"
                onClick={() => openInfoEditor()}
              >
                <Pencil className="size-3.5" aria-hidden />
              </Button>
            </div>
            {/* 説明そのものも押せるようにする。説明が空のときは
                「まだありません」が入り口を兼ねる。 */}
            <button
              type="button"
              onClick={() => openInfoEditor()}
              className="mt-0.5 block max-w-full text-left text-ink-muted text-sm hover:text-ink"
            >
              {event.description || "説明はまだありません。（押して追記できます）"}
            </button>
            <div className="mt-2 flex flex-wrap gap-1.5 text-ink-subtle text-xs">
              <span className="rounded-full bg-surface px-2.5 py-1">
                {event.scheduleMode === "weekly"
                  ? `毎週固定 / ${describeWeeklyLayout(event.columns, baseSlots)}`
                  : `${formatDisplayDate(event.startDate)} - ${formatDisplayDate(event.endDate)} / 1時間刻み`}
              </span>
              <span className="rounded-full bg-surface px-2.5 py-1 tabular-nums">
                {summary.participantCount} 人登録
              </span>
            </div>
          </div>
          <ShareLink />
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        {/* 左カラムは「表とその周辺」でひとまとまり。ここを分けると、
            追加したカードが右のサイドバーへ流れ込んでしまう。 */}
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader
              title="全体の予定表"
              description="緑は表示中のメンバー全員が空いているコマ。赤はそこに予定がある人がいるコマで、数字はその人数です。"
              action={
                <span className="flex shrink-0 items-baseline gap-1 whitespace-nowrap rounded-full border border-line bg-surface-muted px-3 py-1">
                  <span className="font-semibold text-accent text-sm tabular-nums">
                    {summary.matchedCount}
                  </span>
                  <span className="text-ink-muted text-xs">
                    / {summary.participantCount} 人を表示
                  </span>
                </span>
              }
            />

            <div className="space-y-3 border-line border-b px-4 py-3">
              {/* 絞り込み。区分は 1 人 1 つなので複数選んだら「いずれか」で効く。 */}
              {event.grades.length > 0 && (
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="w-10 shrink-0 font-medium text-ink-subtle text-xs">
                    {roleTerm}
                  </span>
                  <div className="min-w-0 flex-1">
                    <CategoryChips
                      items={event.grades}
                      selectedIds={filterGradeIds}
                      mode="multi"
                      showCount
                      onToggle={(id, selected) =>
                        setFilterGradeIds((current) =>
                          selected ? [...current, id] : current.filter((value) => value !== id),
                        )
                      }
                    />
                  </div>
                </div>
              )}
              {event.groups.length > 0 && (
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="w-10 shrink-0 font-medium text-ink-subtle text-xs">
                    {groupTerm}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <CategoryChips
                      items={event.groups}
                      selectedIds={filterGroupIds}
                      mode="multi"
                      showCount
                      onToggle={(id, selected) =>
                        setFilterGroupIds((current) =>
                          selected ? [...current, id] : current.filter((value) => value !== id),
                        )
                      }
                      action={{
                        icon: Pin,
                        disabled: selection === null,
                        // 押下状態は「いま選んでいるコマに仮決めされているか」。
                        // 「どこかに仮決め済みか」で塗ると、別のコマを選んでいるときに
                        // 解除ボタンのように見えて、押すと付け替わる。
                        isActive: (item) =>
                          isFixedAtSelection(event.groups.find((value) => value.id === item.id)),
                        title: (item) => {
                          const group = event.groups.find((value) => value.id === item.id);
                          if (!selection) {
                            return "表のコマを選んでから押すと、そこに開催日時を仮決めできます";
                          }
                          return isFixedAtSelection(group)
                            ? `${item.name} の仮決めを取り消す`
                            : `選んだコマに ${item.name} の開催日時を仮決めする（${group?.slotSpan ?? 1} コマ）`;
                        },
                        onClick: (item) => {
                          const group = event.groups.find((value) => value.id === item.id);
                          if (!selection) return;
                          if (isFixedAtSelection(group)) {
                            void setGroupSchedule(
                              item.id,
                              { pinned: false },
                              `${item.name} の仮決めを外しました（場所はそのまま）`,
                            );
                            return;
                          }
                          void setGroupSchedule(
                            item.id,
                            {
                              fixed: {
                                columnKey: selection.columnKey,
                                startSlot: selection.startSlot,
                              },
                              pinned: true,
                            },
                            `${item.name} をこの枠に仮決めしました`,
                          );
                        },
                      }}
                    />
                    {/* アイコンだけでは何のボタンか伝わらないので、意味をその場に置く。
                      文中にも同じアイコンを挟んで、どのボタンの話かを取り違えないようにする。 */}
                    <p className="flex flex-wrap items-center gap-1 text-ink-subtle text-[11px]">
                      表でコマを選んでから
                      <Pin className="size-3 shrink-0" aria-hidden />
                      を押すと、その{groupTerm}の開催日時を仮決めできます（何度でも変えられます）
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="text-ink-subtle">表に出すのは</span>
                <div className="flex items-center gap-1 rounded-full border border-line bg-surface-muted p-0.5">
                  {/* 違いは 1 語だけにする（どれか / 全部）。長い説明を並べるより、
                    下の「いまの表：…」で実際の条件を読ませたほうが早い。 */}
                  {(
                    [
                      { value: "any", label: "どれかに入っている人" },
                      { value: "all", label: "全部に入っている人" },
                    ] as const
                  ).map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        "cursor-pointer rounded-full px-2.5 py-1 transition-colors",
                        filterMode === option.value ? "bg-surface text-ink" : "text-ink-muted",
                      )}
                    >
                      <input
                        type="radio"
                        name="filterMode"
                        className="sr-only"
                        checked={filterMode === option.value}
                        onChange={() => setFilterMode(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-ink-muted">
                  <input
                    type="checkbox"
                    checked={showNames}
                    onChange={(changeEvent) => setShowNames(changeEvent.target.checked)}
                  />
                  予定がある人の名前を表に出す
                </label>
              </div>

              {/* 切り替えの効き目を言葉で 1 行にする。チップの選択状態だけでは
                「どれか / 全部」がどう効いているのかが読み取れない。 */}
              {filterLabels.length > 0 && (
                <p className="text-ink-muted text-xs">
                  この表は
                  <span className="font-medium text-ink">
                    {filterMode === "all" && filterLabels.length > 1
                      ? `${filterLabels.join(" と ")} のすべてに入っている人`
                      : `${filterLabels.join(" と ")} の人`}
                  </span>
                  <span className="text-ink-subtle">
                    {` ${summary.matchedCount} 人ぶんの空き状況です`}
                  </span>
                </p>
              )}
            </div>

            <div className="space-y-3 p-4">
              <MatrixTable
                event={event}
                summary={summary}
                showNames={showNames}
                requiredSpan={requiredSpan}
                selection={selection}
                placeableStarts={view.assignment?.placeableStarts ?? []}
                onMoveGroup={(groupId, target) =>
                  // この表に出るのは仮決めした枠だけ。動かした拍子に仮決めが外れると
                  // 表から消えてしまい、掴み直すことも戻すこともできなくなる。
                  void setGroupSchedule(
                    groupId,
                    {
                      fixed: { columnKey: target.columnKey, startSlot: target.slot },
                      pinned: true,
                    },
                    `${groupName(groupId)} をここへ動かして仮決めしました`,
                  )
                }
                action={
                  <span className="flex items-center gap-2">
                    {/* 人が置いた枠が 1 つも無いときは出さない（押しても何も起きないボタンを置かない）。 */}
                    {fixedCount > 0 && (
                      <Button size="sm" onClick={() => void resetSchedules()}>
                        <RotateCcw className="size-3.5" aria-hidden />
                        人が置いた枠をすべて外す
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void copyMatrixImage()}>
                      <ImageDown className="size-3.5" aria-hidden />
                      画像でコピー
                    </Button>
                  </span>
                }
                onSelect={setSelection}
              />

              {/* 押したコマの内訳は表の下に出す。表の上に置くと、選ぶたびに
                表そのものが下へずれて狙いが動く。 */}
              {selectionDetail && (
                <div className="space-y-2.5 rounded-[var(--radius-control)] border border-line bg-surface-muted px-3 py-2.5 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium text-ink">{selectionDetail.columnLabel}</span>
                    <span className="font-medium text-ink">{selectionDetail.timeLabel}</span>
                    {selectionDetail.slotCount > 1 && (
                      <span className="text-ink-subtle tabular-nums">
                        {selectionDetail.slotCount} コマ連続
                      </span>
                    )}
                    <span className="text-ink-muted">
                      {selectionDetail.slotCount > 1 ? "通して空いている人" : "空いている人"}
                    </span>
                    {/* 0 人は「候補にならない」という否定的な情報なので、緑ではなく赤で出す。 */}
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        selectionDetail.allFreeCount === 0 ? "text-busy" : "text-free",
                      )}
                    >
                      {selectionDetail.allFreeCount} 人
                    </span>
                    <span className="text-ink-subtle">/ {summary.matchedCount} 人</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 px-2"
                      onClick={() => setSelection(null)}
                    >
                      選択を解除
                    </Button>
                  </div>

                  {/* 誰がどのコマで空いているかは、文章より升目のほうが速く読める。
                    色は全体表と同じ意味（緑＝空き / 赤＝予定あり）に揃えてある。 */}
                  <div className="max-h-56 overflow-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="w-full pb-1 text-left font-medium text-ink-subtle">
                            メンバー
                          </th>
                          {selectionDetail.slotLabels.map((label) => (
                            <th
                              key={label}
                              className="whitespace-nowrap px-1 pb-1 text-center font-medium text-ink-subtle"
                            >
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selectionDetail.people.map((person) => (
                          <tr key={person.name}>
                            <td
                              className={cn(
                                "truncate py-0.5 pr-2",
                                // 予定が入っている人を強く出す。開催の可否を決めるのはこの人たち。
                                person.freeCount === selectionDetail.slotCount
                                  ? "text-ink-muted"
                                  : "font-medium text-ink",
                              )}
                            >
                              {person.name}
                            </td>
                            {person.freeBySlot.map((free, index) => (
                              <td
                                // 並び順がコマの並びそのもの
                                // biome-ignore lint/suspicious/noArrayIndexKey: 位置が識別子を兼ねる
                                key={index}
                                className="px-1 py-0.5 text-center"
                              >
                                <span
                                  title={free ? "空き" : "予定あり"}
                                  className={cn(
                                    "inline-flex h-4 w-7 items-center justify-center rounded-[3px] text-[10px]",
                                    free ? "bg-free-soft text-free" : "bg-busy-soft text-busy",
                                  )}
                                >
                                  {free ? "空" : "予"}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* 決まった開催日時をその場で書き込めるようにする。最適化結果からも決められるが、
                    表を見ながら「ここにする」と決める流れのほうが自然なことが多い。 */}
                  {event.groups.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-line border-t pt-2">
                      <span className="text-ink-subtle">このコマに入れる</span>
                      {event.groups.map((group) => {
                        // 仮決めしているときだけ「押下中」。手で動かしただけの枠を
                        // 押下中に見せると、押しても何も起きないボタンになる。
                        const here =
                          group.pinned &&
                          group.fixed?.columnKey === selection?.columnKey &&
                          group.fixed?.startSlot === selection?.startSlot;
                        return (
                          <button
                            key={group.id}
                            type="button"
                            title={
                              here
                                ? `${group.name} の決定を取り消す`
                                : `${group.name} をここで開催すると決める（${group.slotSpan} コマ）`
                            }
                            onClick={() => {
                              if (here || !selection) {
                                void setGroupSchedule(
                                  group.id,
                                  { pinned: false },
                                  `${group.name} の仮決めを外しました（場所はそのまま）`,
                                );
                                return;
                              }
                              void setGroupSchedule(
                                group.id,
                                {
                                  fixed: {
                                    columnKey: selection.columnKey,
                                    startSlot: selection.startSlot,
                                  },
                                  pinned: true,
                                },
                                `${group.name} をこの枠に仮決めしました`,
                              );
                            }}
                            className={cn(
                              "cursor-pointer rounded-full border px-2.5 py-1 transition-colors",
                              here
                                ? "border-transparent font-medium text-white"
                                : "border-line text-ink-muted hover:border-ink-subtle",
                            )}
                            style={here ? { backgroundColor: group.color } : undefined}
                          >
                            {group.name}
                            <span className="ml-1 tabular-nums opacity-70">
                              {group.slotSpan} コマ
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 追加コマの入り口は表のすぐ下。設定画面の奥にあると、
                そもそもこの機能があることに気づけない。 */}
              {event.scheduleMode === "weekly" && (
                <div className="flex flex-wrap items-center gap-2 border-line border-t pt-3 text-xs">
                  <span className="text-ink-subtle">コマの範囲</span>
                  <span className="rounded-full bg-surface-muted px-2.5 py-1 text-ink">
                    {baseSlots[0]?.label}〜{baseSlots.at(-1)?.label}
                    {event.extraSlots.map((slot, index) => (
                      <span
                        // 並び順そのものがコマ番号。名前は重複しうるので位置を key にする
                        // biome-ignore lint/suspicious/noArrayIndexKey: 位置が識別子を兼ねる
                        key={index}
                        className="ml-1 text-accent-ink"
                      >
                        ＋{slot.label}
                      </span>
                    ))}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setSlotDraft(event.extraSlots)}>
                    <Clock className="size-3.5" aria-hidden />
                    {event.extraSlots.length > 0 ? "コマを編集" : "コマを追加"}
                  </Button>
                </div>
              )}
            </div>

            <EventNotes slug={slug} notes={event.notes} />
          </Card>

          {event.groups.length > 0 && (
            <SeminarPlan
              groups={event.groups}
              grades={event.grades}
              assignment={view.assignment}
              searching={recomputing}
              columns={event.columns}
              slotDefinitions={event.slotDefinitions}
              scheduleMode={event.scheduleMode}
              onChangeRequiredGrade={(groupId, gradeId) =>
                void changeRequiredGrade(groupId, gradeId)
              }
              onConfirm={(groupId, columnKey, startSlot) =>
                void setGroupSchedule(
                  groupId,
                  { fixed: { columnKey, startSlot }, pinned: true },
                  `${groupName(groupId)} をこの枠に仮決めしました`,
                )
              }
              onRelease={(groupId) =>
                void setGroupSchedule(
                  groupId,
                  { pinned: false },
                  `${groupName(groupId)} の仮決めを外しました（場所はそのまま）`,
                )
              }
              onCopyImage={() => void copyPlanImage()}
              onResolve={() => void resolvePlan()}
              onMove={(groupId, target) =>
                void setGroupSchedule(
                  groupId,
                  { fixed: { columnKey: target.columnKey, startSlot: target.slot }, pinned: true },
                  `${groupName(groupId)} をここへ動かして仮決めしました`,
                )
              }
            />
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="自分の予定を入力" />
            <form
              className="space-y-3 p-4"
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                void openMySchedule();
              }}
            >
              {/* 期ごとに同じ顔ぶれで作り直すので、カテゴリの打ち直しを省けるようにする。 */}
              <button
                type="button"
                onClick={() => void openCategoryCopy()}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] border border-line border-dashed px-3 py-2 text-ink-muted text-xs transition-colors hover:border-accent/50 hover:text-accent-ink"
              >
                <CopyPlus className="size-3.5 shrink-0" aria-hidden />
                他のイベントから{roleTerm}と{groupTerm}を引き継ぐ
              </button>

              <Field label="名前">
                <input
                  className={inputClass}
                  maxLength={40}
                  placeholder="例: 山田"
                  value={name}
                  onChange={(changeEvent) => setName(changeEvent.target.value)}
                />
              </Field>

              <fieldset>
                <legend className="mb-1.5 font-medium text-ink text-xs">{roleTerm}</legend>
                <CategoryChips
                  items={event.grades}
                  selectedIds={selfGradeId === null ? [] : [selfGradeId]}
                  mode="single"
                  onToggle={(id, selected) =>
                    setSelfGradeId((current) => nextSingleSelection(current, id, selected))
                  }
                  onDelete={(item) => void deleteGrade(item.id, item.name)}
                  onRename={(item, value) => void renameGrade(item.id, value)}
                  onAdd={(value) => void addGrade(value)}
                  addPlaceholder={`${roleTerm}を追加`}
                />
              </fieldset>

              <fieldset>
                <legend className="mb-1.5 font-medium text-ink text-xs">参加する{groupTerm}</legend>
                <CategoryChips
                  items={event.groups.map((group) => ({
                    ...group,
                    badge: `${group.slotSpan} コマ`,
                  }))}
                  selectedIds={selfGroupIds}
                  mode="multi"
                  onToggle={(id, selected) =>
                    setSelfGroupIds((current) =>
                      selected ? [...current, id] : current.filter((value) => value !== id),
                    )
                  }
                  onDelete={(item) => void deleteGroup(item.id, item.name)}
                  onRename={(item, value) => void renameGroup(item.id, value)}
                  onAdd={(value) => void addGroup(value, newGroupSpan)}
                  addPlaceholder={`${groupTerm}を追加`}
                  addExtra={
                    <SlotSpanPicker
                      label={`新しい${groupTerm}`}
                      value={newGroupSpan}
                      onChange={setNewGroupSpan}
                    />
                  }
                  emptyText={`まだ${groupTerm}が登録されていません。`}
                />
                {/* 1 回の長さはグループの持ちものなので、誰が変えても全員に効く。
                  選んだグループの分だけ出す（全部並べると自分に関係ない設定で埋まる）。 */}
                {selfGroupIds.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {event.groups
                      .filter((group) => selfGroupIds.includes(group.id))
                      .map((group) => (
                        <li key={group.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 truncate text-ink-muted text-xs">
                            {group.name}
                          </span>
                          <span className="ml-auto">
                            <SlotSpanPicker
                              label={group.name}
                              value={group.slotSpan}
                              onChange={(slotSpan) => void changeSlotSpan(group.id, slotSpan)}
                            />
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </fieldset>

              <Field label="パスワード（任意）" hint="未入力なら誰でも編集できます。">
                <input
                  type="password"
                  className={inputClass}
                  value={password}
                  onChange={(changeEvent) => setPassword(changeEvent.target.value)}
                />
              </Field>

              <Button type="submit" variant="primary" className="w-full" disabled={!name.trim()}>
                自分の予定表を開く
              </Button>
              <Message text={message.text} tone={message.tone} />
            </form>
          </Card>

          <Card>
            <CardHeader
              title="登録メンバー"
              description="押すとその人の予定表を開けます。"
              action={
                <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
                  <span className="text-ink-muted tabular-nums">
                    {hiddenCount > 0
                      ? `${participants.length} 人（${hiddenCount} 人を非表示）`
                      : `${participants.length} 人`}
                  </span>
                  {pendingCount > 0 && (
                    <span className="rounded-full bg-busy-soft px-2 py-0.5 text-busy tabular-nums">
                      未入力 {pendingCount} 人
                    </span>
                  )}
                </span>
              }
            />
            <div className="p-4">
              <MemberList
                participants={participants}
                sort={memberSort}
                onChangeSort={setMemberSort}
                onOpen={(participant) => {
                  if (participant.hasPassword) {
                    setAccessTarget(participant);
                    setAccessPassword("");
                    return;
                  }
                  void openMember(participant);
                }}
                onToggleVisibility={(participant, hidden) =>
                  void toggleVisibility(participant, hidden)
                }
                onDelete={(participant) => void deleteParticipant(participant)}
              />
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={editor !== null}
        wide
        title={editor ? `${editor.participant.name} の予定表` : ""}
        onClose={() => void closeEditor()}
        footer={
          <>
            {editor?.conflict && (
              <span className="copy-block mr-auto max-w-md text-danger text-xs leading-relaxed">
                {editor.conflict}
              </span>
            )}
            <Button onClick={() => void closeEditor()}>閉じる</Button>
            <Button variant="primary" disabled={saving} onClick={() => void saveEditor()}>
              {saving ? "保存中..." : editor?.conflict ? "上書きして保存" : "保存する"}
            </Button>
          </>
        }
      >
        {editor && (
          <ScheduleEditor
            event={event}
            draft={editor.draft}
            onChange={(draft) => setEditor({ ...editor, draft, dirty: true, conflict: undefined })}
          />
        )}
      </Modal>

      <Modal
        open={slotDraft !== null}
        title="コマの設定"
        onClose={() => setSlotDraft(null)}
        footer={
          <>
            <Button onClick={() => setSlotDraft(null)}>キャンセル</Button>
            <Button variant="primary" onClick={() => void saveSlots()}>
              保存
            </Button>
          </>
        }
      >
        {slotDraft && (
          <ExtraSlotEditor slots={slotDraft} baseSlots={baseSlots} onChange={setSlotDraft} />
        )}
      </Modal>

      <Modal
        open={accessTarget !== null}
        title={accessTarget ? `${accessTarget.name} の予定表を開く` : ""}
        onClose={() => setAccessTarget(null)}
        footer={
          <>
            <Button onClick={() => setAccessTarget(null)}>キャンセル</Button>
            <Button
              variant="primary"
              onClick={() => accessTarget && void openMember(accessTarget, accessPassword)}
            >
              開く
            </Button>
          </>
        }
      >
        <form
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            if (accessTarget) void openMember(accessTarget, accessPassword);
          }}
        >
          <Field label="パスワード">
            <input
              type="password"
              className={inputClass}
              value={accessPassword}
              onChange={(changeEvent) => setAccessPassword(changeEvent.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title={deleteTarget ? `${deleteTarget.name} を削除` : ""}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>キャンセル</Button>
            <Button
              variant="danger"
              onClick={() =>
                deleteTarget && void runDeleteParticipant(deleteTarget, deletePassword)
              }
            >
              削除する
            </Button>
          </>
        }
      >
        <form
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            if (deleteTarget) void runDeleteParticipant(deleteTarget, deletePassword);
          }}
        >
          <Field label="パスワード" hint="本人が設定したパスワードです。">
            <input
              type="password"
              className={inputClass}
              value={deletePassword}
              onChange={(changeEvent) => setDeletePassword(changeEvent.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={infoDraft !== null}
        title="イベント情報を編集"
        onClose={() => setInfoDraft(null)}
        footer={
          <>
            <Button onClick={() => setInfoDraft(null)}>キャンセル</Button>
            <Button variant="primary" onClick={() => void saveInfo()}>
              保存
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void saveInfo();
          }}
        >
          <Field label="イベント名">
            <input
              className={inputClass}
              maxLength={80}
              value={infoDraft?.title ?? ""}
              onChange={(changeEvent) =>
                setInfoDraft((current) =>
                  current ? { ...current, title: changeEvent.target.value } : current,
                )
              }
            />
          </Field>
          <Field label="説明" hint="空欄にすると説明なしになります。">
            <textarea
              rows={4}
              maxLength={500}
              className={inputClass}
              placeholder="例: 新しい期の開催枠を決めます。全員入力してください。"
              value={infoDraft?.description ?? ""}
              onChange={(changeEvent) =>
                setInfoDraft((current) =>
                  current ? { ...current, description: changeEvent.target.value } : current,
                )
              }
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={copySources !== null}
        title={`${roleTerm}と${groupTerm}を引き継ぐ`}
        onClose={() => setCopySources(null)}
        footer={<Button onClick={() => setCopySources(null)}>閉じる</Button>}
      >
        <div className="space-y-3">
          <p className="text-ink-muted text-sm leading-relaxed">
            {`選んだイベントの${roleTerm}と${groupTerm}（1 回の長さと「必ず参加」も含む）をこのイベントへ写します。参加者や予定は持ってきません。同じ名前のものは飛ばします。`}
          </p>
          {copySources?.length === 0 ? (
            <EmptyState>引き継げる他のイベントがありません。</EmptyState>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {copySources?.map((item) => (
                <li key={item.slug}>
                  <button
                    type="button"
                    onClick={() => void copyCategories(item.slug, item.title)}
                    className="w-full cursor-pointer rounded-[var(--radius-control)] border border-line px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
                  >
                    <span className="block truncate font-medium text-ink text-sm">
                      {item.title}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {item.groups.map((group) => (
                        <span
                          key={group.id}
                          className="rounded-full px-2 py-0.5"
                          style={{ backgroundColor: `${group.color}1f`, color: group.color }}
                        >
                          {group.name}
                        </span>
                      ))}
                      <span className="text-ink-subtle tabular-nums">
                        {item.createdAt.slice(0, 10)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      {/* 確認ダイアログは最後に置く。Modal はどれも同じ z-index の固定レイヤーなので、
        先に置くと後ろの Modal に隠れて見えなくなる（予定表を閉じられなくなる）。 */}
      {confirmDialog}
    </div>
  );
}
