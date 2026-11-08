/**
 * 在室のお知らせに載せる文。
 *
 * 知りたいのは「いま行ったら誰かいるか」なので、**一番乗りと合流を言い分ける**。
 * 人数を数字で言うだけだと、その差が読み取れない（1 人と 3 人の違いは数字より言葉で伝わる）。
 *
 * 時間帯で言い方を変えるのは、同じ文が毎日流れると読まれなくなるため。
 * 変えるのは言い方だけで、伝える中身（誰が・何人・何時）は変えない。
 *
 * 送信そのものからは切り離してある（文だけを、時計を渡して確かめたい）。
 */

export type TimeBand = "morning" | "day" | "night";

/** 時間帯の切れ目。朝は「開ける」、夜は「灯りをつける」が自然に読める範囲で切る。 */
export function timeBandOf(hour: number): TimeBand {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 18) return "day";
  return "night";
}

/**
 * Slack のテキストとして安全な形にする。
 *
 * 席の名前は誰でも変えられる。`<!channel>` のような文字列をそのまま流すと
 * **全員にメンションが飛ぶ**。`&` `<` `>` の 3 つだけを実体参照にするのが Slack の作法。
 */
export function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const FIRST: Record<TimeBand, (name: string, place: string) => string> = {
  morning: (name, place) => `${name} が${place}を開けました`,
  // 「いまはひとり」は末尾の「在室 1 人」と重なるので、言い方のほうで一番乗りを示す。
  day: (name) => `${name} がいちばん乗りです`,
  night: (name, place) => `${name} が夜の${place}に灯りをつけました`,
};

const JOIN: Record<TimeBand, (name: string) => string> = {
  morning: (name) => `${name} が来ました`,
  day: (name) => `${name} が合流しました`,
  night: (name) => `${name} が合流しました`,
};

const ANONYMOUS_FIRST: Record<TimeBand, (place: string) => string> = {
  morning: (place) => `だれかが${place}を開けました`,
  day: () => "だれかがいちばん乗りのようです",
  night: (place) => `だれかが夜の${place}に灯りをつけました`,
};

const ANONYMOUS_JOIN: Record<TimeBand, () => string> = {
  morning: () => "だれかが来たようです",
  day: () => "だれかが合流しました",
  night: () => "だれかが合流しました",
};

export interface ArrivalMessageInput {
  /** 席の名前。既定名のままなら `named: false` にして名前を伏せる。 */
  label: string;
  named: boolean;
  /** 送る時点の在室人数。1 なら一番乗り。 */
  presentCount: number;
  /** 言い方を決めるためのその土地の時刻。文には出さない（Slack が時刻を持っている）。 */
  hour: number;
  /** 場所の呼び名（設定 PLACE_NAME）。 */
  place: string;
}

/**
 * 末尾に添える人数。
 *
 * 「在室 3 人」のような台帳の書き方だと、人を数える掲示に見えてしまう。
 * 伝えたいのは「いま行ったら誰かいる」ことなので、そのまま話し言葉で言う。
 */
function tailCount(count: number, place: string): string {
  return `・いま${place}には ${count} 人います。`;
}

/** 形は `本文・いま<場所>には N 人います。`。 */
export function buildArrivalMessage(input: ArrivalMessageInput): string {
  const band = timeBandOf(input.hour);
  const first = input.presentCount <= 1;
  const name = `*${escapeSlackText(input.label)}*`;
  const head = input.named
    ? (first ? FIRST : JOIN)[band](name, input.place)
    : (first ? ANONYMOUS_FIRST : ANONYMOUS_JOIN)[band](input.place);
  // 人数は 0 にならない（送る時点でその人が在室）。念のため下限を敷く。
  return `${head}${tailCount(Math.max(1, input.presentCount), input.place)}`;
}

/** 同時に来た人たちをまとめて言う。名前を伏せる人がいても数だけは足す。 */
const GROUP_FIRST: Record<TimeBand, (names: string, place: string) => string> = {
  morning: (names, place) => `${names} が${place}を開けました`,
  day: (names) => `${names} がいちばん乗りです`,
  night: (names, place) => `${names} が夜の${place}に灯りをつけました`,
};

const GROUP_JOIN: Record<TimeBand, (names: string) => string> = {
  morning: (names) => `${names} が来ました`,
  day: (names) => `${names} が合流しました`,
  night: (names) => `${names} が合流しました`,
};

export interface ArrivalGroupMessageInput {
  /** 同じ猶予のあいだに在室になった席。名前を伏せる席も含めて全部渡す。 */
  arrivals: { label: string; named: boolean }[];
  /** 送る時点の在室人数。 */
  presentCount: number;
  hour: number;
  place: string;
}

/**
 * 同じ猶予のあいだに来た人をまとめて 1 通で知らせる。
 *
 * 会の開始前など、数人が続けて席を押す場面で 1 人ずつ通知すると Slack が流れる。
 * **人数ぶん通知が出ること自体には情報がない**（知りたいのは「いま行ったら誰かいるか」）
 * ので、猶予のあいだに溜まったぶんは 1 通にまとめる。
 *
 * 名前を伏せる席（既定名のまま）が混ざったときは、名前のある人だけを挙げて
 * 残りを「ほか N 人」と数える。伏せている席の名前は出さない。
 */
export function buildArrivalGroupMessage(input: ArrivalGroupMessageInput): string {
  const band = timeBandOf(input.hour);
  const named = input.arrivals.filter((item) => item.named);
  const anonymousCount = input.arrivals.length - named.length;
  // 送った時点の在室が来た人数と同じなら、その全員が最初の入室者。
  const first = input.presentCount <= input.arrivals.length;

  let head: string;
  if (named.length === 0) {
    // 全員が既定名。名前を出せないので数で言うが、末尾の在室人数と並ぶと
    // 同じ数字が 2 度出て読みにくい。ここは数を言わず、来たことだけを伝える。
    head = first ? "何人か来たようです" : "何人か合流しました";
  } else {
    // 名前は太字にしない。1 人のときは名前が主役なので目立たせるが、
    // 並べると太字だらけで、かえって誰の名前かの区切りが読み取りにくくなる。
    const names = named.map((item) => escapeSlackText(item.label)).join("、");
    const withRest = anonymousCount > 0 ? `${names} ほか ${anonymousCount} 人` : names;
    head = (first ? GROUP_FIRST : GROUP_JOIN)[band](withRest, input.place);
  }
  return `${head}${tailCount(Math.max(input.arrivals.length, input.presentCount), input.place)}`;
}
