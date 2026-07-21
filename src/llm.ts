/**
 * pi-ai LLM plumbing for the sub-agents (research/write).
 *
 * OpenRouter by default (matches SUB/WAVE's DJ brain). The API key is read from
 * OPENROUTER_API_KEY by the provider; no key is passed explicitly here.
 */

import { createModels, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const DEFAULT_MODEL = process.env.DOCS_LLM_MODEL ?? "qwen/qwen3-235b-a22b-2507";

export function makeModels() {
  const models = createModels();
  models.setProvider(openrouterProvider());
  return models;
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
  return extractText(await models.complete(model, context));
}
