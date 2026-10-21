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
    name,
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
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return ctx
}

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
