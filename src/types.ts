export interface TaxonomyRule {
  includes?: string[];
  pattern?: string;
}

export type TaxonomyRules = Record<string, TaxonomyRule>;

export interface TagSyncConfig {
  cwd: string;
  workspaceRoot: string;
  postRoot: string;
  postRootRaw: string;
  tagsJsonPath: string;
  tagsJsonRaw: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  proxyUrl: string | null;
  language: string;
  dryRun: boolean;
  includeDrafts: boolean;
  filter: string;
  timeoutMs: number;
  maxConcurrency: number;
  sortTags: boolean;
  debug: boolean;
  taxonomyRules: TaxonomyRules | null;
  extraHeaders: Record<string, string>;
}

export interface ConfigOverrides {
  postRoot?: string;
  tagsJson?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  proxyUrl?: string | null;
  language?: string;
  dryRun?: boolean;
  includeDrafts?: boolean;
  filter?: string;
  timeoutSeconds?: number;
  maxConcurrency?: number;
  sortTags?: boolean;
  debug?: boolean;
  taxonomyPath?: string;
  extraHeaders?: string;
}

export interface LoadedPost {
  absolutePath: string;
  relativePath: string;
  title: string;
  frontMatterTags: string[];
  frontMatter: Record<string, unknown>;
  frontMatterRaw: string;
  content: string;
  excerpt: string;
}

export interface Logger {
  info(message: unknown, metadata?: unknown): void;
  warn(message: unknown, metadata?: unknown): void;
  error(message: unknown, metadata?: unknown): void;
  debug(message: unknown, metadata?: unknown): void;
}

export interface LlmResponse {
  tags: string[];
  raw: string | null;
  error?: Error;
  model?: string;
}

export interface MergeResult {
  tags: string[];
  added: string[];
  classification: Record<string, string>;
}

export type TagsMap = Record<string, string[]>;

export interface WriteResult {
  updatedPaths: string[];
  skippedPaths: string[];
  created: boolean;
}

export interface SyncStatistics {
  totalPosts: number;
  processedPosts: number;
  skippedPosts: number;
  llmCalls: number;
  llmFailures: number;
  totalTags: number;
  totalNewTags: number;
}
