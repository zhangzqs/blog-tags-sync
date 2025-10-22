import fs from 'fs/promises';
import path from 'path';
import { Logger, TagsMap, TagSyncConfig, WriteResult } from './types';

export async function readTagsFile(filePath: string, logger: Logger): Promise<TagsMap> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as TagsMap;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug?.(`Existing tags.json not found at ${filePath}.`);
      return {};
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`Failed to read existing tags.json: ${message}`);
    return {};
  }
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildDiff(existing: TagsMap, next: TagsMap) {
  const updatedPaths: string[] = [];
  for (const [relativePath, tags] of Object.entries(next)) {
    const previous = existing[relativePath];
    if (!arraysEqual(previous, tags)) {
      updatedPaths.push(relativePath);
    }
  }

  const removedPaths = Object.keys(existing).filter((key) => !(key in next));
  return { updatedPaths, removedPaths };
}

function formatSampleDiff(existing: TagsMap, next: TagsMap, paths: string[]): Array<{ path: string; before: string[] | undefined; after: string[] | undefined }> {
  return paths.slice(0, 10).map((relativePath) => ({
    path: relativePath,
    before: existing[relativePath],
    after: next[relativePath]
  }));
}

export async function writeTagsSnapshot(tags: TagsMap, config: TagSyncConfig, logger: Logger, reason?: string): Promise<void> {
  await fs.mkdir(path.dirname(config.tagsJsonPath), { recursive: true });
  const serialized = JSON.stringify(tags, null, 2);
  await fs.writeFile(config.tagsJsonPath, serialized, 'utf8');
  logger.debug(`Incremental tags.json update${reason ? ` after ${reason}` : ''}`);
}

export async function writeTagsFile(tags: TagsMap, config: TagSyncConfig, logger: Logger): Promise<WriteResult> {
  const existing = await readTagsFile(config.tagsJsonPath, logger);
  const { updatedPaths, removedPaths } = buildDiff(existing, tags);
  const created = Object.keys(existing).length === 0;
  const changedPaths = [...updatedPaths, ...removedPaths];

  if (config.dryRun) {
    logger.info(`Dry run enabled. ${changedPaths.length} entries would change.`);
    if (changedPaths.length > 0) {
      logger.info('Sample diff:', formatSampleDiff(existing, tags, changedPaths));
    }
    return {
      updatedPaths: changedPaths,
      skippedPaths: [],
      created: false
    };
  }

  await fs.mkdir(path.dirname(config.tagsJsonPath), { recursive: true });
  const serialized = JSON.stringify(tags, null, 2);
  await fs.writeFile(config.tagsJsonPath, serialized, 'utf8');
  logger.info(`Tags written to ${config.tagsJsonPath}. Updated ${changedPaths.length} entries.`);

  return {
    updatedPaths: changedPaths,
    skippedPaths: [],
    created
  };
}
