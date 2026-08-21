# Agent Note: Reuse the standing mode for non-widening sandbox escalation requests

Status: implemented

English | [中文](2026-08-21-idempotent-non-widening-sandbox-escalation.zh.md)

## Problem

`approveEscalation()` failed the whole tool call whenever the model requested a sandbox mode at or below the call's effective mode, with `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`. The [sandbox Agent Note](../feature/2026-07-06-sandbox.md) chose that fail-closed answer so a non-widening request would never prompt a human, treating such a request purely as a model error.

In practice the request is not always an error. A model that was denied under one mode and later runs under a standing wider mode — a session whose durable override was raised, or a harness whose deployment default is already `danger-full-access` — can attach `sandbox_permissions` at the standing level, and integrations that template the escalation fields can emit them redundantly. Under a `danger-full-access` session every such call failed before executing anything, and because the failure text names a mode the call already holds, the model cannot repair the request by widening it further. The result was a session where every shell call was dead on arrival.

## Decision

A requested mode at or below the call's effective mode is idempotent: `approveEscalation()` returns the effective mode without consulting the approval channel, and the call executes under exactly the access it already had. A granted mode never lowers the call. Only a strict widening reaches the approval channel, so a non-widening request still never prompts a human — the guarantee the original note pinned — but it no longer kills the call either.

The comparison uses a total rank over the closed mode vocabulary (`read-only` < `workspace-write` < `danger-full-access`). A requested mode outside that vocabulary is not rankable and still falls through to the strict-widening check, where it fails closed with the existing verbatim `not strictly wider` text. The stable message therefore remains in the tool READMEs' error inventories; it now marks a malformed request rather than a redundant one.

## Alternatives considered

**Keep failing non-widening requests closed.** Rejected by real-world failure: under a standing `danger-full-access` mode the failure is unrepairable from the model side — no wider mode exists to request — and the deployment loses every escalating call. A fail-closed answer is only safe when the model can act on it.

**Strip the escalation fields from the schema when the session is already at the widest mode.** Rejected before in the original note: schemas are registry-global while the effective mode is per-session, so the enum cannot track per-session truth. The execution-time check remains the safety boundary.

**Treat a non-widening request as an approval-channel ask anyway.** Rejected: prompting a human to grant access the call already has is noise, and the original note's guarantee that a non-widening request never prompts anyone is worth keeping.

**Silently drop the `sandbox_permissions` field and run at the effective mode without stamping.** Behaviorally identical for the executing call, but returning the granted mode keeps the one-call stamping contract uniform for both families and leaves an accurate record of what the call ran under.

## Consequences

A redundant escalation request now degrades to a plain call instead of an error, so standing-wide sessions keep working when a model or integration attaches the fields defensively. The strict-widening error text no longer appears for rankable non-widening requests, and prose describing the old behavior in the [sandbox Agent Note](../feature/2026-07-06-sandbox.md) and the `dsh-tool-bash`/`dsh-tool-pwsh` READMEs is updated alongside this note. Unknown mode strings still fail closed, so the closed target vocabulary remains enforced at execution. Escalation tests in `dsh-sandbox`, `dsh-tool-bash`, and `dsh-tool-pwsh` pin the reuse, the never-lower guarantee, and the unknown-mode fail-closed path.
