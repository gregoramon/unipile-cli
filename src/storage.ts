import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

const SERVICE_NAME = "unipile-cli";
const SECRET_FILE = "secrets.json";

type SecretBackend = "keychain" | "file";

interface SecretStore {
  backend: SecretBackend;
  get(secretKey: string): Promise<string | null>;
  set(secretKey: string, value: string): Promise<void>;
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

class FileSecretStore implements SecretStore {
  public readonly backend: SecretBackend = "file";

  private get path(): string {
    return join(getConfigDir(), SECRET_FILE);
  }

  public async get(secretKey: string): Promise<string | null> {
    const all = await this.readAll();
    return all[secretKey] ?? null;
  }

  public async set(secretKey: string, value: string): Promise<void> {
    const all = await this.readAll();
    all[secretKey] = value;
    await this.writeAll(all);
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async writeAll(payload: Record<string, string>): Promise<void> {
    await ensureConfigDir();
    await fs.writeFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600
    });
  }
}

class KeytarSecretStore implements SecretStore {
  public readonly backend: SecretBackend = "keychain";

  public constructor(private readonly keytar: KeytarLike) {}

  public async get(secretKey: string): Promise<string | null> {
    return this.keytar.getPassword(SERVICE_NAME, secretKey);
  }

  public async set(secretKey: string, value: string): Promise<void> {
    await this.keytar.setPassword(SERVICE_NAME, secretKey, value);
  }
}

let cachedStore: SecretStore | null = null;

function buildSecretKey(profile: string): string {
  return `${profile}:api-key`;
}

async function loadOptionalKeytar(): Promise<KeytarLike | null> {
  try {
    const importer = new Function("specifier", "return import(specifier);") as (
      specifier: string
    ) => Promise<unknown>;

    const moduleObject = (await importer("keytar")) as { default?: unknown } | undefined;
    const candidate = (moduleObject?.default ?? moduleObject) as Partial<KeytarLike> | undefined;

    if (
      candidate &&
      typeof candidate.getPassword === "function" &&
      typeof candidate.setPassword === "function"
    ) {
      return candidate as KeytarLike;
    }
  } catch {
    return null;
  }

  return null;
}

async function getSecretStore(): Promise<SecretStore> {
  if (cachedStore) {
    return cachedStore;
  }

  const keytar = await loadOptionalKeytar();
  if (!keytar) {
    cachedStore = new FileSecretStore();
    return cachedStore;
  }

  const keytarStore = new KeytarSecretStore(keytar);
  try {
    // Probe keychain access once; some headless environments throw runtime errors.
    await keytarStore.get("__unipile_cli_probe__");
    cachedStore = keytarStore;
  } catch {
    cachedStore = new FileSecretStore();
  }

  return cachedStore;
}

async function withFallback<T>(
  action: (store: SecretStore) => Promise<T>
): Promise<{ value: T; backend: SecretBackend }> {
  const store = await getSecretStore();
  try {
    const value = await action(store);
    return { value, backend: store.backend };
  } catch {
    if (store.backend === "keychain") {
      const fallback = new FileSecretStore();
      cachedStore = fallback;
      const value = await action(fallback);
      return { value, backend: fallback.backend };
    }
    throw new Error("Failed to access configured secret store.");
  }
}

export async function setProfileApiKey(
  profile: string,
  apiKey: string
): Promise<{ backend: SecretBackend }> {
  const result = await withFallback((resolvedStore) =>
    resolvedStore.set(buildSecretKey(profile), apiKey)
  );
  return { backend: result.backend };
}

export async function getProfileApiKey(
  profile: string
): Promise<{ apiKey: string | null; backend: SecretBackend }> {
  const result = await withFallback((resolvedStore) =>
    resolvedStore.get(buildSecretKey(profile))
  );
  return { apiKey: result.value, backend: result.backend };
}
