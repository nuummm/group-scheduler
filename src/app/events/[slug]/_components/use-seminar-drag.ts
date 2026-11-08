import { useCallback, useEffect, useRef, useState } from "react";

/**
 * グループの枠を掴んで別のコマへ動かす操作。
 *
 * 押しただけでは動かない。**マウスの長押しで掴む**（`HOLD_MS`）。タッチでは掴まない
 * （表のスクロールに使うため）。表のマスは押すと別の意味を持つので、
 * 触れただけで動き出すと誤操作になる。掴んだあとは置ける場所だけを光らせ、そこへ落としたときだけ
 * 移動する。置けない場所で離したときは何もしない。
 *
 * 2 コマ以上のグループは「開始コマ」だけでなく **占める範囲すべて** を扱う。開始コマだけを
 * 光らせると、2 コマぶん必要なのに 1 マスしか置けないように見える。
 *
 * 座標からマスを引くのは `elementFromPoint`。マスごとの pointerenter は速く動かすと取りこぼす。
 */

/** 掴んだと見なすまでの長押し時間。 */
const HOLD_MS = 220;

/**
 * いま誰かの枠を掴んでいるか。
 *
 * 掴んでいる最中に巡回が新しい盤面を入れると、置ける場所の対応表だけが古いまま残り、
 * 「光っているのに落とせない」ことが起きる。巡回側がこれを見て一拍置く。
 * ポインタは 1 本なので、表と時間割をまたいでも掴めるのは同時に 1 つ。
 */
let grabbing = false;

export function isGrabbingSeminar(): boolean {
  return grabbing;
}

/** この距離を超えて動いたら「掴む前に指が滑った」と見なして取り消す。 */
const CANCEL_DISTANCE = 12;

/**
 * 掴んで離した直後の click を捨てる有効時間。
 *
 * 別のマスへ落とすと、click は押した所と離した所の共通の親（tr や table）へ飛び、
 * どのマスの onClick も呼ばれない。印を真偽値で持つと下ろす機会が無いまま残り、
 * その次のキーボード操作やタップを 1 回飲んでしまう。時刻で持てば自然に切れる。
 */
const DROP_GUARD_MS = 500;

export interface DragTarget {
  columnKey: string;
  slot: number;
}

/** 掴むときに渡す情報。`cover` は「そのマス → 置いたときの開始コマ」の対応。 */
export interface DragSource {
  groupId: number;
  label: string;
  color: string;
  cover: Map<string, string>;
}

/**
 * どちらの表のマスを落とし先にするか。
 *
 * 全体表と時間割は同じ `data-drop-*` を持つので、指定しないと相手の表の上でも
 * 落とせてしまう。落ちる側のマスは光らないので、光っていない所へ落ちることになる。
 */
export type DragScope = "matrix" | "plan";

export interface SeminarDragState {
  /** 掴んでいるグループ。null なら掴んでいない。 */
  source: DragSource | null;
  /** 指が乗っている先の開始コマ（`${列キー}:${開始コマ}`）。置ける場所のときだけ入る。 */
  hoveredStart: string | null;
  /** 掴んでいる札を出す位置。 */
  pointer: { x: number; y: number } | null;
}

const EMPTY: SeminarDragState = { source: null, hoveredStart: null, pointer: null };

export function useSeminarDrag(
  scope: DragScope,
  onMove: (groupId: number, target: DragTarget) => void,
) {
  const [state, setState] = useState<SeminarDragState>(EMPTY);
  /**
   * 呼び出し側は毎回その場で関数を作るので、そのまま effect の依存に入れると
   * 描画のたびに購読を張り直すことになる。張り直しの後片付けが長押しのタイマーを
   * 消してしまい、**掴めなくなる**（巡回で数秒ごとに再描画されるので確実に踏む）。
   * 最新の実装は ref で持ち、購読は 1 度だけにする。
   */
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const holdTimerRef = useRef(0);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  // 掴んでいる最中の値を、描画を待たずに読むための控え。
  const activeRef = useRef<SeminarDragState>(EMPTY);
  // 掴んで離した直後の click を押下として扱わないための印（立てた時刻）。
  const droppedAtRef = useRef(0);
  // 掴んだあと実際に動かしたか。長押ししただけで離したときは、
  // 普通の押下として扱う（押しっぱなしが無反応になるのを避ける）。
  const movedRef = useRef(false);

  const reset = useCallback(() => {
    grabbing = false;
    window.clearTimeout(holdTimerRef.current);
    originRef.current = null;
    movedRef.current = false;
    activeRef.current = EMPTY;
    setState(EMPTY);
  }, []);

  /** グループの枠の上で押されたとき。長押しになったら掴む。 */
  const startHold = useCallback((event: React.PointerEvent, source: DragSource) => {
    // タッチはページのスクロールに使うので掴まない（誤操作のほうが困る）。
    // 前の掴みの印もここで倒す。残すと、次の普通のクリックが 1 回無視される。
    droppedAtRef.current = 0;
    movedRef.current = false;
    if (event.pointerType === "touch" || event.button !== 0 || source.cover.size === 0) {
      return;
    }
    const { clientX, clientY } = event;
    originRef.current = { x: clientX, y: clientY };
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      const next: SeminarDragState = {
        source,
        hoveredStart: null,
        pointer: { x: clientX, y: clientY },
      };
      grabbing = true;
      activeRef.current = next;
      setState(next);
    }, HOLD_MS);
  }, []);

  /** 掴む前に指が滑ったら取り消す。掴んだあとは、乗っているマスと札の位置を追う。 */
  const track = useCallback((clientX: number, clientY: number) => {
    const active = activeRef.current;
    if (!active.source) {
      const origin = originRef.current;
      if (!origin) return;
      if (Math.hypot(clientX - origin.x, clientY - origin.y) > CANCEL_DISTANCE) {
        window.clearTimeout(holdTimerRef.current);
        originRef.current = null;
      }
      return;
    }
    const cell = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>(`[data-drop-scope="${scopeRef.current}"]`);
    const key =
      cell?.dataset.dropColumn && cell.dataset.dropSlot
        ? `${cell.dataset.dropColumn}:${cell.dataset.dropSlot}`
        : null;
    movedRef.current = true;
    const hoveredStart = (key && active.source.cover.get(key)) ?? null;
    const next: SeminarDragState = { ...active, hoveredStart, pointer: { x: clientX, y: clientY } };
    activeRef.current = next;
    setState(next);
  }, []);

  // 追跡も終了も window で拾う。表の中だけで拾うと、外へ出た瞬間に座標が止まり、
  // そこで離すと「最後に乗っていたマス」へ落ちてしまう（外して中断したつもりが移動になる）。
  useEffect(() => {
    const move = (event: PointerEvent) => track(event.clientX, event.clientY);
    const finish = () => {
      const { source, hoveredStart } = activeRef.current;
      if (source && movedRef.current) {
        // 動かした以上、置けても置けなくても続く click は押下として扱わない。
        // 動かしていない（長押しして離しただけ）なら、普通の押下として通す。
        droppedAtRef.current = Date.now();
        if (hoveredStart) {
          const [columnKey, slot] = hoveredStart.split(":");
          onMoveRef.current(source.groupId, { columnKey: columnKey ?? "", slot: Number(slot) });
        }
      }
      reset();
    };
    // 中断したのに続く click が押下として通ると「やめたのに仮決めされる」ことになる。
    // Escape でも、ブラウザ側の判定でポインタが取り消されたときでも同じ扱いにする。
    const abort = () => {
      if (activeRef.current.source && movedRef.current) {
        droppedAtRef.current = Date.now();
      }
      reset();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") abort();
    };
    // 掴んだまま右クリック / 別アプリへ切り替え / タブを離れる、では pointerup が届かない。
    // 掴んだ状態が残ると、次にどこかを押した瞬間にそこへ落ちてしまう。
    const leave = () => {
      if (activeRef.current.source || originRef.current) abort();
    };
    const hide = () => {
      if (document.hidden) leave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", leave);
    window.addEventListener("contextmenu", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", leave);
      window.removeEventListener("contextmenu", leave);
      document.removeEventListener("visibilitychange", hide);
      window.clearTimeout(holdTimerRef.current);
      // 掴んだまま画面が消えたときに立てっぱなしにすると、巡回が二度と回らなくなる。
      grabbing = false;
    };
    // track / reset はどちらも依存の無い useCallback なので、購読は 1 度だけ張られる。
  }, [reset, track]);

  /** 直前が掴んで動かす操作だったか。読むと下ろす（続く click 1 回ぶんだけ効く）。 */
  const consumeDrop = useCallback(() => {
    const at = droppedAtRef.current;
    droppedAtRef.current = 0;
    return at !== 0 && Date.now() - at < DROP_GUARD_MS;
  }, []);

  /** そのマスが「置ける場所」か、さらに「いま落とす先」か。 */
  const dropStateOf = useCallback(
    (key: string): "none" | "placeable" | "target" => {
      const source = state.source;
      if (!source) return "none";
      const start = source.cover.get(key);
      if (!start) return "none";
      return start === state.hoveredStart ? "target" : "placeable";
    },
    [state],
  );

  return {
    state,
    dragging: state.source !== null,
    startHold,
    consumeDrop,
    dropStateOf,
  };
}

/**
 * 「開始コマの一覧」を「占めるマス → 開始コマ」に広げる。
 *
 * 2 コマのグループを火 3 限に置くなら、火 3 限と火 4 限の両方が落とせるマスで、
 * どちらに落としても開始は火 3 限。
 */
export function buildCoverMap(
  starts: string[],
  slotNumbers: number[],
  slotSpan: number,
): Map<string, string> {
  const cover = new Map<string, string>();
  const span = Math.max(1, slotSpan);
  for (const start of starts) {
    const [columnKey, rawSlot] = start.split(":");
    const startSlot = Number(rawSlot);
    const index = slotNumbers.indexOf(startSlot);
    if (!columnKey || index < 0) continue;
    for (const slot of slotNumbers.slice(index, index + span)) {
      cover.set(`${columnKey}:${slot}`, start);
    }
  }
  return cover;
}
