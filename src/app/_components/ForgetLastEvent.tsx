import { useEffect } from "react";
import { clearLastEventPath } from "../_lib/last-event";

/**
 * 「見つかりません」を出したときに、覚えている続きを忘れる。
 *
 * これが無いと、消えたイベントを覚えたまま日程調整タブがそこへ連れて行き、
 * 何度押しても 404 に着く（自力で抜け出せない）。
 */
export function ForgetLastEvent() {
  useEffect(() => {
    clearLastEventPath();
  }, []);
  return null;
}
