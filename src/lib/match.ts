/**
 * Match CSV identifiers to Telegram users who have started the bot
 * (username and optional email). Unmatched identifiers become failed records.
 */

import {
  findUserByIdentifier,
  getSettings,
  looksLikeEmail,
  normalizeUsername,
  type RegisteredUser,
} from "./store.js";
import type { Api } from "grammy";

export interface MatchResult {
  telegram_user_id: number | null;
  failure_reason: string | null;
  matched_via: "username" | "email" | "getChat" | null;
}

/**
 * Resolve one identifier. Prefers registry (users who /start'd). Falls back
 * to getChat(@username) for public usernames; still cannot DM users who never
 * started the bot — that surfaces as a delivery 403 later.
 */
export async function matchIdentifier(
  api: Api,
  identifier: string,
  emailMatching: boolean,
): Promise<MatchResult> {
  const reg = await findUserByIdentifier(identifier, emailMatching);
  if (reg) {
    return {
      telegram_user_id: reg.user_id,
      failure_reason: null,
      matched_via: reg.email && looksLikeEmail(identifier) ? "email" : "username",
    };
  }

  // Email with no registry hit
  if (looksLikeEmail(identifier)) {
    if (!emailMatching) {
      return {
        telegram_user_id: null,
        failure_reason: "Email matching is disabled",
        matched_via: null,
      };
    }
    return {
      telegram_user_id: null,
      failure_reason: "No registered student with that email — they must /start and link email",
      matched_via: null,
    };
  }

  // Try Telegram getChat for public @username
  const uname = normalizeUsername(identifier);
  if (!uname) {
    return {
      telegram_user_id: null,
      failure_reason: "Empty identifier",
      matched_via: null,
    };
  }
  try {
    const chat = await api.getChat(`@${uname}`);
    if (chat && "id" in chat && typeof chat.id === "number") {
      return {
        telegram_user_id: chat.id,
        failure_reason: null,
        matched_via: "getChat",
      };
    }
  } catch {
    // getChat fails for private / unknown usernames
  }

  return {
    telegram_user_id: null,
    failure_reason: "No Telegram user found for that identifier",
    matched_via: null,
  };
}

export async function matchAll(
  api: Api,
  identifiers: string[],
): Promise<MatchResult[]> {
  const settings = await getSettings();
  const out: MatchResult[] = [];
  // Prefer first match when both username and email would resolve (dedupe by
  // processing rows independently; same Telegram user can appear twice).
  const seenUsers = new Map<number, string>();

  for (const id of identifiers) {
    const m = await matchIdentifier(api, id, settings.email_matching);
    if (m.telegram_user_id != null) {
      const prev = seenUsers.get(m.telegram_user_id);
      if (prev && prev !== id) {
        // Same Telegram user matched by username earlier and email now (or vice versa).
        // Keep the match; delivery will send once per row as specified by CSV.
      }
      seenUsers.set(m.telegram_user_id, id);
    }
    out.push(m);
  }
  return out;
}

export type { RegisteredUser };
