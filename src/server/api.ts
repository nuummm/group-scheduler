import { ZodError } from "zod";

/**
 * API の共通の受け皿。
 *
 * 各ハンドラは「成功時の値を返す」か「ApiError を投げる」だけに専念し、
 * ステータスコードと JSON 化はここへ集約する。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

/** 応答は取り置かせない（一覧も盤面も、開いた瞬間の状態を返す必要がある）。 */
export function jsonResponse(
  body: unknown,
  init: { status: number; headers?: Record<string, string> },
): Response {
  return Response.json(body, {
    status: init.status,
    headers: { "Cache-Control": "no-store", ...init.headers },
  });
}

export async function handle<T>(run: () => Promise<T> | T, successStatus = 200): Promise<Response> {
  try {
    const result = await run();
    // 応答の形を自分で決めたい処理（死活監視の 503 など）は Response をそのまま返す。
    if (result instanceof Response) {
      return result;
    }
    return jsonResponse(result as object, { status: successStatus });
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse(
        { error: error.message },
        { status: error.status, headers: error.headers },
      );
    }
    if (error instanceof ZodError) {
      const first = error.issues[0];
      return jsonResponse({ error: first?.message ?? "入力内容が不正です。" }, { status: 400 });
    }
    // 想定外は内部メッセージを外へ出さない。
    console.error("[scheduler] unhandled error", error);
    return jsonResponse({ error: "サーバー側で問題が発生しました。" }, { status: 500 });
  }
}

/**
 * JSON ボディを読む。空ボディは `{}` として扱う。
 *
 * オブジェクト以外（`null` や `"5"` など）はここで弾く。ハンドラ側は
 * `"status" in body` のような判定をするので、素通しすると TypeError で 500 になる。
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("JSON の形式が不正です。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("リクエストの形式が不正です。");
  }
  return parsed as Record<string, unknown>;
}
