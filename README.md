# Tag Sync 工具

基于大模型的 Hexo 标签同步工具，遍历 `source/_posts` 中的 Markdown 文章，结合现有 front-matter 标签与模型推荐，为仓库生成统一的 `tags.json` 索引，并支持标签归一化与分类。

## 功能概览

- 自动加载 `.env` 配置（默认从仓库根目录）
- 扫描 `source/_posts` 下的所有文章，解析 YAML front-matter
- 将整篇 Markdown 内容（无截断）与 front-matter 标签、历史 `tags.json` 标签一同送入兼容 OpenAI Chat Completions 协议的大模型
- 优先复用历史标签，结合模型输出完成去重、排序、分类（支持可选的 `taxonomy` 规则）
- 生成或更新仓库根目录的 `tags.json`
- 默认跳过 `tags.json` 已有记录，仅为新增文章补齐标签（可用 `--full` 触发全量刷新）
- 支持 `--dry-run` 与草稿过滤、路径过滤等 CLI 选项
- 新增 `frontmatter` 子命令，可将 `tags.json` 中的标签回写到 Markdown front-matter 中

## 安装

项目使用 pnpm 管理工作区依赖，执行一次安装即可：

```bash
pnpm install
```

## 环境变量

在仓库根目录创建 `.env`（可参考根目录的 `.env.example`），常用配置如下：

| 变量名 | 说明 | 默认值 |
| --- | --- | --- |
| `TAG_SYNC_API_KEY` | 大模型 API Key | _无（必填）_ |
| `TAG_SYNC_BASE_URL` | 大模型接口地址 | `https://api.openai.com/v1` |
| `TAG_SYNC_PROXY` | 代理服务器地址（支持 `http://`、`https://`、`socks://`） | _继承系统 `HTTPS_PROXY`/`HTTP_PROXY` 或为空_ |
| `TAG_SYNC_MODEL` | 使用的模型名称 | `gpt-4o-mini` |
| `TAG_SYNC_POST_ROOT` | 文章目录（相对仓库根目录） | `source/_posts` |
| `TAG_SYNC_TAGS_JSON` | 输出文件（相对仓库根目录） | `tags.json` |
| `TAG_SYNC_LANGUAGE` | 生成标签语言 | `zh` |
| `TAG_SYNC_MAX_CONCURRENCY` | 并发请求数量 | `3` |
| `TAG_SYNC_TIMEOUT` | 单次调用超时时间（秒） | `30` |
| `TAG_SYNC_DRY_RUN` | `true` 时只输出 diff | `false` |
| `TAG_SYNC_TAXONOMY_JSON` | 标签分类规则 JSON 文件 | _无_ |
| `TAG_SYNC_EXTRA_HEADERS` | 额外 HTTP 请求头（JSON 字符串） | _无_ |

## 使用方法

### 一键同步（推荐）

在仓库根目录执行：

```bash
pnpm sync:tags
```

此命令会：

1. 编译 `tools/tag-sync` 内的 TypeScript 源码
2. 读取 `.env`
3. 扫描文章、仅为 `tags.json` 中缺失的文章调用大模型并增量生成标签

如需无视缓存对匹配到的文章全量重算，可追加 `--full`：

```bash
pnpm sync:tags -- --full
```

如需先查看效果而不写入文件，可传入 `--dry-run`：

```bash
pnpm sync:tags -- --dry-run
```

### 直接调用子包脚本

```bash
pnpm --filter @zhangzqs/tag-sync run sync -- --dry-run
```

### 其他 CLI 选项

- `--include-drafts`：处理 front-matter 中标记为 `draft: true` 的文章
- `--filter=路径关键词`：仅处理路径中包含关键字的文章
- `--full`：无视现有 `tags.json`，对筛选后的文章全量重新生成标签
- `--debug`：输出调试日志

### 将 `tags.json` 写回 front-matter

当 `tags.json` 已经整理完成，若需要把标签同步回对应 Markdown 的 front-matter，可使用新增的 `frontmatter` 子命令：

```bash
pnpm --filter @zhangzqs/tag-sync run dev frontmatter -- --dry-run --filter=Android/
```

- `--dry-run`：只输出将要改动的文件，不写入磁盘，可去掉该参数执行真实更新
- `--filter`、`--include-drafts` 等选项依旧有效，语义与主命令保持一致
- 命令会尽量保留原有 front-matter 中日期、布尔量等字段的格式，仅更新 `tags` 数组

如果需要在编译后的产物上运行，可先执行 `pnpm --filter @zhangzqs/tag-sync run build`，再通过 `node dist/index.js frontmatter` 调用。

## 输出结构

`tags.json` 采用以下结构：

```json
{
  "source/_posts/虚拟化/折腾Hyper-V嵌套虚拟化来运行PVE.md": [
    "虚拟化",
    "Hyper-V",
    "PVE"
  ],
  "source/_posts/Rust/使用Rust描述音乐系统并模拟乐器演奏.md": [
    "Rust",
    "音频处理"
  ]
}
```

若配置了 `TAG_SYNC_TAXONOMY_JSON`，在运行日志中会附带标签分类结果以方便审阅。

## 开发调试

- `pnpm --filter @zhangzqs/tag-sync run dev -- --dry-run`：使用 `tsx` 直接运行 TypeScript 源码
- `pnpm --filter @zhangzqs/tag-sync run build`：仅编译生成 `dist/`

## 常见问题

- **提示 `TAG_SYNC_API_KEY is not set` 并退出**：脚本会立即中止；请在 `.env` 中配置有效的 API Key 后重试
- **网络请求失败**：可通过 `TAG_SYNC_BASE_URL` 指向兼容 OpenAI 的其它模型服务，必要时设置 `TAG_SYNC_PROXY`（或系统 `HTTPS_PROXY`/`HTTP_PROXY`）并使用 `TAG_SYNC_EXTRA_HEADERS` 追加认证信息
- **文章过多时速度慢**：提高 `TAG_SYNC_MAX_CONCURRENCY`，或配合 `--filter` 进行局部同步

欢迎根据自身需求扩展模块或引入更多校验与可视化工具。