import { describe, expect, it } from "vitest";

import { decodeDdgHref, htmlToText, parseDdgResults } from "./web";

describe("htmlToText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToText("Made by <b>Phoebe</b> &amp; friends &#39;20")).toBe("Made by Phoebe & friends '20");
  });
  it("drops script/style content", () => {
    expect(htmlToText("<style>x{}</style>hi<script>alert(1)</script> there")).toBe("hi there");
  });
  it("decodes hex entities", () => {
    expect(htmlToText("Made &#x27;Punisher&#x27;")).toBe("Made 'Punisher'");
  });
});

describe("decodeDdgHref", () => {
  it("unwraps a uddg redirect", () => {
    const href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FPunisher_(album)&amp;rut=abc";
    expect(decodeDdgHref(href)).toBe("https://en.wikipedia.org/wiki/Punisher_(album)");
  });
  it("protocol-relative becomes https", () => {
    expect(decodeDdgHref("//example.com/x")).toBe("https://example.com/x");
  });
  it("leaves a direct url alone", () => {
    expect(decodeDdgHref("https://example.com")).toBe("https://example.com");
  });
});

describe("parseDdgResults", () => {
  const HTML = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FPunisher_(album)&rut=1">Punisher (album) - Wikipedia</a>
      <a class="result__snippet" href="x">Punisher is the second studio album by <b>Phoebe Bridgers</b>.</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpitchfork.com%2Freviews%2Falbums%2Fpunisher%2F&rut=2">Phoebe Bridgers: Punisher - Pitchfork</a>
      <a class="result__snippet" href="x">A review of the record.</a>
    </div>`;

  it("extracts titles, decoded urls, and snippets", () => {
    const rs = parseDdgResults(HTML);
    expect(rs).toHaveLength(2);
    expect(rs[0]!.title).toBe("Punisher (album) - Wikipedia");
    expect(rs[0]!.url).toBe("https://en.wikipedia.org/wiki/Punisher_(album)");
    expect(rs[0]!.snippet).toContain("second studio album by Phoebe Bridgers");
    expect(rs[1]!.url).toBe("https://pitchfork.com/reviews/albums/punisher/");
  });

  it("respects the max", () => {
    expect(parseDdgResults(HTML, 1)).toHaveLength(1);
  });

  it("returns [] for markup with no results", () => {
    expect(parseDdgResults("<html><body>nothing</body></html>")).toEqual([]);
  });
});
