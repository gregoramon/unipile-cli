import type { Chat } from "./types.js";

/** Normalizes provider tokens for matching regardless of case or punctuation. */
export function normalizeProviderToken(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Computes Levenshtein distance for typo-tolerant provider matching. */
export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);

  for (let j = 0; j <= right.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost
      );
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

/** Resolves provider filters with case-insensitive and close-typo tolerance. */
export function resolveProviderFilter(
  input: string,
  availableProviderTypes: string[]
): { requested: string; resolved?: string; hint?: string } {
  const requested = normalizeProviderToken(input);
  if (requested.length === 0) {
    return { requested };
  }

  const canonicalByToken = new Map<string, string>();
  for (const providerType of availableProviderTypes) {
    const token = normalizeProviderToken(providerType);
    if (token.length > 0 && !canonicalByToken.has(token)) {
      canonicalByToken.set(token, providerType);
    }
  }

  const tokens = Array.from(canonicalByToken.keys());
  const canonicalValues = Array.from(canonicalByToken.values());
  const exactCanonical = canonicalByToken.get(requested);
  if (exactCanonical) {
    return { requested, resolved: exactCanonical };
  }

  let best: { token: string; distance: number } | null = null;
  for (const token of tokens) {
    const distance = levenshteinDistance(requested, token);
    if (best === null || distance < best.distance) {
      best = { token, distance };
    }
  }

  if (best && best.distance <= 2) {
    const canonical = canonicalByToken.get(best.token) as string;
    return {
      requested,
      resolved: canonical,
      hint: `Provider "${input}" interpreted as "${canonical}".`
    };
  }

  return {
    requested,
    hint:
      canonicalValues.length > 0
        ? `Unknown provider "${input}". Available types: ${canonicalValues.join(", ")}`
        : `Unknown provider "${input}".`
  };
}

/** Heuristic group detector across providers, with WhatsApp-specific precision. */
export function isGroupChat(chat: Chat): boolean {
  if (typeof chat.is_group === "boolean") {
    return chat.is_group;
  }

  if (chat.account_type === "WHATSAPP") {
    if (chat.provider_id?.endsWith("@g.us")) {
      return true;
    }
    if (chat.provider_id?.endsWith("@s.whatsapp.net")) {
      return false;
    }
    if (chat.type === 1) {
      return true;
    }
    if (chat.type === 0) {
      return false;
    }
  }

  return !chat.attendee_provider_id;
}
