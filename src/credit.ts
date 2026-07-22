/**
 * Credit hard-stop — never START a render the ElevenLabs key can't finish, and
 * cap per-episode spend (T1-1). This is the load-bearing autonomy guardrail: the
 * S01E02 render hit `quota_exceeded` MID-way (3 of 9 segments, then 179 credits
 * left, 1046 required), leaving a partial episode with no rundown. This gate makes
 * that impossible by checking the live balance BEFORE the first TTS call.
 *
 * The PURE `classifyCreditGuard` verdict logic is split from the network-touching
 * `assertCreditGuard` so it unit-tests without a key (mirrors src/preflight.ts and
 * src/tools/web.ts). Fail-closed by design: a balance query that can't be resolved
 * aborts the render unless an explicit override is set — a missing signal must
 * never silently permit spend.
 */

import { estimateFile, type Estimate } from "./budget";
import { type CreditBalance, ElevenLabsError, fetchCreditBalance } from "./elevenlabs";

export interface CreditGuardInput {
  /** Credits the render needs (chosen-model credits from budget.ts). */
  estimatedCredits: number;
  /** Credits the key has left (from fetchCreditBalance). */
  remaining: number;
  /** Sanity ceiling on a single episode's spend ([budget] per_episode_cap). */
  perEpisodeCap: number;
}

export interface CreditGuardVerdict {
  ok: boolean;
  reason: string;
}

// --- pure classifier ---------------------------------------------------------

/**
 * Decide whether a render may proceed. Pure. Two abort conditions:
 *  1. estimatedCredits > remaining  — the key can't finish (the S01E02 failure).
 *  2. estimatedCredits > perEpisodeCap — over the per-episode sanity cap.
 * Otherwise ok.
 */
export function classifyCreditGuard({ estimatedCredits, remaining, perEpisodeCap }: CreditGuardInput): CreditGuardVerdict {
  const need = Math.round(estimatedCredits);
  if (estimatedCredits > remaining) {
    return {
      ok: false,
      reason: `insufficient balance: render needs ~${need} credits, key has ${Math.round(remaining)} remaining`,
    };
  }
  if (estimatedCredits > perEpisodeCap) {
    return {
      ok: false,
      reason: `over per-episode cap: render needs ~${need} credits > cap ${perEpisodeCap}`,
    };
  }
  return {
    ok: true,
    reason: `ok: ~${need} credits ≤ ${Math.round(remaining)} remaining, within cap ${perEpisodeCap}`,
  };
}

// --- network -----------------------------------------------------------------

/** Credits the render needs for `modelId`, from the pure estimate. */
export function requiredCredits(estimate: Estimate, modelId: string): number | undefined {
  return estimate.creditsByModel[modelId];
}

export interface CreditCheck extends CreditGuardVerdict {
  estimatedCredits: number | undefined;
  remaining: number | undefined;
  perEpisodeCap: number;
  balance?: CreditBalance;
}

export interface CreditCheckOptions {
  /** Bypass fail-closed when the balance can't be read (use the cap alone). Default false. */
  allowUnknownBalance?: boolean;
}

/**
 * Estimate need, query the live balance, and classify — the full credit gate.
 * Never throws: resolves a structured verdict (fail-closed on any error). The
 * caller (renderEpisode / the CLI) decides how to react to `ok === false`.
 */
export async function checkCredit(
  scriptPath: string,
  modelId: string,
  apiKey: string,
  perEpisodeCap: number,
  opts: CreditCheckOptions = {},
): Promise<CreditCheck> {
  const estimate = estimateFile(scriptPath);
  const estimatedCredits = requiredCredits(estimate, modelId);

  // Unknown model ⇒ we can't size the spend. Fail-closed: never guess cheap.
  if (estimatedCredits === undefined) {
    return {
      ok: false,
      reason: `cannot estimate credits — model '${modelId}' has no known credit rate; refusing to render blind`,
      estimatedCredits: undefined,
      remaining: undefined,
      perEpisodeCap,
    };
  }

  let balance: CreditBalance;
  try {
    balance = await fetchCreditBalance(apiKey);
  } catch (e) {
    if (opts.allowUnknownBalance) {
      // Explicit override: skip the balance check, still enforce the cap.
      const capVerdict = classifyCreditGuard({ estimatedCredits, remaining: Infinity, perEpisodeCap });
      return {
        ...capVerdict,
        reason: `balance unknown (override) — ${capVerdict.reason}`,
        estimatedCredits,
        remaining: undefined,
        perEpisodeCap,
      };
    }
    return {
      ok: false,
      reason: `balance query failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
      estimatedCredits,
      remaining: undefined,
      perEpisodeCap,
    };
  }

  const verdict = classifyCreditGuard({ estimatedCredits, remaining: balance.remaining, perEpisodeCap });
  return { ...verdict, estimatedCredits, remaining: balance.remaining, perEpisodeCap, balance };
}

/**
 * Hard guard for the START of a render: run the check and THROW if it doesn't
 * clear, so no partial render can happen. Returns the passing check otherwise.
 */
export async function assertCreditGuard(
  scriptPath: string,
  modelId: string,
  apiKey: string,
  perEpisodeCap: number,
  opts: CreditCheckOptions = {},
): Promise<CreditCheck> {
  const check = await checkCredit(scriptPath, modelId, apiKey, perEpisodeCap, opts);
  if (!check.ok) {
    throw new ElevenLabsError(`credit hard-stop: ${check.reason}`);
  }
  return check;
}
