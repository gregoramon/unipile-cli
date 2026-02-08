export type OutputMode = "text" | "json";

export interface GlobalCliOptions {
  profile: string;
  output: OutputMode;
  nonInteractive: boolean;
}

export interface ProfileConfig {
  dsn: string;
  qmdCollection?: string;
  qmdCommand?: string;
  autoSendThreshold?: number;
  autoSendMargin?: number;
}

export interface AppConfig {
  profile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface Account {
  id: string;
  type: string;
  name: string;
  created_at?: string;
  connection_params?: Record<string, unknown>;
  sources?: Array<{ id: string; status: string }>;
}

export interface ChatAttendee {
  id: string;
  account_id: string;
  provider_id: string;
  name: string;
  is_self: 0 | 1;
  profile_url?: string;
  picture_url?: string;
  specifics?: Record<string, unknown>;
}

export interface Chat {
  id: string;
  account_id: string;
  account_type: string;
  type?: number;
  provider_id?: string;
  attendee_provider_id?: string;
  name?: string | null;
  timestamp?: string | null;
  unread_count?: number;
}

export interface Message {
  id: string;
  account_id: string;
  chat_id: string;
  sender_id: string;
  text?: string | null;
  timestamp?: string;
}

export interface UnipileListResponse<T> {
  object: string;
  items: T[];
  cursor?: string | null;
}

export interface QmdHit {
  text: string;
  source?: string;
  score?: number;
}

export interface QmdQueryResult {
  available: boolean;
  hits: QmdHit[];
  error?: string;
}

export interface ContactCandidate {
  attendee: ChatAttendee;
  lexicalScore: number;
  recencyScore: number;
  qmdScore: number;
  totalScore: number;
  matchedBy: string[];
}

export type ResolutionStatus = "resolved" | "ambiguous" | "not_found";

export interface ContactResolution {
  query: string;
  status: ResolutionStatus;
  selected?: ContactCandidate;
  candidates: ContactCandidate[];
  threshold: number;
  margin: number;
}
