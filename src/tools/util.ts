/** Shared shaping for Pi AgentToolResult: a text summary + structured details. */
export function toolResult(summary: string, details: unknown) {
  return { content: [{ type: "text" as const, text: summary }], details };
}
