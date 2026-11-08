/**
 * クライアントからの API 呼び出し。
 *
 * エラーはサーバーが返す日本語メッセージをそのまま Error にして投げ直し、
 * 呼び出し側は `catch` して島や画面のメッセージに出すだけでよい形にする。
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  // JSON とは限らない。開発中のエラーページや、途中の proxy が返す 502 は HTML で来る。
  // そのまま JSON.parse すると "Unexpected token '<'" が画面のメッセージになる。
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new ApiRequestError(response.status, "応答を読み取れませんでした。");
      }
    }
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "通信に失敗しました。";
    throw new ApiRequestError(response.status, message);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: "GET", cache: "no-store", headers }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body ?? {}) }),
};
