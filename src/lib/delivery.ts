/**
 * Credential delivery: rate-limited sends with retry for transient failures.
 * Tolerates 403 (user blocked / never started) without aborting the batch.
 */

import type { Api } from "grammy";
import {
  type StudentRecord,
  type UploadJob,
  type OwnerSettings,
  getPasswordPlain,
  updateRecord,
  updateJob,
  getSettings,
} from "./store.js";

export interface DeliveryProgress {
  done: number;
  total: number;
  success: number;
  failure: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function isTransient(err: unknown): boolean {
  const e = err as { error_code?: number; parameters?: { retry_after?: number } };
  if (e?.error_code === 429) return true;
  if (e?.error_code && e.error_code >= 500) return true;
  const msg = String((err as Error)?.message ?? err);
  return /429|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
}

function isForbidden(err: unknown): boolean {
  const e = err as { error_code?: number };
  if (e?.error_code === 403) return true;
  return /403|blocked|bot was blocked|can't initiate/i.test(
    String((err as Error)?.message ?? err),
  );
}

function retryAfterMs(err: unknown, fallback: number): number {
  const e = err as { parameters?: { retry_after?: number } };
  if (e?.parameters?.retry_after != null) {
    return Math.max(fallback, e.parameters.retry_after * 1000);
  }
  return fallback;
}

function credentialMessage(identifier: string, password: string): string {
  return (
    "Your school credentials\n\n" +
    `Login: ${identifier}\n` +
    `Password: ${password}\n\n` +
    "Keep this message private. Change the password after first sign-in if your school requires it."
  );
}

/**
 * Deliver pending records for a job. Updates each record and final job counts.
 * Calls onProgress after each record (for real-time admin updates).
 */
export async function deliverJob(
  api: Api,
  job: UploadJob,
  records: StudentRecord[],
  opts?: {
    settings?: OwnerSettings;
    onProgress?: (p: DeliveryProgress) => Promise<void> | void;
    /** Inject sleep for tests (default real sleep). */
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<UploadJob> {
  const settings = opts?.settings ?? (await getSettings());
  const wait = opts?.sleepFn ?? sleep;
  let success = 0;
  let failure = job.failure_count; // already-failed (unmatched) count
  let done = 0;
  const total = records.length;

  for (const rec of records) {
    if (rec.delivery_status === "failed" && !rec.telegram_user_id) {
      done++;
      if (opts?.onProgress) {
        await opts.onProgress({ done, total, success, failure });
      }
      continue;
    }
    if (rec.delivery_status === "delivered") {
      success++;
      done++;
      continue;
    }

    const chatId = rec.telegram_user_id!;
    let delivered = false;
    let lastReason = "Delivery failed";

    let password: string;
    try {
      password = await getPasswordPlain(rec);
    } catch {
      rec.delivery_status = "failed";
      rec.failure_reason = "Could not decrypt stored password";
      failure++;
      done++;
      await updateRecord(rec);
      if (opts?.onProgress) {
        await opts.onProgress({ done, total, success, failure });
      }
      continue;
    }

    for (let attempt = 1; attempt <= settings.max_retries; attempt++) {
      try {
        await api.sendMessage(chatId, credentialMessage(rec.identifier, password));
        delivered = true;
        break;
      } catch (err) {
        if (isForbidden(err)) {
          lastReason = "User blocked the bot or never started it";
          break;
        }
        if (isTransient(err) && attempt < settings.max_retries) {
          await wait(retryAfterMs(err, settings.retry_delay_ms * attempt));
          continue;
        }
        lastReason = isTransient(err)
          ? "Telegram rate limit or temporary error after retries"
          : "Telegram rejected the message";
        break;
      }
    }

    if (delivered) {
      rec.delivery_status = "delivered";
      rec.failure_reason = null;
      // Wipe ciphertext after successful delivery — minimize retained secrets.
      rec.password_enc = "";
      success++;
    } else {
      rec.delivery_status = "failed";
      rec.failure_reason = lastReason;
      failure++;
    }
    await updateRecord(rec);
    done++;
    if (opts?.onProgress) {
      await opts.onProgress({ done, total, success, failure });
    }
    await wait(settings.rate_limit_ms);
  }

  job.success_count = success;
  job.failure_count = failure;
  job.status = "complete";
  await updateJob(job);
  return job;
}

export function formatJobSummary(job: UploadJob): string {
  const when = new Date(job.timestamp).toISOString().slice(0, 16).replace("T", " ");
  return (
    "Delivery summary\n\n" +
    `Job: ${job.id}\n` +
    `Started: ${when} UTC\n` +
    `Total: ${job.total_records}\n` +
    `Delivered: ${job.success_count}\n` +
    `Failed: ${job.failure_count}`
  );
}
