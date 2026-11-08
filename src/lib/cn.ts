import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 条件付きクラス名の結合。後勝ちで Tailwind の衝突を解決する。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
