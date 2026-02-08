import type {
  Account,
  ContactResolution,
  Message,
  OutputMode,
  QmdQueryResult
} from "./types.js";

/** Writes either JSON or text output depending on selected output mode. */
export function printResult(
  output: OutputMode,
  payload: unknown,
  textRenderer: () => string
): void {
  if (output === "json") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(textRenderer());
}

/** Formats account lists for human-readable terminal output. */
export function formatAccounts(accounts: Account[]): string {
  if (accounts.length === 0) {
    return "No accounts found.";
  }

  const lines = ["Accounts:"];
  for (const account of accounts) {
    lines.push(`- ${account.id}  ${account.type}  ${account.name}`);
  }

  return lines.join("\n");
}

/** Formats contact resolution details with scoring and QMD availability context. */
export function formatResolution(resolution: ContactResolution, qmd: QmdQueryResult): string {
  const lines: string[] = [];
  lines.push(`Query: ${resolution.query}`);
  lines.push(`Status: ${resolution.status}`);

  if (qmd.available) {
    lines.push(`QMD: available (${qmd.hits.length} hit(s))`);
  } else {
    lines.push(`QMD: unavailable (${qmd.error ?? "unknown error"})`);
  }

  if (resolution.selected) {
    const top = resolution.selected;
    lines.push(
      `Top match: ${top.attendee.name} [attendee_id=${top.attendee.id} provider_id=${top.attendee.provider_id}] score=${top.totalScore.toFixed(3)}`
    );
  }

  if (resolution.candidates.length > 0) {
    lines.push("Candidates:");
    for (const candidate of resolution.candidates) {
      lines.push(
        `- ${candidate.attendee.name} (${candidate.attendee.id}) total=${candidate.totalScore.toFixed(3)} lexical=${candidate.lexicalScore.toFixed(3)} recency=${candidate.recencyScore.toFixed(3)} qmd=${candidate.qmdScore.toFixed(3)} [${candidate.matchedBy.join(","
        )}]`
      );
    }
  }

  return lines.join("\n");
}

/** Formats message lists for human-readable terminal output. */
export function formatMessages(messages: Message[]): string {
  if (messages.length === 0) {
    return "No messages found.";
  }

  const lines = ["Messages:"];
  for (const message of messages) {
    lines.push(
      `- ${message.timestamp ?? ""} chat=${message.chat_id} message=${message.id} sender=${message.sender_id} text=${message.text ?? ""}`
    );
  }

  return lines.join("\n");
}
