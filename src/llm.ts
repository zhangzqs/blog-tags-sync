import pLimit from 'p-limit';
import { ProxyAgent, Dispatcher } from 'undici';
import { LlmResponse, TagSyncConfig, LoadedPost, Logger, TagsMap } from './types';
import { sleep } from './utils';
import { mergeTags } from './taxonomy';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

const proxyAgents = new Map<string, Dispatcher>();

function getDispatcher(config: TagSyncConfig): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  const existing = proxyAgents.get(config.proxyUrl);
  if (existing) return existing;
  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent(config.proxyUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize proxy agent (${config.proxyUrl}): ${message}`);
  }
  proxyAgents.set(config.proxyUrl, agent);
  return agent;
}

function buildPrompt(post: LoadedPost, language: string, historyTags: string[]): string {
  const frontMatterTags = post.frontMatterTags.length ? post.frontMatterTags.join(', ') : '（无）';
  const historical = historyTags.length ? historyTags.join(', ') : '（无）';
  const languageLabel = language === 'en' ? '英文' : '中文';
  return `你是一名熟悉技术博客的标签分类专家，请基于完整文章生成 3-6 个高质量标签。

文章标题：${post.title}
Front-matter 标签：${frontMatterTags}
历史标签（tags.json）：${historical}

全文内容如下：
${post.content}

要求：
1. 优先复用已有标签；若含义适用，请直接保留。
2. 对英文技术专有名词（协议、框架、API、库等）保持英文，不要翻译成中文。
3. 标签需具体、可复用，避免过宽泛，例如“技术”或“学习”。
4. 输出采用 ${languageLabel} 为主，可中英混用，格式为 JSON 数组，例如 ["标签1", "Tag2"].`;
}

async function callChatCompletion(config: TagSyncConfig, prompt: string): Promise<LlmResponse> {
  if (!config.apiKey) {
    return { tags: [], raw: null, error: new Error('Missing TAG_SYNC_API_KEY') };
  }

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: '你是一个优秀的中文技术标签生成器。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
  max_tokens: 1024
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const fetchOptions: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...config.extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    };

    const dispatcher = getDispatcher(config);
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content ?? '';
    const tags = parseTagsFromContent(content);
    return { tags, raw: content, model: config.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { tags: [], raw: null, error: new Error(message) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseTagsFromContent(content: string): string[] {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
    return [];
  } catch (error) {
    return [];
  }
}

interface GenerateTagOptions {
  retries?: number;
  historicalTags?: TagsMap;
  onPostProcessed?: (post: LoadedPost, merge: ReturnType<typeof mergeTags>) => Promise<void> | void;
}

export async function generateTags(
  posts: LoadedPost[],
  config: TagSyncConfig,
  logger: Logger,
  options: GenerateTagOptions = {}
): Promise<{
  results: Map<string, LlmResponse>;
  merges: Map<string, ReturnType<typeof mergeTags>>;
}> {
  const results = new Map<string, LlmResponse>();
  const merges = new Map<string, ReturnType<typeof mergeTags>>();

  const historicalTagsMap: TagsMap = { ...(options.historicalTags ?? {}) };

  if (!config.apiKey) {
    throw new Error('TAG_SYNC_API_KEY is not set. 请在 .env 中配置有效的接口密钥。');
  }

  const limit = pLimit(config.maxConcurrency);
  const retries = options.retries ?? 2;

  await Promise.all(
    posts.map((post) =>
      limit(async () => {
        logger.info(`Processing ${post.relativePath}`);
        const historyTags = historicalTagsMap[post.relativePath] ?? [];
        let attempt = 0;
        let lastError: Error | undefined;
        while (attempt <= retries) {
          try {
            if (attempt > 0) {
              const backoffMs = Math.min(2000 * attempt, 5000);
              await sleep(backoffMs);
            }
            const prompt = buildPrompt(post, config.language, historyTags);
            const response = await callChatCompletion(config, prompt);
            results.set(post.relativePath, response);
            const merged = mergeTags(post.frontMatterTags, response.tags, historyTags, config);
            merges.set(post.relativePath, merged);
            historicalTagsMap[post.relativePath] = merged.tags;
            await options.onPostProcessed?.(post, merged);
            if (response.error) {
              lastError = response.error;
              logger.warn?.(`LLM call for ${post.relativePath} failed: ${response.error.message}`);
            }
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            logger.warn?.(`Retry ${attempt + 1} failed for ${post.relativePath}: ${lastError.message}`);
            attempt += 1;
          }
        }
        if (lastError) {
          results.set(post.relativePath, { tags: [], raw: null, error: lastError });
          const fallbackMerge = mergeTags(post.frontMatterTags, [], historyTags, config);
          merges.set(post.relativePath, fallbackMerge);
          historicalTagsMap[post.relativePath] = fallbackMerge.tags;
          await options.onPostProcessed?.(post, fallbackMerge);
          logger.error?.(`LLM generation failed for ${post.relativePath}: ${lastError.message}`);
        }
      })
    )
  );

  return { results, merges };
}
