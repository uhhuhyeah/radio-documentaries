import { describe, expect, it } from "vitest";

import { htmlToText, parseBraveResults, sourceReliability } from "./web";

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

describe("sourceReliability", () => {
  it("rates established music press as reliable", () => {
    expect(sourceReliability("https://en.wikipedia.org/wiki/Punisher_(album)")).toBe("reliable");
    expect(sourceReliability("https://pitchfork.com/reviews/albums/punisher/")).toBe("reliable");
    expect(sourceReliability("https://www.soundonsound.com/techniques/whatever")).toBe("reliable");
  });
  it("rates crowd-sourced / fan / forum sources as low-trust", () => {
    expect(sourceReliability("https://equipboard.com/pros/phoebe-bridgers")).toBe("low-trust");
    expect(sourceReliability("https://genius.com/albums/Phoebe-bridgers/Punisher")).toBe("low-trust");
    expect(sourceReliability("https://music.fandom.com/wiki/Punisher")).toBe("low-trust");
    expect(sourceReliability("https://www.reddit.com/r/phoebebridgers/comments/x")).toBe("low-trust");
  });
  it("matches subdomains, not arbitrary substrings", () => {
    expect(sourceReliability("https://blog.pitchfork.com/x")).toBe("reliable");
    expect(sourceReliability("https://notpitchfork.com.evil.example/x")).toBe("unrated");
  });
  it("returns unrated for unknown hosts and unparseable urls", () => {
    expect(sourceReliability("https://some-random-blog.example/post")).toBe("unrated");
    expect(sourceReliability("not a url")).toBe("unrated");
  });
});
