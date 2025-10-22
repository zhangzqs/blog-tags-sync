# Tag Sync Tool Design

## 背景与目标

Hexo 博客的所有文章位于 `source/_posts` 目录，并在每篇 Markdown 文件的 YAML front-matter 中维护 `tags` 列表。当前希望通过自动化流程：

1. 读取所有文章的现有标签。
2. 基于大模型对文章主体内容（含 front-matter 信息）进行分析，生成推荐标签。
3. 结合已有标签与模型推荐，对标签进行归一化、分类和整理。
4. 将最终结果写入一个位于仓库根目录的 `tags.json` 文件，结构为 `{ "path/to/post.md": ["tag1", "tag2", ...] }`。
5. 提供一键执行的 npm 脚本命令，支持从 `.env` 文件读取所需配置。

## 约束条件与假设

- Node.js 版本需要满足 Hexo 当前依赖（建议 >= 18）。
- 仓库根目录存在 `.env` 文件，提供大模型 API Key、模型名称、标签输出目录等配置信息。若不存在需要提示用户。
- `tags.json` 将保存到 `.env` 中配置的路径（默认仓库根目录）。
- 大模型接口遵循 OpenAI 兼容协议（可通过 HTTP 调用）。如果用户配置其他厂商兼容接口（如阿里云百炼、智谱等），需要允许自定义 Base URL 和 Header。
- 当模型不可用时，需要 fallback 到仅使用已有标签，并记录日志。

## 关键输入与输出

### 输入

| 输入 | 类型 | 描述 |
| --- | --- | --- |
| `.env` 文件 | 文件 | 包含 API Key、模型、Base URL、代理、博客根目录、输出路径、最大并发、开关等配置 |
| Markdown 文章 | 文件 | `source/_posts/**\/*.md` 内的所有文件 |
| 现有 `tags.json` | 文件（可选） | 作为历史缓存，辅助增量更新与冲突检测 |

### 输出

| 输出 | 类型 | 描述 |
| --- | --- | --- |
| `tags.json` | 文件 | `{ "相对路径": ["tag1", ...] }` 的结构 |
| 执行日志 | 控制台 / `logs/` | 包含处理成功、失败、跳过的文章信息 |

## 环境变量约定

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `TAG_SYNC_API_KEY` | 大模型 API Key | `sk-xxx` |
| `TAG_SYNC_MODEL` | 模型名称 | `gpt-4o-mini` |
| `TAG_SYNC_BASE_URL` | 模型接口地址，默认 `https://api.openai.com/v1` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `TAG_SYNC_TAGS_JSON` | 输出文件路径（相对或绝对） | `tags.json` |
| `TAG_SYNC_POST_ROOT` | 博客文章根目录 | `source/_posts` |
| `TAG_SYNC_LANGUAGE` | 标签语言偏好，默认 `zh` | `en` |
| `TAG_SYNC_DRY_RUN` | 是否仅输出日志不写入文件 | `true` |
| `TAG_SYNC_MAX_CONCURRENCY` | 并发请求数，默认 3 | `5` |
| `TAG_SYNC_TIMEOUT` | 单次 API 调用超时（秒） | `30` |
| `TAG_SYNC_CACHE_PATH` | 缓存位置（可选） | `.cache/tag-sync.json` |
| `TAG_SYNC_STRICT_MODE` | 严格模式，若缺标签则报错退出 | `true` |

## 目录结构规划

```text
tools/
  tag-sync/
    DESIGN.md          # 设计文档（当前文件）
    package.json       # 独立 npm 包定义（后续添加）
    src/
      index.ts         # CLI 入口
      loader.ts        # 文件扫描与 front-matter 解析
      llm.ts           # 大模型请求封装
      taxonomy.ts      # 标签合并、标准化逻辑
      writer.ts        # 输出写入（含 dry-run 支持）
      logger.ts        # 日志工具
    scripts/
      build.ts         # 可选打包脚本
```

> 说明：若不想引入 TypeScript，可改为纯 JavaScript，但推荐使用 TS 以获取类型校验。

## 模块划分

### CLI (`index.ts`)
- 解析命令行参数（如 `--dry-run`、`--filter path`）。
- 调用 Config 模块读取 `.env`。
- 串联 Loader → LLM → Taxonomy → Writer 的执行流程。
- 捕获全局异常，友好输出。

### Config 模块
- 使用 `dotenv` 加载 `.env`。
- 提供默认值和类型校验。
- 支持从命令行参数覆盖部分配置。

### Loader 模块
- 遍历 `TAG_SYNC_POST_ROOT` 目录，筛选 `.md` 文件。
- 使用 `gray-matter` 等库解析 front-matter。
- 返回数组：`{ path, frontMatterTags, contentExcerpt, metadata }`。
- 可配置是否跳过草稿（front-matter 中 `draft: true`）。

### LLM 模块
- 构造 prompt：包含文章标题、摘要、已有标签、文章正文摘要。
- 支持批量请求，控制并发，自动重试。
- 返回推荐标签列表，并标注置信度或来源。
- 若 API Key 缺失或请求失败，返回空列表，并由上层处理。

### Taxonomy 模块
- 输入：已有标签 + 模型推荐标签。
- 操作：
  - 标签归一化（大小写、全角半角、空格处理）。
  - 指定语言（例如中文）优先，必要时提供翻译。
  - 分类：根据配置的 Classifier 表（可在 JSON 文件维护）或通过 LLM 分类。
  - 去重与排序：可按字母或权重排序。
  - 输出结构：`{ finalTags, metadata }`。

### Writer 模块
- 读取现有 `tags.json`（若存在）。
- 合并新结果，支持增量更新。
- `dry-run` 模式输出 Diff 而不写文件。
- 常规模式下写回 JSON，并美化格式（2 空格缩进）。

### Logger 模块
- 基于 `pino` 或 `winston` 实现。
- 支持将日志输出到控制台和文件（可选）。
- 提供多级别（info、warn、error、debug）。

## 数据流

1. CLI 启动，读取配置。
2. Loader 扫描所有文章，提取元数据与正文摘要。
3. 对每篇文章：
   1. 从 LLM 获取推荐标签（可带并发控制）。
   2. Taxonomy 模块合并已有标签与新标签。
4. Writer 将结果写入/合并到 `tags.json`。
5. CLI 输出摘要统计（新增标签数、模型调用次数等）。

## 大模型 Prompt 设计示例

```
你是一个熟悉技术博客的标签分类助手。
请根据以下信息生成 3-6 个标签，使用中文短语，输出 JSON 数组。

标题: {{title}}
已有标签: {{tags}}
正文摘要: {{excerpt}}

要求：
1. 标签需要具体且可复用，例如 “虚拟化平台” 而不是 “技术”。
2. 若已有标签合理可保留。
3. 若内容涉及操作系统、编程语言等，请体现。
4. 输出形如 ["标签1", "标签2"]。
```

## 错误处理与重试策略
- LLM 调用失败：记录错误并重试最多 `n` 次（指数退避）。超过次数后，落回使用已有标签。
- 文件解析失败：将路径记录到失败列表并继续；最终在 CLI 中以非零退出码返回。
- 配置缺失：CLI 启动时检查，缺失关键字段直接报错并退出。

## 未来扩展
- 支持将结果回写到 Markdown front-matter 中。
- 增加标签白名单/黑名单机制。
- 与 Hexo 分类（categories）联动。
- 集成前端可视化工具查看标签分布。

## 执行计划概述
1. **设计阶段（当前）**：确认工具整体架构与配置。
2. **实现阶段**：按模块开发 `src/` 目录及相关脚本。
3. **集成阶段**：在仓库 `package.json` 中添加 `sync:tags` 命令，调用 `node tools/tag-sync/dist/index.js`。
4. **文档阶段**：更新 README，说明 `.env` 样例与使用方法。
5. **验证阶段**：编写 smoke test（如针对少量文章的 dry-run），确保脚本能执行。
