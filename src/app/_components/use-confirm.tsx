import { type ReactNode, useCallback, useState } from "react";
import { Button, Modal } from "./ui";

/**
 * 確認ダイアログ。`window.confirm` の置き換え。
 *
 * ブラウザ既定のダイアログは見た目が揃わないうえ、モバイルでは表示位置が読みにくい。
 * 戻り値の `confirm()` は Promise なので、呼び出し側は await するだけでよい。
 */

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          // 前の確認が開いたままなら「キャンセル」として決着させる。
          // 放置すると呼び出し側の await が永久に返らない。
          current?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  const confirmDialog = pending ? (
    <Modal
      open
      title={pending.title}
      onClose={() => settle(false)}
      footer={
        <>
          {/* 取り返しのつかない操作では、開いた瞬間の Enter が実行に当たらないよう
              キャンセル側に置く（キーを押しっぱなしにしていると確定してしまう）。 */}
          <Button onClick={() => settle(false)} autoFocus={pending.danger}>
            キャンセル
          </Button>
          <Button
            variant={pending.danger ? "danger" : "primary"}
            onClick={() => settle(true)}
            autoFocus={!pending.danger}
          >
            {pending.confirmLabel ?? "実行する"}
          </Button>
        </>
      }
    >
      <div className="text-ink text-sm leading-relaxed">{pending.message}</div>
    </Modal>
  ) : null;

  return { confirm, confirmDialog };
}
