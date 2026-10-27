import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-job-receipts-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry],
    ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
  ])
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([...modules.keys()].map(name => ({
    name: `cordis:${name}`,
    ...name === '@deepseek-ai/dsh-session-persistence-jsonl'
      ? { config: { root: join(root!, 'sessions'), compression: 'none' } }
      : name === '@deepseek-ai/dsh-agent-loop' ? { config: { agents: [] } }
        : name === '@deepseek-ai/dsh-tool-jobs' ? { config: { completionDelivery: 'quiet' } } : {},
  }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return ctx
}

async function terminalJob(ctx: Context, owner: SessionId) {
  const id = ctx.jobs.start({
    kind: 'bash', owner, label: 'unread receipt producer',
    run: (job) => {
      job.append('unread stream\n')
      return { cancel: () => {}, done: Promise.resolve({ status: 'completed', result: 'unread final' }) }
    },
  })
  await ctx.jobs.wait(id, 1000, owner)
  return ctx.jobs.observe(id, owner)
}

async function persistedEvents(ctx: Context, owner: SessionId) {
  const session = ctx.sessions.get(owner)
  if (session === undefined) throw new Error(`missing session ${owner}`)
  await ctx.sessions.flush(session)
  const reader = await ctx.sessionPersistence.open(owner, 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}

it.each(['deny', 'replace', 'unknown'] as const)('persists no receipt or collection for %s without reading the pending job', async (policy) => {
  const ctx = await boot()
  const adapter = new MockAdapter([
    toolCallResponse('negative', 'job_output', { job_id: policy === 'unknown' ? 'missing' : 'bash-1' }),
    textResponse('negative finished'),
    toolCallResponse('actual', 'job_output', { job_id: 'bash-1' }),
    textResponse('collected'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`negative-${policy}`), { provider: 'mock', model: 'mock' })
  const pending = await terminalJob(ctx, agent.id)
  let interceptions = 0
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.callId !== 'negative' || policy !== 'deny') return next()
    interceptions += 1
    return { kind: 'deny', reason: 'job output denied' }
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.callId !== 'negative' || policy !== 'replace') return next()
    interceptions += 1
    return {
      content: [], isError: false,
      value: { text: 'policy replacement', job: {
        id: pending.job.id, kind: 'bash', label: 'policy job', status: 'completed', startedAt: 0,
      } },
    }
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Attempt the guarded read.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(interceptions).toBe(policy === 'unknown' ? 0 : 1)
  expect(ctx.jobs.observe(pending.job.id, agent.id)).toEqual(pending)
  expect(pending.terminalResult).toBe('pending')
  const before = await persistedEvents(ctx, agent.id)
  const negative = before.filter(event => event.type === 'tool/result').map(event => event.data)
  expect(negative).toHaveLength(1)
  expect(negative[0]?.meta ?? {}).not.toHaveProperty('jobReceipt')
  expect(negative[0]?.message.isError ?? false).toBe(policy !== 'replace')
  expect(before.some(event => event.type === 'jobs/collected')).toBe(false)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the pending output.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const after = await persistedEvents(ctx, agent.id)
  const actual = after.filter(event => event.type === 'tool/result').map(event => event.data)[1]
  expect(actual?.meta).toEqual({ jobReceipt: {
    registryEpoch: pending.registryEpoch, instanceId: pending.instanceId, jobId: pending.job.id, terminalRead: 'first',
  } })
  expect(actual?.message.content).toEqual([{ type: 'text', text: 'unread stream\nunread final\n[status: completed]' }])
  expect(ctx.jobs.observe(pending.job.id, agent.id).terminalResult).toBe('collected')
  expect(after.filter(event => event.type === 'jobs/collected')).toMatchObject([{ data: { collection: 'read' } }])
})

it('keeps actual collection when post-execute replaces the read value without a receipt', async () => {
  const ctx = await boot()
  const adapter = new MockAdapter([
    toolCallResponse('post-replace', 'job_output', { job_id: 'bash-1' }),
    toolCallResponse('repeat', 'job_output', { job_id: 'bash-1' }),
    textResponse('collected before replacement'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('post-read-replacement'), { provider: 'mock', model: 'mock' })
  const pending = await terminalJob(ctx, agent.id)
  let replacements = 0
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.callId !== 'post-replace') return next()
    replacements += 1
    expect(ctx.jobs.observe(pending.job.id, agent.id).terminalResult).toBe('collected')
    expect(result.meta).toEqual({ jobReceipt: {
      registryEpoch: pending.registryEpoch, instanceId: pending.instanceId, jobId: pending.job.id, terminalRead: 'first',
    } })
    return { kind: 'accept', value: { text: 'policy replacement', job: {
      id: pending.job.id, kind: 'bash', label: 'policy job', status: 'completed', startedAt: 0,
    } } }
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read with a post policy.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(replacements).toBe(1)
  const events = await persistedEvents(ctx, agent.id)
  const results = events.filter(event => event.type === 'tool/result').map(event => event.data)
  expect(results).toHaveLength(2)
  expect(results[0]?.meta ?? {}).not.toHaveProperty('jobReceipt')
  expect(results[0]?.message.content).toEqual([{ type: 'text', text: 'policy replacement\n[status: completed]' }])
  expect(results[1]?.meta).toEqual({ jobReceipt: {
    registryEpoch: pending.registryEpoch, instanceId: pending.instanceId, jobId: pending.job.id, terminalRead: 'repeat',
  } })
  expect(results[1]?.message.content).toEqual([{ type: 'text', text: '(no new output)\n[status: completed]' }])
  expect(events.filter(event => event.type === 'jobs/collected')).toMatchObject([{ data: { collection: 'read' } }])
  expect(ctx.jobs.observe(pending.job.id, agent.id).terminalResult).toBe('collected')
})

it('persists real job_output receipts and owner lifecycle facts through Loader, loop, flush and reload', async () => {
  const ctx = await boot()
  const adapter = new MockAdapter([
    toolCallResponse('first', 'job_output', { job_id: 'bash-1', wait: true }),
    toolCallResponse('repeat', 'job_output', { job_id: 'bash-1' }),
    textResponse('collected'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('receipt-owner'), { provider: 'mock', model: 'mock' })
  let settle!: (outcome: JobOutcome) => void
  const id = ctx.jobs.start({
    kind: 'bash', owner: agent.id, label: 'receipt producer',
    run: (job) => {
      job.append('stream output\n')
      return {
        done: new Promise((resolve) => { settle = resolve }),
        cancel: () => { settle({ status: 'killed' }) },
      }
    },
  })
  const initial = ctx.jobs.observe(id, agent.id)
  expect(initial.terminalResult).toBe('not-terminal')
  await ctx.sessions.flush(agent.session)
  const before = await ctx.sessionPersistence.open(agent.id, 'read')
  try {
    expect((await before.read()).events).toContainEqual(expect.objectContaining({
      type: 'jobs/registered', ignorable: true, data: initial,
    }))
  } finally { await before.close() }
  const emptyRegistry = await boot()
  expect(emptyRegistry.jobs.list(agent.id)).toEqual([])
  const pendingHistory = await emptyRegistry.sessionPersistence.open(agent.id, 'read')
  try {
    const facts = (await pendingHistory.read()).events.filter(event => event.type.startsWith('jobs/'))
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ type: 'jobs/registered', data: {
      registryEpoch: initial.registryEpoch, instanceId: initial.instanceId, terminalResult: 'not-terminal',
    } })
  } finally { await pendingHistory.close() }
  settle({ status: 'completed', result: 'final value' })
  await ctx.jobs.wait(id, 1000, agent.id)
  expect(ctx.jobs.observe(id, agent.id).terminalResult).toBe('pending')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Collect the job.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(ctx.jobs.observe(id, agent.id).terminalResult).toBe('collected')
  await ctx.sessions.flush(agent.session)
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  try {
    const events = (await reader.read()).events
    const receipts = events.filter(event => event.type === 'tool/result').map(event => event.data.meta)
    const identity = { registryEpoch: initial.registryEpoch, instanceId: initial.instanceId, jobId: id }
    expect(receipts).toEqual([
      { jobReceipt: { ...identity, terminalRead: 'first' } },
      { jobReceipt: { ...identity, terminalRead: 'repeat' } },
    ])
    expect(events.filter(event => event.type.startsWith('jobs/')).map(event => ({
      type: event.type, ignorable: event.ignorable,
    }))).toEqual([
      { type: 'jobs/registered', ignorable: true },
      { type: 'jobs/settled', ignorable: true },
      { type: 'jobs/collected', ignorable: true },
    ])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.content)).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "stream output
      final value
      [status: completed]",
            "type": "text",
          },
        ],
        [
          {
            "text": "(no new output)
      [status: completed]",
            "type": "text",
          },
        ],
      ]
    `)
  } finally { await reader.close() }
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
  const restarted = await boot()
  const history = await restarted.sessionPersistence.open(agent.id, 'read')
  try {
    const events = (await history.read()).events
    expect(events.some(event => event.type === 'jobs/registered' && event.data.instanceId === initial.instanceId)).toBe(true)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  } finally { await history.close() }
  const replacement = await restarted.agentLoop.create(SessionId('new-owner'), { provider: 'mock', model: 'mock' })
  const newId = restarted.jobs.start({
    kind: 'bash', owner: replacement.id, label: 'replacement',
    run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
  })
  const fresh = restarted.jobs.observe(newId, replacement.id)
  expect(newId).toBe(id)
  expect(fresh.registryEpoch).not.toBe(initial.registryEpoch)
  expect(fresh.instanceId).not.toBe(initial.instanceId)
})
