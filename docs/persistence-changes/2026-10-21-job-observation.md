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
## Compatibility

The three new log-only event roots are emitted with ignorable:true. Existing payloads and Session format generation remain unchanged. Older readers retain these unknown records without interpreting them. Missing records are unknown, never evidence of collection or model understanding. Synchronous job operations commit to memory; durability requires the existing Session flush barrier.

<a id="verification"></a>
## Verification

Real Loader, AgentLoop, jobs-local, tool-jobs and JSONL composition passes: registration survives flush, terminal job_output first/repeat receipts persist through reload, and a replacement registry's same job id has a new epoch and instance. Explicit Session appendIgnorable regression verifies unaware-reader retention with no derived model messages.

<a id="dev-note"></a>
## Dev Note

None.
