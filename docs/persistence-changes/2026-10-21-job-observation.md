---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-job-observation

English | [中文](2026-10-21-job-observation.zh.md)

## Summary

Adds optional owner-session job observation journal events with stable registry and instance identity.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-job-observation
baseline: false
changes:
  - root: "event:jobs/collected"
    previous: null
    after: "f76ad6d72d4df8e9295acb820368b1e23178f1bb29c03a90e35f0c1fc7b1c871"
    decision: same-version
  - root: "event:jobs/registered"
    previous: null
    after: "fe8df306db98012b6c46c4af81a5330e23831f2b69f0d4ddc5f4573f1b5e3632"
    decision: same-version
  - root: "event:jobs/settled"
    previous: null
    after: "21825e1160f3e8f81061e11b444f3ddc4389d3cdc8bcd26969672b750c3797a6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The three new log-only event roots are emitted with ignorable:true. Existing payloads and Session format generation remain unchanged. Older readers retain these unknown records without interpreting them. Missing records are unknown, never evidence of collection or model understanding. Collection records distinguish terminal read from explicit foreground controller removal; teardown is never collection. Synchronous job operations commit to memory; durability requires the existing Session flush barrier.

<a id="verification"></a>
## Verification

Real Loader, AgentLoop, jobs-local, tool-jobs and JSONL composition passes: registration survives flush, terminal job_output first/repeat receipts persist through reload, and a replacement registry's same job id has a new epoch and instance. Explicit Session appendIgnorable regression verifies unaware-reader retention with no derived model messages.

<a id="dev-note"></a>
## Dev Note

None.
