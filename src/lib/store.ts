/**
 * Durable domain store for upload jobs, student records, registered users,
 * and owner settings. Backed by the toolkit's StorageAdapter (Redis when
 * REDIS_URL is set, in-memory for dev/test). Uses explicit index keys —
 * never KEYS/SCAN/readAll.
 */

import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import { defaultRedisStorage } from "../toolkit/session/redis.js";
import { now } from "./clock.js";
import { encryptPassword, decryptPassword } from "./crypto.js";

// ─── domain types ───────────────────────────────────────────────────────────

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface UploadJob {
  id: string;
  uploader_id: number;
  timestamp: number;
  total_records: number;
  success_count: number;
  failure_count: number;
  status: "processing" | "complete";
}

export interface StudentRecord {
  id: string;
  job_id: string;
  identifier: string;
  /** AES-GCM ciphertext — never plaintext. */
  password_enc: string;
  telegram_user_id: number | null;
  delivery_status: DeliveryStatus;
  failure_reason: string | null;
  created_at: number;
}

export interface RegisteredUser {
  user_id: number;
  chat_id: number;
  username: string | null;
  email: string | null;
  first_name: string;
  started_at: number;
}

export interface OwnerSettings {
  /** Max delivery attempts per record (including the first try). */
  max_retries: number;
  /** Base delay between delivery attempts in ms. */
  retry_delay_ms: number;
  /** Pause between successful sends (rate limit) in ms. */
  rate_limit_ms: number;
  /** Days to retain job + record data (default 30). */
  retention_days: number;
  /** When true, match CSV identifiers that look like emails. */
  email_matching: boolean;
  /** Admin Telegram user ids (runtime override of env whitelist). */
  admin_ids: number[];
}

export const DEFAULT_SETTINGS: OwnerSettings = {
  max_retries: 3,
  retry_delay_ms: 500,
  rate_limit_ms: 50,
  retention_days: 30,
  email_matching: true,
  admin_ids: [],
};

// ─── adapter + keys ─────────────────────────────────────────────────────────

type Json = unknown;

const K = {
  settings: "settings:global",
  user: (id: number) => `user:${id}`,
  username: (u: string) => `index:username:${u}`,
  email: (e: string) => `index:email:${e}`,
  job: (id: string) => `job:${id}`,
  jobRecords: (jobId: string) => `job:${jobId}:records`,
  record: (jobId: string, recId: string) => `record:${jobId}:${recId}`,
  lastJob: (userId: number) => `user:${userId}:lastJob`,
  uploaderJobs: (userId: number) => `jobIndex:uploader:${userId}`,
  seq: "seq:ids",
};

let adapter: StorageAdapter<Json> | null = null;

function resolveAdapter(): StorageAdapter<Json> {
  if (adapter) return adapter;
  const url =
    typeof process !== "undefined" ? process.env.REDIS_URL?.trim() : undefined;
  // defaultRedisStorage lazy-loads ioredis on first op (Node only).
  adapter = url
    ? (defaultRedisStorage<Json>(url) as StorageAdapter<Json>)
    : new MemorySessionStorage<Json>();
  return adapter;
}

/** Test / harness: wipe all durable state and force a fresh memory adapter. */
export function resetStore(): void {
  adapter = new MemorySessionStorage<Json>();
}

/** Inject a custom adapter (tests). */
export function setStoreAdapter(a: StorageAdapter<Json>): void {
  adapter = a;
}

async function read<T>(key: string): Promise<T | undefined> {
  const v = await resolveAdapter().read(key);
  return v as T | undefined;
}

async function write(key: string, value: Json): Promise<void> {
  await resolveAdapter().write(key, value);
}

async function del(key: string): Promise<void> {
  await resolveAdapter().delete(key);
}

async function nextId(prefix: string): Promise<string> {
  const cur = (await read<number>(K.seq)) ?? 0;
  const n = cur + 1;
  await write(K.seq, n);
  return `${prefix}_${n}`;
}

// ─── settings ───────────────────────────────────────────────────────────────

export async function getSettings(): Promise<OwnerSettings> {
  const s = await read<OwnerSettings>(K.settings);
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function updateSettings(
  patch: Partial<OwnerSettings>,
): Promise<OwnerSettings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await write(K.settings, next);
  return next;
}

// ─── registered users (opt-in on /start) ────────────────────────────────────

export function normalizeUsername(u: string): string {
  return u.replace(/^@/, "").trim().toLowerCase();
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function upsertRegisteredUser(input: {
  user_id: number;
  chat_id: number;
  username?: string | null;
  first_name: string;
}): Promise<RegisteredUser> {
  const existing = await read<RegisteredUser>(K.user(input.user_id));
  const username = input.username
    ? normalizeUsername(input.username)
    : (existing?.username ?? null);

  if (existing?.username && existing.username !== username) {
    await del(K.username(existing.username));
  }

  const user: RegisteredUser = {
    user_id: input.user_id,
    chat_id: input.chat_id,
    username,
    email: existing?.email ?? null,
    first_name: input.first_name,
    started_at: existing?.started_at ?? now(),
  };
  await write(K.user(input.user_id), user);
  if (username) await write(K.username(username), input.user_id);
  return user;
}

export async function setUserEmail(
  userId: number,
  email: string,
): Promise<RegisteredUser | null> {
  const user = await read<RegisteredUser>(K.user(userId));
  if (!user) return null;
  const normalized = normalizeEmail(email);
  if (user.email && user.email !== normalized) {
    await del(K.email(user.email));
  }
  user.email = normalized;
  await write(K.user(userId), user);
  await write(K.email(normalized), userId);
  return user;
}

export async function getUser(userId: number): Promise<RegisteredUser | undefined> {
  return read<RegisteredUser>(K.user(userId));
}

export async function findUserByIdentifier(
  identifier: string,
  emailMatching: boolean,
): Promise<RegisteredUser | null> {
  const raw = identifier.trim();
  if (emailMatching && looksLikeEmail(raw)) {
    const id = await read<number>(K.email(normalizeEmail(raw)));
    if (id != null) {
      const u = await getUser(id);
      if (u) return u;
    }
    return null;
  }
  const uname = normalizeUsername(raw);
  const id = await read<number>(K.username(uname));
  if (id != null) {
    const u = await getUser(id);
    if (u) return u;
  }
  return null;
}

// ─── jobs + records ─────────────────────────────────────────────────────────

export async function createJob(
  uploaderId: number,
  rows: Array<{ identifier: string; password: string }>,
  matches: Array<{ telegram_user_id: number | null; failure_reason: string | null }>,
): Promise<{ job: UploadJob; records: StudentRecord[] }> {
  const jobId = await nextId("job");
  const ts = now();
  const records: StudentRecord[] = [];
  const recordIds: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const match = matches[i]!;
    const recId = await nextId("rec");
    const rec: StudentRecord = {
      id: recId,
      job_id: jobId,
      identifier: row.identifier,
      password_enc: await encryptPassword(row.password),
      telegram_user_id: match.telegram_user_id,
      delivery_status: match.telegram_user_id ? "pending" : "failed",
      failure_reason: match.failure_reason,
      created_at: ts,
    };
    records.push(rec);
    recordIds.push(recId);
    await write(K.record(jobId, recId), rec);
  }

  const job: UploadJob = {
    id: jobId,
    uploader_id: uploaderId,
    timestamp: ts,
    total_records: records.length,
    success_count: 0,
    failure_count: records.filter((r) => r.delivery_status === "failed").length,
    status: "processing",
  };
  await write(K.job(jobId), job);
  await write(K.jobRecords(jobId), recordIds);
  await write(K.lastJob(uploaderId), jobId);

  const idx = (await read<string[]>(K.uploaderJobs(uploaderId))) ?? [];
  idx.push(jobId);
  await write(K.uploaderJobs(uploaderId), idx);

  return { job, records };
}

export async function getJob(jobId: string): Promise<UploadJob | undefined> {
  return read<UploadJob>(K.job(jobId));
}

export async function getLastJob(uploaderId: number): Promise<UploadJob | undefined> {
  const id = await read<string>(K.lastJob(uploaderId));
  if (!id) return undefined;
  return getJob(id);
}

export async function getJobRecords(jobId: string): Promise<StudentRecord[]> {
  const ids = (await read<string[]>(K.jobRecords(jobId))) ?? [];
  const out: StudentRecord[] = [];
  for (const id of ids) {
    const r = await read<StudentRecord>(K.record(jobId, id));
    if (r) out.push(r);
  }
  return out;
}

export async function updateRecord(rec: StudentRecord): Promise<void> {
  await write(K.record(rec.job_id, rec.id), rec);
}

export async function updateJob(job: UploadJob): Promise<void> {
  await write(K.job(job.id), job);
}

export async function getPasswordPlain(rec: StudentRecord): Promise<string> {
  return decryptPassword(rec.password_enc);
}

export async function getFailedRecords(jobId: string): Promise<StudentRecord[]> {
  const all = await getJobRecords(jobId);
  return all.filter((r) => r.delivery_status === "failed");
}

// ─── retention / purge ──────────────────────────────────────────────────────

/**
 * Purge jobs (and their records) older than retention_days for one uploader.
 * Walks the uploader's job index only — no keyspace scan.
 */
export async function purgeExpiredForUploader(
  uploaderId: number,
  retentionDays?: number,
): Promise<number> {
  const settings = await getSettings();
  const days = retentionDays ?? settings.retention_days;
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const ids = (await read<string[]>(K.uploaderJobs(uploaderId))) ?? [];
  const kept: string[] = [];
  let purged = 0;
  let lastJobId: string | undefined = await read<string>(K.lastJob(uploaderId));

  for (const jobId of ids) {
    const job = await getJob(jobId);
    if (!job) continue;
    if (job.timestamp < cutoff) {
      const recIds = (await read<string[]>(K.jobRecords(jobId))) ?? [];
      for (const rid of recIds) await del(K.record(jobId, rid));
      await del(K.jobRecords(jobId));
      await del(K.job(jobId));
      purged++;
      if (lastJobId === jobId) lastJobId = undefined;
    } else {
      kept.push(jobId);
    }
  }

  await write(K.uploaderJobs(uploaderId), kept);
  if (lastJobId) await write(K.lastJob(uploaderId), lastJobId);
  else await del(K.lastJob(uploaderId));
  return purged;
}
