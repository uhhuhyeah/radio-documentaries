#!/usr/bin/env tsx
/**
 * Entry point for the Producer agent.
 *   pnpm producer "Making of Punisher by Phoebe Bridgers, Jools to host"
 * Needs LLM auth (OPENROUTER_API_KEY / ~/.pi/agent).
 */

import { runProducer } from "./agents/producer";

const trigger = process.argv.slice(2).join(" ").trim();
if (!trigger) {
  console.error('usage: pnpm producer "Making of <album> by <artist>, <host> to host"');
  process.exit(2);
}

runProducer(trigger)
  .then(() => console.log("\nproducer: done"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
