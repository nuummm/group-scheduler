import type { AttendanceAward, AttendanceHighlights } from "@/lib/types";
import { serverConfig } from "./config";
import type { Db } from "./db";
import { memo, rememberMemo } from "./runtime";
import { isDefaultSeatLabel } from "./slack";

/**
 * その場所に来ている積み重ねを称えるための集計。
 *
 * ## 出す情報の原則
 * **盤面とテロップには称号だけ**を出し、日数や順位は返さない。「今月 12 日」のような
 * 数値は、受け取る側にとって嬉しい情報とは限らないし、並べた瞬間に多い少ないの物差しになる。
 * 称号なら、該当した人には嬉しく、該当しない人にとっては何の情報にもならない。
 *
 * **例外は `buildArrival` だけ。** 席を押した本人の画面に数秒だけ出るお祝いには、
 * 連続日数と 2 位との差を渡す。残らない・その端末にしか出ない・押した操作への返事、
 * という 3 つが揃っているので常時見える物差しにはならない。相手の名前は出さない。
 *
 * ## 誰に出すか
 * 各称号は **1 位のみ**、かつ最低ラインを超えたときだけ発行する。数を絞るほど
 * 「載っていないこと」の意味は薄まる（3 人中 2 人が載る一覧は、残り 1 人を指してしまう）。
 * 席名が既定のまま（空席 A など）の席は個人と結び付いていないので対象外。
 */

/** 称号を出すための最低ライン。これを下回るなら該当者なしとして何も出さない。 */
const MIN_STREAK_DAYS = 3;
const MIN_MONTHLY_DAYS = 5;
const MIN_YEARLY_DAYS = 20;

/**
 * アプリの設定のタイムゾーン。「その日来たか」の切れ目を決めるのに使う。
 * 保存は UTC なので、これがないと深夜に来た記録が前日に寄る。
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** ISO の時刻を、設定のタイムゾーンでの `YYYY-MM-DD` にする。 */
export function localDate(iso: string): string {
  const { timeZone } = serverConfig();
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(iso));
}

/**
 * `YYYY-MM-DD` を日数ぶんずらす。
 * ここでの日付はタイムゾーン変換済みの「ラベル」なので、UTC 深夜として扱って足し引きすれば
 * 夏時間の有無に関係なく正しくカレンダー日が動く。
 */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 末尾から連続している日数を数える。
 *
 * 今日まだ来ていないだけの人の連続を切らないため、起点は「今日」と「昨日」の
 * どちらでもよい。それより前で途切れていれば連続は 0。
 */
export function countStreak(days: ReadonlySet<string>, today: string): number {
  const yesterday = shiftDays(today, -1);
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
  if (!cursor) {
    return 0;
  }
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDays(cursor, -1);
  }
  return streak;
}

interface SeatTally {
  seatKey: string;
  seatLabel: string;
  streakDays: number;
  monthlyDays: number;
  yearlyDays: number;
}

/**
 * 称号ごとの 1 位を選ぶ。
 * 同点は席名で決める — 実行のたびに受賞者が入れ替わると称号の意味が薄れる。
 */
function pickWinner(
  tallies: SeatTally[],
  value: (tally: SeatTally) => number,
  minimum: number,
  kind: AttendanceAward["kind"],
  title: string,
): AttendanceAward | null {
  const best = [...tallies]
    .filter((tally) => value(tally) >= minimum)
    .sort((a, b) => value(b) - value(a) || a.seatLabel.localeCompare(b.seatLabel, "ja"))[0];
  return best ? { kind, title, seatKey: best.seatKey, seatLabel: best.seatLabel } : null;
}

/**
 * 称号を取り出す。
 *
 * 在室の盤面は数秒ごとに取り直されるため、そのたびに年間分の履歴を走査すると
 * 読み取り行数がそのまま積み上がる。称号が動くのは書き込みがあったときと日付が
 * 変わったときだけなので、その間は控え（{@link memo}）を返す。
 *
 * 控えに置くのはトランザクションの外だけ。書き込みの途中で読んだ結果を焼き付けると、
 * 巻き戻したときに DB に存在しない状態の称号が残ってしまう。
 */
export function buildHighlights(db: Db, options: { cache?: boolean } = {}): AttendanceHighlights {
  if (options.cache === false) {
    return computeHighlights(db);
  }
  return memo(highlightsKey(), () => computeHighlights(db));
}

function highlightsKey(): string {
  return `attendance-highlights:${localDate(new Date().toISOString())}`;
}

/**
 * 書き込みの中で組んだ称号を、確定のあとで控えに置く。置かないと、書き込みのたびに
 * 次の取り直しでもう 1 回、年度ぶんの記録を走査することになる。
 */
export function rememberHighlights(highlights: AttendanceHighlights): void {
  rememberMemo(highlightsKey(), highlights);
}

/**
 * 年の称号が数える範囲。**年度**（4/1 〜 翌 3/31）で区切る。
 *
 * 学校や多くの組織の 1 年は 4 月に入れ替わるので、1/1 で数え直すと「今年の主」が
 * 顔ぶれの入れ替わりとずれる。記録そのものは消さず、数える窓だけを毎年 4/1 に動かす。
 */
export function fiscalYearStart(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${month >= 4 ? year : year - 1}-04-01`;
}

/** 年度ぶんの来訪日を席ごとにまとめる。称号の集計と、本人向けの表示で共有する。 */
function collectTallies(db: Db): { today: string; tallies: SeatTally[] } {
  const today = localDate(new Date().toISOString());
  const monthPrefix = today.slice(0, 7);
  const fiscalStart = fiscalYearStart(today);
  // 取り出す範囲は年度ではなく「ここ 400 日」。
  //
  // 年度の頭で切ると、**連続日数まで年度で切れる**。3 月から毎日来ている人が
  // 4/2 に「4 日連続」になり、3/30 から来始めた人と並んで称号が入れ替わる。
  // 年度で数えるのは yearlyDays だけで、そちらは下の day >= fiscalStart で絞る。
  const since = `${new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00Z`;

  // 名前は席の現在値を使う（履歴側の seat_label は記録時点のもので、改名すると古くなる）。
  // 席ごと消えている履歴は集計しない — もうその席は存在しない。
  const rows = db
    .prepare(`
      SELECT e.seat_key, s.seat_label, e.created_at
      FROM attendance_events e
      JOIN attendance_seats s ON s.seat_key = e.seat_key
      WHERE e.status = 'present' AND e.previous_status = 'offsite' AND e.created_at >= ?
        AND s.seat_kind = 'seat'
      ORDER BY e.created_at ASC
    `)
    .all(since) as { seat_key: string; seat_label: string; created_at: string }[];

  const daysBySeat = new Map<string, Set<string>>();
  const labelBySeat = new Map<string, string>();
  for (const row of rows) {
    const days = daysBySeat.get(row.seat_key) ?? new Set<string>();
    days.add(localDate(row.created_at));
    daysBySeat.set(row.seat_key, days);
    labelBySeat.set(row.seat_key, row.seat_label);
  }

  const tallies: SeatTally[] = [];
  for (const [seatKey, days] of daysBySeat) {
    const seatLabel = labelBySeat.get(seatKey) ?? "";
    if (isDefaultSeatLabel(seatLabel)) {
      continue;
    }
    tallies.push({
      seatKey,
      seatLabel,
      streakDays: countStreak(days, today),
      monthlyDays: [...days].filter((day) => day.startsWith(monthPrefix)).length,
      // 年度の始まり以降だけを数える（4/1 に自動で数え直る）。
      yearlyDays: [...days].filter((day) => day >= fiscalStart).length,
    });
  }
  return { today, tallies };
}

/**
 * カードを押した本人にだけ返す値。
 *
 * テロップ（称号だけ・日数は伏せる）とは用途が別で、こちらは押した人の画面に一瞬出るだけ。
 * 他人の日数は返さない。2 位との差は返すが **相手の名前は返さない** ので、
 * 「誰が来ていないか」は読み取れないまま。
 */
export function buildArrival(db: Db, seatKey: string, seatLabel: string) {
  const { tallies } = collectTallies(db);
  const mine = tallies.find((tally) => tally.seatKey === seatKey);
  if (!mine) {
    return { seatLabel, streakDays: 0, monthlyLead: null, yearlyTop: false };
  }
  const leadOver = (pick: (tally: SeatTally) => number, minimum: number): number | null => {
    const sorted = tallies.map(pick).sort((a, b) => b - a);
    const mineValue = pick(mine);
    const second = sorted[1];
    // 自分しかいないなら「2 位との差」は無い。0 を相手に差を出すと、
    // 存在しない 2 位に何日差を付けた、という嘘になる。
    if (second === undefined) {
      return null;
    }
    // 単独 1 位で、最低ラインを超えているときだけ。並んでいるうちは出さない。
    return mineValue >= minimum && sorted[0] === mineValue && mineValue > second
      ? mineValue - second
      : null;
  };
  const monthlyLead = leadOver((tally) => tally.monthlyDays, MIN_MONTHLY_DAYS);
  return {
    seatLabel,
    streakDays: mine.streakDays,
    monthlyLead: monthlyLead === null ? null : { days: mine.monthlyDays, lead: monthlyLead },
    yearlyTop: leadOver((tally) => tally.yearlyDays, MIN_YEARLY_DAYS) !== null,
  };
}

function computeHighlights(db: Db): AttendanceHighlights {
  const { tallies } = collectTallies(db);

  const awards = [
    pickWinner(tallies, (t) => t.streakDays, MIN_STREAK_DAYS, "streak", "連続記録"),
    pickWinner(tallies, (t) => t.monthlyDays, MIN_MONTHLY_DAYS, "monthly", "今月の主"),
    pickWinner(tallies, (t) => t.yearlyDays, MIN_YEARLY_DAYS, "yearly", "今年度の主"),
  ].filter((award): award is AttendanceAward => award !== null);

  return { awards };
}
