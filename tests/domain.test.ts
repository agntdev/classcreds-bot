import { describe, it, expect, beforeEach } from "vitest";
import { parseCredentialCsv, buildFailureCsv } from "../src/lib/csv.js";
import {
  resetStore,
  createJob,
  getLastJob,
  getFailedRecords,
  getPasswordPlain,
  purgeExpiredForUploader,
  updateSettings,
  getSettings,
  upsertRegisteredUser,
  setUserEmail,
  findUserByIdentifier,
  DEFAULT_SETTINGS,
} from "../src/lib/store.js";
import { setNow } from "../src/lib/clock.js";
import { encryptPassword, decryptPassword, resetCryptoCache } from "../src/lib/crypto.js";
import { deliverJob } from "../src/lib/delivery.js";
import { isAdmin } from "../src/lib/auth.js";
import type { Api } from "grammy";

beforeEach(() => {
  resetStore();
  resetCryptoCache();
  setNow(undefined);
  delete process.env.ADMIN_USER_IDS;
});

describe("CSV parsing", () => {
  it("accepts valid header + rows", () => {
    const r = parseCredentialCsv("identifier,password\n@a,p1\nb@e.com,p2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0]).toEqual({ identifier: "@a", password: "p1" });
    }
  });

  it("rejects missing header", () => {
    const r = parseCredentialCsv("alice,secret\nbob,x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/header/i);
  });

  it("rejects wrong column count", () => {
    const r = parseCredentialCsv("identifier,password,extra\na,b,c");
    expect(r.ok).toBe(false);
  });

  it("builds failure csv", () => {
    const csv = buildFailureCsv([
      { identifier: "@x", failure_reason: "No match" },
    ]);
    expect(csv).toContain("identifier,failure_reason");
    expect(csv).toContain("@x");
  });
});

describe("crypto", () => {
  it("round-trips passwords and never stores plaintext form", async () => {
    const enc = await encryptPassword("hunter2");
    expect(enc).not.toContain("hunter2");
    expect(await decryptPassword(enc)).toBe("hunter2");
  });
});

describe("store + purge", () => {
  it("creates job with encrypted passwords", async () => {
    const { job, records } = await createJob(
      1,
      [{ identifier: "@a", password: "secret" }],
      [{ telegram_user_id: 9, failure_reason: null }],
    );
    expect(job.total_records).toBe(1);
    expect(records[0]!.password_enc).not.toContain("secret");
    expect(await getPasswordPlain(records[0]!)).toBe("secret");
    expect((await getLastJob(1))?.id).toBe(job.id);
  });

  it("purges jobs older than retention (30 days default)", async () => {
    const t0 = 1_700_000_000_000;
    setNow(() => t0);
    await createJob(
      42,
      [{ identifier: "@old", password: "p" }],
      [{ telegram_user_id: null, failure_reason: "x" }],
    );
    // 31 days later
    setNow(() => t0 + 31 * 24 * 60 * 60 * 1000);
    const n = await purgeExpiredForUploader(42, 30);
    expect(n).toBe(1);
    expect(await getLastJob(42)).toBeUndefined();
  });

  it("keeps jobs inside retention window", async () => {
    const t0 = 1_700_000_000_000;
    setNow(() => t0);
    await createJob(
      42,
      [{ identifier: "@new", password: "p" }],
      [{ telegram_user_id: null, failure_reason: "x" }],
    );
    setNow(() => t0 + 5 * 24 * 60 * 60 * 1000);
    const n = await purgeExpiredForUploader(42, 30);
    expect(n).toBe(0);
    expect(await getLastJob(42)).toBeDefined();
  });

  it("matches username and email via registry", async () => {
    await upsertRegisteredUser({
      user_id: 7,
      chat_id: 7,
      username: "alice",
      first_name: "A",
    });
    await setUserEmail(7, "alice@school.edu");
    const byUser = await findUserByIdentifier("@alice", true);
    const byEmail = await findUserByIdentifier("alice@school.edu", true);
    expect(byUser?.user_id).toBe(7);
    expect(byEmail?.user_id).toBe(7);
  });
});

describe("delivery retry", () => {
  it("retries transient failures then succeeds", async () => {
    let attempts = 0;
    const api = {
      sendMessage: async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("429: Too Many Requests") as Error & {
            error_code: number;
            parameters: { retry_after: number };
          };
          err.error_code = 429;
          err.parameters = { retry_after: 0 };
          throw err;
        }
        return { message_id: 1 };
      },
    } as unknown as Api;

    await updateSettings({ max_retries: 3, retry_delay_ms: 1, rate_limit_ms: 0 });
    const { job, records } = await createJob(
      1,
      [{ identifier: "@s", password: "pw" }],
      [{ telegram_user_id: 99, failure_reason: null }],
    );
    const final = await deliverJob(api, job, records, {
      settings: await getSettings(),
      sleepFn: async () => {},
    });
    expect(attempts).toBe(3);
    expect(final.success_count).toBe(1);
    expect(final.failure_count).toBe(0);
  });

  it("does not abort batch on 403", async () => {
    const api = {
      sendMessage: async (chatId: number) => {
        if (chatId === 1) {
          const err = new Error("403: Forbidden: bot was blocked by the user") as Error & {
            error_code: number;
          };
          err.error_code = 403;
          throw err;
        }
        return { message_id: 1 };
      },
    } as unknown as Api;

    await updateSettings({ max_retries: 2, retry_delay_ms: 1, rate_limit_ms: 0 });
    const { job, records } = await createJob(
      1,
      [
        { identifier: "@blocked", password: "a" },
        { identifier: "@ok", password: "b" },
      ],
      [
        { telegram_user_id: 1, failure_reason: null },
        { telegram_user_id: 2, failure_reason: null },
      ],
    );
    const final = await deliverJob(api, job, records, {
      settings: await getSettings(),
      sleepFn: async () => {},
    });
    expect(final.success_count).toBe(1);
    expect(final.failure_count).toBe(1);
    const failed = await getFailedRecords(job.id);
    expect(failed[0]!.failure_reason).toMatch(/blocked/i);
  });
});

describe("admin whitelist", () => {
  it("allows all when whitelist empty", async () => {
    expect(await isAdmin(1)).toBe(true);
  });

  it("enforces ADMIN_USER_IDS", async () => {
    process.env.ADMIN_USER_IDS = "10,20";
    expect(await isAdmin(10)).toBe(true);
    expect(await isAdmin(99)).toBe(false);
  });

  it("honors runtime admin_ids from settings", async () => {
    process.env.ADMIN_USER_IDS = "10";
    await updateSettings({ admin_ids: [55] });
    expect(await isAdmin(55)).toBe(true);
    expect(await isAdmin(11)).toBe(false);
  });

  it("default retention is 30 days", async () => {
    expect((await getSettings()).retention_days).toBe(DEFAULT_SETTINGS.retention_days);
  });

  it("denies /upload when user is not whitelisted", async () => {
    process.env.ADMIN_USER_IDS = "999";
    const { buildBot } = await import("../src/bot.js");
    const { runSpecs, parseBotSpec } = await import("../src/toolkit/index.js");
    const suite = await runSpecs(
      () => buildBot("test-token", { resetDurableStore: true }),
      [
        parseBotSpec({
          name: "non-admin upload denied",
          steps: [
            {
              send: { text: "/upload", userId: 1, chatId: 1 },
              expect: [
                {
                  method: "sendMessage",
                  payload: {
                    text: "You don't have permission to upload. Ask the bot owner to add your Telegram id to the admin whitelist.",
                  },
                },
              ],
            },
          ],
        }),
      ],
    );
    expect(suite.failed).toBe(0);
  });
});
