import { describe, expect, it } from "vitest";

import { isAuthorized } from "./auth";

const TOKEN = "s3cret-token-value";

describe("isAuthorized", () => {
  it("accepts the exact Bearer token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized("", TOKEN)).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized("Bearer nope", TOKEN)).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(false); // scheme is case-sensitive here
  });

  it("fails closed when the expected token is empty/whitespace", () => {
    expect(isAuthorized("Bearer ", "")).toBe(false);
    expect(isAuthorized("Bearer   ", "   ")).toBe(false);
    expect(isAuthorized(undefined, "")).toBe(false);
  });
});
