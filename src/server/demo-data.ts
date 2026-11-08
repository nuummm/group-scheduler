import { createRandom } from "@/lib/random";

/**
 * 見本のイベントの中身。人物も予定も、固定の seed から作る架空のデータ。
 *
 * 手で書いた名簿にしないのは、実在の人と同じ氏名を避けるため（名前は名字なしの
 * よくある呼び名だけにする）と、seed を変えれば別の盤面をいくらでも作れるため。
 * seed は「全員が出られないグループが 1〜2 件ある」「探索を打ち切らない」盤面になるものを
 * 選んで固定している（demo-data.test.ts が確かめる）。
 */

export const DEMO_SEED = 23;

export interface DemoGroup {
  name: string;
  slotSpan: number;
  /** 主宰者の区分を「必ず参加」にするか。 */
  requiresOwner: boolean;
}

export interface DemoMember {
  name: string;
  /** 主宰者か。主宰者でなければ既定の区分のどれかに入る。 */
  owner: boolean;
  /** 既定の区分のうち何番目に入るか（主宰者なら使わない）。 */
  roleIndex: number;
  groups: string[];
  /** 予定が入っているコマ。`${列キー}:${コマ番号}`。 */
  busy: string[];
}

export interface DemoData {
  groups: DemoGroup[];
  members: DemoMember[];
}

export const DEMO_GROUPS: DemoGroup[] = [
  { name: "定例ミーティング", slotSpan: 2, requiresOwner: true },
  { name: "プロジェクト A", slotSpan: 2, requiresOwner: true },
  { name: "勉強会（基礎）", slotSpan: 1, requiresOwner: false },
  { name: "勉強会（応用）", slotSpan: 1, requiresOwner: true },
  { name: "読書会", slotSpan: 1, requiresOwner: false },
];

const GIVEN_NAMES = [
  "あおい",
  "はると",
  "ゆい",
  "そうた",
  "めい",
  "りく",
  "ひなた",
  "かいと",
  "さくら",
  "れん",
  "みお",
  "ゆうま",
  "ことね",
  "たくみ",
  "なな",
  "しゅん",
  "いろは",
  "だいち",
];

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/**
 * 盤面を作る。列とコマは呼ぶ側の設定から渡す（既定は 月〜金 × 6 コマ）。
 *
 * 予定は人ごとに「忙しさ」を引き、コマごとにその確率で埋める。全員が同じ確率だと
 * 盤面が一様になり、どこに置いても大差ない退屈な見本になる。
 */
export function buildDemoData(
  seed: number,
  columnKeys: readonly string[],
  slotCount: number,
  roleCount: number,
  memberCount = 14,
): DemoData {
  const random = createRandom(seed);
  const names = shuffle(GIVEN_NAMES, random).slice(0, memberCount + 1);
  const cells = columnKeys.flatMap((key) =>
    Array.from({ length: slotCount }, (_, index) => `${key}:${index + 1}`),
  );
  const busyFor = (density: number) => cells.filter(() => random() < density);

  const members: DemoMember[] = names.slice(1).map((name) => {
    const groupCount = 1 + Math.floor(random() * 3);
    return {
      name,
      owner: false,
      roleIndex: Math.floor(random() * Math.max(1, roleCount)),
      groups: shuffle(
        DEMO_GROUPS.map((group) => group.name),
        random,
      ).slice(0, groupCount),
      busy: busyFor(0.15 + random() * 0.25),
    };
  });
  members.push({
    name: names[0] ?? "リーダー",
    owner: true,
    roleIndex: 0,
    groups: DEMO_GROUPS.filter((group) => group.requiresOwner).map((group) => group.name),
    busy: busyFor(0.3),
  });
  return { groups: DEMO_GROUPS, members };
}
