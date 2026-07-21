/**
 * pi-ai LLM plumbing for the sub-agents (research/write).
 *
 * OpenRouter by default (matches SUB/WAVE's DJ brain). The API key is read from
 * OPENROUTER_API_KEY by the provider; no key is passed explicitly here.
 */

import { createModels, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

import { config } from "./config";

export const DEFAULT_MODEL = config.models.write;
const TIMEOUT_MS = config.models.timeoutMs;

export function makeModels() {
  const models = createModels();
  models.setProvider(openrouterProvider());
  return models;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function extractText(reply: AssistantMessage): string {
  const blocks = Array.isArray(reply.content) ? reply.content : [];
  return blocks
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("");
}

/** One-shot completion: systemPrompt + a single user message → text. */
export async function complete(systemPrompt: string, user: string, modelId: string = DEFAULT_MODEL): Promise<string> {
  const models = makeModels();
  const model = models.getModel("openrouter", modelId);
  if (!model) {
    throw new Error(`model not found: openrouter/${modelId} (is OPENROUTER_API_KEY set?)`);
  }
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: user, timestamp: Date.now() }],
  };
  return extractText(await withTimeout(models.complete(model, context), TIMEOUT_MS, "LLM completion"));
}
