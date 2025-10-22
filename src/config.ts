import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { ConfigOverrides, TagSyncConfig, TaxonomyRules } from './types';
import { parseJsonSilent } from './utils';

let dotenvLoaded = false;

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;
  const maxDepth = 10;
  for (let i = 0; i < maxDepth; i += 1) {
    if (fs.existsSync(path.join(current, 'source', '_posts')) || fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return startDir;
}

function loadEnvironment(workspaceRoot: string, runtimeCwd: string): void {
  if (dotenvLoaded) return;

  const candidates = [
    path.join(workspaceRoot, '.env'),
    path.join(runtimeCwd, '.env')
  ];

  let loaded = false;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      loaded = true;
      break;
    }
  }

  if (!loaded) {
    dotenv.config();
  }

  dotenvLoaded = true;
}

export function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function parseInteger(value: unknown, defaultValue: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return defaultValue;
}

function parseHeaders(raw: string | undefined | null): Record<string, string> {
  const parsed = parseJsonSilent<Record<string, string>>(raw ?? '', {});
  const entries = Object.entries(parsed ?? {})
    .filter(([key, val]) => typeof key === 'string' && val !== undefined && val !== null)
    .map(([key, val]) => [key, String(val)] as const);
  return Object.fromEntries(entries);
}

function resolvePath(baseDir: string, target: string): string {
  if (!target) return baseDir;
  if (path.isAbsolute(target)) return target;
  return path.resolve(baseDir, target);
}

function loadTaxonomyRules(configPath: string | undefined | null, workspaceRoot: string): TaxonomyRules | null {
  if (!configPath) {
    return null;
  }
  const resolved = resolvePath(workspaceRoot, configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Tag Sync: Taxonomy config path not found: ${resolved}`);
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return JSON.parse(raw) as TaxonomyRules;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tag Sync: Failed to parse taxonomy rules from ${resolved}: ${message}`);
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): TagSyncConfig {
  const runtimeCwd = process.cwd();
  const workspaceRoot = findWorkspaceRoot(runtimeCwd);

  loadEnvironment(workspaceRoot, runtimeCwd);

  const postRootInput = overrides.postRoot ?? process.env.TAG_SYNC_POST_ROOT ?? 'source/_posts';
  const postRoot = resolvePath(workspaceRoot, postRootInput);
  const tagsJsonInput = overrides.tagsJson ?? process.env.TAG_SYNC_TAGS_JSON ?? 'tags.json';
  const tagsJsonPath = resolvePath(workspaceRoot, tagsJsonInput);
  const apiKey = overrides.apiKey ?? process.env.TAG_SYNC_API_KEY ?? '';
  const model = overrides.model ?? process.env.TAG_SYNC_MODEL ?? 'gpt-4o-mini';
  const baseUrl = (overrides.baseUrl ?? process.env.TAG_SYNC_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const proxyCandidate = overrides.proxyUrl ?? process.env.TAG_SYNC_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  const proxyUrl = typeof proxyCandidate === 'string' && proxyCandidate.trim().length > 0 ? proxyCandidate.trim() : null;
  const language = overrides.language ?? process.env.TAG_SYNC_LANGUAGE ?? 'zh';
  const dryRun = overrides.dryRun ?? parseBoolean(process.env.TAG_SYNC_DRY_RUN, false);
  const includeDrafts = overrides.includeDrafts ?? parseBoolean(process.env.TAG_SYNC_INCLUDE_DRAFTS, false);
  const filter = overrides.filter ?? process.env.TAG_SYNC_FILTER ?? '';
  const timeoutSeconds = overrides.timeoutSeconds ?? process.env.TAG_SYNC_TIMEOUT ?? 30;
  const timeoutMs = parseInteger(timeoutSeconds, 30) * 1000;
  const maxConcurrencyRaw = overrides.maxConcurrency ?? process.env.TAG_SYNC_MAX_CONCURRENCY ?? 3;
  const maxConcurrency = Math.max(1, parseInteger(maxConcurrencyRaw, 3));
  const sortTags = overrides.sortTags ?? parseBoolean(process.env.TAG_SYNC_SORT_TAGS, true);
  const debug = overrides.debug ?? parseBoolean(process.env.TAG_SYNC_DEBUG, false);
  const taxonomyRules = loadTaxonomyRules(overrides.taxonomyPath ?? process.env.TAG_SYNC_TAXONOMY_JSON, workspaceRoot);
  const extraHeaders = parseHeaders(overrides.extraHeaders ?? process.env.TAG_SYNC_EXTRA_HEADERS);

  if (!fs.existsSync(postRoot)) {
    throw new Error(`Tag Sync: Post root directory not found: ${postRoot}`);
  }

  return {
    cwd: runtimeCwd,
    workspaceRoot,
    postRoot,
    postRootRaw: path.relative(workspaceRoot, postRoot) || postRoot,
    tagsJsonPath,
    tagsJsonRaw: path.relative(workspaceRoot, tagsJsonPath) || tagsJsonPath,
    apiKey,
    model,
    baseUrl,
  proxyUrl,
    language,
    dryRun,
    includeDrafts,
    filter,
    timeoutMs,
    maxConcurrency,
    sortTags,
    debug,
    taxonomyRules,
    extraHeaders
  };
}
