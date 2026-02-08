#!/usr/bin/env node
import { getProfileConfig, loadConfig, saveConfig, upsertProfile } from "./config.js";
import { printResult, formatAccounts, formatChats, formatMessages, formatResolution } from "./format.js";
import {
  buildInboxScopeKey,
  computeNextSinceCursor,
  createInboxStateStore,
  getInboxStatePath,
  normalizeChatIds
} from "./inbox-state.js";
import type { InboxStateStore } from "./inbox-state.js";
import { isGroupChat, resolveProviderFilter } from "./provider.js";
import { queryQmd } from "./qmd.js";
import { resolveContacts } from "./resolver.js";
import { getProfileApiKey, setProfileApiKey } from "./storage.js";
import type { AppConfig, ChatAttendee, GlobalCliOptions, Message, OutputMode } from "./types.js";
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
    "  inbox pull --account-id <id> [--chat-id <id[,id2]>] [--sender-id <id>] [--since <ISO8601>] [--limit <n>] [--max-pages <n>] [--state-key <name>] [--reset-state] [--no-state]",
    "  inbox watch --account-id <id> [--chat-id <id[,id2]>] [--sender-id <id>] [--since <ISO8601>] [--limit <n>] [--max-pages <n>] [--interval-seconds <n>] [--max-iterations <n>] [--once] [--state-key <name>] [--reset-state] [--no-state]",
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

/** Reads and validates a positive integer flag with optional bounds. */
function getPositiveInteger(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: number,
  bounds: { max?: number } = {}
): number {
  const parsed = getNumber(flags, key) ?? fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Flag --${key} expects a positive integer.`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`Flag --${key} must be <= ${bounds.max}.`);
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

/** Parses comma-separated string lists from a flag value. */
function parseCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parses comma-separated file path lists from a flag value. */
function parsePathList(value: string | undefined): string[] {
  return parseCsvList(value);
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
    ? accounts.filter((account) => account.type === resolvedProvider.resolved)
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

interface InboxQueryScope {
  chatIds: string[];
  senderId?: string;
}

interface InboxStateOptions {
  useState: boolean;
  resetState: boolean;
  customStateKey?: string;
}

/** Parses inbox scope filters from command flags. */
function parseInboxQueryScope(flags: Map<string, string | boolean>): InboxQueryScope {
  const chatIds = normalizeChatIds(parseCsvList(getString(flags, "chat-id")));
  const sender = getString(flags, "sender-id")?.trim();
  return {
    chatIds,
    senderId: sender && sender.length > 0 ? sender : undefined
  };
}

/** Parses state-related inbox flags. */
function parseInboxStateOptions(flags: Map<string, string | boolean>): InboxStateOptions {
  const customStateKey = getString(flags, "state-key")?.trim();
  return {
    useState: !Boolean(flags.get("no-state")),
    resetState: Boolean(flags.get("reset-state")),
    customStateKey:
      customStateKey && customStateKey.length > 0 ? customStateKey : undefined
  };
}

/** Builds a stable dedupe key for one message row. */
function toMessageKey(message: Message): string {
  return `${message.account_id}:${message.id}`;
}

/** Returns messages sorted from oldest to newest with id tie-breakers. */
function sortMessagesChronologically(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => {
    const leftTs = toEpochMillis(left.timestamp) ?? 0;
    const rightTs = toEpochMillis(right.timestamp) ?? 0;
    if (leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    return left.id.localeCompare(right.id);
  });
}

/** Deduplicates message arrays by account/message id pair. */
function dedupeMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const deduped: Message[] = [];
  for (const message of messages) {
    const key = toMessageKey(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(message);
  }
  return deduped;
}

/** Collects paginated message responses until cursor exhaustion or max pages. */
async function collectPagedMessages(
  fetchPage: (cursor: string | undefined) => Promise<{ items: Message[]; cursor?: string | null }>,
  maxPages: number
): Promise<Message[]> {
  const collected: Message[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const response = await fetchPage(cursor);
    collected.push(...(response.items ?? []));

    const nextCursor = response.cursor;
    if (typeof nextCursor !== "string") {
      break;
    }

    if (nextCursor.trim().length === 0 || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return collected;
}

/** Fetches messages for account-wide or chat-scoped polling with pagination. */
async function fetchScopedMessages(args: {
  client: UnipileClient;
  accountId: string;
  scope: InboxQueryScope;
  since?: string;
  limit: number;
  maxPages: number;
}): Promise<Message[]> {
  const { client, accountId, scope, since, limit, maxPages } = args;

  if (scope.chatIds.length === 0) {
    const accountMessages = await collectPagedMessages(
      (cursor) =>
        client.listMessagesPage({
          accountId,
          senderId: scope.senderId,
          after: since,
          cursor,
          limit
        }),
      maxPages
    );
    return dedupeMessages(accountMessages);
  }

  const scoped: Message[] = [];
  for (const chatId of scope.chatIds) {
    const chatMessages = await collectPagedMessages(
      (cursor) =>
        client.listMessagesFromChatPage(chatId, {
          senderId: scope.senderId,
          after: since,
          cursor,
          limit
        }),
      maxPages
    );
    scoped.push(...chatMessages);
  }

  return dedupeMessages(scoped);
}

/** Pulls new messages and persists scope cursor/message payload state by default. */
async function commandInboxPull(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const limit = getPositiveInteger(flags, "limit", 100, { max: 250 });
  const maxPages = getPositiveInteger(flags, "max-pages", 10);
  const scope = parseInboxQueryScope(flags);
  const stateOptions = parseInboxStateOptions(flags);
  const explicitSince = getString(flags, "since");

  const { client, profileName } = await buildClient(global);
  let stateStore: InboxStateStore | null = null;

  try {
    let scopeKey: string | undefined;
    let sinceCursor = explicitSince;
    let usedStoredCursor = false;

    if (stateOptions.useState) {
      stateStore = await createInboxStateStore();
      scopeKey = buildInboxScopeKey({
        profileName,
        accountId,
        chatIds: scope.chatIds,
        senderId: scope.senderId,
        customStateKey: stateOptions.customStateKey
      });

      if (stateOptions.resetState) {
        stateStore.resetScope(scopeKey);
      }

      if (!sinceCursor) {
        const stored = stateStore.getCursor(scopeKey);
        if (stored) {
          sinceCursor = stored;
          usedStoredCursor = true;
        }
      }
    }

    const batch = await fetchScopedMessages({
      client,
      accountId,
      scope,
      since: sinceCursor,
      limit,
      maxPages
    });

    const sorted = sortMessagesChronologically(batch);
    let returnedMessages = sorted;
    let newStoreRows = 0;
    let newScopeRows = 0;

    const nextSince = computeNextSinceCursor(
      sinceCursor,
      sorted.map((message) => message.timestamp)
    );

    if (stateStore && scopeKey) {
      returnedMessages = [];
      for (const message of sorted) {
        const persisted = stateStore.persistMessage(scopeKey, message);
        if (persisted.isNewInStore) {
          newStoreRows += 1;
        }
        if (persisted.isNewForScope) {
          newScopeRows += 1;
          returnedMessages.push(message);
        }
      }

      stateStore.upsertScopeState({
        scopeKey,
        profileName,
        accountId,
        chatIds: scope.chatIds,
        senderId: scope.senderId,
        sinceCursor: nextSince
      });
    }

    const payload = {
      mode: "pull",
      account_id: accountId,
      scope: {
        chat_ids: scope.chatIds,
        sender_id: scope.senderId ?? null
      },
      count: returnedMessages.length,
      messages: returnedMessages,
      state: {
        enabled: stateOptions.useState,
        db_path: stateOptions.useState ? getInboxStatePath() : null,
        scope_key: stateOptions.useState
          ? buildInboxScopeKey({
              profileName,
              accountId,
              chatIds: scope.chatIds,
              senderId: scope.senderId,
              customStateKey: stateOptions.customStateKey
            })
          : null,
        used_stored_cursor: usedStoredCursor,
        explicit_since: explicitSince ?? null,
        last_since_cursor: nextSince ?? null,
        new_store_rows: newStoreRows,
        new_scope_rows: newScopeRows
      }
    };

    printResult(global.output, payload, () => formatMessages(returnedMessages));
    return 0;
  } finally {
    stateStore?.close();
  }
}

/** Polls inbox messages with optional stateful dedupe and persistent cursors. */
async function commandInboxWatch(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const limit = getPositiveInteger(flags, "limit", 100, { max: 250 });
  const maxPages = getPositiveInteger(flags, "max-pages", 10);
  const intervalSeconds = getPositiveInteger(flags, "interval-seconds", 20);
  const maxIterations = getNumber(flags, "max-iterations");
  const once = Boolean(flags.get("once"));
  const scope = parseInboxQueryScope(flags);
  const stateOptions = parseInboxStateOptions(flags);
  const explicitSince = getString(flags, "since");

  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
    throw new Error("Flag --max-iterations expects a positive integer.");
  }

  const { client, profileName } = await buildClient(global);
  const memorySeen = new Set<string>();
  let stateStore: InboxStateStore | null = null;

  try {
    let scopeKey: string | undefined;
    let sinceCursor = explicitSince;
    let usedStoredCursor = false;

    if (stateOptions.useState) {
      stateStore = await createInboxStateStore();
      scopeKey = buildInboxScopeKey({
        profileName,
        accountId,
        chatIds: scope.chatIds,
        senderId: scope.senderId,
        customStateKey: stateOptions.customStateKey
      });

      if (stateOptions.resetState) {
        stateStore.resetScope(scopeKey);
      }

      if (!sinceCursor) {
        const stored = stateStore.getCursor(scopeKey);
        if (stored) {
          sinceCursor = stored;
          usedStoredCursor = true;
        }
      }
    }

    let iteration = 0;
    let totalNew = 0;
    let totalStored = 0;

    while (true) {
      iteration += 1;

      const batch = await fetchScopedMessages({
        client,
        accountId,
        scope,
        since: sinceCursor,
        limit,
        maxPages
      });

      const sorted = sortMessagesChronologically(batch);
      const newMessages: Message[] = [];

      if (stateStore && scopeKey) {
        for (const message of sorted) {
          const persisted = stateStore.persistMessage(scopeKey, message);
          if (persisted.isNewInStore) {
            totalStored += 1;
          }
          if (persisted.isNewForScope) {
            newMessages.push(message);
          }
        }
      } else {
        for (const message of sorted) {
          const key = toMessageKey(message);
          if (memorySeen.has(key)) {
            continue;
          }
          memorySeen.add(key);
          newMessages.push(message);
        }
      }

      sinceCursor = computeNextSinceCursor(
        sinceCursor,
        sorted.map((message) => message.timestamp)
      );

      if (stateStore && scopeKey) {
        stateStore.upsertScopeState({
          scopeKey,
          profileName,
          accountId,
          chatIds: scope.chatIds,
          senderId: scope.senderId,
          sinceCursor
        });
      }

      if (newMessages.length > 0) {
        totalNew += newMessages.length;
        const payload = {
          mode: "watch_event",
          account_id: accountId,
          scope: {
            chat_ids: scope.chatIds,
            sender_id: scope.senderId ?? null
          },
          poll_index: iteration,
          count: newMessages.length,
          messages: newMessages
        };
        printResult(global.output, payload, () => formatMessages(newMessages));
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
      scope: {
        chat_ids: scope.chatIds,
        sender_id: scope.senderId ?? null
      },
      polls: iteration,
      total_new_messages: totalNew,
      last_since_cursor: sinceCursor ?? null,
      state: {
        enabled: stateOptions.useState,
        db_path: stateOptions.useState ? getInboxStatePath() : null,
        scope_key: stateOptions.useState
          ? buildInboxScopeKey({
              profileName,
              accountId,
              chatIds: scope.chatIds,
              senderId: scope.senderId,
              customStateKey: stateOptions.customStateKey
            })
          : null,
        used_stored_cursor: usedStoredCursor,
        explicit_since: explicitSince ?? null,
        new_store_rows: stateOptions.useState ? totalStored : null
      }
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
  } finally {
    stateStore?.close();
  }
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
