#!/usr/bin/env node
/* eslint-disable no-console */

import process from 'process';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { loadPosts } from './loader';
import { generateTags } from './llm';
import { syncFrontmatterFromTags } from './frontmatter';
import { readTagsFile, writeTagsFile, writeTagsSnapshot } from './writer';
import { TagsMap, SyncStatistics, LlmResponse, MergeResult, TagSyncConfig, Logger } from './types';

interface CliOptions {
  dryRun?: boolean;
  includeDrafts?: boolean;
  filter?: string;
  debug?: boolean;
  full?: boolean;
}

type CommandName = 'generate' | 'apply';

const COMMAND_ALIASES = new Map<string, CommandName>([
  ['generate', 'generate'],
  ['sync', 'generate'],
  ['frontmatter', 'apply'],
  ['apply', 'apply'],
  ['apply-frontmatter', 'apply'],
  ['tags-to-frontmatter', 'apply']
]);

function extractCommand(argv: string[]): { command: CommandName; rest: string[] } {
  if (argv.length === 0) {
    return { command: 'generate', rest: [] };
  }
  const [first, ...rest] = argv;
  if (first.startsWith('--')) {
    return { command: 'generate', rest: argv };
  }
  const normalized = first.toLowerCase();
  const mapped = COMMAND_ALIASES.get(normalized);
  if (!mapped) {
    return { command: 'generate', rest: argv };
  }
  return { command: mapped, rest };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [flag, rawValue] = arg.slice(2).split('=');
    switch (flag) {
      case 'dry-run':
        options.dryRun = rawValue ? rawValue !== 'false' : true;
        break;
      case 'include-drafts':
        options.includeDrafts = rawValue ? rawValue !== 'false' : true;
        break;
      case 'filter':
        options.filter = rawValue ?? '';
        break;
      case 'debug':
        options.debug = rawValue ? rawValue !== 'false' : true;
        break;
      case 'full':
      case 'force-full':
        options.full = rawValue ? rawValue !== 'false' : true;
        break;
      default:
        break;
    }
  }
  return options;
}

function buildStatistics(
  postsCount: number,
  merges: Map<string, { tags: string[]; added: string[] }>,
  responses: Map<string, { error?: Error | null; tags: string[] }>
): SyncStatistics {
  let processedPosts = 0;
  let llmCalls = 0;
  let llmFailures = 0;
  let totalTags = 0;
  let totalNewTags = 0;

  for (const [path, merge] of merges.entries()) {
    processedPosts += 1;
    totalTags += merge.tags.length;
    totalNewTags += merge.added.length;
    const response = responses.get(path);
    if (response) {
      llmCalls += 1;
      if (response.error) {
        llmFailures += 1;
      }
    }
  }

  return {
    totalPosts: postsCount,
    processedPosts,
    skippedPosts: postsCount - processedPosts,
    llmCalls,
    llmFailures,
    totalTags,
    totalNewTags
  };
}

function sortTagsMap(map: TagsMap): TagsMap {
  return Object.fromEntries(Object.entries(map).sort((a, b) => a[0].localeCompare(b[0], 'en-US')));
}

async function runGenerate(args: CliOptions, config: TagSyncConfig, scopedLogger: Logger): Promise<void> {
  scopedLogger.info(`Scanning posts from ${config.postRootRaw}`);
  const posts = await loadPosts(config.postRoot, {
    filter: config.filter,
    includeDrafts: config.includeDrafts,
    logger: scopedLogger,
    workspaceRoot: config.workspaceRoot
  });

  if (posts.length === 0) {
    scopedLogger.warn('No posts found matching current filters.');
    return;
  }

  const historicalTags = await readTagsFile(config.tagsJsonPath, scopedLogger);
  const tagsMap: TagsMap = { ...historicalTags };
  let writeChain = Promise.resolve();
  const forceFull = args.full ?? false;

  const postsToProcess = forceFull
    ? posts
    : posts.filter((post) => !historicalTags[post.relativePath]);

  if (!forceFull) {
    const skipped = posts.length - postsToProcess.length;
    if (skipped > 0) {
      scopedLogger.info(
        `Skipping ${skipped} existing post${skipped === 1 ? '' : 's'} present in tags.json (use --full to regenerate).`
      );
    }
  }

  const scheduleWrite = (reason: string) => {
    writeChain = writeChain.then(async () => {
      const snapshot = sortTagsMap(tagsMap);
      await writeTagsSnapshot(snapshot, config, scopedLogger, reason);
    });
    return writeChain;
  };

  let results = new Map<string, LlmResponse>();
  let merges = new Map<string, MergeResult>();

  if (postsToProcess.length > 0) {
    scopedLogger.info(
      `Loaded ${posts.length} posts; generating tags for ${postsToProcess.length} via ${config.model}...`
    );
    const generated = await generateTags(postsToProcess, config, scopedLogger, {
      historicalTags,
      onPostProcessed: async (post, merge) => {
        tagsMap[post.relativePath] = merge.tags;
        if (!config.dryRun) {
          await scheduleWrite(post.relativePath);
        }
      }
    });
    results = generated.results;
    merges = generated.merges;
  } else {
    scopedLogger.info('No new posts require tag generation.');
  }

  await writeChain;

  const processedPaths = new Set(posts.map((post) => post.relativePath));
  const filterApplied = Boolean(config.filter && config.filter.trim());
  if (!filterApplied) {
    for (const key of Object.keys(tagsMap)) {
      if (!processedPaths.has(key)) {
        delete tagsMap[key];
      }
    }
  }

  const sortedTagsMap = sortTagsMap(tagsMap);

  if (config.dryRun || postsToProcess.length === 0) {
    await writeTagsFile(sortedTagsMap, config, scopedLogger);
  } else {
    await scheduleWrite('finalize');
    await writeChain;
  }

  const stats = buildStatistics(postsToProcess.length, merges, results);
  scopedLogger.info('Sync summary', stats);
}

async function runApply(config: TagSyncConfig, scopedLogger: Logger): Promise<void> {
  scopedLogger.info(
    `Applying tags from ${config.tagsJsonRaw} to front-matter under ${config.postRootRaw}${config.dryRun ? ' (dry run)' : ''}.`
  );
  const summary = await syncFrontmatterFromTags(config, scopedLogger, {
    dryRun: config.dryRun,
    filter: config.filter,
    includeDrafts: config.includeDrafts,
    sortTags: config.sortTags
  });
  scopedLogger.info(
    `Front-matter sync complete. Updated ${summary.updated.length}, unchanged ${summary.unchanged.length}, missing ${summary.missing.length}.`
  );
  if (summary.missing.length > 0) {
    scopedLogger.warn(`Missing ${summary.missing.length} posts referenced in ${config.tagsJsonRaw}.`, summary.missing.slice(0, 10));
  }
  if (summary.filteredOut.length > 0) {
    scopedLogger.debug(
      `Filtered out ${summary.filteredOut.length} entr${summary.filteredOut.length === 1 ? 'y' : 'ies'} due to active filters or drafts.`,
      summary.filteredOut.slice(0, 10)
    );
  }
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, rest } = extractCommand(argv);
  const args = parseArgs(rest);
  const config = loadConfig({
    dryRun: args.dryRun,
    includeDrafts: args.includeDrafts,
    filter: args.filter,
    debug: args.debug
  });

  const scopedLogger = createLogger({ debug: config.debug });

  if (command === 'apply') {
    await runApply(config, scopedLogger);
  } else {
    await runGenerate(args, config, scopedLogger);
  }
}

(async () => {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const fallback = createLogger({ debug: true });
    fallback.error(`Tag sync failed: ${message}`);
    process.exitCode = 1;
  }
})();
