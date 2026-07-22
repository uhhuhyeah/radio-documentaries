import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the default excludes, and also ignore git worktrees created under
    // .claude/ (background-task sandboxes) — they carry their own *.test.ts copies
    // that otherwise pollute discovery and fail in an unrelated checkout.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
