import fs from 'fs/promises';
import matter from 'gray-matter';
import path from 'path';
import { loadPosts } from './loader';
import { Logger, TagSyncConfig } from './types';
import { ensureArray, toPosix } from './utils';
import { readTagsFile } from './writer';

interface FrontmatterSyncOptions {
  dryRun: boolean;
  filter: string;
  includeDrafts: boolean;
  sortTags: boolean;
}

export interface FrontmatterSyncResult {
  updated: string[];
  unchanged: string[];
  missing: string[];
  filteredOut: string[];
  totalEntries: number;
}

function dedupeTags(tags: string[], sort: boolean): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  }
  const normalized = Array.from(seen.values());
  if (sort) {
    return normalized.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  return normalized;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function formatDateLikeHexo(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return formatDateLikeHexo(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, normalizeValue(inner)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function normalizeFrontMatter(data: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const normalizedValue = normalizeValue(value);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function stripTimestampQuotes(serialized: string): string {
  const closingIndex = serialized.indexOf('\n---', 4);
  if (closingIndex === -1) {
    return serialized;
  }
  const frontMatterSection = serialized.slice(0, closingIndex);
  const contentSection = serialized.slice(closingIndex);
  const adjustedFrontMatter = frontMatterSection.replace(
    /^([A-Za-z0-9_-]+): '(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'$/gm,
    '$1: $2'
  );
  return `${adjustedFrontMatter}${contentSection}`;
}

function extractScalarLiterals(frontMatterRaw: string): Record<string, string> {
  if (!frontMatterRaw) return {};
  const result: Record<string, string> = {};
  const lines = frontMatterRaw.split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    const trimmed = rawValue.trim();
    if (trimmed === '' || trimmed === '|' || trimmed === '>' || trimmed === '>-') {
      continue;
    }
    if (trimmed.startsWith('- ')) continue;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) continue;
    result[key] = trimmed;
  }
  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function syncFrontmatterFromTags(
  config: TagSyncConfig,
  logger: Logger,
  options: FrontmatterSyncOptions
): Promise<FrontmatterSyncResult> {
  const tagsMap = await readTagsFile(config.tagsJsonPath, logger);
  const entries = Object.entries(tagsMap);
  const totalEntries = entries.length;

  if (totalEntries === 0) {
    logger.warn(`No entries found in ${config.tagsJsonRaw}. Nothing to apply.`);
    return { updated: [], unchanged: [], missing: [], filteredOut: [], totalEntries: 0 };
  }

  const posts = await loadPosts(config.postRoot, {
    filter: options.filter,
    includeDrafts: options.includeDrafts,
    logger,
    workspaceRoot: config.workspaceRoot
  });

  const postMap = new Map(posts.map((post) => [toPosix(post.relativePath), post]));
  const updated: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const filteredOut: string[] = [];

  const filterApplied = options.filter.trim().length > 0;

  for (const [rawPath, tagList] of entries) {
    const relativePath = toPosix(rawPath);
    const post = postMap.get(relativePath);
    if (!post) {
      const absoluteCandidate = path.resolve(config.workspaceRoot, relativePath);
      if (filterApplied) {
        filteredOut.push(relativePath);
      } else if (await fileExists(absoluteCandidate)) {
        filteredOut.push(relativePath);
      } else {
        missing.push(relativePath);
      }
      continue;
    }

    const expectedTags = dedupeTags(tagList, options.sortTags);
    const currentTags = dedupeTags(ensureArray(post.frontMatter.tags), options.sortTags);

    if (arraysEqual(expectedTags, currentTags)) {
      unchanged.push(relativePath);
      continue;
    }

    const dataWithTags = { ...post.frontMatter, tags: expectedTags } as Record<string, unknown>;
    const scalarLiterals = extractScalarLiterals(post.frontMatterRaw);
    for (const [key, value] of Object.entries(dataWithTags)) {
      if (value instanceof Date) {
        dataWithTags[key] = scalarLiterals[key] ?? formatDateLikeHexo(value);
      }
    }
    const nextData = normalizeFrontMatter(dataWithTags);
    const serialized = stripTimestampQuotes(matter.stringify(post.content, nextData));

    if (options.dryRun) {
      logger.info(`Dry run: would update tags in ${relativePath}`);
    } else {
      await fs.writeFile(post.absolutePath, serialized, 'utf8');
      logger.info(`Updated tags in ${relativePath}`);
    }

    updated.push(relativePath);
  }

  if (!options.dryRun && updated.length === 0) {
    logger.info('All matching posts already up to date.');
  }

  return {
    updated,
    unchanged,
    missing,
    filteredOut,
    totalEntries
  };
}
