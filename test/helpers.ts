import { env, exports } from "cloudflare:workers";

export const BASIC_USER = "demo";
export const BASIC_PASSWORD = "test-password";

export function basicAuth(user = BASIC_USER, password = BASIC_PASSWORD): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Worker の入口から叩く（合言葉を付けて）。 */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", basicAuth());
  }
  // 画面と同じく、書き込みには JSON の Content-Type を付ける（付けないと Worker が断る）。
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return exports.default.fetch(`https://app.test${path}`, { ...init, headers });
}

export async function json<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await call(path, init);
  return { status: response.status, body: (await response.json()) as T };
}

export function send(method: string, path: string, body?: unknown, headers: HeadersInit = {}) {
  return json(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function store() {
  return env.STORE.get(env.STORE.idFromName("main"));
}
