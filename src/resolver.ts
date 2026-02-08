import type {
  Chat,
  ChatAttendee,
  ContactCandidate,
  ContactResolution,
  QmdQueryResult
} from "./types.js";

const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_MARGIN = 0.15;
const DEFAULT_MAX_CANDIDATES = 5;

/** Normalizes strings for fuzzy matching across user input and provider data. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenizes normalized strings for overlap-based lexical scoring. */
function tokenize(value: string): string[] {
  const cleaned = normalize(value);
  return cleaned.length > 0 ? cleaned.split(" ") : [];
}

/** Computes lexical relevance score and match reasons for a single attendee. */
function lexicalScore(query: string, attendee: ChatAttendee): { score: number; matchedBy: string[] } {
  const matchedBy: string[] = [];
  const queryNorm = normalize(query);
  const nameNorm = normalize(attendee.name);
  const attendeeIdNorm = normalize(attendee.id);
  const providerIdNorm = normalize(attendee.provider_id);

  if (queryNorm.length === 0) {
    return { score: 0, matchedBy };
  }

  if (queryNorm === attendeeIdNorm || queryNorm === providerIdNorm) {
    matchedBy.push("exact_id");
    return { score: 1, matchedBy };
  }

  if (providerIdNorm.includes(queryNorm)) {
    matchedBy.push("provider_id_contains");
    return { score: 0.95, matchedBy };
  }

  if (nameNorm === queryNorm) {
    matchedBy.push("exact_name");
    return { score: 0.94, matchedBy };
  }

  if (nameNorm.includes(queryNorm)) {
    matchedBy.push("name_contains");
    return { score: 0.9, matchedBy };
  }

  const queryTokens = tokenize(query);
  const nameTokens = tokenize(attendee.name);

  if (queryTokens.length === 0 || nameTokens.length === 0) {
    return { score: 0, matchedBy };
  }

  const nameTokenSet = new Set(nameTokens);
  const overlapCount = queryTokens.filter((token) => nameTokenSet.has(token)).length;

  if (overlapCount === 0) {
    return { score: 0, matchedBy };
  }

  const recall = overlapCount / queryTokens.length;
  const precision = overlapCount / nameTokens.length;
  const overlapScore = (2 * recall * precision) / (recall + precision);

  matchedBy.push("token_overlap");
  return { score: overlapScore * 0.88, matchedBy };
}

/** Builds recency scores per attendee provider id from chat timestamps. */
function buildRecencyScoreByProviderId(chats: Chat[]): Map<string, number> {
  const rawMap = new Map<string, number>();

  for (const chat of chats) {
    const providerId = chat.attendee_provider_id;
    if (!providerId) {
      continue;
    }

    const timestamp = chat.timestamp ? Date.parse(chat.timestamp) : Number.NaN;
    if (Number.isNaN(timestamp)) {
      continue;
    }

    const current = rawMap.get(providerId);
    if (!current || timestamp > current) {
      rawMap.set(providerId, timestamp);
    }
  }

  if (rawMap.size === 0) {
    return new Map<string, number>();
  }

  const values = Array.from(rawMap.values());
  const min = Math.min(...values);
  const max = Math.max(...values);

  const normalized = new Map<string, number>();
  for (const [providerId, value] of rawMap.entries()) {
    if (max === min) {
      normalized.set(providerId, 0.5);
      continue;
    }

    normalized.set(providerId, (value - min) / (max - min));
  }

  return normalized;
}

/** Computes a light semantic boost from QMD query hits. */
function qmdBoost(attendee: ChatAttendee, qmdResult: QmdQueryResult): number {
  if (!qmdResult.available || qmdResult.hits.length === 0) {
    return 0;
  }

  const name = normalize(attendee.name);
  const providerId = normalize(attendee.provider_id);

  let best = 0;

  for (const hit of qmdResult.hits) {
    const haystack = normalize(`${hit.text} ${hit.source ?? ""}`);

    if (providerId.length > 0 && haystack.includes(providerId)) {
      best = Math.max(best, 1);
      continue;
    }

    if (name.length > 0 && haystack.includes(name)) {
      best = Math.max(best, 0.8);
      continue;
    }

    const nameTokens = tokenize(attendee.name);
    if (nameTokens.length > 0) {
      const overlap = nameTokens.filter((token) => haystack.includes(token)).length;
      const ratio = overlap / nameTokens.length;
      best = Math.max(best, ratio * 0.6);
    }
  }

  return best;
}

/** Produces ranked contact candidates with lexical, recency, and QMD components. */
export function rankContacts(
  query: string,
  attendees: ChatAttendee[],
  chats: Chat[],
  qmdResult: QmdQueryResult
): ContactCandidate[] {
  const recencyByProviderId = buildRecencyScoreByProviderId(chats);

  const ranked = attendees
    .filter((attendee) => attendee.is_self !== 1)
    .map((attendee) => {
      const lexical = lexicalScore(query, attendee);
      const recencyScore = recencyByProviderId.get(attendee.provider_id) ?? 0;
      const qmdScore = qmdBoost(attendee, qmdResult);
      const totalScore = lexical.score * 0.75 + recencyScore * 0.15 + qmdScore * 0.1;

      const matchedBy = [...lexical.matchedBy];
      if (recencyScore >= 0.65) {
        matchedBy.push("recent_chat");
      }
      if (qmdScore >= 0.5) {
        matchedBy.push("qmd_context");
      }

      return {
        attendee,
        lexicalScore: lexical.score,
        recencyScore,
        qmdScore,
        totalScore,
        matchedBy
      } as ContactCandidate;
    })
    .sort((left, right) => right.totalScore - left.totalScore);

  return ranked;
}

/** Resolves a query to one contact or returns ambiguous/not_found with candidates. */
export function resolveContacts(
  query: string,
  attendees: ChatAttendee[],
  chats: Chat[],
  qmdResult: QmdQueryResult,
  options: {
    threshold?: number;
    margin?: number;
    maxCandidates?: number;
  } = {}
): ContactResolution {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const ranked = rankContacts(query, attendees, chats, qmdResult).slice(0, maxCandidates);
  const top = ranked[0];
  const second = ranked[1];

  if (!top || top.totalScore < 0.35) {
    return {
      query,
      status: "not_found",
      candidates: ranked,
      threshold,
      margin
    };
  }

  const delta = second ? top.totalScore - second.totalScore : top.totalScore;

  if (top.totalScore >= threshold && delta >= margin) {
    return {
      query,
      status: "resolved",
      selected: top,
      candidates: ranked,
      threshold,
      margin
    };
  }

  return {
    query,
    status: "ambiguous",
    selected: top,
    candidates: ranked,
    threshold,
    margin
  };
}
