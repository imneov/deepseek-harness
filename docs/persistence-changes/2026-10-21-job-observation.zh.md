---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-job-observation

[English](2026-10-21-job-observation.md) | 中文

## 概述

新增可选的所有者会话作业观察日志事件，携带稳定的注册表与实例身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-job-observation
baseline: false
changes:
  - root: "event:jobs/collected"
    previous: null
    after: "ed7a9d4486ff70d1375b1242864b78e63aca92ed2f620bb0eca9fd47f400d7aa"
    decision: same-version
  - root: "event:jobs/registered"
    previous: null
    after: "f4e6a19413549200c22e5288b2d58bd791e75e033175a0662839c6a0381f63ad"
    decision: same-version
  - root: "event:jobs/settled"
    previous: null
    after: "9a9ea866e2ad1c37d00e559cf538bb48f424e62c8ae11b9cb7e1a97988eb7eac"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

三个新增仅日志事件均写入 ignorable:true。现有载荷和 Session 格式代次保持不变。旧读取方保留这些未知记录而不解释。记录缺失表示未知，不能证明收取或模型理解。同步作业操作仅提交内存，持久性需要现有 Session flush 屏障。

<a id="verification"></a>
## 验证

真实 Loader、AgentLoop、jobs-local、tool-jobs 与 JSONL 组合通过：注册记录经 flush 保留，终态 job_output 的首次和重复回执经 reload 保留，替换注册表中的同名作业具有新的 epoch 和 instance。显式 Session appendIgnorable 回归验证不认识事件的读取方保留记录且不派生模型消息。

<a id="dev-note"></a>
## 开发备注

无。
