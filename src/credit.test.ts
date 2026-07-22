import { describe, expect, it } from "vitest";

import { classifyCreditGuard } from "./credit";

describe("classifyCreditGuard", () => {
  const CAP = 15000;

  it("proceeds when the render fits both balance and cap", () => {
    const v = classifyCreditGuard({ estimatedCredits: 9000, remaining: 20000, perEpisodeCap: CAP });
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("within cap");
  });

  it("aborts when the estimate exceeds the remaining balance (can't finish)", () => {
    // The S01E02 shape: needs more than the key has left.
    const v = classifyCreditGuard({ estimatedCredits: 1046, remaining: 179, perEpisodeCap: CAP });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/insufficient balance/);
    expect(v.reason).toContain("179");
  });

  it("aborts when the estimate exceeds the per-episode cap even with balance to spare", () => {
    const v = classifyCreditGuard({ estimatedCredits: 20000, remaining: 1_000_000, perEpisodeCap: CAP });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/over per-episode cap/);
    expect(v.reason).toContain(String(CAP));
  });

  it("checks balance before the cap (insufficient balance reported first)", () => {
    // Over both limits: the can't-finish reason takes precedence.
    const v = classifyCreditGuard({ estimatedCredits: 30000, remaining: 100, perEpisodeCap: CAP });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/insufficient balance/);
  });

  it("proceeds at the exact balance and cap boundary (need == remaining == cap)", () => {
    const v = classifyCreditGuard({ estimatedCredits: CAP, remaining: CAP, perEpisodeCap: CAP });
    expect(v.ok).toBe(true);
  });

  it("aborts one credit over the balance", () => {
    const v = classifyCreditGuard({ estimatedCredits: 501, remaining: 500, perEpisodeCap: CAP });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/insufficient balance/);
  });
});
