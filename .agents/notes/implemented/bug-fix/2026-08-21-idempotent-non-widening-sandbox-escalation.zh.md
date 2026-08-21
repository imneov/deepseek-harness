# Agent Note: Reuse the standing mode for non-widening sandbox escalation requests

Status: implemented

[English](2026-08-21-idempotent-non-widening-sandbox-escalation.md) | 中文

## Problem

只要模型请求的 sandbox 模式不高于调用的有效模式，`approveEscalation()` 就会让整个工具调用失败，报 `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`。[sandbox Agent Note](../feature/2026-07-06-sandbox.zh.md) 选择这种 fail-closed 答案，是为了让非拓宽请求绝不提示人类，并把这类请求纯粹当作模型错误。

实践中这种请求并不总是错误。模型可能曾在某个模式下被拒，之后又运行在一个常驻的更宽模式下——会话的持久覆盖被调高，或者部署默认值本来就是 `danger-full-access`——它会按常驻级别附带 `sandbox_permissions`；模板化升级字段的集成也可能冗余地发出这些字段。在 `danger-full-access` 会话下，每个这样的调用都会在执行任何内容之前失败，而且由于失败文本指名的是调用已经持有的模式，模型无法通过继续拓宽来修复请求。结果是一个所有 shell 调用都当场死亡的会话。

## Decision

请求的模式不高于调用有效模式时是幂等的：`approveEscalation()` 不咨询审批通道，直接返回有效模式，调用严格按它已有的访问权限执行。授予的模式绝不降低调用。只有严格拓宽才会到达审批通道，因此非拓宽请求仍然绝不提示人类——原 note 固定的保证——但它也不再杀死调用。

比较使用封闭模式词汇上的全序秩（`read-only` < `workspace-write` < `danger-full-access`）。词汇之外的请求模式无秩可比，仍落入严格拓宽检查，在那里以既有的逐字 `not strictly wider` 文本失败关闭。该稳定消息因此保留在两个工具 README 的错误清单中；它现在标记的是畸形请求而非冗余请求。

## Alternatives considered

**继续对非拓宽请求失败关闭。** 被真实世界的失败否决：在常驻 `danger-full-access` 模式下，该失败在模型侧不可修复——不存在可请求的更宽模式——部署失去所有带升级字段的调用。fail-closed 答案只有在模型能据此行动时才是安全的。

**当会话已处于最宽模式时从 schema 中剥离升级字段。** 原 note 已否决过：schema 是注册表全局的，而有效模式是按会话的，枚举无法追踪按会话的真实状态。执行时检查仍是安全边界。

**把非拓宽请求照样当作审批通道的询问。** 否决：提示人类授予调用已经拥有的访问权限是噪音，而且原 note 中非拓宽请求绝不提示任何人的保证值得保留。

**静默丢弃 `sandbox_permissions` 字段，按有效模式运行且不盖章。** 对执行中的调用行为等同，但返回授予的模式使两个家族的单调用盖章约定保持统一，并留下调用实际运行模式的准确记录。

## Consequences

冗余的升级请求现在退化为普通调用而不是错误，因此当模型或集成防御性地附带这些字段时，常驻宽模式的会话继续工作。可排秩的非拓宽请求不再出现严格拓宽错误文本；[sandbox Agent Note](../feature/2026-07-06-sandbox.zh.md) 与 `dsh-tool-bash`/`dsh-tool-pwsh` README 中描述旧行为的散文随本 note 一并更新。未知模式字符串仍失败关闭，封闭目标词汇在执行时依旧强制。`dsh-sandbox`、`dsh-tool-bash`、`dsh-tool-pwsh` 中的升级测试钉住重用行为、绝不降低保证与未知模式的失败关闭路径。
