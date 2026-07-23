import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { isAdmin } from "../lib/auth.js";
import {
  getSettings,
  updateSettings,
  type OwnerSettings,
} from "../lib/store.js";
import { now } from "../lib/clock.js";

registerMainMenuItem({ label: "Settings", data: "settings:show", order: 50 });

const composer = new Composer<Ctx>();

const DENIED =
  "You don't have permission to change settings. Ask the bot owner to add you to the admin whitelist.";

const FLOW_TTL_MS = 10 * 60 * 1000;

function settingsText(s: OwnerSettings): string {
  const admins =
    s.admin_ids.length > 0
      ? s.admin_ids.join(", ")
      : "(env whitelist only — none stored here)";
  return (
    "Owner settings\n\n" +
    `Retries per delivery: ${s.max_retries}\n` +
    `Retry delay: ${s.retry_delay_ms} ms\n` +
    `Rate limit pause: ${s.rate_limit_ms} ms\n` +
    `Retention: ${s.retention_days} days\n` +
    `Email matching: ${s.email_matching ? "on" : "off"}\n` +
    `Extra admin ids: ${admins}`
  );
}

function settingsKb(s: OwnerSettings) {
  return inlineKeyboard([
    [
      inlineButton(
        s.email_matching ? "Email match: on" : "Email match: off",
        "settings:toggle_email",
      ),
    ],
    [inlineButton("Retries +", "settings:retries_up"), inlineButton("Retries −", "settings:retries_down")],
    [inlineButton("Retention", "settings:retention"), inlineButton("Add admin", "settings:add_admin")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
}

async function showSettings(ctx: Ctx, edit: boolean): Promise<void> {
  if (!(await isAdmin(ctx.from?.id))) {
    if (edit) {
      await ctx.editMessageText(DENIED, {
        reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
      });
    } else {
      await ctx.reply(DENIED);
    }
    return;
  }
  const s = await getSettings();
  const text = settingsText(s);
  const kb = settingsKb(s);
  if (edit) await ctx.editMessageText(text, { reply_markup: kb });
  else await ctx.reply(text, { reply_markup: kb });
}

composer.callbackQuery("settings:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await showSettings(ctx, true);
});

composer.callbackQuery("settings:toggle_email", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isAdmin(ctx.from?.id))) {
    await ctx.editMessageText(DENIED);
    return;
  }
  const s = await getSettings();
  await updateSettings({ email_matching: !s.email_matching });
  await showSettings(ctx, true);
});

composer.callbackQuery("settings:retries_up", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isAdmin(ctx.from?.id))) return;
  const s = await getSettings();
  await updateSettings({ max_retries: Math.min(10, s.max_retries + 1) });
  await showSettings(ctx, true);
});

composer.callbackQuery("settings:retries_down", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isAdmin(ctx.from?.id))) return;
  const s = await getSettings();
  await updateSettings({ max_retries: Math.max(1, s.max_retries - 1) });
  await showSettings(ctx, true);
});

composer.callbackQuery("settings:retention", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isAdmin(ctx.from?.id))) return;
  ctx.session.step = "awaiting_retention";
  ctx.session.expiresAt = now() + FLOW_TTL_MS;
  await ctx.editMessageText(
    "Send the retention period in days (1–365). Default is 30. Older job data is purged automatically.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Cancel", "settings:show")],
      ]),
    },
  );
});

composer.callbackQuery("settings:add_admin", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isAdmin(ctx.from?.id))) return;
  ctx.session.step = "awaiting_admin_id";
  ctx.session.expiresAt = now() + FLOW_TTL_MS;
  await ctx.editMessageText(
    "To add an admin, have them open this bot first, then send their numeric Telegram user id.\n\n" +
      "Tip: they can learn their id from @userinfobot. Prefer sharing an invite link so they /start first.",
    {
      reply_markup: inlineKeyboard([[inlineButton("Cancel", "settings:show")]]),
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (step !== "awaiting_retention" && step !== "awaiting_admin_id") {
    return next();
  }
  if (!(await isAdmin(ctx.from?.id))) {
    ctx.session.step = "idle";
    await ctx.reply(DENIED);
    return;
  }
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    ctx.session.step = "idle";
    return next();
  }

  if (step === "awaiting_retention") {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      await ctx.reply("Send a whole number of days between 1 and 365.");
      return;
    }
    await updateSettings({ retention_days: n });
    ctx.session.step = "idle";
    ctx.session.expiresAt = undefined;
    await ctx.reply(`Retention set to ${n} days.`);
    await showSettings(ctx, false);
    return;
  }

  // awaiting_admin_id — only add ids of users who already started (registered).
  const id = Number(text);
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.reply("Send a numeric Telegram user id (digits only).");
    return;
  }
  const s = await getSettings();
  if (!s.admin_ids.includes(id)) {
    await updateSettings({ admin_ids: [...s.admin_ids, id] });
  }
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  await ctx.reply(
    `Admin id ${id} saved. They must have started this bot before using admin features.`,
  );
  await showSettings(ctx, false);
});

export default composer;
