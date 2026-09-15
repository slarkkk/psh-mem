---
description: "跨会话记忆的能力定义：记忆词汇、MemoryProvider 约定，以及组合各提供方的 ctx.memory 注册表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

跨会话记忆的 Service Definition。它拥有共享词汇——目标、条目、操作、快照与写入结局——以及 `MemoryProvider` 约定和具体的 `ctx.memory` 注册表；后者注册提供方、为每个策展目标强制唯一所有者，并路由读、写与召回。存储与检索的每项决策都归提供方所有，因此替换后端无需改动工具 schema 或提示词段落。消费方一律通过该服务触达每个后端，绝不直接通过提供方。

## 目录

- [能力](#the-capability)
- [提供方约定](#the-provider-contract)
- [目标所有权](#target-ownership)
- [注册与资源释放](#registration-and-disposal)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="the-capability"></a>
## 能力

`ctx.memory` 是一个 `MemoryService`。它持有一张提供方表和一张目标所有权表，并暴露 4 个操作：`register`、`snapshot`、`write` 和 `recall`。消费方需要的每个操作都在该服务上；提供方切面是唯一可替换的部分。

生成的 [Cordis surface](../../../docs/subsystems/memory.zh.md#cordis-surface) 是每个方法及其 JSDoc 的穷尽来源。

这些方法交换的词汇——目标、条目、操作、快照、写入结局与召回请求——声明在 [`src/types.ts`](src/types.ts) 中，并记录在[记忆子系统页面](../../../docs/subsystems/memory.zh.md)上。

<a id="the-provider-contract"></a>
## 提供方约定

提供方是普通对象，而不是服务。它声明一个唯一的 `name`，以及最多两个切面：

| 切面 | 成员 | 约定 |
|---|---|---|
| 策展存储 | `targets` + `store` | 拥有具名目标；`snapshot(target)` 读取它们，`write(target, operations)` 针对目标的最终字符预算应用条目变更。 |
| 召回 | `recall` | 通过 `recall(request, signal)` 为即将到来的步骤检索上下文。 |

没有策展存储的提供方会同时省略 `targets` 和 `store`，这就是仅召回的形态。声明目标却没有存储切面的提供方会在注册时被拒绝，而不是在之后才失败。

一个提供方失败绝不否定另一个：`recall` 从每个提供该切面的提供方收集结果，把拒绝记录为警告，并返回其余提供方的结果。

<a id="target-ownership"></a>
## 目标所有权

每个策展目标恰好由一个提供方拥有。当没有提供方拥有所请求的目标时，`snapshot` 会抛出异常，因为调用方请求一个无主目标属于组合错误。`write` 不抛出异常：它以 `{ ok: false, code: 'unowned-target' }` 结算，因此只挂载一个目标的部署仍能给调用方一个可操作的答复，而不是异常。

<a id="registration-and-disposal"></a>
## 注册与资源释放

`register` 返回精确的资源释放函数：它移除提供方并释放其拥有的目标。调用插件拥有生命周期，并把该调用包在 `ctx.effect` 中，因此卸载贡献它的 fiber 会连同该提供方一起撤回。

注册在三种无法在之后解决的组合上快速失败：提供方名称重复、两个提供方声明同一个目标，以及声明了目标却没有存储切面。

```yaml
- insert:
    - id: memory
      name: '@deepseek-ai/dsh-memory'

    - id: memory-curated
      name: '@deepseek-ai/dsh-memory-curated'
```

没有随产品发布的 bundle 挂载该能力；部署用自己的补丁层组合它。示例 overlay 见[记忆组 README](../README.zh.md)。

<a id="model-experience"></a>
## 模型体验

间接地，通过注册在它上面的提供方和 `dsh-tool-memory`：它们把已存条目与召回的文本变成提示词段落和工具结果。

#### KV Cache 影响

无直接失效；注册的提供方拥有其提示词段落的字节稳定性，工具消费方拥有其 schema。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **每个目标一个提供方**——该能力无法合并两个提供方针对同一目标的条目，第二个声明者会在注册时被拒绝，而不是被仲裁。想要合并来源的后端必须只呈现一个切面。
- **没有跨进程变更通知**——提供方通过它们自行选择的后端持久化，而该服务不会把另一个进程中的写入传播到活动注册表。长时间运行的宿主只能观察到自己的注册。
- **没有跨提供方的写入顺序保证**——`write` 只路由到一个拥有该目标的提供方，因此部署无法表达一个跨越分属不同提供方的两个目标的单一原子操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

该类是具体类而不是抽象类，因为该能力可替换的部分是提供方切面，而不是服务。这与存储中枢一致：`ctx.storage` 是具体的，后端注册到其中。

不发布不变式配套插件，因为每一件值得断言的事实都是该服务已在调用点强制执行的调用内关系：所有权表只在校验它的同一次注册中写入，而每个路由决策读取的正是它刚刚写入的那张表。外部观察者重新推导这些，等于在检查它自己被调用时所处的那次调用。

</details>
