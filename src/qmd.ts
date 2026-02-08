import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QmdHit, QmdQueryResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface QmdQueryOptions {
  command?: string;
  collection?: string;
  timeoutMs?: number;
  maxHits?: number;
}

function toHit(entry: unknown): QmdHit | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const asRecord = entry as Record<string, unknown>;
  const textCandidate =
    asRecord.text ?? asRecord.snippet ?? asRecord.content ?? asRecord.chunk ?? asRecord.body;

  if (typeof textCandidate !== "string" || textCandidate.trim().length === 0) {
    return null;
  }

  const sourceCandidate = asRecord.source ?? asRecord.path ?? asRecord.file;
  const scoreCandidate = asRecord.score ?? asRecord.similarity ?? asRecord.rank;

  return {
    text: textCandidate,
    source: typeof sourceCandidate === "string" ? sourceCandidate : undefined,
    score: typeof scoreCandidate === "number" ? scoreCandidate : undefined
  };
}

function normalizeHits(payload: unknown): QmdHit[] {
  if (Array.isArray(payload)) {
    return payload.map(toHit).filter((hit): hit is QmdHit => hit !== null);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const list = record.hits ?? record.results ?? record.items ?? record.data;
  return normalizeHits(list);
}

export async function queryQmd(query: string, options: QmdQueryOptions = {}): Promise<QmdQueryResult> {
  const command = options.command ?? "qmd";
  const collection = options.collection ?? "memory-root";

  try {
    const { stdout } = await execFileAsync(
      command,
      ["query", query, "-c", collection, "--json"],
      {
        timeout: options.timeoutMs ?? 4000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const rawOutput = stdout.trim();
    if (rawOutput.length === 0) {
      return {
        available: true,
        hits: []
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      return {
        available: false,
        hits: [],
        error: "QMD returned non-JSON output."
      };
    }

    return {
      available: true,
      hits: normalizeHits(parsed).slice(0, options.maxHits ?? 12)
    };
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;

    if (asNodeError.code === "ENOENT") {
      return {
        available: false,
        hits: [],
        error: "QMD command not found on PATH."
      };
    }

    return {
      available: false,
      hits: [],
      error: asNodeError.message
    };
  }
}
