import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermes__judge, provider_a1 } from '../scripts/guestbook-moderate.ts'
import { batch__judge as batch__judge_, text__json } from '../scripts/_lib/guestbook-moderation.ts'
const batch__judge = (b:Parameters<typeof batch__judge_>[0])=>batch__judge_(b, provider_a1())

/**
 * Moderation provider tests.
 *
 * The invariant under test is fail-closed: no provider failure, malformed reply,
 * or missing decision may ever publish a guestbook entry. Every such path must
 * resolve to `escalate`, which leaves the entry in the queue for /guestbook/admin.
 *
 * hermes is stubbed with throwaway shell scripts via HERMES_BIN, so these run
 * offline and deterministically — no model call, no network.
 */
const dir = mkdtempSync(join(tmpdir(), 'guestbook-moderate-'))
afterAll(()=>rmSync(dir, { recursive: true, force: true }))
const batch = [
	{ id: 1, name: 'Ann', message: 'Loved your videos!', create_dts: '2026-01-01' },
	{ id: 2, name: 'Spam', message: 'buy cheap pills http://x.co', create_dts: '2026-01-01' },
]
async function hermes__stub(name:string, body:string) {
	const path = join(dir, name)
	await Bun.write(path, `#!/bin/sh\n${body}\n`)
	await Bun.spawn(['chmod', '+x', path]).exited
	process.env.HERMES_BIN = path
	return path
}
beforeEach(()=>{
	// No fallback unless a test opts in, so `escalate` results are attributable
	// to the hermes path rather than to a stray ambient key.
	delete process.env.OPENAI_API_KEY
})

describe('text__json', ()=>{
	it('passes a bare object through', ()=>{
		expect(text__json('{"decisions":[]}')).toBe('{"decisions":[]}')
	})
	it('unwraps a code fence', ()=>{
		expect(text__json('```json\n{"a":1}\n```')).toBe('{"a":1}')
	})
	it('extracts an object embedded in prose', ()=>{
		expect(text__json('Sure!\n{"a":1}\nDone.')).toBe('{"a":1}')
	})
})

describe('hermes__judge', ()=>{
	it('treats a failure printed with exit status 0 as a failure', async()=>{
		// hermes exits 0 even when the run fails, so the exit code cannot be
		// trusted — a missed failure here would read as an empty judgement.
		await hermes__stub('fail.sh',
			`echo 'hermes -z: agent failed: Attempted to access streaming response content'\nexit 0`)
		expect(hermes__judge(batch)).rejects.toThrow(/agent failed/)
	})
	it('treats empty output as a failure', async()=>{
		await hermes__stub('empty.sh', 'exit 0')
		expect(hermes__judge(batch)).rejects.toThrow(/no output/)
	})
})

describe('batch__judge', ()=>{
	it('applies decisions from a clean hermes reply', async()=>{
		await hermes__stub('ok.sh', `cat <<'EOF'
{"decisions":[{"id":1,"decision":"approve","reason":"friendly"},{"id":2,"decision":"reject","reason":"spam"}]}
EOF`)
		const out = await batch__judge(batch)
		expect(out[0]!.decision).toBe('approve')
		expect(out[1]!.decision).toBe('reject')
	})
	it('parses a reply wrapped in a fence and prose', async()=>{
		await hermes__stub('fenced.sh', `cat <<'EOF'
Here you go:
\`\`\`json
{"decisions":[{"id":1,"decision":"escalate","reason":"unsure"},{"id":2,"decision":"reject","reason":"spam"}]}
\`\`\`
EOF`)
		const out = await batch__judge(batch)
		expect(out[0]!.decision).toBe('escalate')
		expect(out[1]!.decision).toBe('reject')
	})
	it('escalates the whole batch when every provider fails', async()=>{
		await hermes__stub('fail.sh', `echo 'hermes -z: agent failed: boom'\nexit 0`)
		const out = await batch__judge(batch)
		expect(out.every(d=>d.decision === 'escalate')).toBe(true)
		expect(out[0]!.reason).toContain('hermes')
	})
	it('escalates an entry the model omitted from its reply', async()=>{
		await hermes__stub('partial.sh', `cat <<'EOF'
{"decisions":[{"id":1,"decision":"approve","reason":"ok"}]}
EOF`)
		const out = await batch__judge(batch)
		expect(out[0]!.decision).toBe('approve')
		expect(out[1]!.decision).toBe('escalate')
	})
	it('escalates rather than trusting an unknown decision value', async()=>{
		await hermes__stub('bogus.sh', `cat <<'EOF'
{"decisions":[{"id":1,"decision":"publish","reason":"nope"},{"id":2,"decision":"approve","reason":"ok"}]}
EOF`)
		const out = await batch__judge(batch)
		expect(out[0]!.decision).toBe('escalate')
	})
	it('escalates when hermes emits unparseable output', async()=>{
		await hermes__stub('garbage.sh', `echo 'not json at all'`)
		const out = await batch__judge(batch)
		expect(out.every(d=>d.decision === 'escalate')).toBe(true)
	})
})

describe('worker scheduled moderate()', ()=>{
	/** Minimal D1 stand-in: records bound UPDATEs instead of running them. */
	function db__stub(pending:typeof batch) {
		// `applied` is status changes only. Recording an escalation is also an
		// UPDATE, but it publishes nothing — keeping the two apart is what lets
		// "escalating writes no status" stay assertable now that an escalation
		// leaves a trace.
		const applied:unknown[][] = []
		const escalated:unknown[][] = []
		const db = {
			prepare(sql:string) {
				const stmt = {
					_bind: [] as unknown[],
					bind(...a:unknown[]) {
						stmt._bind = a
						if (sql.includes('SET status')) applied.push(a)
						else if (sql.includes('SET escalated_at')) escalated.push(a)
						return stmt
					},
					all: async()=>({ results: pending }),
				}
				return stmt
			},
			batch: async()=>[],
		}
		return { db, applied, escalated }
	}
	function openai__stub(body:unknown, ok = true) {
		globalThis.fetch = (async()=>new Response(JSON.stringify(body), {
			status: ok ? 200 : 500,
			headers: { 'Content-Type': 'application/json' },
		})) as typeof fetch
	}
	const real_fetch = globalThis.fetch
	afterAll(()=>{ globalThis.fetch = real_fetch })

	it('writes back approvals and rejections from OpenAI', async()=>{
		const { moderate } = await import('../workers/guestbook-moderate/index.ts')
		const { db, applied } = db__stub(batch)
		openai__stub({ choices: [{ message: { content: JSON.stringify({
			decisions: [
				{ id: 1, decision: 'approve', reason: 'friendly' },
				{ id: 2, decision: 'reject', reason: 'spam' },
			],
		}) } }] })
		const out = await moderate({ DB: db as never, OPENAI_API_KEY: 'k' })
		expect(out).toEqual({ pending: 2, approved: 1, rejected: 1, escalated: 0 })
		expect(applied.length).toBe(2)
		expect(applied[0]![0]).toBe('approved')
		expect(applied[1]![0]).toBe('rejected')
	})
	it('escalates without publishing, and records that this panel declined', async()=>{
		const { moderate } = await import('../workers/guestbook-moderate/index.ts')
		const { db, applied, escalated } = db__stub(batch)
		openai__stub({ error: { message: 'upstream boom' } }, false)
		const out = await moderate({ DB: db as never, OPENAI_API_KEY: 'k' })
		expect(out.escalated).toBe(2)
		expect(applied.length).toBe(0)
		// Without the record the sweep re-judges these two every 15 minutes for
		// as long as they sit in the queue — a bill once a model is answering.
		expect(escalated.length).toBe(2)
		for (const bound of escalated) expect(bound[0]).toBe('cron:openai:default')
	})
	it('does nothing at all without a key', async()=>{
		const { moderate } = await import('../workers/guestbook-moderate/index.ts')
		const { db, applied } = db__stub(batch)
		const out = await moderate({ DB: db as never })
		expect(out.pending).toBe(0)
		expect(applied.length).toBe(0)
	})
})

describe('entry__judge_now (submit-time moderation)', ()=>{
	const entry = { id: 7, name: 'Ann', message: 'Loved your videos!', create_dts: '2026-01-01' }
	const real_fetch = globalThis.fetch
	afterAll(()=>{ globalThis.fetch = real_fetch })
	function db__spy() {
		const applied:unknown[][] = []
		return {
			applied,
			update: async(status:string, reason:string, id:number)=>{ applied.push([status, reason, id]) },
		}
	}
	function openai__reply(decision:string, ok = true) {
		globalThis.fetch = (async()=>new Response(JSON.stringify(ok
			? { choices: [{ message: { content: JSON.stringify({
				decisions: [{ id: 7, decision, reason: 'because' }] }) } }] }
			: { error: { message: 'down' } }), { status: ok ? 200 : 503 })) as typeof fetch
	}

	it('publishes an approved entry immediately', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		openai__reply('approve')
		expect(await entry__judge_now(entry, { db, api_key: 'k' })).toBe('approved')
		expect(db.applied[0]![0]).toBe('approved')
	})
	it('marks a rejected entry without publishing it', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		openai__reply('reject')
		expect(await entry__judge_now(entry, { db, api_key: 'k' })).toBe('rejected')
		expect(db.applied[0]![0]).toBe('rejected')
	})
	it('leaves an escalated entry pending and untouched', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		openai__reply('escalate')
		expect(await entry__judge_now(entry, { db, api_key: 'k' })).toBe('pending')
		expect(db.applied.length).toBe(0)
	})
	it('leaves the entry pending when the model is down', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		openai__reply('approve', false)
		expect(await entry__judge_now(entry, { db, api_key: 'k' })).toBe('pending')
		expect(db.applied.length).toBe(0)
	})
	it('is a no-op without a key, so submission still works', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		expect(await entry__judge_now(entry, { db })).toBe('pending')
		expect(db.applied.length).toBe(0)
	})
	it('leaves the entry pending when the model times out', async()=>{
		const { entry__judge_now } = await import('../scripts/_lib/guestbook-moderation.ts')
		const db = db__spy()
		globalThis.fetch = ((_u:unknown, init?:RequestInit)=>new Promise((_res, rej)=>{
			init?.signal?.addEventListener('abort', ()=>rej(new Error('The operation timed out.')))
		})) as typeof fetch
		expect(await entry__judge_now(entry, { db, api_key: 'k', timeout_ms: 50 })).toBe('pending')
		expect(db.applied.length).toBe(0)
	})
})
