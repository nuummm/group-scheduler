import { X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * 画面の素になる小さな部品。
 *
 * ここに無い見た目はページ側で Tailwind を直書きする。共通化するのは
 * 「アプリ内で意味が同じもの」だけに絞る（ボタンの階層・カード・ダイアログ）。
 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-ink-subtle",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-muted",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "border border-line text-danger hover:bg-danger hover:text-white",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-line border-b px-5 py-4">
      <div className="min-w-0">
        <h2 className="font-semibold text-base text-ink">{title}</h2>
        {description && (
          <p className="copy-block mt-0.5 text-ink-muted text-xs leading-relaxed">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 入力は children として渡され、label が包む形で関連付く（暗黙のラベル）
    <label className="block">
      <span className="mb-1.5 block font-medium text-ink text-xs">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-ink-subtle text-xs">{hint}</span>}
    </label>
  );
}

export const inputClass = cn(
  "w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink",
  "placeholder:text-ink-subtle focus:border-accent focus:outline-none",
);

export function Message({ text, tone }: { text: string; tone: "info" | "error" }) {
  if (!text) return null;
  return (
    <p className={cn("text-xs", tone === "error" ? "text-danger" : "text-ink-muted")} role="status">
      {text}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line border-dashed px-4 py-8 text-center text-ink-subtle text-sm">
      {children}
    </div>
  );
}

/**
 * ダイアログ。デスクトップは中央、モバイルは下から出るシートになる。
 *
 * Escape で閉じ、開いている間は背後をスクロールさせない。閉じる操作を
 * 背景クリック・×・Escape の 3 つとも用意するのは、モーダルから出られない状態を作らないため。
 */
/**
 * 開いているダイアログの積み重なり。
 *
 * 重ねて開いたとき（予定表の上に確認ダイアログ）、
 * - 背景のスクロール固定は **最後の 1 枚が閉じるまで**保つ
 * - キー操作は **いちばん上の 1 枚だけ**が扱う。全員が扱うと、Escape が下の
 *   ダイアログまで閉じ、Tab は上下のダイアログが互いにフォーカスを奪い合って
 *   先頭から動かなくなる
 */
const modalStack: symbol[] = [];
let overflowBeforeLock = "";

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // onClose は呼び出し側でインラインに書かれるため毎レンダー別物になる。
  // 依存に入れると開いているあいだ listener を張り直し続けるので、ref 経由で読む。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) {
    idRef.current = Symbol("modal");
  }
  /**
   * 閉じたあとにフォーカスを戻す先。
   *
   * effect の中で `document.activeElement` を読むと、React の `autoFocus` が
   * 先に当たっているので「そのダイアログ自身のボタン」を掴んでしまい、閉じたときには
   * もう DOM に無い。描画の時点＝まだ開く前に読む。
   */
  const restoreRef = useRef<Element | null>(null);
  if (open) {
    restoreRef.current ??= document.activeElement;
  } else if (restoreRef.current) {
    restoreRef.current = null;
  }

  useEffect(() => {
    if (!open) return;
    const id = idRef.current as symbol;
    const onKeyDown = (event: KeyboardEvent) => {
      // いちばん上の 1 枚だけが扱う。
      if (modalStack[modalStack.length - 1] !== id) return;
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      // Tab はダイアログの中で回す。外へ出られると、背後のボタンを押せてしまう
      // （見えている面と操作できる面が食い違う）。
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const candidates = dialog.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      // 端の 2 つしか要らない。予定表は 61 列 × 24 コマぶんのボタンを抱えるので、
      // 全件に offsetParent を読むと Tab のたびにレイアウトが千数百回走る。
      const visible = (element: HTMLElement) =>
        element.offsetParent !== null || element === document.activeElement;
      let first: HTMLElement | undefined;
      let last: HTMLElement | undefined;
      for (const element of candidates) {
        if (visible(element)) {
          first = element;
          break;
        }
      }
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const element = candidates[index];
        if (element && visible(element)) {
          last = element;
          break;
        }
      }
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    if (modalStack.length === 0) {
      overflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    modalStack.push(id);
    const restoreFocusTo = restoreRef.current;
    // 開いたら中の最初の入力へ、無ければダイアログ自体へフォーカスを移す。
    // 呼び出し側が個々の input に autoFocus を書くと、フォーカスの流れが
    // ダイアログごとにばらつくので、ここに一本化する。
    // ただし中身が自分でフォーカスを取っている場合（確認ダイアログの実行ボタンなど）は奪わない。
    const dialog = dialogRef.current;
    if (!dialog?.contains(document.activeElement)) {
      const firstField = dialog?.querySelector<HTMLElement>(
        "input:not([type='hidden']), textarea, select",
      );
      (firstField ?? dialog)?.focus();
    }
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = modalStack.lastIndexOf(id);
      if (at >= 0) {
        modalStack.splice(at, 1);
      }
      if (modalStack.length === 0) {
        document.body.style.overflow = overflowBeforeLock;
      }
      // 閉じたら元の場所へ戻す。戻さないと、キーボードだけの操作で
      // ページの先頭からやり直しになる。
      if (restoreFocusTo instanceof HTMLElement && restoreFocusTo.isConnected) {
        restoreFocusTo.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-float)]",
          "sm:max-h-[88vh] sm:rounded-[var(--radius-card)]",
          wide ? "sm:max-w-5xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-line border-b px-5 py-4">
          <h2 className="font-semibold text-base text-ink">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="閉じる">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-line border-t px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
