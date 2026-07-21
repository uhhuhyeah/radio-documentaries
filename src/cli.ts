#!/usr/bin/env tsx
/**
 * docuflow — CLI for the SUB/WAVE radio-documentaries pipeline.
 *
 *   pnpm cli catalog next [--season N] [--file seasons.md]
 *   pnpm cli catalog list [--season N]
 *   pnpm cli catalog assign --album A --artist B --host Jools [--season N]
 *   pnpm cli lint   path/to/script.md
 *   pnpm cli budget path/to/script.md [--cap 15000]
 *   pnpm cli navidrome ping | find-album --album A [--artist B] | album-songs --id ID | scan-status
 *
 * The deterministic tools these wrap are also exposed to the Producer agent as
 * Pi tools (see src/tools/). This CLI is for humans and smoke-testing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { researchAlbum } from "./agents/researcher";
import { writeScript } from "./agents/writer";
import * as budget from "./budget";
import * as catalog from "./catalog";
import * as lint from "./lint";
import { complete } from "./llm";
import * as navidrome from "./navidrome";
import { loadDotenv, songsOfAlbum } from "./navidrome";
import { renderEpisode } from "./render";
import { webFetchText, webSearch } from "./tools/web";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  loadDotenv(join(REPO_ROOT, ".env")); // make .env keys available to every command
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (cmd === "llm-check") {
    const model = process.env.DOCS_LLM_MODEL ?? "qwen/qwen3-235b-a22b-2507";
    try {
      const reply = await complete("You are terse.", "Reply with exactly: OK");
      console.log(`llm-check (openrouter/${model}): ${reply.trim() || "(empty)"}`);
      return 0;
    } catch (e) {
      console.error(`llm-check failed: ${String(e)}`);
      return 1;
    }
  }

  if (cmd === "catalog") {
    const file = flag(rest, "file");
    const seasonArg = flag(rest, "season");
    const season = seasonArg !== undefined ? parseInt(seasonArg, 10) : undefined;
    const text = catalog.read(file ?? catalog.DEFAULT_PATH);
    if (sub === "next") {
      console.log(catalog.nextEpisode(text, season ?? catalog.activeSeason(text)));
      return 0;
    }
    if (sub === "list") {
      const s = season ?? catalog.activeSeason(text);
      const rows = catalog.rowsForSeason(text, s);
      console.log(`Season ${s} (active=${catalog.activeSeason(text)}): ${rows.length} episode(s)`);
      for (const r of rows) {
        console.log(`  E${String(r.ep).padStart(2, "0")}  ${r.status.padEnd(14)} ` +
          `${r.album} — ${r.artist} (host ${r.host})  dir=${r.dir}  pub=${r.published}`);
      }
      return 0;
    }
    if (sub === "assign") {
      const album = flag(rest, "album");
      const artist = flag(rest, "artist");
      const host = flag(rest, "host");
      if (!album || !artist || !host) {
        console.error("assign requires --album, --artist, --host");
        return 2;
      }
      const r = catalog.assign(album, artist, host, season, file ?? catalog.DEFAULT_PATH);
      console.log(`${r.action}: S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")} → ${r.dir}`);
      return 0;
    }
    console.error("catalog: expected next | list | assign");
    return 2;
  }

  if (cmd === "lint") {
    if (!sub) {
      console.error("lint requires a script path");
      return 2;
    }
    const findings = lint.lintFile(sub);
    console.log(`lint ${sub}`);
    if (findings.length === 0) console.log("  OK — no issues");
    for (const f of findings) console.log(`  [${f.level}] ${f.msg}`);
    const errs = findings.filter((f) => f.level === "ERROR").length;
    const warns = findings.length - errs;
    console.log(`  → ${errs} error(s), ${warns} warning(s)`);
    return errs > 0 ? 1 : 0;
  }

  if (cmd === "budget") {
    if (!sub) {
      console.error("budget requires a script path");
      return 2;
    }
    const capArg = flag(rest, "cap");
    const cap = capArg !== undefined ? parseInt(capArg, 10) : undefined;
    const e = budget.estimateFile(sub);
    console.log(`budget ${sub}`);
    console.log(`  spoken text: ${e.chars.toLocaleString()} chars / ${e.words.toLocaleString()} words / ~${Math.round(e.spokenMinutes)} min spoken`);
    console.log("  credits by model:");
    for (const [model, credits] of Object.entries(e.creditsByModel)) {
      const mark = model === e.chosenModel ? "  <- chosen" : "";
      console.log(`    ${model.padEnd(24)} ${Math.round(credits).toLocaleString().padStart(10)} credits${mark}`);
    }
    if (cap !== undefined) {
      const verdict = budget.withinCap(e, cap);
      if (verdict === null) {
        console.log(`  cap check: chosen model unknown — cannot evaluate`);
      } else {
        console.log(`  cap check: ${Math.round(e.chosenCredits!).toLocaleString()} vs cap ${cap.toLocaleString()} → ${verdict ? "OK" : "OVER CAP"}`);
        return verdict ? 0 : 2;
      }
    }
    return 0;
  }

  if (cmd === "navidrome") {
    let client: navidrome.Subsonic;
    try {
      client = navidrome.clientFromEnv(join(REPO_ROOT, ".env"));
    } catch (e) {
      console.error(String(e));
      return 1;
    }
    try {
      if (sub === "ping") {
        await client.ping();
        console.log("ok — Navidrome reachable and auth valid");
        return 0;
      }
      if (sub === "find-album") {
        const album = flag(rest, "album");
        if (!album) {
          console.error("find-album requires --album");
          return 2;
        }
        const a = await client.findAlbum(album, flag(rest, "artist"));
        if (!a) {
          console.log("album not found");
          return 1;
        }
        console.log(`${a.name} — ${a.artist}  id=${a.id}  songs=${a.songCount}`);
        return 0;
      }
      if (sub === "album-songs") {
        const id = flag(rest, "id");
        if (!id) {
          console.error("album-songs requires --id");
          return 2;
        }
        for (const s of songsOfAlbum(await client.getAlbum(id))) {
          console.log(`  ${String(s.track ?? 0).padStart(2)}. ${s.title}  id=${s.id}`);
        }
        return 0;
      }
      if (sub === "scan-status") {
        console.log(await client.scanStatus());
        return 0;
      }
      console.error("navidrome: expected ping | find-album | album-songs | scan-status");
      return 2;
    } catch (e) {
      console.error(`navidrome error: ${String(e)}`);
      return 1;
    }
  }

  if (cmd === "research") {
    const a = [sub, ...rest].filter((x): x is string => !!x);
    const album = flag(a, "album");
    const artist = flag(a, "artist");
    const out = flag(a, "out");
    if (!album || !artist || !out) {
      console.error("research requires --album --artist --out [--focus]");
      return 2;
    }
    await researchAlbum(album, artist, out, flag(a, "focus"));
    console.log(`research written to ${out}`);
    return 0;
  }

  if (cmd === "write") {
    const a = [sub, ...rest].filter((x): x is string => !!x);
    const researchPath = flag(a, "research");
    const out = flag(a, "out");
    const album = flag(a, "album");
    const artist = flag(a, "artist");
    const host = flag(a, "host");
    const hostName = flag(a, "host-name");
    const season = flag(a, "season");
    const episode = flag(a, "episode");
    if (!researchPath || !out || !album || !artist || !host || !hostName || !season || !episode) {
      console.error("write requires --research --out --album --artist --host --host-name --season --episode [--model --target-minutes --reference-tracks]");
      return 2;
    }
    const tm = flag(a, "target-minutes");
    const rt = flag(a, "reference-tracks");
    const script = await writeScript({
      album,
      artist,
      host,
      hostName,
      season: parseInt(season, 10),
      episode: parseInt(episode, 10),
      model: flag(a, "model"),
      targetMinutes: tm ? parseInt(tm, 10) : undefined,
      referenceTracks: rt ? parseInt(rt, 10) : undefined,
      research: readFileSync(researchPath, "utf-8"),
    });
    writeFileSync(out, script, "utf-8");
    console.log(`script written to ${out} (${script.length} chars)`);
    return 0;
  }

  if (cmd === "render") {
    if (!sub) {
      console.error("render requires a script path");
      return 2;
    }
    const maxArg = flag([...rest], "max-spoken");
    try {
      const r = await renderEpisode(sub, maxArg ? { maxSpoken: parseInt(maxArg, 10) } : {});
      console.log(`rendered ${r.rendered} segment(s) → ${r.audioDir}\ncue → ${r.cuePath}`);
      return 0;
    } catch (e) {
      console.error(`render error: ${String(e)}`);
      return 1;
    }
  }

  if (cmd === "web-search") {
    const query = [sub, ...rest].filter(Boolean).join(" ");
    if (!query) {
      console.error('web-search requires a query, e.g. pnpm cli web-search "punisher phoebe bridgers making of"');
      return 2;
    }
    const results = await webSearch(query);
    for (const [i, r] of results.entries()) {
      console.log(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
    }
    return results.length ? 0 : 1;
  }

  if (cmd === "web-fetch") {
    if (!sub) {
      console.error("web-fetch requires a url");
      return 2;
    }
    console.log((await webFetchText(sub, 1200)) + "\n…");
    return 0;
  }

  console.error("usage: catalog | lint | budget | render | navidrome | web-search | web-fetch (see header)");
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
