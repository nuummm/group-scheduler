import { NotebookPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, inputClass, Message } from "../../../_components/ui";
import { ApiRequestError, api } from "../../../_lib/api-client";

/**
 * 予定表の下に置く共有メモ。
 *
 * イベント全体で 1 つ、誰でも書ける。参加者ごとの備考（メンバー一覧に出るもの）とは別で、
 * 「この日程調整そのものへの申し送り」を置く場所。
 *
 * 自動保存はしない。共有のテキストを勝手に上書きし合うと、書いている途中の文が
 * 他の人の画面に流れてしまう。保存は明示的な操作にする。
 */
export function EventNotes({ slug, notes }: { slug: string; notes: string }) {
  const [draft, setDraft] = useState(notes);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" }>({
    text: "",
    tone: "info",
  });
  const [saving, setSaving] = useState(false);
  // 「編集中かどうか」を effect からも読めるようにする（state だと依存に入れる必要が出る）。
  const dirtyRef = useRef(false);

  const edit = (value: string) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft(value);
  };

  // 他の人が書き換えたぶんを取り直したときは、こちらが編集中でなければ追従する。
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(notes);
  }, [notes]);

  const save = async () => {
    setSaving(true);
    setMessage({ text: "", tone: "info" });
    try {
      const result = await api.patch<{ notes: string }>(`/api/events/${encodeURIComponent(slug)}`, {
        notes: draft,
      });
      dirtyRef.current = false;
      setDirty(false);
      setDraft(result.notes);
      setMessage({ text: "メモを保存しました。", tone: "info" });
    } catch (error) {
      setMessage({
        text: error instanceof ApiRequestError ? error.message : "メモを保存できませんでした。",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-line border-t px-4 py-4">
      <div className="mb-2 flex items-center gap-2">
        <NotebookPen className="size-3.5 text-ink-subtle" aria-hidden />
        <h3 className="font-medium text-ink text-xs">メモ</h3>
        <span className="text-ink-subtle text-xs">
          {"このイベントに関する共有メモです。参加者の誰でも書けます。"}
        </span>
      </div>
      <textarea
        rows={3}
        maxLength={2000}
        className={inputClass}
        placeholder="例: 火曜1限が最有力。決まり次第 Slack で共有します。"
        value={draft}
        onChange={(event) => edit(event.target.value)}
        aria-label="イベントの共有メモ"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "保存中..." : "メモを保存"}
        </Button>
        {dirty && !saving && (
          <span className="text-ink-subtle text-xs">保存していない変更があります</span>
        )}
        <Message text={message.text} tone={message.tone} />
      </div>
    </section>
  );
}
