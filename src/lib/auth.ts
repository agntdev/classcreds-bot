/**
 * Admin whitelist: env ADMIN_USER_IDS (comma-separated Telegram ids) plus
 * runtime overrides in durable owner settings. Empty whitelist = open access
 * (dev / harness). Production owners should set ADMIN_USER_IDS.
 */

import { getSettings } from "./store.js";

function envAdminIds(): number[] {
  const raw =
    typeof process !== "undefined" ? process.env.ADMIN_USER_IDS?.trim() : undefined;
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** True when the user may run admin actions (upload, status, settings, reports). */
export async function isAdmin(userId: number | undefined): Promise<boolean> {
  if (userId == null) return false;
  const settings = await getSettings();
  const ids = new Set<number>([...envAdminIds(), ...settings.admin_ids]);
  if (ids.size === 0) return true; // open mode when no whitelist configured
  return ids.has(userId);
}

export async function listAdminIds(): Promise<number[]> {
  const settings = await getSettings();
  return [...new Set([...envAdminIds(), ...settings.admin_ids])];
}
