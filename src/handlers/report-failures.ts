import { Composer, InputFile } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { isAdmin } from "../lib/auth.js";
import { buildFailureCsv } from "../lib/csv.js";
import {
  getFailedRecords,
  getLastJob,
  purgeExpiredForUploader,
} from "../lib/store.js";

registerMainMenuItem({
  label: "Failure report",
  data: "report:failures",
  order: 30,
});

const composer = new Composer<Ctx>();

const DENIED =
  "You don't have permission to download failure reports. Ask the bot owner to add you to the admin whitelist.";

const NO_JOB = "No jobs yet — upload a CSV first, then check failures here.";

const NO_FAILURES =
  "Your last job had no failures. Every credential was delivered.";

async function sendFailureReport(ctx: Ctx): Promise<void> {
  const userId = ctx.from?.id;
  if (!(await isAdmin(userId))) {
    await ctx.reply(DENIED);
    return;
  }
  if (userId != null) await purgeExpiredForUploader(userId);
  const job = userId != null ? await getLastJob(userId) : undefined;
  if (!job) {
    await ctx.reply(NO_JOB, {
      reply_markup: inlineKeyboard([
        [inlineButton("Upload CSV", "upload:start")],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const failed = await getFailedRecords(job.id);
  if (failed.length === 0) {
    await ctx.reply(NO_FAILURES, {
      reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
    });
    return;
  }

  const csv = buildFailureCsv(
    failed.map((r) => ({
      identifier: r.identifier,
      failure_reason: r.failure_reason ?? "unknown",
    })),
  );

  await ctx.reply(
    `Failure report for ${job.id}: ${failed.length} row(s). Fix these and re-upload.`,
  );

  try {
    await ctx.api.sendDocument(
      ctx.chat!.id,
      new InputFile(new TextEncoder().encode(csv), `failures-${job.id}.csv`),
      {
        caption: `Failed deliveries — ${job.id}`,
      },
    );
  } catch {
    // Fallback when InputFile / sendDocument is unavailable in harness: paste text.
    const preview =
      csv.length > 3500 ? csv.slice(0, 3500) + "\n…" : csv;
    await ctx.reply(`Failure CSV:\n\n${preview}`, {
      reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
    });
  }
}

composer.callbackQuery("report:failures", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendFailureReport(ctx);
});

export default composer;
