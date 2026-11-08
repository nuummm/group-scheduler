import { handle, jsonResponse } from "./api";
import { serverConfig } from "./config";
import { getDb } from "./db";

/**
 * `/api/*` の振り分け。Worker が合言葉を確かめたあと、要求をそのまま DO へ渡してくる。
 *
 * 書き方は「パス → メソッドごとの処理」の表。処理は成功時の値を返すか ApiError を投げるだけで、
 * JSON 化とステータスコードは {@link handle} に任せる。
 * **固定の部分が多いパスを先に並べる**（`/groups/schedule` を `/groups/:groupId` より前に）。
 * 先に合ったパスだけを見るので、順序を誤ると別の処理に落ちる。
 */

export type Params = Record<string, string>;

export interface Endpoint {
  run: (request: Request, params: Params, url: URL) => unknown;
  /** 成功時のステータス。既定は 200。 */
  status?: number;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Route {
  pattern: RegExp;
  keys: string[];
  methods: Partial<Record<Method, Endpoint>>;
}

export function route(path: string, methods: Partial<Record<Method, Endpoint>>): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), keys, methods };
}

function decodeParams(keys: string[], match: RegExpExecArray): Params | null {
  const params: Params = {};
  for (const [index, key] of keys.entries()) {
    try {
      params[key] = decodeURIComponent(match[index + 1] ?? "");
    } catch {
      return null;
    }
  }
  return params;
}

export async function dispatch(request: Request, routes: Route[]): Promise<Response> {
  const url = new URL(request.url);
  for (const entry of routes) {
    const match = entry.pattern.exec(url.pathname);
    if (!match) {
      continue;
    }
    // HEAD は GET と同じ処理で答え、本文だけ落とす（HEAD で叩く死活監視があるため）。
    const head = request.method === "HEAD";
    const endpoint = entry.methods[(head ? "GET" : request.method) as Method];
    if (!endpoint) {
      return new Response(null, {
        status: 405,
        headers: { Allow: Object.keys(entry.methods).join(", ") },
      });
    }
    const params = decodeParams(entry.keys, match);
    if (!params) {
      return jsonResponse({ error: "URL の形式が不正です。" }, { status: 400 });
    }
    const response = await handle(() => endpoint.run(request, params, url), endpoint.status);
    return head ? new Response(null, response) : response;
  }
  return jsonResponse({ error: "見つかりません。" }, { status: 404 });
}

/** 画面が初めに 1 度だけ読む設定（ビルドに埋め込まず、デプロイ先の設定に従わせる）。 */
export const systemRoutes: Route[] = [
  route("/api/healthz", {
    GET: {
      // Worker → DO → SQLite まで届くことを確かめる（外形監視用。合言葉なしで通す）。
      // 書き込みまでは試さない。監視の回数ぶん、1 日の書き込み枠を食うため。
      run: () => {
        try {
          getDb().prepare("SELECT COUNT(*) AS count FROM schema_marks").get();
        } catch (error) {
          console.error("[scheduler] healthz failed", error);
          return jsonResponse({ status: "error" }, { status: 503 });
        }
        return { status: "ok", time: new Date().toISOString() };
      },
    },
  }),
  route("/api/config", {
    GET: {
      run: () => {
        const { site, timeZone, notifyDelayMs, weeklySlots, weekdays } = serverConfig();
        return { ...site, timeZone, notifyDelayMs, weeklySlots, weekdays };
      },
    },
  }),
];
