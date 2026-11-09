import { clientAddressKey, GUARD_KEY_HEADER, retryAfterSeconds } from "../server/auth-guard";
import { jsonError, unauthorized, verifyBasicAuth } from "./auth";

export { AppStore } from "../server/store";

/** 合言葉なしで通す経路。外形監視から生死だけを確かめられるようにする（読むだけのメソッドに限る）。 */
const OPEN_PATHS = new Set(["/api/healthz"]);

function isOpen(request: Request, url: URL): boolean {
  return (request.method === "GET" || request.method === "HEAD") && OPEN_PATHS.has(url.pathname);
}

/**
 * 他サイトからの書き込みを断る。ブラウザは覚えた Basic 認証の資格情報を、他サイトの
 * フォーム送信にも自動で付けるので、合言葉だけでは「罠のページを開いた人の権限で
 * 全席を不在にする」ような送信を止められない。フォームは JSON の Content-Type を
 * 付けられないことと、ブラウザが付ける Sec-Fetch-Site で見分ける。
 */
function rejectCrossSite(request: Request, url: URL): Response | null {
  if (request.method === "GET" || request.method === "HEAD" || !url.pathname.startsWith("/api/")) {
    return null;
  }
  const contentType = request.headers.get("content-type") ?? "";
  const site = request.headers.get("sec-fetch-site");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    (site && !["same-origin", "none"].includes(site))
  ) {
    return Response.json(
      { error: "この画面からの操作として受け付けられませんでした。" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

/**
 * 画面を他サイトに埋め込ませない・型を推測させない・参照元を外へ出さない。
 * ビルドした JS / CSS（/assets/）は Worker を通らないので、ここで付くのは HTML と API。
 */
function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("Referrer-Policy", "same-origin");
  secured.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  secured.headers.set("X-Frame-Options", "DENY");
  return secured;
}

function locked(until: number): Response {
  return jsonError(
    429,
    "失敗が続いたため、しばらく受け付けを止めています。時間をおいて試してください。",
    { "Retry-After": String(retryAfterSeconds(until)) },
  );
}

/** DO へ渡す要求。ロックアウトの照合に使うキーは Worker だけが付ける（外から来た値は捨てる）。 */
function forward(request: Request, guardKey: string | null): Request {
  const forwarded = new Request(request);
  forwarded.headers.delete(GUARD_KEY_HEADER);
  if (guardKey) {
    forwarded.headers.set(GUARD_KEY_HEADER, guardKey);
  }
  return forwarded;
}

/**
 * 入口。合言葉を確かめ、`/api/*` は Durable Object（DB を持つ唯一の場所）へ、
 * それ以外は画面（静的ファイル。無い URL は index.html）へ渡す。
 *
 * 合言葉の失敗は送り元のアドレスごとに数え、続いたらロックする（auth-guard.ts）。
 * ロック中かどうかの照合は、API なら DO が本来の要求と一緒に行う。DO への要求は
 * 1 日の無料枠で数えられ、画面は数秒ごとに API を取り直すので、照合のためだけに
 * DO を 2 回呼ぶことはしない。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // DO は 1 つ（main）だけ。
    const store = env.STORE.get(env.STORE.idFromName("main"));
    const isApi = url.pathname.startsWith("/api/");
    if (isOpen(request, url)) {
      return withSecurityHeaders(
        isApi ? await store.fetch(forward(request, null)) : await env.ASSETS.fetch(request),
      );
    }

    const result = verifyBasicAuth(request, env);
    if (result === "unconfigured") {
      return withSecurityHeaders(
        jsonError(503, "合言葉がまだ設定されていません。管理者に連絡してください。"),
      );
    }
    if (result === "missing") {
      return withSecurityHeaders(unauthorized());
    }
    // 送り元のアドレスは Cloudflare が付ける。手元の開発では付かないので 1 つにまとまる。
    const guardKey = clientAddressKey(request.headers.get("cf-connecting-ip"));
    if (result === "invalid") {
      const until = await store.recordAuthFailure(guardKey);
      return withSecurityHeaders(until === null ? unauthorized() : locked(until));
    }

    const crossSite = rejectCrossSite(request, url);
    if (crossSite) {
      return withSecurityHeaders(crossSite);
    }
    if (isApi) {
      return withSecurityHeaders(await store.fetch(forward(request, guardKey)));
    }
    const until = await store.authLockedUntil(guardKey);
    if (until !== null) {
      return withSecurityHeaders(locked(until));
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
