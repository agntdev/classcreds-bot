import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "How this bot works\n\n" +
  "Teachers upload a CSV of student logins and passwords. The bot matches " +
  "each identifier to a Telegram user who has started the bot, then sends " +
  "credentials in a private message.\n\n" +
  "Students: tap /start, then Link email if your school matches by email.\n" +
  "Admins: use Upload CSV, Last job, and Failure report from the menu.\n\n" +
  "CSV format (header required):\n" +
  "identifier,password\n" +
  "@username,secret\n" +
  "student@school.edu,secret";

const backToMenu = inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;
