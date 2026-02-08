import type {
  Account,
  Chat,
  ChatAttendee,
  Message,
  UnipileListResponse
} from "./types.js";

export class UnipileApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
    public readonly type?: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "UnipileApiError";
  }
}

export interface ListArgs {
  limit?: number;
  cursor?: string;
}

export interface ListAttendeesArgs extends ListArgs {
  accountId?: string;
}

export interface ListChatsArgs extends ListArgs {
  accountId?: string;
  unread?: boolean;
}

export interface ListMessagesArgs extends ListArgs {
  accountId?: string;
  after?: string;
  before?: string;
}

export interface StartChatArgs {
  accountId: string;
  attendeesIds: string[];
  text?: string;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function withQuery(path: string, args: Record<string, string | number | boolean | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }

  const query = searchParams.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

export class UnipileClient {
  private readonly baseUrl: string;

  public constructor(dsn: string, private readonly apiKey: string) {
    this.baseUrl = trimTrailingSlash(dsn);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    headers.set("X-API-KEY", this.apiKey);

    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers
    });

    const contentType = response.headers.get("content-type") ?? "";
    let payload: unknown = null;

    if (contentType.includes("application/json")) {
      payload = await response.json();
    } else {
      const text = await response.text();
      payload = text.length > 0 ? text : null;
    }

    if (!response.ok) {
      const body = (typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : undefined) as Record<string, unknown> | undefined;
      const detail = typeof body?.detail === "string" ? body.detail : undefined;
      const type = typeof body?.type === "string" ? body.type : undefined;

      throw new UnipileApiError(
        `Unipile request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
        payload,
        type,
        detail
      );
    }

    return payload as T;
  }

  public async listAccounts(args: ListArgs = {}): Promise<Account[]> {
    const response = await this.request<UnipileListResponse<Account>>(
      withQuery("/api/v1/accounts", {
        limit: args.limit,
        cursor: args.cursor
      })
    );

    return response.items ?? [];
  }

  public async listAttendees(args: ListAttendeesArgs): Promise<ChatAttendee[]> {
    const response = await this.request<UnipileListResponse<ChatAttendee>>(
      withQuery("/api/v1/chat_attendees", {
        limit: args.limit,
        cursor: args.cursor,
        account_id: args.accountId
      })
    );

    return response.items ?? [];
  }

  public async listChats(args: ListChatsArgs): Promise<Chat[]> {
    const response = await this.request<UnipileListResponse<Chat>>(
      withQuery("/api/v1/chats", {
        limit: args.limit,
        cursor: args.cursor,
        account_id: args.accountId,
        unread: args.unread
      })
    );

    return response.items ?? [];
  }

  public async listMessages(args: ListMessagesArgs): Promise<Message[]> {
    const response = await this.request<UnipileListResponse<Message>>(
      withQuery("/api/v1/messages", {
        limit: args.limit,
        cursor: args.cursor,
        account_id: args.accountId,
        after: args.after,
        before: args.before
      })
    );

    return response.items ?? [];
  }

  public async listMessagesFromChat(chatId: string, args: ListMessagesArgs = {}): Promise<Message[]> {
    const response = await this.request<UnipileListResponse<Message>>(
      withQuery(`/api/v1/chats/${encodeURIComponent(chatId)}/messages`, {
        limit: args.limit,
        cursor: args.cursor,
        after: args.after,
        before: args.before
      })
    );

    return response.items ?? [];
  }

  public async sendMessage(args: {
    chatId: string;
    text: string;
    accountId?: string;
  }): Promise<{ object: string; message_id: string | null }> {
    const formData = new FormData();
    formData.set("text", args.text);

    if (args.accountId) {
      formData.set("account_id", args.accountId);
    }

    return this.request<{ object: string; message_id: string | null }>(
      `/api/v1/chats/${encodeURIComponent(args.chatId)}/messages`,
      {
        method: "POST",
        body: formData
      }
    );
  }

  public async startChat(args: StartChatArgs): Promise<{
    object: string;
    chat_id: string | null;
    message_id: string | null;
  }> {
    const formData = new FormData();
    formData.set("account_id", args.accountId);

    for (const attendeeId of args.attendeesIds) {
      formData.append("attendees_ids", attendeeId);
    }

    if (args.text && args.text.length > 0) {
      formData.set("text", args.text);
    }

    return this.request<{ object: string; chat_id: string | null; message_id: string | null }>(
      "/api/v1/chats",
      {
        method: "POST",
        body: formData
      }
    );
  }
}
