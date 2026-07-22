import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";

// The repo root, computed the same way config.ts does (this test is in src/, as config.ts is),
// so the default-workdir assertion holds whether we run from the repo or a git worktree.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpToml(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "cfg-")), "settings.toml");
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadConfig", () => {
  it("parses models, elevenlabs, and voices", () => {
    const p = tmpToml(
      [
        "[models]",
        'research = "r/model"',
        'write = "w/model"',
        'producer = "p/model"',
        "timeout_ms = 12345",
        "[elevenlabs]",
        'model = "eleven_multilingual_v2"',
        "[voices.p_cara]",
        'voice_id = "VID_CARA"  # a comment',
        "speed = 1.2",
      ].join("\n"),
    );
    const c = loadConfig(p);
    expect(c.models.research).toBe("r/model");
    expect(c.models.write).toBe("w/model");
    expect(c.models.producer).toBe("p/model");
    expect(c.models.timeoutMs).toBe(12345);
    expect(c.elevenlabs.model).toBe("eleven_multilingual_v2");
    expect(c.voices.p_cara).toEqual({ voiceId: "VID_CARA", speed: 1.2 });
  });

  it("parses the per-episode credit cap", () => {
    const p = tmpToml("[budget]\nper_episode_cap = 9000\n");
    expect(loadConfig(p).budget.perEpisodeCap).toBe(9000);
  });

  it("falls back to defaults when the file is absent", () => {
    const c = loadConfig("/nonexistent/settings.toml");
    expect(c.models.write).toContain("qwen");
    expect(c.elevenlabs.model).toBe("eleven_flash_v2_5");
    expect(c.voices.p_cara?.voiceId).toBeTruthy();
    expect(c.budget.perEpisodeCap).toBe(15000);
  });

  it("env var overrides the per-episode cap", () => {
    const p = tmpToml("[budget]\nper_episode_cap = 9000\n");
    process.env.DOCS_PER_EPISODE_CAP = "500";
    try {
      expect(loadConfig(p).budget.perEpisodeCap).toBe(500);
    } finally {
      delete process.env.DOCS_PER_EPISODE_CAP;
    }
  });

  it("env var overrides the toml value", () => {
    const p = tmpToml('[models]\nwrite = "w/model"\n');
    process.env.DOCS_WRITE_MODEL = "env/model";
    try {
      expect(loadConfig(p).models.write).toBe("env/model");
    } finally {
      delete process.env.DOCS_WRITE_MODEL;
    }
  });

  it("work.dir defaults to the repo root, and DOCS_WORK_DIR / toml override it", () => {
    // Default: the repo root, so episodes land where they always have.
    expect(loadConfig("/nonexistent/settings.toml").work.dir).toBe(REPO_ROOT);

    const p = tmpToml('[work]\ndir = "/srv/subwave/work"\n');
    expect(loadConfig(p).work.dir).toBe("/srv/subwave/work");

    process.env.DOCS_WORK_DIR = "/var/lib/subwave";
    try {
      expect(loadConfig(p).work.dir).toBe("/var/lib/subwave");
    } finally {
      delete process.env.DOCS_WORK_DIR;
    }
  });
});
