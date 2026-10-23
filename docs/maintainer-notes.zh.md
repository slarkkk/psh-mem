# dsh-mem — DSH 跨会话记忆插件包（宿主外挂）

DeepSeek Harness 的「跨会话记忆」能力：用户档案 + 助手笔记，跨会话保留，可在 Web GUI 的
「记忆」tab 里查看和编辑。整套插件住在本仓库、位于 DSH 检出之外，所以 **升级 DSH 不会丢**，
但也因此要自己维护与宿主版本的对齐（见下面「DSH 升级后」）。

本仓库不是一个 pnpm workspace，也没有自己的 `package.json`：五个包都以源码形式被宿主进程加载，
`@deepseek-ai/*` 依赖由 `tsconfig.json` 的 `paths` 别名指向宿主检出的**同一份源码**——同一实例，
cordis 的 Service 身份才成立。

## 一个路径挂载整套

`cordis.yml` 是本仓库的条目清单，profile 的 `cordis.patch.yml` 里只需一条 `insert`：

```yaml
# 跨会话记忆（<repo>）
- insert:
    - id: memory-pack
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: 'file:///<repo>/cordis.yml'
```

要点：

- `path` **必须是 `file:///` 绝对 URL**。include 用 `new URL(path, baseUrl)` 解析它，
  裸盘符 `G:/…` 会被当成 `g:` scheme，报 `URL must be of scheme file`。
- `cordis.yml` 里的 `name` 是相对路径，按**该文件所在目录**解析，所以整个仓库可以整体移动；
  换机器/换盘符只改 profile 里那条 `path`。
- include 不监听文件内容，改完 `cordis.yml` 要**重启 DSH**。反过来，任何通过 loader 增删条目的
  操作都会重写 `cordis.yml`（注释会丢），所以平时直接编辑它。
- **只适用于 Web / CLI 源码启动的 profile。** DSH Desktop 是打包运行时（`<DSH Desktop 安装目录>`，
  宿主进程为 Electron 内嵌 Node v24 运行 `app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`），
  「绝对路径指向 `.ts` 源码 + tsconfig paths 指向宿主源码」那套不成立，实测两类硬错误：
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`（本仓库没有装着宿主包的
  `node_modules`），以及 Node 24 只有 strip-only 类型擦除时 `constructor(private readonly x)`
  这类参数属性报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。桌面端走下面的 `desktop-bundle`。
- client-modules 会递归遍历 include 子树的条目，所以 `ui-memory` 的浏览器包仍能被发现并下发。

## 桌面端（DSH Desktop）

桌面端只接受**已安装的包**，且必须是声明 `dsh.bundle` 的 bundle 包；GUI「添加插件」直接把
`<repo>` 填进去会报 `该路径不存在或不是有效插件包`（它要求路径下有 `package.json`，
并且是 npm 包 / Git 仓库 / 本地包目录）。`desktop-bundle/` 就是为此准备的：

| 文件 | 作用 |
|---|---|
| `desktop-bundle/package.json` | 包名 `@deepseek-ai/dsh-client-ui-memory`、`exports` 子路径、`dsh.bundle.patch`、`dsh.client` |
| `desktop-bundle/cordis.patch.yml` | 五行 `insert`，全部指向本包的子路径 |
| `desktop-bundle/lib/*.js` | 构建产物：四个宿主插件各自打成自包含 ESM，外加浏览器包 |

重新构建（改了源码之后）：

```powershell
cd <repo>; node build-desktop-bundle.mjs <dsh-checkout>
```

构建把 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-storage-domain` 等宿主包留成裸导入并被
`external`，由 Desktop 的 profile 解析层映射到 `app.asar\dsh` 那份 —— 这是 cordis 只有一个
Service 实例的前提，**不要**在包清单里把这些宿主包写成要安装的 `dependencies`。

安装用**打包好的 tarball**，不要用目录：

| 方式 | 结果 |
|---|---|
| `dsh-client-ui-memory-0.1.0.tgz`（GUI「添加插件」填这个路径，或 `dsh plugin --profile desktop add <tgz>`） | pnpm 把包解到一个真实目录 `profiles/desktop/node_modules/@deepseek-ai/dsh-client-ui-memory` → 实测正常 |
| 填目录 `<repo>\desktop-bundle` | pnpm 只建 junction/软链，包的 realpath 落到仓库里，`@deepseek-ai/cordis` 等裸导入会 `ERR_MODULE_NOT_FOUND` → 实测失败 |

生成 tarball（改完源码、重建 lib 之后）：

```powershell
cd <repo>; node build-desktop-bundle.mjs <dsh-checkout>
cd desktop-bundle; pnpm pack --pack-destination <repo>
```

重装同一个版本号会被判「already installed」：先在 Plugins 页卸载，或把 `package.json`
的 `version` 提一位再重新打包。

CLI 路径（`dsh plugin --profile desktop add <tgz>`）只做 pnpm 安装，之后还要把包名加进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`；GUI 安装会一并完成激活。

构建把 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-storage-domain` 等宿主包留成裸导入并被
`external`，由 Desktop 的 profile 解析层映射到 `app.asar\dsh` 那份 —— 这是 cordis 只有一个
Service 实例的前提，**不要**在包清单里把这些宿主包写成要安装的 `dependencies`。

验证方式（不需要动正在运行的桌面应用）：把 profile 复制一份，注入
`node_modules/@deepseek-ai/dsh-client-ui-memory` 并在 `dsh.profile.bundles` 里加一行，
再用打包运行时启动那个副本：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH Desktop 安装目录>\DeepSeek Harness.exe' --expose-internals `
  '<DSH Desktop 安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js' `
  '<DSH Desktop 安装目录>\resources\app.asar\dsh' "$env:USERPROFILE\.dsh\profiles\desktop-verify" `
  '<DSH Desktop 安装目录>\resources\runtime\primary-runtime' `
  '<DSH Desktop 安装目录>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs' `
  '<DSH Desktop 安装目录>\resources\runtime\bin'
```

启动后它会打印 `dsh web: http://127.0.0.1:<port>/?token=…`；对该端口请求 `/memory/state`
（带 `x-dsh-memory: 1` 和同端口 `Origin`）应返回两个 target，首页注入里应出现
`dsh-client-ui-memory`。2026-10-23 实测：状态 200、19 条记忆、tab 模块在启动图里。

## 五个包

| 目录 | 包 | 角色 |
|---|---|---|
| `memory/` | `@deepseek-ai/dsh-memory` | Service Definition：`ctx.memory`，提供方注册表 + 目标所有权 |
| `memory-curated/` | `@deepseek-ai/dsh-memory-curated` | 策展存储提供方：`user` / `memory` 两个 target，落 `$DSH_HOME/storages/memory.json`，并渲染系统提示段落 |
| `memory-recall/` | `@deepseek-ai/dsh-memory-recall` | 仅召回（检索历史会话），默认未挂载 |
| `tool-memory/` | `@deepseek-ai/dsh-tool-memory` | 模型侧的 `memory` 工具 |
| `memory-api/` | `@deepseek-ai/dsh-memory-api` | 浏览器端点 `GET /memory/state`、`POST /memory/write`（自定义头 + Origin 校验） |
| `ui-memory/` | `@deepseek-ai/dsh-client-ui-memory` | 「记忆」tab；浏览器包 `lib/client.js` 是构建产物 |

数据只落在 `$DSH_HOME/storages/memory.json`（默认 `C:\Users\<你>\.dsh\storages\`），
与 DSH 检出的版本无关，升级不动它。

## DSH 升级后

1. **重灌别名**（宿主检出移动、或 `tsconfig.base.json` 的 `paths` 变化时）：

   ```powershell
   cd <repo>; node sync-paths.mjs <dsh-checkout>
   ```

2. **类型核对**（宿主侧四个包，对照宿主已构建的 `lib/types` 声明）：

   ```powershell
   cd <repo>; <dsh-checkout>\node_modules\.bin\tsc -p tsconfig.check.json
   ```

   浏览器包自带检查配置（同样对照宿主声明）：

   ```powershell
   cd <repo>\ui-memory; <dsh-checkout>\node_modules\.bin\tsc -p tsconfig.json
   ```

3. **跑用例**（`NODE_ENV=test` 必加：否则 React 解析到 production 构建，
   `@testing-library/react` 的 `act()` 直接抛错）：

   ```powershell
   cd <dsh-checkout>
   $env:NODE_ENV='test'
   pnpm exec vitest run --config <repo>/memory-api/vitest.config.mjs
   pnpm exec vitest run --config <repo>/ui-memory/vitest.config.ts
   ```

4. **重建浏览器包**（改了 `ui-memory/src/` 之后才需要；产物是 `lib/client.js`）：

   ```powershell
   cd <repo>\ui-memory; pnpm bundle
   ```

   GUI 的 client-modules 按文件内容/时间算 rev，重建后刷新页面即可；旧标签页仍用旧 rev。

5. **重启 DSH**，然后确认端点：

   ```powershell
   Invoke-WebRequest http://127.0.0.1:3080/memory/state `
     -Headers @{ 'x-dsh-memory' = '1'; Origin = 'http://127.0.0.1:3080' }
   ```

   返回 `{"targets":[{"target":"memory",…},{"target":"user",…}]}` 说明
   memory / memory-curated / memory-api 三者都活着。

## 已知取舍

- `memory-api` 的 Origin 栅栏只认 `http://127.0.0.1:<port>` 与 `http://localhost:<port>`；
  用局域网地址或 HTTPS 打开 GUI 时，「记忆」tab 的读写会被 403 拒掉（宿主侧能力不受影响）。
- `webServer.port` 在 `listen` 之前是 `number | undefined`；路由处理器里取到 `undefined`
  视为服务端缺陷直接抛错（请求只可能在绑定之后到达）。
