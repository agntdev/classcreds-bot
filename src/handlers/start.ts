import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import { upsertRegisteredUser, purgeExpiredForUploader } from "../lib/store.js";
import { isAdmin } from "../lib/auth.js";

const composer = new Composer<Ctx>();

export const WELCOME_ADMIN =
  "Student Credential Distributor\n\n" +
  "Upload a CSV to send private credentials, then review delivery status.\n" +
  "Tap a button below to begin.";

export const WELCOME_STUDENT =
  "Student Credential Distributor\n\n" +
  "You're registered. Link your school email so your teacher can reach you with credentials.\n" +
  "Tap a button below.";

async function registerFromCtx(ctx: Ctx): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  await upsertRegisteredUser({
    user_id: ctx.from.id,
    chat_id: ctx.chat.id,
    username: ctx.from.username ?? null,
    first_name: ctx.from.first_name ?? "User",
  });
  // Best-effort retention sweep for this user's own jobs (admins).
  try {
    await purgeExpiredForUploader(ctx.from.id);
  } catch {
    /* ignore */
  }
}

composer.command("start", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  await registerFromCtx(ctx);
  const admin = await isAdmin(ctx.from?.id);
  await ctx.reply(admin ? WELCOME_ADMIN : WELCOME_STUDENT, {
    reply_markup: mainMenuKeyboard(),
  });
});

composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.expiresAt = undefined;
  await registerFromCtx(ctx);
  const admin = await isAdmin(ctx.from?.id);
  await ctx.editMessageText(admin ? WELCOME_ADMIN : WELCOME_STUDENT, {
    reply_markup: mainMenuKeyboard(),
  });
});

export default composer;
