import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/ignorable-journal': { value: string }
  }
}

describe('Session.appendIgnorable', () => {
  it('commits typed log-only metadata that an unaware reader retains without model history', () => {
    const session = Session.create(SessionId('journal-writer'))
    const event = session.appendIgnorable('test/ignorable-journal', { value: 'recorded' })
    expect(event).toMatchObject({ type: 'test/ignorable-journal', ignorable: true, data: { value: 'recorded' } })
    const restored = Session.create(SessionId('journal-reader'), session.snapshotEvents())
    expect(restored.snapshotEvents()[0]).toEqual(event)
    expect(restored.deriveMessages()).toEqual([])
    const required = session.append('turn/start', { turn: 1 })
    expect(required.ignorable).toBeUndefined()
    if (false) {
      // @ts-expect-error -- model-producing events cannot be marked ignorable by this log-only API.
      session.appendIgnorable('user/message', {})
    }
  })
})
