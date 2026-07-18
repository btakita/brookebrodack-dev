/**
 * Guestbook dispatch hub — the edge half of the freehold transport.
 *
 * This replaces polling. The cron Worker in `workers/guestbook-moderate` wakes
 * every 15 minutes and asks D1 whether anything is pending; here the edge
 * *pushes* a job the moment an entry arrives, over a WebSocket the freehold
 * host opened. The host runs behind NAT on hardware Brian owns, so it is always
 * the client and the edge can never dial in — which is exactly why the socket
 * is held open rather than reconnected per job.
 *
 * A Durable Object because that is the only thing on Cloudflare that can hold
 * one: a Pages Function is per-request and has nowhere to keep a socket. Same
 * reason `guestbook-moderate` is a separate Worker — Pages Functions have no
 * scheduled handler either.
 *
 * Fail-closed throughout. If no host is connected, entries simply stay
 * `pending`: nothing is lost, nothing auto-publishes, and the admin dashboard
 * and the cron Worker both still work. Losing the freehold degrades latency,
 * not correctness.
 *
 * Deploy:
 *   cd workers/guestbook-dispatch
 *   bunx wrangler secret put FREEHOLD_DISPATCH_KEY
 *   bunx wrangler deploy
 */
import {
	type decision_T,
	decision_a1__apply,
	type pending_entry_T,
} from '../../scripts/_lib/guestbook-moderation.ts'

export type env_T = {
	DB:D1Database
	FREEHOLD_HUB:DurableObjectNamespace
	/**
	 * Shared secret the freehold host presents on connect. The host reads it
	 * from its own environment as FREEHOLD_DISPATCH_KEY and never forwards it
	 * to a plugin — `freehold-host`'s config refuses to load if a plugin lists
	 * it in `env_allow`.
	 */
	FREEHOLD_DISPATCH_KEY?:string
}
/**
 * How long a host has to answer before the edge stops waiting. The host drops
 * its own late results rather than publishing minutes after the visitor was
 * told the entry was pending, so both ends agree on the same deadline.
 */
export const job__deadline_ms = 60_000
/** Entries per job. Matches the batch the moderation prompt is built for. */
export const job__batch_size = 25
/** Only one hub instance exists; every request routes to this name. */
export const hub__name = 'guestbook'
/**
 * Constant-time compare. A plain `===` on a secret leaks its prefix through
 * response timing, and this endpoint is public.
 */
export function secret__matches(presented:string, expected:string) {
	if (presented.length !== expected.length) return false
	let diff = 0
	for (let i = 0; i < presented.length; i++) {
		diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
	}
	return diff === 0
}
/** `Authorization: Bearer <token>` → token, or null. */
export function bearer_(header:string|null) {
	if (!header) return null
	const [scheme, ...rest] = header.split(' ')
	if (scheme?.toLowerCase() !== 'bearer') return null
	const token = rest.join(' ').trim()
	return token.length ? token : null
}
export type frame_T =
	| { type:'hello', freehold_version:string, kinds:string[], plugin_ids:string[], max_concurrency:number }
	| { type:'ready', resume_token:string }
	| { type:'dispatch', job:job_T }
	| { type:'claim', job_id:string, lease_ms:number }
	| { type:'complete', result:{ job_id:string, result:unknown } }
	| { type:'ping' }
	| { type:'pong' }
export type job_T = {
	id:string
	kind:string
	payload:{ entries:pending_entry_T[] }
	deadline_dts:number
}
/**
 * Parse a frame without trusting it. An unparseable or unknown frame is
 * ignored rather than closing the connection, so the protocol can grow without
 * a lockstep deploy of both halves.
 */
export function frame_(raw:string):frame_T|null {
	let parsed:unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const type = (parsed as { type?:unknown }).type
	return typeof type === 'string' ? parsed as frame_T : null
}
/**
 * Decisions a host returned, narrowed to the shape we will act on.
 *
 * This is the edge's half of the bounded-vocabulary firewall: the host already
 * parses its plugins strictly, and we do not take its word for the result
 * either. A decision naming an entry that was not in the job is dropped — a
 * host answering a question it was not asked must not move an unrelated entry.
 */
export function decision_a1_(result:unknown, entry_id_a1:number[]):decision_T[] {
	const decisions = (result as { decisions?:unknown })?.decisions
	if (!Array.isArray(decisions)) return []
	const allowed = new Set(entry_id_a1)
	const out:decision_T[] = []
	for (const raw of decisions) {
		if (!raw || typeof raw !== 'object') continue
		const { id, decision, reason } = raw as Record<string, unknown>
		if (typeof id !== 'number' || !allowed.has(id)) continue
		if (decision !== 'approve' && decision !== 'reject' && decision !== 'escalate') continue
		out.push({ id, decision, reason: typeof reason === 'string' ? reason : '' })
	}
	return out
}
/** Jobs the edge has handed out and is still waiting on. */
type claim_T = {
	entry_id_a1:number[]
	deadline_dts:number
}
export class freehold_hub_C implements DurableObject {
	#state:DurableObjectState
	#env:env_T
	constructor(state:DurableObjectState, env:env_T) {
		this.#state = state
		this.#env = env
	}
	async fetch(request:Request) {
		const url = new URL(request.url)
		if (url.pathname === '/notify') {
			// An entry landed. Push immediately if a host is listening.
			await this.#dispatch_pending()
			return new Response(null, { status: 204 })
		}
		if (url.pathname !== '/connect') return new Response('not found', { status: 404 })
		if (request.headers.get('upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 })
		}
		const expected = this.#env.FREEHOLD_DISPATCH_KEY
		const presented = bearer_(request.headers.get('authorization'))
		if (!expected || !presented || !secret__matches(presented, expected)) {
			return new Response('unauthorized', { status: 401 })
		}
		const pair = new WebSocketPair()
		// Hibernation: without this the DO stays billed while the socket idles,
		// which for a personal guestbook is very nearly all of the time.
		this.#state.acceptWebSocket(pair[1])
		return new Response(null, { status: 101, webSocket: pair[0] })
	}
	async webSocketMessage(ws:WebSocket, message:string|ArrayBuffer) {
		if (typeof message !== 'string') return
		const frame = frame_(message)
		if (!frame) return
		switch (frame.type) {
			case 'hello': {
				// Accept, then drain whatever accumulated while nobody was
				// connected — a host that comes back after a laptop sleep
				// should not wait for the next submission.
				this.#send(ws, { type: 'ready', resume_token: crypto.randomUUID() })
				await this.#dispatch_pending()
				return
			}
			case 'claim': {
				const claim = await this.#state.storage.get<claim_T>(`claim:${frame.job_id}`)
				if (!claim) return
				// The lease is the host's promise to answer. Its expiry is what
				// returns the work to the pool if the host dies mid-job, so it
				// is stored durably rather than held in memory.
				const deadline_dts = Date.now() + Math.min(frame.lease_ms, job__deadline_ms)
				await this.#state.storage.put(`claim:${frame.job_id}`, { ...claim, deadline_dts })
				await this.#state.storage.setAlarm(deadline_dts)
				return
			}
			case 'complete': {
				const job_id = frame.result?.job_id
				if (typeof job_id !== 'string') return
				const claim = await this.#state.storage.get<claim_T>(`claim:${job_id}`)
				// Unknown or already-expired job. The edge stopped waiting, so
				// applying this now would publish late.
				if (!claim) return
				if (Date.now() >= claim.deadline_dts) {
					await this.#state.storage.delete(`claim:${job_id}`)
					return
				}
				const decision_a1 = decision_a1_(frame.result?.result, claim.entry_id_a1)
				await decision_a1__apply(this.#env.DB, decision_a1)
				await this.#state.storage.delete(`claim:${job_id}`)
				return
			}
			case 'ping': {
				this.#send(ws, { type: 'pong' })
				return
			}
			default:
				return
		}
	}
	async webSocketClose(_ws:WebSocket, _code:number, _reason:string, _clean:boolean) {
		// Nothing to tear down: claims live in storage and expire on their own
		// alarm, so a host that vanishes mid-job returns its work to the pool
		// without anyone polling for that either.
	}
	async alarm() {
		const now = Date.now()
		const claims = await this.#state.storage.list<claim_T>({ prefix: 'claim:' })
		let next:number|null = null
		for (const [key, claim] of claims) {
			if (now >= claim.deadline_dts) await this.#state.storage.delete(key)
			else next = next === null ? claim.deadline_dts : Math.min(next, claim.deadline_dts)
		}
		if (next !== null) await this.#state.storage.setAlarm(next)
		// Anything freed by an expired lease is pending again, so offer it on.
		await this.#dispatch_pending()
	}
	/**
	 * Offer pending entries to a connected host.
	 *
	 * Entries already inside a live claim are excluded, so a re-dispatch after
	 * a reconnect cannot produce two verdicts for one entry. The host declines
	 * duplicates too — both ends refuse, because either alone would be enough
	 * to publish twice if the other had a bug.
	 */
	async #dispatch_pending() {
		const socket_a1 = this.#state.getWebSockets()
		if (!socket_a1.length) return
		const claims = await this.#state.storage.list<claim_T>({ prefix: 'claim:' })
		const in_flight = new Set<number>()
		for (const [, claim] of claims) for (const id of claim.entry_id_a1) in_flight.add(id)
		const { results } = await this.#env.DB
			.prepare(
				`SELECT id, name, message, create_dts
				 FROM guestbook_entry
				 WHERE status = 'pending' AND deleted_at IS NULL
				 ORDER BY id
				 LIMIT ?`)
			.bind(job__batch_size + in_flight.size)
			.all<pending_entry_T>()
		const entry_a1 = (results ?? [])
			.filter((entry)=>!in_flight.has(entry.id))
			.slice(0, job__batch_size)
		if (!entry_a1.length) return
		const job:job_T = {
			id: crypto.randomUUID(),
			kind: 'moderation',
			payload: { entries: entry_a1 },
			deadline_dts: Date.now() + job__deadline_ms,
		}
		await this.#state.storage.put(`claim:${job.id}`, {
			entry_id_a1: entry_a1.map((entry)=>entry.id),
			deadline_dts: job.deadline_dts,
		} satisfies claim_T)
		await this.#state.storage.setAlarm(job.deadline_dts)
		this.#send(socket_a1[0]!, { type: 'dispatch', job })
	}
	#send(ws:WebSocket, frame:frame_T) {
		try {
			ws.send(JSON.stringify(frame))
		} catch {
			// A socket that died between getWebSockets() and send() is not an
			// error worth failing a request over; the entry stays pending.
		}
	}
}
export default {
	async fetch(request:Request, env:env_T) {
		const id = env.FREEHOLD_HUB.idFromName(hub__name)
		return env.FREEHOLD_HUB.get(id).fetch(request)
	},
} satisfies ExportedHandler<env_T>
