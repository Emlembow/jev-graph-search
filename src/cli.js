import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import {
  redactedConfig,
  resolveConfig,
  saveCredentials,
} from './config.js';

export const VERSION = '0.2.0';

const VALUE_OPTIONS = new Set([
  'input', 'output', 'limit', 'candidates', 'candidate-limit', 'max-chars',
  'from', 'to', 'max-hops', 'max-visited', 'page-types', 'min-links', 'min-outgoing',
  'plan', 'provider', 'model',
]);
const BOOLEAN_OPTIONS = new Set(['help', 'version', 'offline', 'semantic', 'from-env', 'no-cache']);
const SECRET_OPTION = /(?:api[-_]?key|token|secret|password)/i;

export const HELP = `jevgraph ${VERSION}

Read local Markdown folders directly, including Obsidian vaults and Logseq
Markdown graphs. JSON snapshots are optional. Offline inspection is key-free.
Semantic search, placement, and semantic audit require a configured Jev provider
unless --offline is set.

Commands:
  jevgraph audit --input PATH [--semantic] [--offline]
  jevgraph search QUERY --input PATH [--limit N --candidates N --max-chars N --offline --no-cache]
  jevgraph place TEXT --input PATH [same retrieval options]
  jevgraph traverse --input PATH --from ID --to ID [--max-hops N --max-visited N]
  jevgraph connections --input PATH --from ID --to ID
  jevgraph analysis-health --input PATH [--page-types a,b --min-outgoing N]
  jevgraph migration-plan --input PATH [--output FILE]
  jevgraph verify-migration --plan FILE --input TARGET_SNAPSHOT
  jevgraph setup [--provider typesafe|openrouter] [--from-env]
  jevgraph config
  jevgraph doctor

Options:
  --help       Show command help
  --version    Show the CLI version

--output creates a private file and refuses an existing path. Choose a new
filename for each export, and use a directory path without symbolic links.

API keys are accepted only from the environment or hidden setup input. They
are never command-line arguments, printed, or included in graph artifacts.
`;

const COMMAND_HELP = {
  audit: 'jevgraph audit --input PATH [--semantic] [--offline]\nAudit explicit graph structure; --semantic adds bounded Jev suggestions.',
  search: 'jevgraph search QUERY --input PATH [--limit N --candidates N --max-chars N --offline --no-cache]\nFind evidenced pages. Semantic mode is the default; --offline selects lexical retrieval.',
  place: 'jevgraph place TEXT --input PATH [--limit N --candidates N --max-chars N --offline]\nPropose a page for text placement without writing pages.',
  traverse: 'jevgraph traverse --input PATH --from ID --to ID [--max-hops N --max-visited N]\nFind a directed path without provider credentials.',
  connections: 'jevgraph connections --input PATH --from ID --to ID\nReport a path and shared connections without provider credentials.',
  'analysis-health': 'jevgraph analysis-health --input PATH [--page-types a,b --min-outgoing N]\nCheck explicitly tagged analysis, strategy, and assessment pages.',
  'migration-plan': 'jevgraph migration-plan --input PATH [--output FILE]\nCreate a deterministic proposal; no target writes occur.',
  'verify-migration': 'jevgraph verify-migration --plan FILE --input TARGET_SNAPSHOT\nVerify a target snapshot against a migration proposal.',
  setup: 'jevgraph setup [--provider typesafe|openrouter] [--from-env]\nPersist a hidden key prompt or an already-exported provider key.',
  config: 'jevgraph config\nPrint redacted credential presence, provider, and model metadata.',
  doctor: 'jevgraph doctor\nPrint redacted local configuration checks; no live authentication is attempted.',
};

function optionError(message) {
  throw new Error(message);
}

export function parseCliArgs(argv = []) {
  if (!Array.isArray(argv)) optionError('Arguments must be an array');
  const positionals = [];
  const options = {};
  let command;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      if (!command) command = token;
      else positionals.push(token);
      continue;
    }

    let name = token;
    let value;
    const equals = token.indexOf('=');
    if (equals !== -1) {
      name = token.slice(0, equals);
      value = token.slice(equals + 1);
    }
    if (name === '-h') name = '--help';
    if (name === '-v') name = '--version';
    if (!name.startsWith('--')) optionError(`Unknown option ${token}; use --help for usage`);
    const key = name.slice(2);
    if (SECRET_OPTION.test(key)) {
      optionError('API keys and tokens cannot be passed as command-line arguments; use environment variables or setup');
    }
    if (!VALUE_OPTIONS.has(key) && !BOOLEAN_OPTIONS.has(key)) {
      optionError(`Unknown option --${key}; use --help for usage`);
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      if (value !== undefined) optionError(`Boolean option --${key} does not accept a value`);
      options[key] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) optionError(`Option --${key} requires a value`);
      index += 1;
    }
    if (value === '') optionError(`Option --${key} requires a non-empty value`);
    options[key] = value;
  }
  if (options['candidate-limit'] !== undefined && options.candidates === undefined) {
    options.candidates = options['candidate-limit'];
  }
  return { command, positionals, options };
}

function numberOption(parsed, name, fallback, { min = 0, max = 1000000 } = {}) {
  const raw = parsed.options[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) optionError(`--${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    optionError(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredOption(parsed, name) {
  const value = parsed.options[name];
  if (!value) optionError(`--${name} is required; use --help for usage`);
  return value;
}

function csv(value) {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function printJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function emitJson(io, value, outputPath) {
  if (!outputPath) {
    printJson(io, value);
    return;
  }
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  // Check every component before creating descendants: recursive mkdir would
  // follow an existing directory symlink. Existing directory modes stay intact.
  let directory = path.parse(parent).root;
  for (const component of parent.slice(directory.length).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, component);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      const actual = await realpath(directory).catch(() => undefined);
      throw new Error(`Output directory path contains a symbolic link; choose a directory path without symbolic links.${actual ? ` Use ${JSON.stringify(actual)} in place of ${JSON.stringify(directory)}.` : ''}`);
    }
    if (!info.isDirectory()) {
      throw new Error('Output directory must contain only real directories, not symbolic links; choose a directory path without symbolic links');
    }
  }
  // Serialize before creating the staging file; only a complete, synced file is
  // published. link(), unlike rename(), atomically refuses any existing target,
  // including a dangling symlink or a concurrent writer's completed export.
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const staging = await mkdtemp(path.join(parent, '.jevgraph-output-'));
  const temporaryPath = path.join(staging, 'output.json');
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Output path already exists; choose a new --output filename. Existing files and symbolic links are never overwritten.');
      }
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

async function loadEngine() {
  return import('./graph.js');
}

async function loadRetrieval() {
  try {
    return await import('./retrieval.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Retrieval support is not present in this build; use graph commands or install a complete jevgraph package');
    }
    throw error;
  }
}

async function loadJev() {
  try {
    return await import('./jev.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Jev support is not present in this build');
    }
    throw error;
  }
}

async function loadCache() {
  try {
    return await import('./cache.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

async function semanticRuntime(io, offline, { cacheEnabled = true, model, provider } = {}) {
  if (provider !== undefined && provider !== 'typesafe' && provider !== 'openrouter') {
    throw new Error('--provider must be typesafe or openrouter');
  }
  const cacheModule = await loadCache();
  const cacheState = cacheModule
    ? await cacheModule.loadDiskCache({ enabled: cacheEnabled, env: io.env })
    : { cache: null, flush: async () => {}, warnings: [] };
  if (offline) return { jev: undefined, mode: 'off', offline: true, ...cacheState };
  const configEnv = provider ? { ...io.env, JEVGRAPH_PROVIDER: provider } : io.env;
  const config = await resolveConfig({ env: configEnv });
  if (!config.configured || !config.provider || !config.apiKey) {
    const selected = provider ? ` for provider ${provider}` : '';
    throw new Error(`Semantic mode requires a Jev credential${selected}. Set the matching provider environment key, run jevgraph setup, or explicitly pass --offline.`);
  }
  const { createJevClient } = await loadJev();
  return {
    jev: createJevClient({ provider: config.provider, apiKey: config.apiKey, model }),
    mode: 'required',
    offline: false,
    ...cacheState,
  };
}

function decorateCacheResult(result, runtime, warnings, persistenceFailed) {
  if (!result || typeof result !== 'object') return result;
  let decorated = result;
  if (warnings.length) {
    decorated = Array.isArray(result.warnings)
      ? { ...decorated, warnings: [...result.warnings, ...warnings] }
      : { ...decorated, warnings };
    if (result.retrieval && typeof result.retrieval === 'object') {
      decorated = {
        ...decorated,
        retrieval: {
          ...decorated.retrieval,
          warnings: [...(decorated.retrieval.warnings || []), ...warnings],
        },
      };
    }
  }
  if (!persistenceFailed) return decorated;
  const status = 'persistent-disk-unpersisted';
  if (decorated.metrics) decorated = { ...decorated, metrics: { ...decorated.metrics, cache_kind: status } };
  if (decorated.retrieval?.metrics) {
    decorated = {
      ...decorated,
      retrieval: {
        ...decorated.retrieval,
        metrics: { ...decorated.retrieval.metrics, cache_kind: status },
      },
    };
  }
  if (decorated.semantic?.metrics) {
    decorated = {
      ...decorated,
      semantic: {
        ...decorated.semantic,
        metrics: { ...decorated.semantic.metrics, cache_kind: status },
      },
    };
  }
  return decorated;
}

export async function finishCached(runtime, operation) {
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let flushError;
  try {
    await runtime.flush?.();
  } catch (error) {
    flushError = error;
  }
  // Preserve the operation's actionable error if both the operation and cache
  // persistence fail; a cache failure must never mask the real result error.
  if (operationError) throw operationError;
  const warnings = [...(runtime.warnings || [])];
  if (flushError) warnings.push('Semantic disk cache could not be persisted; retrieval results remain valid.');
  const persistenceFailed = Boolean(flushError) || warnings.some((warning) => /cache (?:was busy|could not be saved|could not be persisted)/iu.test(warning));
  return decorateCacheResult(result, runtime, [...new Set(warnings)], persistenceFailed);
}

async function handleSetup(parsed, io) {
  const requestedProvider = parsed.options.provider;
  if (requestedProvider !== undefined && requestedProvider !== 'typesafe' && requestedProvider !== 'openrouter') {
    optionError('--provider must be typesafe or openrouter');
  }
  let provider = requestedProvider;
  let apiKey;
  if (parsed.options['from-env']) {
    if (provider) {
      apiKey = provider === 'typesafe'
        ? (io.env.TYPESAFE_API_KEY || io.env.JEV_API_KEY)
        : io.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error(`No ${provider} key is present in the environment; export it or run interactive setup`);
    } else {
      const config = await resolveConfig({ env: io.env });
      if (!config.configured) throw new Error('No Jev credential is present in the environment; export TYPESAFE_API_KEY or OPENROUTER_API_KEY');
      provider = config.provider;
      apiKey = config.apiKey;
    }
  } else {
    if (!io.stdin?.isTTY || typeof io.stdin.setRawMode !== 'function') {
      throw new Error('Interactive setup needs a TTY. Export a provider key and rerun `jevgraph setup --from-env`.');
    }
    if (!provider) provider = await selectProvider(io);
    apiKey = await readHidden(io, `${provider === 'typesafe' ? 'TypeSafe' : 'OpenRouter'} API key: `);
    if (!apiKey) throw new Error('A non-empty API key is required');
  }
  const saved = await saveCredentials({ provider, apiKey }, { env: io.env });
  printJson(io, { configured: saved.configured, provider: saved.provider, path: saved.path });
}

function selectProvider(io) {
  const choices = [
    { label: 'TypeSafe', value: 'typesafe' },
    { label: 'OpenRouter', value: 'openrouter' },
  ];
  const { stdin } = io;
  const output = io.stderr || io.stdout;
  const wasRaw = Boolean(stdin.isRaw);
  return new Promise((resolve, reject) => {
    let selected = 0;
    let rendered = false;
    let finished = false;
    const clear = () => {
      if (rendered) output.write('\x1b[3A\x1b[0J');
    };
    const render = () => {
      clear();
      output.write('Choose a provider (↑/↓, Enter)\n');
      for (const [index, choice] of choices.entries()) {
        output.write(`${index === selected ? '❯' : ' '} ${choice.label}\n`);
      }
      rendered = true;
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      stdin.off('keypress', onKey);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      clear();
      if (error) reject(error);
      else {
        output.write(`Provider: ${choices[selected].label}\n`);
        resolve(choices[selected].value);
      }
    };
    const onKey = (_text, key = {}) => {
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') {
        finish(new Error('Setup cancelled'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'up' || key.name === 'down') {
        selected = (selected + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
        render();
      }
    };
    const onEnd = () => finish(new Error('Setup cancelled: input closed'));
    const onError = () => finish(new Error('Setup cancelled: input unavailable'));
    try {
      emitKeypressEvents(stdin);
      stdin.on('keypress', onKey);
      stdin.once('end', onEnd);
      stdin.once('error', onError);
      stdin.setRawMode(true);
      render();
      stdin.resume();
    } catch (error) {
      finish(error);
    }
  });
}

function readHidden(io, prompt) {
  const stdin = io.stdin;
  const stdout = io.stderr || io.stdout;
  return new Promise((resolve, reject) => {
    let value = '';
    let raw = false;
    const finish = (error, result) => {
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      if (error) reject(error);
      else {
        stdout.write('\n');
        resolve(result);
      }
    };
    const onData = (chunk) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') return finish(new Error('Setup cancelled'));
        if (char === '\r' || char === '\n') return finish(undefined, value);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
      return undefined;
    };
    try {
      stdout.write(prompt);
      raw = true;
      stdin.setRawMode(raw);
      stdin.resume();
      stdin.on('data', onData);
    } catch (error) {
      finish(error);
    }
  });
}

async function handleConfig(io, doctor = false) {
  const config = await resolveConfig({ env: io.env });
  const model = config.provider === 'openrouter' ? 'typesafe/jev-1.13' : config.provider === 'typesafe' ? 'jev-latest' : undefined;
  if (!doctor) {
    printJson(io, redactedConfig({
      configured: config.configured,
      provider: config.provider ?? null,
      model: model ?? null,
      source: config.source ?? null,
      configDir: config.configDir,
      credentialsPath: config.credentialsPath,
    }));
    return;
  }
  printJson(io, {
    configured: config.configured,
    provider: config.provider ?? null,
    model: model ?? null,
    credential_source: config.source ?? null,
    environment_keys: {
      typesafe: Boolean(io.env.TYPESAFE_API_KEY || io.env.JEV_API_KEY),
      openrouter: Boolean(io.env.OPENROUTER_API_KEY),
    },
    notes: ['Configuration shape checked locally; no live authentication was attempted.'],
  });
}

async function handleGraphCommand(parsed, io) {
  const engine = await loadEngine();
  const input = requiredOption(parsed, 'input');
  const graph = await engine.loadGraph(input);
  switch (parsed.command) {
    case 'audit': {
      const result = engine.auditGraph(graph, {
        minLinks: numberOption(parsed, 'min-links', numberOption(parsed, 'min-outgoing', 3)),
      });
      if (!parsed.options.semantic) return emitJson(io, result, parsed.options.output);
      const retrieval = await loadRetrieval();
      const runtime = await semanticRuntime(io, parsed.options.offline, {
        cacheEnabled: !parsed.options['no-cache'],
        model: parsed.options.model,
        provider: parsed.options.provider,
      });
      const combined = await finishCached(runtime, async () => ({
        ...result,
        semantic: await retrieval.semanticAudit(graph, runtime),
      }));
      return emitJson(io, combined, parsed.options.output);
    }
    case 'traverse':
      return emitJson(io, engine.traverseGraph(graph, {
        from: requiredOption(parsed, 'from'),
        to: requiredOption(parsed, 'to'),
        maxHops: numberOption(parsed, 'max-hops', 4, { max: 100 }),
        maxVisited: numberOption(parsed, 'max-visited', 1000, { min: 1, max: 1000000 }),
      }), parsed.options.output);
    case 'connections':
      return emitJson(io, engine.connectionsGraph(graph, {
        from: requiredOption(parsed, 'from'),
        to: requiredOption(parsed, 'to'),
        maxHops: numberOption(parsed, 'max-hops', 5, { max: 100 }),
        maxVisited: numberOption(parsed, 'max-visited', 1000, { min: 1, max: 1000000 }),
      }), parsed.options.output);
    case 'analysis-health':
      return emitJson(io, engine.analysisHealth(graph, {
        pageTypes: parsed.options['page-types'] ? csv(parsed.options['page-types']) : undefined,
        minOutgoing: numberOption(parsed, 'min-outgoing', 3),
      }), parsed.options.output);
    case 'migration-plan':
      return emitJson(io, engine.migrationPlan(graph), parsed.options.output);
    default:
      throw new Error(`Unsupported graph command ${parsed.command}`);
  }
}

async function handleRetrieval(parsed, io) {
  const runtime = await semanticRuntime(io, parsed.options.offline, {
    cacheEnabled: !parsed.options['no-cache'],
    model: parsed.options.model,
    provider: parsed.options.provider,
  });
  const retrieval = await loadRetrieval();
  const engine = await loadEngine();
  const graph = await engine.loadGraph(requiredOption(parsed, 'input'));
  const options = {
    limit: numberOption(parsed, 'limit', 5, { min: 1, max: 100 }),
    candidateLimit: numberOption(parsed, 'candidates', 20, { min: 1, max: 100 }),
    maxChars: numberOption(parsed, 'max-chars', 6000, { min: 1, max: 1000000 }),
    ...runtime,
  };
  const text = parsed.positionals.join(' ').trim();
  if (!text) optionError(`A ${parsed.command} query is required`);
  const result = await finishCached(runtime, () => parsed.command === 'search'
    ? retrieval.retrieve(graph, text, options)
    : retrieval.planPlacement(graph, text, options));
  return emitJson(io, result, parsed.options.output);
}

async function handleVerify(parsed, io) {
  const engine = await loadEngine();
  const plan = JSON.parse(await readFile(requiredOption(parsed, 'plan'), 'utf8'));
  const graph = await engine.loadGraph(requiredOption(parsed, 'input'));
  const result = engine.verifyMigration(plan, graph);
  await emitJson(io, result, parsed.options.output);
  if (!result.verified) throw new Error('Migration verification failed; inspect the emitted report for fidelity issues');
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const runtime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    ...io,
  };
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.options.version || parsed.command === 'version') {
      runtime.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.options.help || !parsed.command) {
      runtime.stdout.write(parsed.command && COMMAND_HELP[parsed.command] ? `${COMMAND_HELP[parsed.command]}\n` : HELP);
      return 0;
    }
    if (parsed.command === 'setup') await handleSetup(parsed, runtime);
    else if (parsed.command === 'config') await handleConfig(runtime);
    else if (parsed.command === 'doctor') await handleConfig(runtime, true);
    else if (parsed.command === 'search' || parsed.command === 'place') await handleRetrieval(parsed, runtime);
    else if (parsed.command === 'verify-migration') await handleVerify(parsed, runtime);
    else if (['audit', 'traverse', 'connections', 'analysis-health', 'migration-plan'].includes(parsed.command)) await handleGraphCommand(parsed, runtime);
    else throw new Error(`Unknown command ${parsed.command}; use --help for usage`);
    return 0;
  } catch (error) {
    runtime.stderr.write(`Error: ${error?.message || 'command failed'}\n`);
    return 1;
  }
}

export async function main() {
  return runCli();
}
