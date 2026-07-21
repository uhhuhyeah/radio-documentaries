import { describe, expect, it } from "vitest";

import { htmlToText, parseBraveResults } from "./web";

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

describe("parseBraveResults", () => {
  const JSON_OK = {
    web: {
      results: [
        {
          title: "Punisher (album) - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Punisher_(album)",
          description: "Punisher is the <strong>second</strong> studio album by Phoebe Bridgers.",
        },
        {
          title: "Phoebe Bridgers: Punisher - Pitchfork",
          url: "https://pitchfork.com/reviews/albums/punisher/",
          description: "A review of the record.",
        },
      ],
    },
  };

  it("extracts titles, urls, and tag-stripped snippets", () => {
    const rs = parseBraveResults(JSON_OK);
    expect(rs).toHaveLength(2);
    expect(rs[0]!.title).toBe("Punisher (album) - Wikipedia");
    expect(rs[0]!.url).toBe("https://en.wikipedia.org/wiki/Punisher_(album)");
    expect(rs[0]!.snippet).toBe("Punisher is the second studio album by Phoebe Bridgers.");
    expect(rs[1]!.url).toBe("https://pitchfork.com/reviews/albums/punisher/");
  });

  it("respects the max", () => {
    expect(parseBraveResults(JSON_OK, 1)).toHaveLength(1);
  });

  it("returns [] when there are no results", () => {
    expect(parseBraveResults({})).toEqual([]);
    expect(parseBraveResults({ web: {} })).toEqual([]);
    expect(parseBraveResults(null)).toEqual([]);
  });
});
