import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "./src") };

export default defineConfig({
  test: {
    projects: [
      {
        // 純粋なロジック（src/lib・画面の部品・パスワード）。素の Node で速く回す。
        resolve: { alias },
        test: { name: "unit", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        // Worker と Durable Object を、本番と同じ workerd の上で動かす。
        resolve: { alias },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { SCHEDULER_BASIC_PASSWORD: "test-password" },
            },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
