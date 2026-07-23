import { buildBot } from "./bot.js";
import { setNow } from "./lib/clock.js";

// The Tests-gate harness imports THIS module and calls makeBot() with no args,
// replaying dialog specs tokenlessly. Reset durable store per bot so specs
// stay isolated.
export async function makeBot() {
  setNow(undefined);
  return buildBot(process.env.BOT_TOKEN ?? "harness-test-token", {
    resetDurableStore: true,
  });
}
