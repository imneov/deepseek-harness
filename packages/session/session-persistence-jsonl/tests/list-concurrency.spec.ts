import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JsonlSessionPersistence from '../src/index.ts'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const reads = vi.hoisted(() => ({
  root: '',
  entered: 0,
  closed: 0,
  active: 0,
  maximum: 0,
  resume: undefined as Promise<void> | undefined,
  onEntered: undefined as (() => void) | undefined,
  failure: undefined as Error | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!reads.root || !String(args[0]).startsWith(reads.root) || args[1] !== 'r') return handle
      const read = handle.read.bind(handle)
      const close = handle.close.bind(handle)
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        reads.entered += 1
        reads.active += 1
        reads.maximum = Math.max(reads.maximum, reads.active)
        reads.onEntered?.()
        try {
          await reads.resume
          if (reads.failure !== undefined) throw reads.failure
          return await read(...readArgs)
        } finally {
          reads.active -= 1
        }
      }) as typeof handle.read
      handle.close = async () => {
        await close()
        reads.closed += 1
      }
      return handle
    }) as typeof actual.open,
  }
})

let root: string
let ctx: Context | undefined
let release: (() => void) | undefined
let operation: Promise<unknown> | undefined

afterEach(async () => {
  release?.()
  await operation?.catch(() => undefined)
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  Object.assign(reads, {
    root: '', entered: 0, closed: 0, active: 0, maximum: 0,
    resume: undefined, onEntered: undefined, failure: undefined,
  })
  ctx = undefined
  operation = undefined
  release = undefined
})

it.each((['none', 'zstd'] as const).flatMap(compression =>
  (['success', 'abort', 'I/O failure'] as const).map(outcome => ({ compression, outcome })),
))(
  'bounds $compression header reads and closes every handle before $outcome settles', async ({ compression, outcome }) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-list-concurrency-'))
    for (let index = 0; index < 6; index += 1) {
      const header = meta(`session-${index}`, '/list-concurrency')
      const path = generationLogPath(root, header.cwd, header.id, header.version, compression)
      await mkdir(dirname(path), { recursive: true })
      const headerLine = JSON.stringify(toHeaderLine(header)) + '\n'
      await writeFile(path, compression === 'none'
        ? headerLine + 'invalid body must not be read\n'
        : Buffer.concat([await compressZstdFrame(headerLine), Buffer.from('invalid body must not be read')]))
    }
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression, listConcurrency: 2 })
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    release = () => resume.resolve(undefined)
    reads.root = root
    reads.resume = resume.promise
    reads.onEntered = () => { if (reads.entered === 2) entered.resolve(undefined) }
    const controller = new AbortController()
    const failure = new Error(outcome)
    operation = ctx.sessionPersistence.list({ signal: controller.signal })
    // Attach the rejection observer before either controlled failure is released.
    const result = operation.then(value => ({ value }), error => ({ error }))
    const deadline = setTimeout(() => entered.reject(new Error('second header read never entered')), 5000)
    try {
      await entered.promise
      expect(reads.active).toBe(2)
      expect(reads.entered).toBe(2)
      if (outcome === 'abort') controller.abort(failure)
      if (outcome === 'I/O failure') reads.failure = failure
      resume.resolve(undefined)
      const settled = await result
      expect(reads.active).toBe(0)
      expect(reads.closed).toBe(reads.entered)
      expect(reads.maximum).toBe(2)
      if (outcome === 'success') {
        expect(settled).toHaveProperty('value')
        if ('value' in settled) expect(settled.value).toHaveLength(6)
        expect(reads.entered).toBe(6)
      } else {
        expect(settled).toEqual({ error: failure })
        expect(reads.entered).toBe(2)
      }
    } finally {
      clearTimeout(deadline)
      resume.resolve(undefined)
      await result
    }
  },
)


it('validates discovery concurrency once in the plugin configuration schema', () => {
  expect(JsonlSessionPersistence.Config({ root: '/sessions' }).listConcurrency).toBe(16)
  expect(JsonlSessionPersistence.Config({ root: '/sessions', listConcurrency: 1 }).listConcurrency).toBe(1)
  for (const listConcurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => JsonlSessionPersistence.Config({ root: '/sessions', listConcurrency })).toThrow()
  }
})
