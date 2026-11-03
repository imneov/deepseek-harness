import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile, appendFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JsonlSessionPersistence from '../src/index.ts'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const probes = vi.hoisted(() => ({ root: '', reads: 0, scans: 0, stats: 0,
  failure: undefined as Error | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (probes.root && String(args[0]).startsWith(probes.root)) {
        probes.stats += 1
        if (probes.failure) throw probes.failure
      }
      return actual.stat(...args)
    }) as typeof actual.stat,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (probes.root && String(args[0]) === probes.root) probes.scans += 1
      return actual.readdir(...args)
    }) as typeof actual.readdir,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!probes.root || !String(args[0]).startsWith(probes.root) || args[1] !== 'r') return handle
      probes.reads += 1
      const read = handle.read.bind(handle)
      handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs)
        const afterRead = probes.afterRead
        probes.afterRead = undefined
        await afterRead?.()
        return result
      }
      return handle
    },
  }
})
let root = ''
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  ctx = undefined
  Object.assign(probes, { root: '', reads: 0, scans: 0, stats: 0, failure: undefined, afterRead: undefined })
})

it('rescans once and reuses only detached headers from equal physical revisions', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-metadata-'))
  const header = meta('cached', '/work')
  const path = generationLogPath(root, header.cwd, header.id, header.version, 'none')
  await mkdir(dirname(path), { recursive: true })
  const encode = (preset: string) => JSON.stringify(toHeaderLine({ ...header, agentPreset: preset })) + '\n'
  await writeFile(path, encode('first'))
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  probes.root = root
  const cold = await ctx.sessionPersistence.list()
  expect(probes.reads).toBe(1)
  probes.scans = probes.stats = 0
  Object.assign(cold[0]!.header, { agentPreset: 'caller mutation' })
  const warm = await ctx.sessionPersistence.list()
  expect(warm[0]!.header.agentPreset).toBe('first')
  expect(probes.reads).toBe(1)
  expect(probes.scans).toBe(1)
  expect(probes.stats).toBe(1)
  await writeFile(path, encode('other'))
  expect((await ctx.sessionPersistence.list())[0]!.header.agentPreset).toBe('other')
  const replacement = path + '.replacement'
  await writeFile(replacement, encode('third'))
  await rename(replacement, path)
  expect((await ctx.sessionPersistence.list())[0]!.header.agentPreset).toBe('third')
  const beforeAppend = (await ctx.sessionPersistence.list())[0]!
  await appendFile(path, 'body ignored\n')
  const appended = (await ctx.sessionPersistence.list())[0]!
  expect(appended.revision).not.toBe(beforeAppend.revision)
  expect(appended.sizeBytes).toBeGreaterThan(beforeAppend.sizeBytes!)
  probes.failure = Object.assign(new Error('probe denied'), { code: 'EACCES' })
  await expect(ctx.sessionPersistence.list()).rejects.toBe(probes.failure)
  probes.failure = undefined
  await writeFile(path, 'bad header\n')
  expect(await ctx.sessionPersistence.list()).toEqual([])
  await writeFile(path, encode('fixed'))
  expect((await ctx.sessionPersistence.list())[0]!.header.agentPreset).toBe('fixed')
  await rm(path)
  expect(await ctx.sessionPersistence.list()).toEqual([])
})

it('does not attach a header read across a physical revision change to the new revision', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-metadata-changing-'))
  const header = meta('changing', '/work')
  const path = generationLogPath(root, header.cwd, header.id, header.version, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(toHeaderLine({ ...header, agentPreset: 'before' })) + '\n')
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  probes.root = root
  probes.afterRead = () => writeFile(path, JSON.stringify(toHeaderLine({ ...header, agentPreset: 'after' })) + '\n')
  expect((await ctx.sessionPersistence.list())[0]!.header.agentPreset).toBe('before')
  expect((await ctx.sessionPersistence.list())[0]!.header.agentPreset).toBe('after')
  expect(probes.reads).toBe(2)
  await ctx.sessionPersistence.list()
  expect(probes.reads).toBe(2)
})

it('includes unreadable and unsupported selected members in warm historical corpus revisions', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-metadata-corpus-'))
  const parent = meta('historical', '/work')
  const path = generationLogPath(root, parent.cwd, parent.id, 0, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ type: 'session', version: 0, id: parent.id,
    createdAt: parent.createdAt, cwd: parent.cwd, delegationDepth: 0 }) + '\n')
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const original = (await ctx.sessionPersistence.list())[0]!
  expect((await ctx.sessionPersistence.list())[0]!.revision).toBe(original.revision)
  const broken = meta('broken', '/external-project')
  const brokenPath = generationLogPath(root, broken.cwd, broken.id, broken.version, 'none')
  await mkdir(dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, 'unreadable header\n')
  const added = await ctx.sessionPersistence.list()
  expect(added).toHaveLength(1)
  expect(added[0]!.revision).not.toBe(original.revision)
  expect((await ctx.sessionPersistence.stat(parent.id))!.revision).toBe(added[0]!.revision)
  await appendFile(brokenPath, 'changed\n')
  const modified = (await ctx.sessionPersistence.list())[0]!.revision
  expect(modified).not.toBe(added[0]!.revision)
  const futurePath = generationLogPath(root, broken.cwd, broken.id, broken.version + 1, 'none')
  await writeFile(futurePath, JSON.stringify({ type: 'session', version: broken.version + 1, id: broken.id }) + '\n')
  const future = await ctx.sessionPersistence.list()
  expect(future).toHaveLength(1)
  expect(future[0]!.revision).not.toBe(modified)
  await rm(dirname(brokenPath), { recursive: true })
  expect((await ctx.sessionPersistence.list())[0]!.revision).toBe(original.revision)
  const successor = generationLogPath(root, parent.cwd, parent.id, parent.version, 'none')
  await writeFile(successor, JSON.stringify(toHeaderLine({ ...parent, agentPreset: 'successor' })) + '\n')
  const selected = await ctx.sessionPersistence.list()
  expect(selected).toHaveLength(1)
  expect(selected[0]!.header.agentPreset).toBe('successor')
  const duplicatePath = generationLogPath(root, '/other-project', parent.id, parent.version, 'none')
  await mkdir(dirname(duplicatePath), { recursive: true })
  await writeFile(duplicatePath, JSON.stringify(toHeaderLine({ ...parent, cwd: '/other-project' })) + '\n')
  await expect(ctx.sessionPersistence.list()).rejects.toThrow(/duplicate JSONL session id/)
})
