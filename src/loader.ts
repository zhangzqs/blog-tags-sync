import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { LoadedPost, Logger } from './types';
import { ensureArray, toPosix } from './utils';

async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await collectMarkdownFiles(fullPath);
        files.push(...nested);
      } else if (entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    })
  );
  return files;
}

function sanitizeExcerpt(content: string, maxLength = 800): string {
  if (!content) return '';
  const withoutCode = content.replace(/```[\s\S]*?```/g, ' ');
  const withoutLinks = withoutCode.replace(/\[(.*?)\]\((.*?)\)/g, '$1');
  const normalized = withoutLinks.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

interface LoadPostsOptions {
  filter?: string;
  includeDrafts?: boolean;
  logger?: Logger;
  workspaceRoot?: string;
}

export async function loadPosts(postRoot: string, options: LoadPostsOptions = {}): Promise<LoadedPost[]> {
  const { filter = '', includeDrafts = false, logger, workspaceRoot = process.cwd() } = options;
  const files = await collectMarkdownFiles(postRoot);
  const normalizedFilter = filter.trim();
  const filteredFiles = normalizedFilter
    ? files.filter((filePath) => toPosix(path.relative(postRoot, filePath)).includes(normalizedFilter))
    : files;

  const posts: LoadedPost[] = [];
  for (const absolutePath of filteredFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(absolutePath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.error?.(`Failed to read ${absolutePath}: ${message}`);
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.error?.(`Failed to parse front-matter for ${absolutePath}: ${message}`);
      continue;
    }

  const relativePath = toPosix(path.relative(workspaceRoot, absolutePath));
    const data = parsed.data ?? {};
    if (!includeDrafts && (data.draft === true || data.draft === 'true')) {
      logger?.debug?.(`Skipping draft post: ${relativePath}`);
      continue;
    }

    const frontMatterTags = ensureArray(data.tags);
    posts.push({
      absolutePath,
      relativePath,
      title: (typeof data.title === 'string' && data.title) || path.basename(absolutePath, path.extname(absolutePath)),
      frontMatterTags,
      frontMatter: data,
      frontMatterRaw: parsed.matter ?? '',
      content: parsed.content,
      excerpt: sanitizeExcerpt(parsed.content)
    });
  }

  return posts;
}
