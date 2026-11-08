import { create } from "zustand";

/**
 * アプリ島 — 画面上端中央に 1 枚だけ出る一過性の通知。
 *
 * 積まない。島はキューではなく「直前の操作への応答」なので、古い応答を後から
 * 流す価値がない。新しい通知は常に前のものを置き換える。
 *
 * 在室の取り消しのために、通知は「操作」と「期限」を持てる。期限付きの通知は
 * その時刻まで出しっぱなしにする（取り消せる猶予のあいだ、押せる場所が消えないように）。
 */

export type IslandTone = "neutral" | "success" | "danger";

export interface IslandNotice {
  id: number;
  tone: IslandTone;
  title: string;
  detail?: string;
  /** 島の中に置くボタン。押したら島は閉じる。 */
  action?: { label: string; run: () => void };
  /** この時刻まで表示し続ける（epoch ms）。省略時は既定の表示時間。 */
  expiresAt?: number;
}

/** 期限のない通知を自動で閉じるまでの時間。読み切れて、次の操作を邪魔しない長さ。 */
const ISLAND_DURATION_MS = 4_000;

/** 退場アニメーションぶんの待ち時間。 */
const ISLAND_EXIT_MS = 320;

interface IslandState {
  notice: IslandNotice | null;
  closing: boolean;
  show: (notice: Omit<IslandNotice, "id">) => number;
  /** 即座に消す。id を渡すとその通知のときだけ消す（他人の通知を巻き込まない）。 */
  dismiss: (id?: number) => void;
}

let sequence = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let removeTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (removeTimer) clearTimeout(removeTimer);
  hideTimer = null;
  removeTimer = null;
}

export const useIslandStore = create<IslandState>((set, get) => ({
  notice: null,
  closing: false,
  show: (notice) => {
    clearTimers();
    sequence += 1;
    const id = sequence;
    set({ notice: { ...notice, id }, closing: false });

    const visibleFor = notice.expiresAt
      ? Math.max(0, notice.expiresAt - Date.now())
      : ISLAND_DURATION_MS;
    hideTimer = setTimeout(() => {
      if (get().notice?.id !== id) return;
      set({ closing: true });
      removeTimer = setTimeout(() => {
        if (get().notice?.id !== id) return;
        set({ notice: null, closing: false });
      }, ISLAND_EXIT_MS);
    }, visibleFor);
    return id;
  },
  dismiss: (id) => {
    const current = get().notice;
    if (!current || (id !== undefined && current.id !== id)) {
      return;
    }
    clearTimers();
    set({ notice: null, closing: false });
  },
}));
