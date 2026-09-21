import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROVIDERS = new Set(['typesafe', 'openrouter']);
const CREDENTIALS_FILE = 'credentials.env';
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSecretKey(key) {
  if (!key) return false;
  const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
  return normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password');
}

/** Error raised for invalid configuration or credentials input. */
export class ConfigError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

function environment(options = {}) {
  return options.env ?? process.env;
}

function homeDirectory(options = {}) {
  return options.homeDir ?? os.homedir();
}

/**
 * Resolve the per-user configuration directory.
 *
 * Tests and embedders can pass configDir directly. Otherwise XDG_CONFIG_HOME
 * is used, with ~/.config as the portable fallback (and APPDATA on Windows).
 */
export function getConfigDir(options = {}) {
  if (options.configDir) return path.resolve(options.configDir);

  const env = environment(options);
  const base = env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' && env.APPDATA) ||
    path.join(homeDirectory(options), '.config');
  return path.resolve(base, 'jevgraph');
}

function credentialsPath(options = {}) {
  if (options.credentialsPath) return path.resolve(options.credentialsPath);
  return path.join(getConfigDir(options), CREDENTIALS_FILE);
}

function invalidValue(field) {
  throw new ConfigError(`Invalid ${field}; values must be non-empty and contain no whitespace or line breaks`);
}

function validSecret(value, field) {
  if (typeof value !== 'string' || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    invalidValue(field);
  }
  return value;
}

function validProvider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    throw new ConfigError('Invalid JEVGRAPH_PROVIDER; expected typesafe or openrouter');
  }
  return value;
}

function parseEnvFile(contents) {
  const values = Object.create(null);
  const seen = new Set();
  const lines = contents.split('\n');

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match || seen.has(match[1])) {
      throw new ConfigError(`Invalid credentials file format at line ${lineNumber}`);
    }
    const [, key, value] = match;
    if (!KEY_NAME.test(key) || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      throw new ConfigError(`Invalid credentials file format at line ${lineNumber}`);
    }
    seen.add(key);
    values[key] = value;
  });

  return values;
}

async function loadSavedValues(filePath) {
  try {
    const contents = await readFile(filePath, 'utf8');
    return parseEnvFile(contents);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.create(null);
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Unable to read credentials file');
  }
}

function field(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return { present: false };
  const value = source[key];
  // An empty variable is conventionally treated as unset, allowing a saved
  // value to remain useful when a shell exports KEY="".
  if (value === undefined || value === '') return { present: false };
  return { present: true, value };
}

function pickValue(env, saved, names) {
  // Environment values always win over file values. The official direct key
  // wins over the compatibility alias within either source.
  for (const source of [env, saved]) {
    for (const key of names) {
      const candidate = field(source, key);
      if (candidate.present) return { ...candidate, key, source: source === env ? 'env' : 'file' };
    }
  }
  return { present: false };
}

function pickProvider(env, saved) {
  return pickValue(env, saved, ['JEVGRAPH_PROVIDER']);
}

function keyForProvider(provider) {
  return provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
}

function configResult({ env, saved, configDir, filePath }) {
  const providerCandidate = pickProvider(env, saved);
  const provider = providerCandidate.present ? validProvider(providerCandidate.value) : undefined;
  const envTypesafe = pickValue(env, Object.create(null), ['TYPESAFE_API_KEY', 'JEV_API_KEY']);
  const envOpenrouter = pickValue(env, Object.create(null), ['OPENROUTER_API_KEY']);
  const typesafe = pickValue(env, saved, ['TYPESAFE_API_KEY', 'JEV_API_KEY']);
  const openrouter = pickValue(env, saved, ['OPENROUTER_API_KEY']);
  const hasTypesafe = typesafe.present;
  const hasOpenrouter = openrouter.present;

  // A key supplied by the process environment selects its provider when the
  // environment names only one provider. This keeps environment precedence
  // useful even when a saved file contains credentials for the other one.
  const envProvider = envTypesafe.present && !envOpenrouter.present
    ? 'typesafe'
    : envOpenrouter.present && !envTypesafe.present
      ? 'openrouter'
      : undefined;
  const selectedProvider = providerCandidate.source === 'env'
    ? provider
    : envProvider ?? provider ?? (hasTypesafe && hasOpenrouter
      ? undefined
      : hasTypesafe ? 'typesafe' : hasOpenrouter ? 'openrouter' : undefined);

  if (!selectedProvider && hasTypesafe && hasOpenrouter) {
    throw new ConfigError('Both Typesafe and OpenRouter credentials are configured; set JEVGRAPH_PROVIDER to choose one');
  }

  const selected = selectedProvider === 'typesafe' ? typesafe : selectedProvider === 'openrouter' ? openrouter : undefined;
  const apiKey = selected?.present ? validSecret(selected.value, `${selectedProvider} API key`) : undefined;

  return {
    configured: Boolean(apiKey),
    provider: selectedProvider,
    apiKey,
    // Provider-specific fields make inspection and provider switching easy for
    // callers; redactedConfig removes their values before display.
    typesafeApiKey: hasTypesafe ? validSecret(typesafe.value, 'Typesafe API key') : undefined,
    openrouterApiKey: hasOpenrouter ? validSecret(openrouter.value, 'OpenRouter API key') : undefined,
    source: selected?.source,
    configDir,
    credentialsPath: filePath,
  };
}

/** Resolve environment credentials over the saved credentials file. */
export async function resolveConfig(options = {}) {
  const filePath = credentialsPath(options);
  const saved = await loadSavedValues(filePath);
  return configResult({
    env: environment(options),
    saved,
    configDir: getConfigDir(options),
    filePath,
  });
}

function candidate(credentials, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(credentials, name)) {
      return { present: true, value: credentials[name], name };
    }
  }
  return { present: false };
}

function readCredentialUpdates(credentials, existing) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new ConfigError('Credentials must be an object');
  }

  const explicitProvider = candidate(credentials, ['provider', 'JEVGRAPH_PROVIDER']);
  const provider = explicitProvider.present ? validProvider(explicitProvider.value) : undefined;
  const directTypesafe = candidate(credentials, ['typesafeApiKey', 'TYPESAFE_API_KEY']);
  const aliasTypesafe = candidate(credentials, ['jevApiKey', 'JEV_API_KEY']);
  const openrouter = candidate(credentials, ['openrouterApiKey', 'OPENROUTER_API_KEY']);
  const generic = candidate(credentials, ['apiKey']);
  const updates = Object.create(null);

  if (directTypesafe.present) updates.TYPESAFE_API_KEY = validSecret(directTypesafe.value, 'Typesafe API key');
  if (aliasTypesafe.present) updates.JEV_API_KEY = validSecret(aliasTypesafe.value, 'JEV API key');
  if (openrouter.present) updates.OPENROUTER_API_KEY = validSecret(openrouter.value, 'OpenRouter API key');

  if (generic.present) {
    const genericProvider = provider ??
      (existing.JEVGRAPH_PROVIDER && PROVIDERS.has(existing.JEVGRAPH_PROVIDER) ? existing.JEVGRAPH_PROVIDER : undefined);
    if (!genericProvider) {
      throw new ConfigError('An apiKey requires provider: typesafe or openrouter');
    }
    updates[keyForProvider(genericProvider)] = validSecret(generic.value, `${genericProvider} API key`);
  }

  const suppliedProviderKeys = [directTypesafe.present || aliasTypesafe.present, openrouter.present];
  if (!provider && suppliedProviderKeys[0] && suppliedProviderKeys[1]) {
    throw new ConfigError('Both Typesafe and OpenRouter credentials were supplied; set provider to choose one');
  }
  if (explicitProvider.present) updates.JEVGRAPH_PROVIDER = provider;
  if (Object.keys(updates).length === 0) {
    throw new ConfigError('No credentials were supplied');
  }
  return updates;
}

function serializeEnv(values) {
  const ordered = [];
  for (const key of ['JEVGRAPH_PROVIDER', 'TYPESAFE_API_KEY', 'JEV_API_KEY', 'OPENROUTER_API_KEY']) {
    if (Object.prototype.hasOwnProperty.call(values, key)) ordered.push(key);
  }
  for (const key of Object.keys(values).sort()) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return `${ordered.map((key) => `${key}=${values[key]}`).join('\n')}\n`;
}

async function atomicWrite(filePath, contents) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);

  const temporaryPath = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ConfigError('Unable to save credentials');
  }
}

/** Save credentials with restrictive permissions and an atomic replacement. */
export async function saveCredentials(credentials, options = {}) {
  const filePath = credentialsPath(options);
  const existing = await loadSavedValues(filePath);
  const updates = readCredentialUpdates(credentials, existing);
  const merged = { ...existing, ...updates };
  const contents = serializeEnv(merged);
  await atomicWrite(filePath, contents);
  return {
    path: filePath,
    configDir: getConfigDir(options),
    provider: merged.JEVGRAPH_PROVIDER,
    configured: Boolean(merged.TYPESAFE_API_KEY || merged.JEV_API_KEY || merged.OPENROUTER_API_KEY),
  };
}

function redact(value, key, seen) {
  if (isSecretKey(key)) return '[redacted]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));
  const copy = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = redact(childValue, childKey, seen);
  }
  return copy;
}

/** Return a display-safe copy of a resolved config or arbitrary config object. */
export function redactedConfig(config) {
  return redact(config, undefined, new WeakSet());
}
