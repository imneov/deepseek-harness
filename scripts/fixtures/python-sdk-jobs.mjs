/** Deterministic producer for the packaged Python SDK job recordings. */
export const name = 'python-sdk-jobs'
export const inject = ['tools', 'jobs']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned registrations. */
export function apply(ctx) {
  for (const remove of [false, true]) {
    ctx.tools.register({
      name: remove ? 'snapshot_remove_job' : 'snapshot_start_job',
      description: remove ? 'Collect a foreground job by removal.' : 'Start a job for terminal output reads.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render(_args, id) { return [{ type: 'text', text: id }] },
      },
      async execute(_args, exec) {
        if (exec.agent === undefined) throw new Error('job fixture requires an owning agent')
        const owner = exec.agent.id
        const id = ctx.jobs.start({
          kind: 'bash', owner, label: remove ? 'python foreground job' : 'python output job',
          run(job) {
            job.append('python stream\n')
            return {
              cancel() {},
              done: Promise.resolve({ status: 'completed', result: 'python final' }),
            }
          },
        })
        await ctx.jobs.wait(id, 1000, owner)
        if (remove) ctx.jobs.remove(id, owner)
        return id
      },
    })
  }
}
