/**
 * Guestbook moderation on a Cloudflare Cron Trigger.
 *
 * This is the hosted alternative to running scripts/guestbook-moderate.ts from
 * your own crontab. It is a separate Worker rather than part of the Pages
 * project because Pages Functions have no scheduled handler — only Workers can
 * carry a cron trigger. It binds the same `brookebrodack` D1 database, so both
 * paths moderate the same queue and either can be used.
 *
 * Only OpenAI is available here: hermes is a local binary and cannot run on the
 * edge. The fail-closed contract is unchanged — if OpenAI is unreachable or
 * replies with anything unusable, entries stay `pending` for /guestbook/admin.
 *
 * Deploy:
 *   cd workers/guestbook-moderate
 *   bunx wrangler secret put OPENAI_API_KEY
 *   bunx wrangler deploy
 *
 * Trigger by hand (no public route is exposed):
 *   bunx wrangler dev --test-scheduled   then  curl localhost:8787/__scheduled
 */
import {
	batch__judge,
	batch_size,
	decision_a1__apply,
	openai__provider,
	type decision_T,
	type pending_entry_T,
} from '../../scripts/_lib/guestbook-moderation.ts'

export type env_T = {
	DB:D1Database
	/** `wrangler secret put OPENAI_API_KEY` */
	OPENAI_API_KEY?:string
	/** Optional model override; defaults to gpt-4o-mini. */
	OPENAI_MODEL?:string
	/** Max entries judged per run. Defaults to 200. */
	GUESTBOOK_MODERATE_LIMIT?:string
}
export default {
	async scheduled(_event:ScheduledEvent, env:env_T, ctx:ExecutionContext) {
		ctx.waitUntil(moderate(env))
	},
} satisfies ExportedHandler<env_T>

export async function moderate(env:env_T) {
	if (!env.OPENAI_API_KEY) {
		// Loud, and still fail-closed: nothing is published without a judgement.
		console.error('guestbook-moderate: OPENAI_API_KEY not set, skipping run')
		return { pending: 0, approved: 0, rejected: 0, escalated: 0 }
	}
	const limit = Number(env.GUESTBOOK_MODERATE_LIMIT) || 200
	// This sweep is a panel too, and it names itself by the model it asked, so
	// changing the model gives the new one its own look at everything the old
	// one escalated. Entries this same panel already declined to judge are not
	// re-judged every 15 minutes for as long as they sit in the queue.
	const panel_id = `cron:openai:${env.OPENAI_MODEL || 'default'}`
	const { results } = await env.DB
		.prepare(
			`SELECT id, name, message, create_dts
			 FROM guestbook_entry
			 WHERE status = 'pending' AND deleted_at IS NULL
			   AND (escalated_by IS NULL OR escalated_by IS NOT ?)
			 ORDER BY id
			 LIMIT ?`)
		.bind(panel_id, limit)
		.all<pending_entry_T>()
	const pending_a1 = results ?? []
	if (!pending_a1.length) {
		console.log('guestbook-moderate: nothing pending')
		return { pending: 0, approved: 0, rejected: 0, escalated: 0 }
	}
	const provider_a1 = [openai__provider(env.OPENAI_API_KEY, env.OPENAI_MODEL)]
	const decision_a1:decision_T[] = []
	for (let i = 0; i < pending_a1.length; i += batch_size) {
		decision_a1.push(
			...await batch__judge(pending_a1.slice(i, i + batch_size), provider_a1))
	}
	const tally = await decision_a1__apply(env.DB, decision_a1, panel_id)
	console.log(
		`guestbook-moderate: approved ${tally.approve}, rejected ${tally.reject},`
		+ ` left for review ${tally.escalate}`)
	return {
		pending: pending_a1.length,
		approved: tally.approve,
		rejected: tally.reject,
		escalated: tally.escalate,
	}
}
