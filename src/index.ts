#!/usr/bin/env node
import { getProfileConfig, loadConfig, saveConfig, upsertProfile } from "./config.js";
import { printResult, formatAccounts, formatChats, formatMessages, formatResolution } from "./format.js";
import { queryQmd } from "./qmd.js";
import { resolveContacts } from "./resolver.js";
import { getProfileApiKey, setProfileApiKey } from "./storage.js";
import type { AppConfig, ChatAttendee, GlobalCliOptions, OutputMode } from "./types.js";
import { UnipileApiError, UnipileClient } from "./unipile.js";

/** Renders CLI usage text. */
function help(): string {
  return [
    "unipile-cli",
    "",
    "Global flags:",
    "  --profile <name>         profile name (default: default)",
    "  --output <text|json>     output mode (default: text)",
    "  --json                   shorthand for --output json",
    "  --non-interactive        no prompts, automation-safe behavior",
    "",
    "Commands:",
    "  auth set --dsn <url> --api-key <key> [--profile <name>] [--qmd-collection <name>] [--qmd-command <bin>]",
    "  auth status",
    "  accounts list [--provider <WHATSAPP|INSTAGRAM|LINKEDIN|...>] [--limit <n>]",
    "  chats list --account-id <id> [--query <text>] [--group-only] [--limit <n>]",
    "  contacts search --account-id <id> --query <text> [--limit <n>] [--max-candidates <n>] [--no-qmd]",
    "  contacts resolve --account-id <id> --query <text> [--threshold <0..1>] [--margin <0..1>] [--no-qmd]",
    "  send --account-id <id> --text <message> [--chat-id <id> | --attendee-id <id> | --to-query <text>] [--attachment <paths>] [--voice-note <file>] [--video <file>] [--typing-duration <ms>] [--no-qmd]",
    "  inbox pull --account-id <id> [--since <ISO8601>] [--limit <n>]",
    "  inbox watch --account-id <id> [--since <ISO8601>] [--limit <n>] [--interval-seconds <n>] [--max-iterations <n>] [--once]",
    "  doctor run [--account-id <id>] [--qmd-query <text>] [--skip-qmd]",
    "",
    "Notes:",
    "  - Core features work without OpenClaw/QMD.",
    "  - QMD is optional and only used to improve contact ranking.",
    ""
  ].join("\n");
}

/** Parses global flags and returns remaining command tokens. */
function parseGlobal(argv: string[]): { global: GlobalCliOptions; rest: string[] } {
  const global: GlobalCliOptions = {
    profile: "default",
    output: "text",
    nonInteractive: false
  };

  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--profile") {
      global.profile = argv[index + 1] ?? "default";
      index += 1;
      continue;
    }

    if (token === "--output") {
      const value = (argv[index + 1] ?? "text") as OutputMode;
      global.output = value === "json" ? "json" : "text";
      index += 1;
      continue;
    }

    if (token === "--json") {
      global.output = "json";
      continue;
    }

    if (token === "--non-interactive") {
      global.nonInteractive = true;
      continue;
    }

    rest.push(token);
  }

  return { global, rest };
}

/** Parses command-level `--flag value` pairs into a simple map. */
function parseFlags(tokens: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = tokens[index + 1];

    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return flags;
}

/** Reads an optional string flag from the parsed map. */
function getString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Reads and validates a numeric flag from the parsed map. */
function getNumber(flags: Map<string, string | boolean>, key: string): number | undefined {
  const value = getString(flags, key);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Flag --${key} expects a numeric value.`);
  }

  return parsed;
}

/** Reads a required string flag or throws a user-facing error. */
function requireString(flags: Map<string, string | boolean>, key: string): string {
  const value = getString(flags, key);
  if (!value) {
    throw new Error(`Missing required flag --${key}.`);
  }
  return value;
}

/** Parses comma-separated file path lists from a flag value. */
function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Normalizes provider tokens for matching regardless of case or punctuation. */
function normalizeProviderToken(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Computes Levenshtein distance for typo-tolerant provider matching. */
function levenshteinDistance(left: string, right: string): number {
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
function resolveProviderFilter(
  input: string,
  availableProviderTypes: string[]
): { requested: string; resolved?: string; hint?: string } {
  const requested = normalizeProviderToken(input);
  if (requested.length === 0) {
    return { requested };
  }

  const candidates = Array.from(
    new Set(
      availableProviderTypes
        .map((type) => normalizeProviderToken(type))
        .filter((type) => type.length > 0)
    )
  );

  if (candidates.includes(requested)) {
    return { requested, resolved: requested };
  }

  let best: { provider: string; distance: number } | null = null;
  for (const provider of candidates) {
    const distance = levenshteinDistance(requested, provider);
    if (best === null || distance < best.distance) {
      best = { provider, distance };
    }
  }

  if (best && best.distance <= 2) {
    return {
      requested,
      resolved: best.provider,
      hint: `Provider "${input}" interpreted as "${best.provider}".`
    };
  }

  return {
    requested,
    hint:
      candidates.length > 0
        ? `Unknown provider "${input}". Available types: ${candidates.join(", ")}`
        : `Unknown provider "${input}".`
  };
}

/** Heuristic group detector across providers, with WhatsApp-specific precision. */
function isGroupChat(chat: { account_type?: string; provider_id?: string; attendee_provider_id?: string; type?: number }): boolean {
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

/** Async sleep helper used by polling commands. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Converts ISO-like timestamps to epoch millis, returning null when invalid. */
function toEpochMillis(value: string | null | undefined): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Converts a phone-like token to WhatsApp attendee provider id format. */
function toWhatsAppProviderId(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const digits = input.replace(/[^0-9]/g, "");
  if (digits.length < 8) {
    return null;
  }

  return `${digits}@s.whatsapp.net`;
}

/** Builds an authenticated Unipile client for the selected profile. */
async function buildClient(global: GlobalCliOptions): Promise<{
  client: UnipileClient;
  config: AppConfig;
  profileName: string;
}> {
  const config = await loadConfig();
  const profileName = global.profile || config.profile;
  const profileConfig = getProfileConfig(config, profileName);

  if (!profileConfig.dsn || profileConfig.dsn.trim().length === 0) {
    throw new Error(`Profile "${profileName}" is missing DSN. Run "unipile auth set --dsn ... --api-key ..." first.`);
  }

  const { apiKey } = await getProfileApiKey(profileName);
  if (!apiKey) {
    throw new Error(`Profile "${profileName}" is missing API key. Run "unipile auth set --dsn ... --api-key ..." first.`);
  }

  return {
    client: new UnipileClient(profileConfig.dsn, apiKey),
    config,
    profileName
  };
}

/** Stores DSN/profile config and API key credentials for later commands. */
async function commandAuthSet(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const dsn = requireString(flags, "dsn");
  const apiKey = requireString(flags, "api-key");
  const profileName = getString(flags, "profile") ?? global.profile;

  const config = await loadConfig();

  const updated = upsertProfile(config, profileName, {
    dsn,
    qmdCollection: getString(flags, "qmd-collection") ?? undefined,
    qmdCommand: getString(flags, "qmd-command") ?? undefined,
    autoSendThreshold: getNumber(flags, "threshold") ?? undefined,
    autoSendMargin: getNumber(flags, "margin") ?? undefined
  });

  await saveConfig(updated);
  const storage = await setProfileApiKey(profileName, apiKey);

  const payload = {
    ok: true,
    profile: profileName,
    dsn,
    secret_backend: storage.backend
  };

  printResult(global.output, payload, () => {
    return [
      `Profile: ${profileName}`,
      `DSN: ${dsn}`,
      `API key: saved (${storage.backend})`
    ].join("\n");
  });

  return 0;
}

/** Prints auth/config status for the selected profile. */
async function commandAuthStatus(global: GlobalCliOptions): Promise<number> {
  const config = await loadConfig();
  const profileName = global.profile || config.profile;
  const profileConfig = getProfileConfig(config, profileName);
  const secret = await getProfileApiKey(profileName);

  const payload = {
    profile: profileName,
    dsn_configured: Boolean(profileConfig.dsn),
    api_key_configured: Boolean(secret.apiKey),
    secret_backend: secret.backend,
    qmd_collection: profileConfig.qmdCollection ?? "memory-root",
    qmd_command: profileConfig.qmdCommand ?? "qmd"
  };

  printResult(global.output, payload, () => {
    return [
      `Profile: ${payload.profile}`,
      `DSN configured: ${payload.dsn_configured}`,
      `API key configured: ${payload.api_key_configured}`,
      `Secret backend: ${payload.secret_backend}`,
      `QMD command: ${payload.qmd_command}`,
      `QMD collection: ${payload.qmd_collection}`
    ].join("\n");
  });

  return 0;
}

/** Lists accounts and optionally filters by provider type. */
async function commandAccountsList(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const providerInput = getString(flags, "provider");
  const limit = getNumber(flags, "limit") ?? 100;

  const { client } = await buildClient(global);
  const accounts = await client.listAccounts({ limit });
  const resolvedProvider = providerInput
    ? resolveProviderFilter(
        providerInput,
        accounts.map((account) => account.type)
      )
    : undefined;

  const filtered = resolvedProvider?.resolved
    ? accounts.filter((account) => normalizeProviderToken(account.type) === resolvedProvider.resolved)
    : providerInput
      ? []
      : accounts;

  const payload = {
    count: filtered.length,
    accounts: filtered,
    provider_requested: resolvedProvider?.requested ?? null,
    provider_resolved: resolvedProvider?.resolved ?? null,
    provider_hint: resolvedProvider?.hint ?? null
  };

  printResult(global.output, payload, () => {
    const lines: string[] = [];
    if (resolvedProvider?.hint) {
      lines.push(resolvedProvider.hint);
      lines.push("");
    }
    lines.push(formatAccounts(filtered));
    return lines.join("\n");
  });
  return 0;
}

/** Lists chats and supports group-only and name query filtering. */
async function commandChatsList(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const query = getString(flags, "query")?.trim().toLowerCase();
  const groupOnly = Boolean(flags.get("group-only"));
  const limit = getNumber(flags, "limit") ?? 250;

  const { client } = await buildClient(global);
  const chats = await client.listChats({ accountId, limit });

  const filtered = chats.filter((chat) => {
    const isGroup = isGroupChat(chat);
    if (groupOnly && !isGroup) {
      return false;
    }
    if (!query || query.length === 0) {
      return true;
    }

    const haystack = `${chat.name ?? ""} ${chat.id}`.toLowerCase();
    return haystack.includes(query);
  });

  const payload = {
    account_id: accountId,
    count: filtered.length,
    query: query ?? null,
    group_only: groupOnly,
    chats: filtered.map((chat) => ({
      ...chat,
      is_group: isGroupChat(chat)
    }))
  };

  printResult(global.output, payload, () => formatChats(filtered));
  return 0;
}

/** Fetches attendees and chats used by contact resolution and send flows. */
async function fetchResolutionContext(
  client: UnipileClient,
  accountId: string,
  limit: number
): Promise<{ attendees: ChatAttendee[]; chats: Awaited<ReturnType<UnipileClient["listChats"]>> }> {
  const [attendees, chats] = await Promise.all([
    client.listAttendees({ accountId, limit }),
    client.listChats({ accountId, limit: 250 })
  ]);

  return { attendees, chats };
}

/** Runs contact search/resolve using lexical, recency, and optional QMD signals. */
async function commandContacts(args: string[], global: GlobalCliOptions, resolveOnly: boolean): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const query = requireString(flags, "query");
  const limit = getNumber(flags, "limit") ?? 250;
  const maxCandidates = getNumber(flags, "max-candidates") ?? 5;

  const { client, config, profileName } = await buildClient(global);
  const profileConfig = getProfileConfig(config, profileName);
  const context = await fetchResolutionContext(client, accountId, limit);

  const qmdDisabled = Boolean(flags.get("no-qmd"));
  const qmdResult = qmdDisabled
    ? { available: false, hits: [], error: "QMD disabled by --no-qmd." }
    : await queryQmd(query, {
        command: getString(flags, "qmd-command") ?? profileConfig.qmdCommand,
        collection: getString(flags, "qmd-collection") ?? profileConfig.qmdCollection,
        timeoutMs: 4000,
        maxHits: 12
      });

  const threshold =
    getNumber(flags, "threshold") ?? profileConfig.autoSendThreshold ?? 0.9;
  const margin = getNumber(flags, "margin") ?? profileConfig.autoSendMargin ?? 0.15;

  const resolution = resolveContacts(query, context.attendees, context.chats, qmdResult, {
    threshold,
    margin,
    maxCandidates
  });

  const payload = {
    account_id: accountId,
    attendee_count: context.attendees.length,
    chat_count: context.chats.length,
    qmd: qmdResult,
    resolution
  };

  printResult(global.output, payload, () => formatResolution(resolution, qmdResult));

  if (resolveOnly && resolution.status !== "resolved") {
    return 2;
  }

  return 0;
}

/** Sends a message using chat id, attendee id, or query-based resolution. */
async function commandSend(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const text = requireString(flags, "text");

  const chatId = getString(flags, "chat-id");
  const attendeeId = getString(flags, "attendee-id");
  const toQuery = getString(flags, "to-query");
  const attachments = parsePathList(getString(flags, "attachment"));
  const voiceMessage = getString(flags, "voice-note");
  const videoMessage = getString(flags, "video");
  const typingDuration = getNumber(flags, "typing-duration");

  const { client, config, profileName } = await buildClient(global);
  const profileConfig = getProfileConfig(config, profileName);

  if (chatId) {
    const sent = await client.sendMessage({
      chatId,
      text,
      accountId,
      attachments,
      voiceMessage,
      videoMessage,
      typingDuration
    });
    const payload = {
      status: "sent",
      mode: "existing_chat",
      chat_id: chatId,
      message_id: sent.message_id,
      object: sent.object,
      media: {
        attachments_count: attachments.length,
        voice_note: Boolean(voiceMessage),
        video: Boolean(videoMessage)
      }
    };

    printResult(global.output, payload, () => {
      return `Sent message to chat ${chatId}. message_id=${sent.message_id ?? ""}`;
    });

    return 0;
  }

  const whatsappProviderId = toWhatsAppProviderId(toQuery);
  if (toQuery && whatsappProviderId) {
    try {
      const started = await client.startChat({
        accountId,
        attendeesIds: [whatsappProviderId],
        text,
        attachments,
        voiceMessage,
        videoMessage,
        typingDuration
      });

      const payload = {
        status: "sent",
        mode: "new_chat_whatsapp_phone",
        account_id: accountId,
        target_phone: toQuery,
        target_provider_id: whatsappProviderId,
        chat_id: started.chat_id,
        message_id: started.message_id,
        media: {
          attachments_count: attachments.length,
          voice_note: Boolean(voiceMessage),
          video: Boolean(videoMessage)
        }
      };

      printResult(global.output, payload, () => {
        return `Sent message to ${toQuery} via direct WhatsApp phone routing.`;
      });

      return 0;
    } catch {
      // Fall through to generic resolver flow if direct phone routing fails.
    }
  }

  const context = await fetchResolutionContext(client, accountId, 250);

  let selectedAttendee: ChatAttendee | undefined;
  let resolutionPayload: unknown;

  if (attendeeId) {
    selectedAttendee = context.attendees.find(
      (attendee) => attendee.id === attendeeId || attendee.provider_id === attendeeId
    );

    if (!selectedAttendee) {
      throw new Error(
        `Attendee "${attendeeId}" not found in account ${accountId}. Use contacts search first.`
      );
    }
  } else if (toQuery) {
    const qmdDisabled = Boolean(flags.get("no-qmd"));
    const qmdResult = qmdDisabled
      ? { available: false, hits: [], error: "QMD disabled by --no-qmd." }
      : await queryQmd(toQuery, {
          command: getString(flags, "qmd-command") ?? profileConfig.qmdCommand,
          collection: getString(flags, "qmd-collection") ?? profileConfig.qmdCollection,
          timeoutMs: 4000,
          maxHits: 12
        });

    const threshold =
      getNumber(flags, "threshold") ?? profileConfig.autoSendThreshold ?? 0.9;
    const margin = getNumber(flags, "margin") ?? profileConfig.autoSendMargin ?? 0.15;

    const resolution = resolveContacts(toQuery, context.attendees, context.chats, qmdResult, {
      threshold,
      margin,
      maxCandidates: 5
    });

    resolutionPayload = {
      qmd: qmdResult,
      resolution
    };

    if (resolution.status !== "resolved" || !resolution.selected) {
      const payload = {
        status: "blocked",
        reason: resolution.status,
        account_id: accountId,
        resolution: resolutionPayload
      };

      printResult(global.output, payload, () => {
        return [
          `Send blocked: ${resolution.status}`,
          formatResolution(resolution, qmdResult)
        ].join("\n\n");
      });

      return 2;
    }

    selectedAttendee = resolution.selected.attendee;
  } else {
    throw new Error("send requires one of --chat-id, --attendee-id, or --to-query.");
  }

  const existingChat = context.chats.find(
    (chat) => chat.attendee_provider_id && chat.attendee_provider_id === selectedAttendee.provider_id
  );

  if (existingChat) {
    const sent = await client.sendMessage({
      chatId: existingChat.id,
      text,
      accountId,
      attachments,
      voiceMessage,
      videoMessage,
      typingDuration
    });

    const payload = {
      status: "sent",
      mode: "existing_chat",
      chat_id: existingChat.id,
      attendee_id: selectedAttendee.id,
      attendee_provider_id: selectedAttendee.provider_id,
      message_id: sent.message_id,
      resolution: resolutionPayload,
      media: {
        attachments_count: attachments.length,
        voice_note: Boolean(voiceMessage),
        video: Boolean(videoMessage)
      }
    };

    printResult(global.output, payload, () => {
      return `Sent message to ${selectedAttendee.name} via existing chat ${existingChat.id}.`;
    });

    return 0;
  }

  const started = await client.startChat({
    accountId,
    attendeesIds: [selectedAttendee.provider_id],
    text,
    attachments,
    voiceMessage,
    videoMessage,
    typingDuration
  });

  const payload = {
    status: "sent",
    mode: "new_chat",
    chat_id: started.chat_id,
    attendee_id: selectedAttendee.id,
    attendee_provider_id: selectedAttendee.provider_id,
    message_id: started.message_id,
    resolution: resolutionPayload,
    media: {
      attachments_count: attachments.length,
      voice_note: Boolean(voiceMessage),
      video: Boolean(videoMessage)
    }
  };

  printResult(global.output, payload, () => {
    return `Started new chat with ${selectedAttendee.name}. chat_id=${started.chat_id ?? ""}`;
  });

  return 0;
}

/** Pulls messages with optional lower-bound timestamp filtering. */
async function commandInboxPull(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const limit = getNumber(flags, "limit") ?? 100;
  const since = getString(flags, "since");

  const { client } = await buildClient(global);
  const messages = await client.listMessages({
    accountId,
    after: since,
    limit
  });

  const payload = {
    account_id: accountId,
    count: messages.length,
    messages
  };

  printResult(global.output, payload, () => formatMessages(messages));
  return 0;
}

/** Polls inbox messages at a fixed interval for headless watch workflows. */
async function commandInboxWatch(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const limit = getNumber(flags, "limit") ?? 100;
  const intervalSeconds = getNumber(flags, "interval-seconds") ?? 20;
  const maxIterations = getNumber(flags, "max-iterations");
  const once = Boolean(flags.get("once"));
  let sinceCursor = getString(flags, "since");

  if (intervalSeconds <= 0) {
    throw new Error("Flag --interval-seconds must be greater than 0.");
  }

  const { client } = await buildClient(global);
  const seenIds = new Set<string>();
  let iteration = 0;
  let totalNew = 0;

  while (true) {
    iteration += 1;

    const batch = await client.listMessages({
      accountId,
      after: sinceCursor,
      limit
    });

    const sorted = [...batch].sort((left, right) => {
      const leftTs = toEpochMillis(left.timestamp) ?? 0;
      const rightTs = toEpochMillis(right.timestamp) ?? 0;
      return leftTs - rightTs;
    });

    const newMessages = sorted.filter((message) => {
      if (seenIds.has(message.id)) {
        return false;
      }

      seenIds.add(message.id);
      return true;
    });

    if (newMessages.length > 0) {
      totalNew += newMessages.length;
      const payload = {
        mode: "watch_event",
        account_id: accountId,
        poll_index: iteration,
        count: newMessages.length,
        messages: newMessages
      };
      printResult(global.output, payload, () => formatMessages(newMessages));
    }

    let newestTs = sinceCursor ? toEpochMillis(sinceCursor) : null;
    for (const message of batch) {
      const ts = toEpochMillis(message.timestamp);
      if (ts !== null && (newestTs === null || ts > newestTs)) {
        newestTs = ts;
      }
    }

    if (newestTs !== null) {
      sinceCursor = new Date(newestTs).toISOString();
    }

    if (once) {
      break;
    }

    if (maxIterations !== undefined && iteration >= maxIterations) {
      break;
    }

    await sleep(intervalSeconds * 1000);
  }

  const payload = {
    mode: "watch_done",
    account_id: accountId,
    polls: iteration,
    total_new_messages: totalNew,
    last_since_cursor: sinceCursor ?? null
  };

  printResult(global.output, payload, () => {
    return [
      "Watch completed.",
      `Account: ${accountId}`,
      `Polls: ${iteration}`,
      `New messages: ${totalNew}`,
      `Last cursor: ${sinceCursor ?? "(none)"}`
    ].join("\n");
  });

  return 0;
}

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
}

/** Renders doctor check output in a readable text layout. */
function formatDoctorChecks(checks: DoctorCheck[], summary: string): string {
  const lines = [summary, "", "Checks:"];
  for (const check of checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}

/** Runs end-to-end readiness checks for config, Unipile API, and optional QMD. */
async function commandDoctorRun(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = getString(flags, "account-id");
  const qmdQuery = getString(flags, "qmd-query") ?? "recent contact from today";
  const skipQmd = Boolean(flags.get("skip-qmd"));
  const checks: DoctorCheck[] = [];

  const config = await loadConfig();
  const profileName = global.profile || config.profile;
  const profileConfig = getProfileConfig(config, profileName);
  const apiKey = await getProfileApiKey(profileName);

  if (profileConfig.dsn && profileConfig.dsn.trim().length > 0) {
    checks.push({
      name: "profile.dsn",
      status: "pass",
      detail: `Configured (${profileConfig.dsn})`
    });
  } else {
    checks.push({
      name: "profile.dsn",
      status: "fail",
      detail: "Missing DSN. Run: unipile auth set --dsn ... --api-key ..."
    });
  }

  if (apiKey.apiKey) {
    checks.push({
      name: "profile.api_key",
      status: "pass",
      detail: `Configured (${apiKey.backend})`
    });
  } else {
    checks.push({
      name: "profile.api_key",
      status: "fail",
      detail: "Missing API key. Run: unipile auth set --dsn ... --api-key ..."
    });
  }

  let accountCount: number | null = null;
  const hasConfigFailures = checks.some((check) => check.status === "fail");

  if (!hasConfigFailures) {
    const client = new UnipileClient(profileConfig.dsn, apiKey.apiKey as string);

    try {
      const accounts = await client.listAccounts({ limit: 50 });
      accountCount = accounts.length;

      checks.push({
        name: "unipile.accounts",
        status: "pass",
        detail: `Fetched ${accounts.length} account(s) with current API key`
      });

      if (accountId) {
        const account = accounts.find((item) => item.id === accountId);
        if (!account) {
          checks.push({
            name: "unipile.account_id",
            status: "fail",
            detail: `Account ${accountId} not found in /api/v1/accounts`
          });
        } else {
          const [attendees, chats] = await Promise.all([
            client.listAttendees({ accountId, limit: 25 }),
            client.listChats({ accountId, limit: 25 })
          ]);

          checks.push({
            name: "unipile.messaging_scope",
            status: "pass",
            detail: `Account ${accountId}: attendees=${attendees.length}, chats=${chats.length}`
          });
        }
      } else {
        checks.push({
          name: "unipile.account_id",
          status: "skip",
          detail: "Not provided; pass --account-id to validate attendee/chat endpoints too"
        });
      }
    } catch (error: unknown) {
      checks.push({
        name: "unipile.accounts",
        status: "fail",
        detail: `Unable to reach Unipile API (${(error as Error).message})`
      });

      checks.push({
        name: "unipile.account_id",
        status: "skip",
        detail: "Skipped because accounts check failed"
      });
    }
  }

  if (skipQmd) {
    checks.push({
      name: "qmd.query",
      status: "skip",
      detail: "Skipped by --skip-qmd"
    });
  } else {
    const qmdResult = await queryQmd(qmdQuery, {
      command: profileConfig.qmdCommand,
      collection: profileConfig.qmdCollection,
      timeoutMs: 4000,
      maxHits: 5
    });

    if (qmdResult.available) {
      checks.push({
        name: "qmd.query",
        status: "pass",
        detail: `Available (${qmdResult.hits.length} hit(s) for query "${qmdQuery}")`
      });
    } else {
      checks.push({
        name: "qmd.query",
        status: "warn",
        detail: `Unavailable (${qmdResult.error ?? "unknown error"})`
      });
    }
  }

  const hasFailures = checks.some((check) => check.status === "fail");
  const hasWarnings = checks.some((check) => check.status === "warn");
  const summary = hasFailures
    ? "Doctor result: FAIL"
    : hasWarnings
      ? "Doctor result: PASS_WITH_WARNINGS"
      : "Doctor result: PASS";

  const payload = {
    profile: profileName,
    summary: hasFailures ? "fail" : hasWarnings ? "pass_with_warnings" : "pass",
    account_id: accountId ?? null,
    account_count: accountCount,
    checks
  };

  printResult(global.output, payload, () => formatDoctorChecks(checks, summary));
  return hasFailures ? 1 : 0;
}

/** Dispatches argv tokens to command handlers and returns exit status. */
async function run(): Promise<number> {
  const { global, rest } = parseGlobal(process.argv.slice(2));

  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) {
    console.log(help());
    return 0;
  }

  const [group, action, ...args] = rest;

  if (group === "auth" && action === "set") {
    return commandAuthSet(args, global);
  }

  if (group === "auth" && action === "status") {
    return commandAuthStatus(global);
  }

  if (group === "accounts" && action === "list") {
    return commandAccountsList(args, global);
  }

  if (group === "chats" && action === "list") {
    return commandChatsList(args, global);
  }

  if (group === "contacts" && action === "search") {
    return commandContacts(args, global, false);
  }

  if (group === "contacts" && action === "resolve") {
    return commandContacts(args, global, true);
  }

  if (group === "send") {
    return commandSend([action, ...args].filter(Boolean), global);
  }

  if (group === "inbox" && action === "pull") {
    return commandInboxPull(args, global);
  }

  if (group === "inbox" && action === "watch") {
    return commandInboxWatch(args, global);
  }

  if (group === "doctor" && action === "run") {
    return commandDoctorRun(args, global);
  }

  throw new Error(`Unknown command: ${rest.join(" ")}. Use --help to view available commands.`);
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    if (error instanceof UnipileApiError) {
      console.error(error.message);
      if (error.type) {
        console.error(`type=${error.type}`);
      }
      process.exitCode = error.status === 401 ? 3 : 1;
      return;
    }

    console.error((error as Error).message);
    process.exitCode = 1;
  });
