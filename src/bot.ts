import { Composer } from "grammy";
import { createBot, type BotContext, type CreateBotOptions } from "./toolkit/index.js";
import type { StorageAdapter } from "grammy";
import { now } from "./lib/clock.js";

/**
 * Ephemeral conversation state only. Durable domain data (jobs, records,
 * settings, registered users) lives in src/lib/store.ts.
 */
export interface Session {
  /** Multi-step flow marker. */
  step?: "idle" | "awaiting_csv" | "awaiting_email" | "awaiting_admin_id" | "awaiting_retention";
  /** Flow timeout (epoch ms). */
  expiresAt?: number;
}

export type Ctx = BotContext<Session>;

export interface BuildBotOptions {
  handlers?: Composer<Ctx>[];
  storage?: StorageAdapter<Session>;
  telemetryEnv?: CreateBotOptions<Session>["telemetryEnv"];
  telemetryReporterOptions?: CreateBotOptions<Session>["telemetryReporterOptions"];
  /** When true, wipe durable domain store (test harness isolation). */
  resetDurableStore?: boolean;
}

/**
 * buildBot — assembles the bot, AUTO-LOADS every feature handler from
 * src/handlers/, then registers the global fallback. Does NOT start the bot.
 */
export async function buildBot(token: string, opts: BuildBotOptions = {}) {
  if (opts.resetDurableStore) {
    const { resetStore } = await import("./lib/store.js");
    const { resetCryptoCache } = await import("./lib/crypto.js");
    resetStore();
    resetCryptoCache();
  }

  const bot = createBot<Session>(token, {
    initial: () => ({}),
    storage: opts.storage,
    telemetryEnv: opts.telemetryEnv,
    telemetryReporterOptions: opts.telemetryReporterOptions,
  });

  // Flow-timeout sweeper: expire multi-step sessions cleanly.
  bot.use(async (ctx, next) => {
    if (ctx.session.expiresAt && now() > ctx.session.expiresAt) {
      ctx.session.step = "idle";
      ctx.session.expiresAt = undefined;
    }
    return next();
  });

  const handlers = opts.handlers ?? (await loadHandlersFromDisk());
  for (const h of handlers) bot.use(h);

  bot.on("message", (ctx) =>
    ctx.reply("Sorry, I didn't understand that. Try /help."),
  );

  return bot;
}

async function loadHandlersFromDisk(): Promise<Composer<Ctx>[]> {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("./handlers/", import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        (f.endsWith(".js") || f.endsWith(".ts")) &&
        !f.endsWith(".d.ts") &&
        !f.includes(".test.") &&
        !f.includes(".spec."),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = [];
  }
  const out: Composer<Ctx>[] = [];
  for (const file of files.sort()) {
    const mod = (await import(new URL(file, dir).href)) as {
      default?: Composer<Ctx>;
    };
    if (!mod.default) {
      throw new Error(`handler ${file} must default-export a grammY Composer`);
    }
    out.push(mod.default);
  }
  return out;
}
