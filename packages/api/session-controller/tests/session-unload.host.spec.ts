/** Runtime disposal updates availability without deleting durable Session rows. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

describe('Session runtime unloading', () => {
  it.each([false, true])('keeps the catalog row when initialization fails: %s', async (failInitialization) => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await mountAgentLoopTestHarness(ctx)
      ctx.sessionProjections.register(titleProjectionDefinition)
      const remote = createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/workspace',
      })
      const added = vi.fn()
      const removed = vi.fn()
      ctx.on('api-session/added', added)
      ctx.on('api-session/removed', removed)
      const stored: SessionHeader[] = []
      ctx.on('session/created', (session) => {
        stored.push(session.header)
        session.append('session/title', { title: 'Durable conversation' })
      })
      const removeFailure = ctx.on('agent/created', () => {
        if (failInitialization) throw new Error('initialization failed')
      })
      const id = SessionId('unloaded')
      if (failInitialization) {
        await expect(ctx.agents.create({ sessionId: id, meta: { cwd: '/workspace' } }))
          .rejects.toThrow('initialization failed')
      } else {
        const owned = await ctx.agents.create({ sessionId: id, meta: { cwd: '/workspace' } })
        await owned.dispose()
      }
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(removed).not.toHaveBeenCalled()
      expect(added).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: id, agentAvailable: false, running: false,
        projections: expect.objectContaining({ values: expect.objectContaining({ title: 'Durable conversation' }) }),
      }))
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: () => Promise.resolve(stored),
      }) as never)
      const cold = await remote.list({})
      expect(cold.ok && cold.value.items.map(item => item.sessionId)).toContain(id)
      stored.length = 0
      const deleted = await remote.list({})
      expect(deleted.ok && deleted.value.items).toEqual([])
      removeFailure()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
