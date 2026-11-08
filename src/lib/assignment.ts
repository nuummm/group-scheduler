import { type CandidateMember, type CandidateSlot, cellKey, findCandidates } from "./candidates";

/**
 * 全グループの開催枠をまとめて決める（定式化は docs/assignment.md）。
 *
 * **1 コマには 1 グループまで。** 部屋も主宰者も 1 つなので、メンバーが重ならなくても
 * 同時には開けない。グループどうしはコマの取り合いでつながっている。
 * メンバーの重なり（掛け持ち）だけを見て同時開催を許すと、別々の小さな会が同じコマに
 * 並ぶ案が出て、実際には開けない。掛け持ちは各枠の重み（出られる人数）に効くだけになる。
 *
 * ## 解き方
 * 分枝限定つきの深さ優先探索。外部のソルバーは使わない。
 * グループ十数件 × 枠数十という規模では、次の 3 つで十分速く収束する。
 *
 * 1. **貪欲で初期解を作る** — 下界が早く上がるほど枝を切れる
 * 2. **決めにくいグループから先に置く** — 置ける枠が少ないものを先に潰す
 * 3. **残りの最大値で上界を見る** — 今の暫定解を超えられない枝は捨てる
 *
 * それでも組み合わせは爆発しうるので、探索したノード数に上限を設ける。
 * 打ち切っても「そこまでで見つかった最良の案」は返る（近似解であることは画面に出す）。
 */

/** 探索を打ち切るノード数。超えたらそこまでの最良解を返す。 */
export const NODE_BUDGET = 200_000;

/** 1 グループあたり検討する枠の数。多すぎると探索が伸びるだけで案は良くならない。 */
export const MAX_PLACEMENTS_PER_SEMINAR = 24;

/** 探索の上限。既定は本番の値で、検証（厳密解との突き合わせ）のときだけ外す。 */
export interface AssignmentOptions {
  nodeBudget?: number;
  maxPlacements?: number;
}

export interface SeminarInput {
  groupId: number;
  groupName: string;
  groupColor: string;
  slotSpan: number;
  members: CandidateMember[];
  /**
   * 参加が欠かせない人。この人が出られない枠は候補にしない。
   * 「主宰者が来られないなら開催しない」を、点数ではなく制約として扱うための指定。
   */
  requiredNames?: string[];
  /**
   * 「必ず参加」に指定した区分に、全体表へ出ているメンバーが 1 人もいない状態。
   *
   * 呼び出し側でしか判定できない（`requiredNames` が空なのは「指定していない」のか
   * 「指定した区分が空」なのか、ここからは区別が付かない）。区別しないと制約が
   * 黙って消え、その人が出られないコマに「全員参加できます」と出る。
   */
  requiredMissing?: boolean;
  /**
   * 人が置いた開始コマ。掴んで動かしたか、仮決めしたか。
   *
   * どちらも **そこから動かさない**。掴んで動かしたのに解き直しで別の場所へ飛ぶと、
   * 「置けると表示されたのに置けない」ことになり、画面の約束が守られない。
   * 動かした側と決めた側の違いは `pinned`（見た目と、解き直しで残るかどうか）だけ。
   */
  placedStart?: { columnKey: string; startSlot: number } | null;
  /** その置き場所が「仮決め」か。表示と、解き直しで残すかどうかに使う。 */
  pinned?: boolean;
}

export interface SeminarPlacement {
  groupId: number;
  groupName: string;
  groupColor: string;
  slotSpan: number;
  memberCount: number;
  columnKey: string;
  columnLabel: string;
  startSlot: number;
  endSlot: number;
  /** この枠に出られるメンバー。 */
  freeNames: string[];
  /** 予定が入っていて出られないメンバー。 */
  busyNames: string[];
  /** 仮決めした枠か。決まっているなら案ではなく事実。 */
  fixed: boolean;
  /**
   * 人が置いたが、仮決めはしていない枠か（仮決めを外すとこの状態になる）。
   * 動かさない点は仮決めと同じなので、解いた結果で置かれただけの枠とは見分けが要る。
   */
  moved: boolean;
  /**
   * 同じコマに並んでしまっている相手のグループ名。空でなければ **この案は実行できない**。
   * 人が置いた枠は動かさないので、この状態は解消せずに残る。黙って通すと
   * 「全員参加できます」と並んで出てしまうので、行にも総数にも効かせる。
   */
  conflictsWith: string[];
}

export interface AssignmentResult {
  placements: SeminarPlacement[];
  /**
   * 置かなかったグループと、その理由。
   *
   * 理由は 5 通りある。メンバーがいない / 必ず参加する区分が空 / 置いてあったコマが
   * コマ割りから消えた / コマ数が 1 日ぶんを超えている / 他と重ならない枠が無い。
   */
  unplaced: { groupId: number; groupName: string; reason: string }[];
  /**
   * 人が置いた枠どうしが同じ時間にぶつかっている組。
   * 置いたことは動かさないので、解消するかどうかは人が決める。
   */
  fixedConflicts: { groupNames: [string, string] }[];
  /** 全メンバーが出られ、かつ他と重なっていないグループの数。 */
  fullyAttendedCount: number;
  /** 置けなかったぶんも含めたグループの総数。画面の分母はこれを使う。 */
  totalCount: number;
  /** 出られる人の延べ人数。案の良さの目安。 */
  totalAttendance: number;
  /** 探索を打ち切ったか（打ち切ったなら最適とは限らない）。 */
  truncated: boolean;
  /** 探索で訪れたノード数（貪欲の初期解は数えない）。 */
  nodes: number;
  /**
   * グループごとの「動かせる先」。`${列キー}:${開始コマ}` の一覧。
   *
   * 画面でグループの枠を掴んで動かすときに、置ける場所だけを光らせるために使う。
   * 条件は解のときより厳しい。
   *
   * - そのグループの **全員** が、必要なコマ数ぶん通して空いていること
   *   （解の候補は「1 人でも出られれば」なので、そこは同じではない）
   * - 人が置いた枠（仮決めも、仮決めを外して場所だけ残っている枠も）と重ならないこと
   *
   * 掛け持ちの有無は見ない。同じコマに 2 つのグループは置かないので、それで足りる。
   */
  placeableStarts: { groupId: number; starts: string[] }[];
}

type Slot = CandidateSlot;

/** 時間が重なるか。重なったらそれだけで置けない（同じコマに 2 つのグループは開けない）。 */
function overlaps(a: Slot, b: Slot): boolean {
  return a.columnKey === b.columnKey && a.startSlot <= b.endSlot && b.startSlot <= a.endSlot;
}

/**
 * 指定した開始コマから枠を 1 つ組む。
 *
 * 候補の一覧から探すのではなく直接組むのは、仮決めした枠を「候補に無いから」という
 * 理由で取り下げないため。コマ割りが変わって窓が作れないときだけ null を返す。
 */
function buildSlot(
  seminar: SeminarInput,
  columns: { key: string; label: string }[],
  slotNumbers: number[],
  start: { columnKey: string; startSlot: number },
): CandidateSlot | null {
  const column = columns.find((item) => item.key === start.columnKey);
  const span = Math.max(1, Math.trunc(seminar.slotSpan));
  const index = slotNumbers.indexOf(start.startSlot);
  if (!column || index < 0) {
    return null;
  }
  const window = slotNumbers.slice(index, index + span);
  if (
    window.length !== span ||
    !window.every((slot, offset) => slot === start.startSlot + offset)
  ) {
    return null;
  }
  const freeNames: string[] = [];
  const busyNames: string[] = [];
  for (const member of seminar.members) {
    const free = window.every((slot) => !member.busy.has(cellKey(column.key, slot)));
    (free ? freeNames : busyNames).push(member.name);
  }
  return {
    columnKey: column.key,
    columnLabel: column.label,
    startSlot: start.startSlot,
    endSlot: window[window.length - 1] as number,
    freeCount: freeNames.length,
    freeNames,
    busyNames,
  };
}

export function assignSeminars(
  seminars: SeminarInput[],
  columns: { key: string; label: string }[],
  slotNumbers: number[],
  options: AssignmentOptions = {},
): AssignmentResult {
  const nodeBudget = options.nodeBudget ?? NODE_BUDGET;
  const maxPlacements = options.maxPlacements ?? MAX_PLACEMENTS_PER_SEMINAR;
  const unplaced: AssignmentResult["unplaced"] = [];

  // グループごとに置ける枠を用意する。誰も出られない枠は最初から捨てる。
  const all = seminars.map((seminar) => {
    const required = new Set(seminar.requiredNames ?? []);
    // 人が置いた場所があるなら選択肢はその 1 つだけ。人の指定は案より強いので、
    // 空き人数でも必須メンバーの都合でも捨てない（候補の一覧からは引かず、直接組む）。
    const placedSlot = seminar.placedStart
      ? buildSlot(seminar, columns, slotNumbers, seminar.placedStart)
      : null;
    // 必須の人が出られない枠は、何人集まっても開催できないので候補にしない。
    const usable = placedSlot
      ? [placedSlot]
      : findCandidates(seminar.members, columns, slotNumbers, seminar.slotSpan).filter(
          (slot) => slot.freeCount > 0 && !slot.busyNames.some((name) => required.has(name)),
        );
    const slots: Slot[] = usable.slice(0, maxPlacements);
    return {
      seminar,
      slots,
      // 探索から漏れた枠。置けなかったときの最後の当たり直しに使う。
      // ここを見ずに「置けません」と言うと、掴めば置けるマスが光っているのに
      // 赤字で「枠がありません」と出る、という食い違いになる。
      spilled: usable.slice(maxPlacements),
      isFixed: Boolean(placedSlot),
      hasRequired: required.size > 0,
      // 置き場所があるのに枠が組めない＝コマ割りが変わって指し先が消えている。
      lostFixed: Boolean(seminar.placedStart) && placedSlot === null,
      // 連続で確保したいコマ数が 1 日のコマ数を超えている。予定の埋まり具合とは
      // 関係なく置けないので、理由を分ける。
      tooLong: Math.max(1, seminar.slotSpan) > slotNumbers.length,
    };
  });

  // 判断の材料が欠けているグループは、仮決めしてあっても案に出さない。
  // 「全員参加できます」と出てしまい、欠けていることに気づけなくなる。
  const staffed = all.filter((entry) => {
    const reason =
      entry.seminar.members.length === 0
        ? "メンバーがいません"
        : entry.seminar.requiredMissing
          ? "「必ず参加」の指定先に、全体表へ出ているメンバーがいません"
          : null;
    if (!reason) {
      return true;
    }
    unplaced.push({
      groupId: entry.seminar.groupId,
      groupName: entry.seminar.groupName,
      reason,
    });
    return false;
  });

  // 人が押さえたコマは、案に出さないグループのぶんも空けておく。案から外れても
  // 全体表には 📌 が描かれたままなので、そこへ別のグループを入れると
  // 画面上は同じコマに 2 つ並ぶ。
  const occupiedSlots = all.filter((entry) => entry.isFixed).map((entry) => entry.slots[0] as Slot);

  // 確定済みは動かさない。探索の対象から外し、他のグループが避ける固定の障害物として扱う。
  const fixedEntries = staffed.filter((entry) => entry.isFixed);
  const entries = staffed
    .filter((entry) => !entry.isFixed)
    .filter((entry) => {
      if (entry.lostFixed) {
        unplaced.push({
          groupId: entry.seminar.groupId,
          groupName: entry.seminar.groupName,
          reason: "置いてあったコマが今のコマ割りに無くなっています",
        });
        return false;
      }
      if (entry.slots.length === 0) {
        unplaced.push({
          groupId: entry.seminar.groupId,
          groupName: entry.seminar.groupName,
          reason: entry.tooLong
            ? "必要な連続コマ数が、1 日ぶんのコマ数を超えています"
            : entry.hasRequired
              ? "必ず参加する人が出られる枠がありません"
              : "全員に予定が入っていて置ける枠がありません",
        });
        return false;
      }
      return true;
    })
    // 決めにくいものから先に置く。枠が少ないグループを後回しにすると、
    // 先に置いたグループのせいで置けなくなり、やり直しが増える。
    .sort(
      (a, b) =>
        a.slots.length - b.slots.length || b.seminar.members.length - a.seminar.members.length,
    );

  const toPlacement = (entry: (typeof all)[number], slot: Slot): SeminarPlacement => ({
    groupId: entry.seminar.groupId,
    groupName: entry.seminar.groupName,
    groupColor: entry.seminar.groupColor,
    slotSpan: entry.seminar.slotSpan,
    memberCount: entry.seminar.members.length,
    columnKey: slot.columnKey,
    columnLabel: slot.columnLabel,
    startSlot: slot.startSlot,
    endSlot: slot.endSlot,
    freeNames: slot.freeNames,
    busyNames: slot.busyNames,
    // 📌 を出すのは仮決めだけ。掴んで動かした場所も動かさないが、決定ではない。
    fixed: Boolean(entry.seminar.pinned) && entry.isFixed,
    moved: entry.isFixed && !entry.seminar.pinned,
    conflictsWith: [],
  });

  // 人が置いた枠。案ではなく人の指定なので、重なっていても外さない。
  // ただし黙って通すと同じコマに 2 つ並んでいることに気づけないので、
  // ぶつかっている組は数え上げて画面に返す。
  const fixedSlots = fixedEntries.map((entry) => entry.slots[0] as Slot);
  const fixedPlacements = fixedEntries.map((entry, index) =>
    toPlacement(entry, fixedSlots[index] as Slot),
  );

  /**
   * 人が置いた枠すべて（案に出さないグループも含む）。
   *
   * 重なりを `staffed` の中だけで見ると、メンバーのいないグループの仮決めと
   * ぶつかっていることに気づけない。全体表はそのグループの 📌 も描くので、
   * 画面には 2 本並ぶのに集計は満点、という食い違いになる。
   */
  const humanPlaced = all
    .filter((entry) => entry.isFixed)
    .map((entry) => ({
      groupId: entry.seminar.groupId,
      groupName: entry.seminar.groupName,
      slot: entry.slots[0] as Slot,
    }));

  const fixedConflicts: AssignmentResult["fixedConflicts"] = [];
  for (let left = 0; left < humanPlaced.length; left += 1) {
    for (let right = left + 1; right < humanPlaced.length; right += 1) {
      const a = humanPlaced[left];
      const b = humanPlaced[right];
      if (a && b && overlaps(a.slot, b.slot)) {
        fixedConflicts.push({ groupNames: [a.groupName, b.groupName] });
      }
    }
  }

  // 「動かせる先」は全員が出られる枠だけ。掴んで動かすときに、置いた瞬間に
  // 誰かが出られなくなる場所を選べてしまわないようにする。
  //
  // 避けるのは **他のグループが人の手で置かれている枠**（仮決めも、掴んで動かしただけも）。
  // どちらも動かさないので、そこへ落とすと必ず落とせない。解いた結果で置かれている
  // だけのグループは避けない — そちらが自動で別の枠へ動く。
  // 掛け持ちの有無は見ない。同じコマに 2 つのグループは置かないため。
  const fixedByGroup = all
    .filter((entry) => entry.isFixed)
    .map((entry) => ({ groupId: entry.seminar.groupId, slot: entry.slots[0] as Slot }));
  const placeableStarts = all.map((entry) => {
    const obstacles = fixedByGroup
      .filter((other) => other.groupId !== entry.seminar.groupId)
      .map((other) => other.slot);
    const starts = findCandidates(
      entry.seminar.members,
      columns,
      slotNumbers,
      entry.seminar.slotSpan,
    )
      .filter((slot) => slot.freeCount > 0 && slot.freeCount === entry.seminar.members.length)
      .filter((slot) => !obstacles.some((other) => overlaps(slot, other)))
      .map((slot) => cellKey(slot.columnKey, slot.startSlot));
    return { groupId: entry.seminar.groupId, starts };
  });

  const finish = (
    placements: SeminarPlacement[],
    truncated: boolean,
    nodes: number,
  ): AssignmentResult => {
    // 表示順は登録順に戻す。探索の都合で並べ替えたままだと、
    // 予定を 1 つ変えただけで一覧の並びが入れ替わって読みにくい。
    const order = new Map(seminars.map((seminar, index) => [seminar.groupId, index]));
    const ordered = [...placements].sort(
      (a, b) => (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0),
    );

    // 同じコマに並んでしまった枠を突き合わせる。人が置いた枠どうしでしか起きないが、
    // 起きたときに「全員参加できます」と数えてしまうと、実行できない案が満点で出る。
    // 案に出さないグループ（メンバー不在など）の仮決めも相手に含める。表には出ているので、
    // 数えないと「画面には 2 本、集計は満点」になる。
    const placedIds = new Set(ordered.map((item) => item.groupId));
    for (const placement of ordered) {
      const here: Slot = {
        columnKey: placement.columnKey,
        columnLabel: placement.columnLabel,
        startSlot: placement.startSlot,
        endSlot: placement.endSlot,
        freeCount: 0,
        freeNames: [],
        busyNames: [],
      };
      placement.conflictsWith = [
        ...ordered
          .filter(
            (other) =>
              other.groupId !== placement.groupId &&
              other.columnKey === placement.columnKey &&
              other.startSlot <= placement.endSlot &&
              placement.startSlot <= other.endSlot,
          )
          .map((other) => other.groupName),
        ...humanPlaced
          .filter((other) => !placedIds.has(other.groupId) && overlaps(other.slot, here))
          .map((other) => other.groupName),
      ];
    }

    return {
      placements: ordered,
      unplaced,
      fixedConflicts,
      // 出られない人がいる枠と、同じコマに並んでしまった枠は数えない。
      fullyAttendedCount: ordered.filter(
        (item) => item.busyNames.length === 0 && item.conflictsWith.length === 0,
      ).length,
      // 置けなかったグループも含めた総数。分母がこれでないと「6 / 6」で満点に見えてしまう。
      totalCount: ordered.length + unplaced.length,
      totalAttendance: ordered.reduce((total, item) => total + item.freeNames.length, 0),
      truncated,
      nodes,
      placeableStarts,
    };
  };

  if (entries.length === 0) {
    return finish(fixedPlacements, false, 0);
  }

  // 各段より後ろで得られる出席者数の上限。上界の見積もりに使う。
  const remainingMax: number[] = new Array(entries.length + 1).fill(0);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const best = entries[index]?.slots[0]?.freeCount ?? 0;
    remainingMax[index] = best + (remainingMax[index + 1] as number);
  }

  const conflicts = (chosen: (Slot | null)[], depth: number, slot: Slot): boolean => {
    for (const other of occupiedSlots) {
      if (overlaps(slot, other)) {
        return true;
      }
    }
    for (let index = 0; index < depth; index += 1) {
      const other = chosen[index];
      if (!other) continue;
      if (overlaps(slot, other)) {
        return true;
      }
    }
    return false;
  };

  // 貪欲で初期解を作る。下界が早く上がるほど枝を切れる。
  const greedy: (Slot | null)[] = new Array(entries.length).fill(null);
  let greedyScore = 0;
  entries.forEach((entry, depth) => {
    const pick = entry.slots.find((slot) => !conflicts(greedy, depth, slot));
    if (pick) {
      greedy[depth] = pick;
      greedyScore += pick.freeCount;
    }
  });

  let bestChoice: (Slot | null)[] = [...greedy];
  let bestScore = greedyScore;
  let nodes = 0;
  let truncated = false;

  const chosen: (Slot | null)[] = new Array(entries.length).fill(null);

  const search = (depth: number, score: number): void => {
    if (truncated) {
      return;
    }
    nodes += 1;
    if (nodes > nodeBudget) {
      truncated = true;
      return;
    }
    if (depth === entries.length) {
      if (score > bestScore) {
        bestScore = score;
        bestChoice = [...chosen];
      }
      return;
    }
    // ここから先を全部いちばん良い枠で埋めても届かないなら、この枝は見る意味がない。
    if (score + (remainingMax[depth] as number) <= bestScore) {
      return;
    }
    const entry = entries[depth];
    if (!entry) return;
    for (const slot of entry.slots) {
      if (conflicts(chosen, depth, slot)) {
        continue;
      }
      chosen[depth] = slot;
      search(depth + 1, score + slot.freeCount);
      chosen[depth] = null;
      if (truncated) return;
    }
    // このグループを置かない道も見る。全部置ける組み合わせが無いとき、
    // 1 つ諦めれば残りが全部入る、という案を取りこぼさないため。
    search(depth + 1, score);
  };

  search(0, 0);

  const placements: SeminarPlacement[] = [...fixedPlacements];
  const taken: Slot[] = [...occupiedSlots];
  for (const slot of bestChoice) {
    if (slot) taken.push(slot);
  }
  entries.forEach((entry, depth) => {
    let slot = bestChoice[depth];
    if (!slot && entry.spilled.length > 0) {
      // 探索の対象から外した枠にも当たってみる。1 度だけの線形走査なので安い。
      const rescued = entry.spilled.find(
        (candidate) => !taken.some((other) => overlaps(candidate, other)),
      );
      if (rescued) {
        slot = rescued;
        taken.push(rescued);
      }
    }
    if (!slot) {
      unplaced.push({
        groupId: entry.seminar.groupId,
        groupName: entry.seminar.groupName,
        // 打ち切ったときは「無い」とは言えない。探し切っていないだけかもしれない。
        reason: truncated
          ? "組み合わせが多く、探索を打ち切ったため置き場所が決まりませんでした"
          : "他と重ならない枠が見つかりませんでした",
      });
      return;
    }
    placements.push(toPlacement(entry, slot));
  });

  return finish(placements, truncated, nodes);
}
