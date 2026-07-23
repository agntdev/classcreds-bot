import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  looksLikeEmail,
  setUserEmail,
  upsertRegisteredUser,
} from "../lib/store.js";
import { now } from "../lib/clock.js";

registerMainMenuItem({ label: "Link email", data: "register:email", order: 40 });

const composer = new Composer<Ctx>();

const FLOW_TTL_MS = 10 * 60 * 1000;

const backKb = inlineKeyboard([
  [inlineButton("Cancel", "register:cancel")],
  [inlineButton("Back to menu", "menu:main")],
]);

function enterEmail(ctx: Ctx): void {
  ctx.session.step = "awaiting_email";
  ctx.session.expiresAt = now() + FLOW_TTL_MS;
}

composer.callbackQuery("register:email", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from && ctx.chat) {
    await upsertRegisteredUser({
      user_id: ctx.from.id,
      chat_id: ctx.chat.id,
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? "User",
    });
  }
  enterEmail(ctx);
  await ctx.editMessageText(
    "Send your school email address. We'll use it only to match credentials from your teacher.",
    { reply_markup: backKb },
  );
});

composer.callbackQuery("register:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  await ctx.editMessageText("Email linking cancelled. Tap /start for the menu.", {
    reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]),
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_email") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    ctx.session.step = "idle";
    ctx.session.expiresAt = undefined;
    return next();
  }
  if (!looksLikeEmail(text)) {
    await ctx.reply(
      "That doesn't look like an email. Send something like name@school.edu, or tap Cancel.",
      { reply_markup: backKb },
    );
    return;
  }
  if (!ctx.from) {
    await ctx.reply("Couldn't identify you. Tap /start and try again.");
    return;
  }
  if (ctx.chat) {
    await upsertRegisteredUser({
      user_id: ctx.from.id,
      chat_id: ctx.chat.id,
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? "User",
    });
  }
  const user = await setUserEmail(ctx.from.id, text);
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  if (!user) {
    await ctx.reply("Tap /start first so we can register you, then link your email.");
    return;
  }
  await ctx.reply(
    `Email linked: ${user.email}\n\nYour teacher can now match credentials to this account.`,
    { reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]) },
  );
});

export default composer;
