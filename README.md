# psh-mem · DeepSeek Harness 的跨会话记忆

**Cross-session memory for DeepSeek Harness: a user profile and a notes store that the model reads
every turn and writes back with one `memory` tool call, plus a Memory tab in the Web GUI.**

> 非官方插件。它原本是 DeepSeek Harness 仓库里的记忆子系统，抽出来独立维护，
> 因此包名仍沿用 `@deepseek-ai/*`，但不由官方发布，也不与上游版本绑定。

跨会话记忆解决一件事：一次对话里学到的偏好、约定、环境事实，下一个会话不该消失。
本插件把它做成 DSH 的一等能力——模型有工具写、系统提示每轮读、人有界面改，数据存在本地。

## 特性

- **两个可编辑目标**：`user`（用户档案：你是谁、偏好、习惯）与 `memory`（助手笔记：环境事实、约定、教训），各有独立字符预算。
- **模型侧 `memory` 工具**：一次调用携带全部增删改，操作原子；字符预算只在**最终结果**上校验，所以「先删旧、再加新」可以在同一调用里完成。
- **每轮注入**：两个目标的内容作为 `Curated memory` 段落进入系统提示，带上当前用量。
- **「记忆」tab**：Web GUI 会话视图里的第三个页签（Chat / Trajectory / 记忆），可查看、编辑、批量保存、重载。
- **数据与版本解耦**：只落一个本地文件，升级 DSH 不会丢；Web 端和桌面端共用同一份。
- **失败可解释**：超预算、匹配不到、匹配到多条都会返回明确的拒绝原因与当前条目，模型能在同一轮重试。

## 安装

前置：DSH `0.2.x`（在 `0.2.1-rc.2` 上验证）、Node `>=22.19`。

### 方式一：Web / CLI（源码启动的 profile）

```powershell
git clone https://github.com/slarkkk/psh-mem.git C:\path\to\psh-mem
cd C:\path\to\psh-mem
node sync-paths.mjs C:\path\to\dsh-checkout   # 生成指向宿主源码的 @deepseek-ai/* 别名
```

`sync-paths.mjs` 让插件与宿主引用**同一批源码文件**，这是 cordis Service 单实例的前提；
DSH 检出移动或依赖别名变化后重跑一次。

然后在 profile 的补丁层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）加**一条** include：

```yaml
- insert:
    - id: memory-pack
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: 'file:///C:/path/to/psh-mem/cordis.yml'
```

重启 DSH 生效。三个坑：

1. `path` **必须是 `file:///` 绝对 URL**（include 用 `new URL(path, baseUrl)` 解析，裸盘符会被当成 `g:` scheme）。
2. include 不监听文件内容，改完 `cordis.yml` 要重启。
3. 不想用 include 也可以把 `cordis.yml` 里的五行直接抄进 profile 补丁，效果相同。

### 方式二：DSH Desktop（可安装 bundle）

桌面端是打包运行时，源码 + tsconfig 别名那套不成立（`Cannot find package '@deepseek-ai/cordis'`；
Node 24 的 strip-only 类型擦除也不支持参数属性）。所以要先编译：

```powershell
cd C:\path\to\psh-mem
node build-desktop-bundle.mjs C:\path\to\dsh-checkout
cd desktop-bundle
pnpm pack --pack-destination ..
```

产物是 `deepseek-ai-dsh-client-ui-memory-<version>.tgz`。打开 Desktop 的 Plugins 页 →「添加插件」→ 填这个
**tarball 路径**，装完重开应用。

**不要填 `desktop-bundle` 目录**：目录安装只会建软链，包的 realpath 留在仓库里，宿主包解析不到。

## 配置

`memory-curated` 的字段（全部可省略）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `memoryLimit` | `2200` | `memory` 目标的字符预算（按条目拼接后计） |
| `userLimit` | `1375` | `user` 目标的字符预算 |
| `consolidationFailureLimit` | `3` | 单轮内「超预算 / 匹配不到」失败几次后转为终止性失败，避免模型反复重试 |
| `providerName` | `curated` | 注册到 `ctx.memory` 的提供方名字 |
| `sectionOrder` | `700` | 系统提示段落位置（persona、plan 之后，工具说明之前） |

`memory-api` 只有 `enabled`（默认 `true`），关掉就不注册浏览器端点。

写在你自己的 profile 补丁里即可覆盖（补丁层在 bundle 之后应用）：

```yaml
- id: memory-curated
  config:
    memoryLimit: 4000
    userLimit: 2000
```

## 数据

- 位置：`$DSH_HOME/storages/memory.json`（`DSH_HOME` 默认 `~/.dsh`，Windows 为 `C:\Users\<你>\.dsh`）。
- 内容：两个目标的条目列表，纯文本，没有 embedding、没有远程调用。
- 这是**真实用户信息**：发布 issue、截图、提交仓库前检查一下，别把它带出去。

## 目录结构

| 目录 | 包 | 角色 |
|---|---|---|
| `memory/` | `@deepseek-ai/dsh-memory` | 能力定义：`ctx.memory`，提供方注册表 + 目标所有权 + 召回路由 |
| `memory-curated/` | `@deepseek-ai/dsh-memory-curated` | 策展存储提供方：拥有 `user` / `memory`，渲染系统提示段落，全部写入原子化 |
| `tool-memory/` | `@deepseek-ai/dsh-tool-memory` | 模型侧的 `memory` 工具（schema、描述、结果渲染） |
| `memory-api/` | `@deepseek-ai/dsh-memory-api` | 浏览器端点 `GET /memory/state`、`POST /memory/write` |
| `ui-memory/` | `@deepseek-ai/dsh-client-ui-memory` | 「记忆」tab 的浏览器实现（`lib/client.js` 为构建产物） |
| `lessons/` | — | 失败教训库：`lesson` 工具、提醒哨兵、`/lessons/*` 端点（界面在「记忆」页底部） |
| `memory-recall/` | `@deepseek-ai/dsh-memory-recall` | 可选的仅召回提供方（检索历史会话），默认不挂载 |
| `desktop-bundle/` | — | 桌面端可安装包：编译产物 + bundle 补丁 + 清单 |

### 失败教训库（lessons）

记忆存「事实」，教训库存「负经验」：一次非显然的失败、根因、真正有效的做法。工具 `lesson`：

| action | 作用 |
|---|---|
| `record` | 记一条：`title` + `fix` 必填，`symptom`/`cause`/`tags`/`paths`/`tools`/`scope` 可选 |
| `recall` | 按关键词或当前会话活动查相关教训 |
| `list` / `stats` | 列表 / 统计 |
| `confirm` | 「仍然成立」：刷新确认时间，过期条目重新参与自动提醒 |
| `forget` / `archive` | 删除 / 归档 |

自动提醒只在回合开头或工具失败后评估，分数阈值 + 每轮上限 2 + 冷却 10 分钟 + 过期排除，避免念旧账。数据：工作区 `.dsh/lessons.json`；全局 `$DSH_HOME/storages/lessons.json`。浏览器端点：`GET /lessons/state`、`POST /lessons/confirm|forget`（同源 + `x-dsh-lessons` 头）。

界面不另开 tab：`ui-memory` 的「记忆」页底部就是「失败教训」区（确认仍然成立 / 删除 / 标签），桌面端同一份 bundle 也有。`build-desktop-bundle.mjs` 会把 `lessons/` 编进 `lib/lessons.js`，并把新的 `ui-memory/lib/client.js` 复制进 bundle，装一个 tgz 就有工具、端点与这块界面。

分层是标准的 DSH 能力接缝：Service Definition（`memory`）+ Provider（`memory-curated`）+
Consumers（工具、HTTP 面、界面）。换存储后端只需要换 Provider，工具 schema 和提示词不动。

## 开发

```powershell
# 类型核对（对照宿主已构建的 lib/types 声明）
G:\path\to\dsh-checkout\node_modules\.bin\tsc -p tsconfig.check.json
cd ui-memory; G:\path\to\dsh-checkout\node_modules\.bin\tsc -p tsconfig.json

# 用例（NODE_ENV=test 必加：否则 React 解析到 production 构建，act() 会直接抛）
cd <dsh-checkout>
$env:NODE_ENV='test'
pnpm exec vitest run --config <...>/memory-api/vitest.config.mjs
pnpm exec vitest run --config <...>/ui-memory/vitest.config.ts
```

改了 `ui-memory/src/` 要重建浏览器包；改了任意宿主侧源码、要发桌面端，还要重建 bundle。

浏览器包用 tsdown 构建。宿主的 `tsconfig.base.client.json` 在部分环境里会让 tsdown 加载失败（`Package subpath is not defined by exports`），因此包内放了一份最小配置兜底：

```powershell
cd ui-memory
node <dsh-checkout>\node_modules\tsdown\dist\run.mjs --config tsdown.config.ts --tsconfig tsconfig.build.json
```

`desktop-bundle/lib/client.js` 是 `ui-memory/lib/client.js` 的副本，重建后记得复制过去；桌面端宿主插件（`lessons.js` 等）可以用 `tsc --noCheck` 单独产出，或直接跑 `node build-desktop-bundle.mjs <dsh-checkout>`（需要 esbuild；本机沙箱会拦子进程写文件）。

## 兼容性

- 宿主 API 处于 pre-stable 阶段。升级 DSH 后建议按顺序跑一遍：`node sync-paths.mjs` → 类型核对 → 两个用例集 →（需要桌面端时）重建 bundle 并重装。
- 桌面端每次 DSH 升级都要重新打包重装；同一版本号重复安装会被判「already installed」，先卸载或提 `version`。
- 已在 `0.2.1-rc.2` 上验证：Web 端与桌面端都能挂载，`/memory/state` 返回两个目标、19 条记忆，启动图里含「记忆」tab。

## 已知限制

- **每个目标一个提供方**：两个提供方声明同一目标会在注册时直接失败，不做合并。
- **没有跨进程变更通知**：另一个进程写盘后，正在运行的宿主看不到，直到它自己再写或重启。
- **浏览器端点只认 loopback Origin**：用局域网地址或 HTTPS 打开 GUI 时，「记忆」tab 的读写会 403（模型侧能力不受影响）。
- **桌面端只接受 tarball 安装**（见上）。
- 包名沿用 `@deepseek-ai/*` 只因为代码从上游仓库抽出，属于第三方分发，与官方发布无关。

## 许可

MIT（见 [LICENSE](LICENSE) 与各包 `package.json`）。
> `lessons/` 必须保留自己的 `package.json`（`type: module`）：没有它时 tsx 按 CommonJS 加载，宿主的 tsconfig `paths` 不参与解析，`@deepseek-ai/*` 会直接 `MODULE_NOT_FOUND`，表现为 `/lessons/state` 404、工具消失——且没有任何显式报错。