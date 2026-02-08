#!/usr/bin/env node
import { getProfileConfig, loadConfig, saveConfig, upsertProfile } from "./config.js";
import { printResult, formatAccounts, formatMessages, formatResolution } from "./format.js";
import { queryQmd } from "./qmd.js";
import { resolveContacts } from "./resolver.js";
import { getProfileApiKey, setProfileApiKey } from "./storage.js";
import type { AppConfig, ChatAttendee, GlobalCliOptions, OutputMode } from "./types.js";
import { UnipileApiError, UnipileClient } from "./unipile.js";

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
    "  contacts search --account-id <id> --query <text> [--limit <n>] [--max-candidates <n>] [--no-qmd]",
    "  contacts resolve --account-id <id> --query <text> [--threshold <0..1>] [--margin <0..1>] [--no-qmd]",
    "  send --account-id <id> --text <message> [--chat-id <id> | --attendee-id <id> | --to-query <text>] [--no-qmd]",
    "  inbox pull --account-id <id> [--since <ISO8601>] [--limit <n>]",
    "",
    "Notes:",
    "  - Core features work without OpenClaw/QMD.",
    "  - QMD is optional and only used to improve contact ranking.",
    ""
  ].join("\n");
}

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

function getString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

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

function requireString(flags: Map<string, string | boolean>, key: string): string {
  const value = getString(flags, key);
  if (!value) {
    throw new Error(`Missing required flag --${key}.`);
  }
  return value;
}

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

async function commandAccountsList(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const provider = getString(flags, "provider")?.toUpperCase();
  const limit = getNumber(flags, "limit") ?? 100;

  const { client } = await buildClient(global);
  const accounts = await client.listAccounts({ limit });
  const filtered = provider ? accounts.filter((account) => account.type === provider) : accounts;

  const payload = {
    count: filtered.length,
    accounts: filtered
  };

  printResult(global.output, payload, () => formatAccounts(filtered));
  return 0;
}

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

async function commandSend(args: string[], global: GlobalCliOptions): Promise<number> {
  const flags = parseFlags(args);
  const accountId = requireString(flags, "account-id");
  const text = requireString(flags, "text");

  const chatId = getString(flags, "chat-id");
  const attendeeId = getString(flags, "attendee-id");
  const toQuery = getString(flags, "to-query");

  const { client, config, profileName } = await buildClient(global);
  const profileConfig = getProfileConfig(config, profileName);

  if (chatId) {
    const sent = await client.sendMessage({ chatId, text, accountId });
    const payload = {
      status: "sent",
      mode: "existing_chat",
      chat_id: chatId,
      message_id: sent.message_id,
      object: sent.object
    };

    printResult(global.output, payload, () => {
      return `Sent message to chat ${chatId}. message_id=${sent.message_id ?? ""}`;
    });

    return 0;
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
      accountId
    });

    const payload = {
      status: "sent",
      mode: "existing_chat",
      chat_id: existingChat.id,
      attendee_id: selectedAttendee.id,
      attendee_provider_id: selectedAttendee.provider_id,
      message_id: sent.message_id,
      resolution: resolutionPayload
    };

    printResult(global.output, payload, () => {
      return `Sent message to ${selectedAttendee.name} via existing chat ${existingChat.id}.`;
    });

    return 0;
  }

  const started = await client.startChat({
    accountId,
    attendeesIds: [selectedAttendee.provider_id],
    text
  });

  const payload = {
    status: "sent",
    mode: "new_chat",
    chat_id: started.chat_id,
    attendee_id: selectedAttendee.id,
    attendee_provider_id: selectedAttendee.provider_id,
    message_id: started.message_id,
    resolution: resolutionPayload
  };

  printResult(global.output, payload, () => {
    return `Started new chat with ${selectedAttendee.name}. chat_id=${started.chat_id ?? ""}`;
  });

  return 0;
}

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
