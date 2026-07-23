import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { isAdmin } from "../lib/auth.js";
import { getLastJob, purgeExpiredForUploader } from "../lib/store.js";
import { formatJobSummary } from "../lib/delivery.js";

registerMainMenuItem({ label: "Last job", data: "status:show", order: 20 });

const composer = new Composer<Ctx>();

const DENIED =
  "You don't have permission to view job status. Ask the bot owner to add you to the admin whitelist.";

const EMPTY =
  "No jobs yet — tap Upload CSV to process your first credential file.";

async function showStatus(ctx: Ctx, viaEdit: boolean): Promise<void> {
  const userId = ctx.from?.id;
  if (!(await isAdmin(userId))) {
    if (viaEdit) {
      await ctx.editMessageText(DENIED, {
        reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
      });
    } else {
      await ctx.reply(DENIED);
    }
    return;
  }
  if (userId != null) await purgeExpiredForUploader(userId);
  const job = userId != null ? await getLastJob(userId) : undefined;
  if (!job) {
    if (viaEdit) {
      await ctx.editMessageText(EMPTY, {
        reply_markup: inlineKeyboard([
          [inlineButton("Upload CSV", "upload:start")],
          [inlineButton("Back to menu", "menu:main")],
        ]),
      });
    } else {
      await ctx.reply(EMPTY, {
        reply_markup: inlineKeyboard([
          [inlineButton("Upload CSV", "upload:start")],
          [inlineButton("Back to menu", "menu:main")],
        ]),
      });
    }
    return;
  }

  const text = formatJobSummary(job);
  const rows = [];
  if (job.failure_count > 0) {
    rows.push([inlineButton("Failure report", "report:failures")]);
  }
  rows.push([inlineButton("Back to menu", "menu:main")]);
  const kb = inlineKeyboard(rows);

  if (viaEdit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
}

composer.command("status", async (ctx) => {
  await showStatus(ctx, false);
});

composer.callbackQuery("status:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showStatus(ctx, true);
});

export default composer;
