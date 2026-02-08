import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig, ProfileConfig } from "./types.js";

const CONFIG_DIR_ENV = "UNIPILE_CLI_CONFIG_DIR";
const CONFIG_FILE = "config.json";

export function getConfigDir(): string {
  return process.env[CONFIG_DIR_ENV] ?? join(homedir(), ".config", "unipile-cli");
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE);
}

export function getDefaultConfig(): AppConfig {
  return {
    profile: "default",
    profiles: {
      default: {
        dsn: "",
        qmdCollection: "memory-root",
        qmdCommand: "qmd",
        autoSendThreshold: 0.9,
        autoSendMargin: 0.15
      }
    }
  };
}

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 });
}

export async function loadConfig(): Promise<AppConfig> {
  const path = getConfigPath();
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const defaults = getDefaultConfig();

    return {
      profile: parsed.profile ?? defaults.profile,
      profiles: { ...defaults.profiles, ...(parsed.profiles ?? {}) }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultConfig();
    }
    throw error;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
}

export function getProfileConfig(config: AppConfig, profileName: string): ProfileConfig {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" not found. Run \"unipile auth set ... --profile ${profileName}\" first.`
    );
  }
  return profile;
}

export function upsertProfile(
  config: AppConfig,
  profileName: string,
  partial: Partial<ProfileConfig>
): AppConfig {
  const existing = config.profiles[profileName] ?? getDefaultConfig().profiles.default;

  return {
    ...config,
    profile: profileName,
    profiles: {
      ...config.profiles,
      [profileName]: {
        ...existing,
        ...partial
      }
    }
  };
}
