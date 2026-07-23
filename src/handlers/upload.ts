import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { isAdmin } from "../lib/auth.js";
import { parseCredentialCsv } from "../lib/csv.js";
import { matchAll } from "../lib/match.js";
import {
  createJob,
  getSettings,
  purgeExpiredForUploader,
} from "../lib/store.js";
import { deliverJob, formatJobSummary } from "../lib/delivery.js";
import { now } from "../lib/clock.js";

registerMainMenuItem({ label: "Upload CSV", data: "upload:start", order: 10 });

const composer = new Composer<Ctx>();

const FLOW_TTL_MS = 15 * 60 * 1000;

const DENIED =
  "You don't have permission to upload. Ask the bot owner to add your Telegram id to the admin whitelist.";

const PROMPT =
  "Send a CSV file (or paste the CSV text) with two columns:\n\n" +
  "identifier,password\n" +
  "@student,secret123\n\n" +
  "Identifier can be a Telegram username or school email. Tap Cancel to stop.";

const cancelKb = inlineKeyboard([
  [inlineButton("Cancel", "upload:cancel")],
  [inlineButton("Back to menu", "menu:main")],
]);

function enterUpload(ctx: Ctx): void {
  ctx.session.step = "awaiting_csv";
  ctx.session.expiresAt = now() + FLOW_TTL_MS;
}

async function beginUpload(ctx: Ctx, viaEdit: boolean): Promise<void> {
  if (!(await isAdmin(ctx.from?.id))) {
    if (viaEdit) await ctx.editMessageText(DENIED, { reply_markup: cancelKb });
    else await ctx.reply(DENIED);
    return;
  }
  enterUpload(ctx);
  if (viaEdit) await ctx.editMessageText(PROMPT, { reply_markup: cancelKb });
  else await ctx.reply(PROMPT, { reply_markup: cancelKb });
}

composer.command("upload", async (ctx) => {
  ctx.session.step = "idle";
  await beginUpload(ctx, false);
});

composer.callbackQuery("upload:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await beginUpload(ctx, true);
});

composer.callbackQuery("upload:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  await ctx.editMessageText("Upload cancelled.", {
    reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
  });
});

/** Fetch CSV body from a Telegram document (or return null on failure). */
async function readDocumentText(ctx: Ctx): Promise<string | null> {
  const doc = ctx.message?.document;
  if (!doc) return null;
  const name = (doc.file_name ?? "").toLowerCase();
  const mime = (doc.mime_type ?? "").toLowerCase();
  const looksCsv =
    name.endsWith(".csv") ||
    name.endsWith(".txt") ||
    mime.includes("csv") ||
    mime.includes("text") ||
    mime === "application/vnd.ms-excel" ||
    mime === "";
  if (!looksCsv) {
    await ctx.reply("Please send a .csv (or plain text) file.", {
      reply_markup: cancelKb,
    });
    return null;
  }
  if (doc.file_size != null && doc.file_size > 1_000_000) {
    await ctx.reply("That file is too large (max 1 MB).", {
      reply_markup: cancelKb,
    });
    return null;
  }
  try {
    const file = await ctx.getFile();
    const token =
      (ctx.api as unknown as { token?: string }).token ??
      (typeof process !== "undefined" ? process.env.BOT_TOKEN : undefined) ??
      "";
    const path = file.file_path;
    if (!path) {
      // Harness stub: no real file — treat as unavailable.
      await ctx.reply(
        "Couldn't download that file. Paste the CSV text instead, or try again.",
        { reply_markup: cancelKb },
      );
      return null;
    }
    const url = path.startsWith("http")
      ? path
      : `https://api.telegram.org/file/bot${token}/${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply("Couldn't download that file. Paste the CSV text instead.", {
        reply_markup: cancelKb,
      });
      return null;
    }
    return await res.text();
  } catch {
    await ctx.reply("Couldn't download that file. Paste the CSV text instead.", {
      reply_markup: cancelKb,
    });
    return null;
  }
}

async function processCsv(ctx: Ctx, text: string): Promise<void> {
  const userId = ctx.from?.id;
  if (userId == null) {
    await ctx.reply("Couldn't identify you. Tap /start and try again.");
    return;
  }
  if (!(await isAdmin(userId))) {
    ctx.session.step = "idle";
    await ctx.reply(DENIED);
    return;
  }

  const parsed = parseCredentialCsv(text);
  if (!parsed.ok) {
    await ctx.reply(parsed.error + "\n\nFix the file and send it again.", {
      reply_markup: cancelKb,
    });
    return;
  }

  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;

  await purgeExpiredForUploader(userId);
  await ctx.reply(
    `Parsed ${parsed.rows.length} row(s). Matching students and delivering…`,
  );

  const matches = await matchAll(
    ctx.api,
    parsed.rows.map((r) => r.identifier),
  );
  const { job, records } = await createJob(
    userId,
    parsed.rows,
    matches.map((m) => ({
      telegram_user_id: m.telegram_user_id,
      failure_reason: m.failure_reason,
    })),
  );

  const settings = await getSettings();
  // Speed up tests / small batches: still honor settings.
  const finalJob = await deliverJob(ctx.api, job, records, {
    settings,
    sleepFn: async (ms) => {
      if (ms > 0 && ms < 5) return;
      // Cap wait in interactive path so large retries don't hang; settings still apply.
      if (ms > 2000) {
        await new Promise((r) => setTimeout(r, 2000));
      } else if (ms > 0) {
        await new Promise((r) => setTimeout(r, ms));
      }
    },
    onProgress: async (p) => {
      // Lightweight real-time tick every 10 records (or last).
      if (p.done === p.total || (p.done > 0 && p.done % 10 === 0)) {
        try {
          await ctx.reply(
            `Progress: ${p.done}/${p.total} (delivered ${p.success}, failed ${p.failure})`,
          );
        } catch {
          /* ignore */
        }
      }
    },
  });

  const summary = formatJobSummary(finalJob);
  const kb =
    finalJob.failure_count > 0
      ? inlineKeyboard([
          [inlineButton("Failure report", "report:failures")],
          [inlineButton("Back to menu", "menu:main")],
        ])
      : inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);

  await ctx.reply(summary, { reply_markup: kb });

  if (finalJob.failure_count > 0) {
    // Auto-offer a compact failure note (full CSV on request).
    await ctx.reply(
      `${finalJob.failure_count} delivery(ies) failed. Tap Failure report for a CSV you can fix and re-upload.`,
    );
  }
}

composer.on("message:document", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_csv") return next();
  const text = await readDocumentText(ctx);
  if (text == null) return;
  await processCsv(ctx, text);
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_csv") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    ctx.session.step = "idle";
    ctx.session.expiresAt = undefined;
    return next();
  }
  await processCsv(ctx, text);
});

export default composer;
