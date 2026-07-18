/**
 * Guestbook AI moderation pass.
 *
 * Reads `pending` guestbook entries out of D1, asks a model to judge each one,
 * and writes back `approved` / `rejected` with the reason. Anything the model is
 * not confident about is left `pending` for a human to handle in the admin
 * dashboard at /guestbook/admin — the queue is the safe default, not the
 * failure case.
 *
 * Judging runs through the local `hermes` agent first and falls back to the
 * OpenAI API if hermes is unavailable or returns something unusable. If every
 * provider fails, the whole batch escalates: a broken model pipeline can never
 * publish an entry.
 *
 * Usage:
 *   bun scripts/guestbook-moderate.ts [--dry-run] [--limit N]
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID    Cloudflare account that owns the D1 database
 *   CLOUDFLARE_API_TOKEN     Token with D1 edit permission
 *   BROOKEBRODACK_D1_ID      D1 database id (defaults to the brookebrodack db)
 *   OPENAI_API_KEY           Fallback provider. Optional, but with it unset the
 *                            script has nowhere to go when hermes fails.
 *   OPENAI_MODEL             Fallback model (default gpt-4o-mini)
 *   HERMES_BIN               hermes executable (default `hermes`)
 *   HERMES_MODEL             Model override passed to hermes as `-m`
 *   HERMES_TIMEOUT_MS        Per-batch hermes timeout (default 180000)
 *
 * Run it on a schedule with an env file holding those values — every 15
 * minutes is a reasonable cadence, since nothing is published until it runs:
 *
 *   0,15,30,45 * * * * cd /path/to/brookebrodack-dev \
 *     && set -a && . ./.env.guestbook && set +a \
 *     && bun scripts/guestbook-moderate.ts >> /var/log/guestbook-moderate.log 2>&1
 *
 * Missing a run is harmless — entries simply wait in the queue, and the admin
 * dashboard at /guestbook/admin can approve them by hand at any time.
 */
import {
	batch__judge,
	batch_size,
	openai__provider,
	system,
	batch__prompt,
	type decision_T,
	type pending_entry_T,
	type provider_T,
} from './_lib/guestbook-moderation.ts'
const d1_database_id = process.env.BROOKEBRODACK_D1_ID
	?? 'dc50a79e-5479-4685-ac29-4c7f15fa5c57'
// CLOUDFLARE_* is read at query time, not import time, so the module stays
// importable by tests that never touch D1. A missing value still fails loudly
// on the first query.
const dry_run = process.argv.includes('--dry-run')
const limit = limit__parse() ?? 200
// Guarded so the provider layer below can be imported by tests without the CLI
// run firing.
if (import.meta.main) {
	main().catch(err=>{
		console.error(err)
		process.exit(1)
	})
}
async function main() {
	const pending_a1 = await pending_a1__load()
	if (!pending_a1.length) {
		console.log('guestbook-moderate: nothing pending')
		return
	}
	console.log(`guestbook-moderate: ${pending_a1.length} pending`)
	const decision_a1:decision_T[] = []
	for (let i = 0; i < pending_a1.length; i += batch_size) {
		const batch = pending_a1.slice(i, i + batch_size)
		decision_a1.push(...await batch__judge(batch, provider_a1()))
	}
	const tally = { approve: 0, reject: 0, escalate: 0 }
	for (const decision of decision_a1) {
		tally[decision.decision]++
		const entry = pending_a1.find(e=>e.id === decision.id)
		console.log(
			`  #${decision.id} ${decision.decision.padEnd(8)} ${JSON.stringify(entry?.message.slice(0, 60) ?? '')}`
			+ `\n      ${decision.reason}`)
	}
	if (dry_run) {
		console.log('guestbook-moderate: --dry-run, no changes written')
	} else {
		await decision_a1__apply(decision_a1)
	}
	console.log(
		`guestbook-moderate: approved ${tally.approve}, rejected ${tally.reject},`
		+ ` left for review ${tally.escalate}`)
}
async function pending_a1__load() {
	const rows = await d1_query<pending_entry_T>(
		`SELECT id, name, message, create_dts
		 FROM guestbook_entry
		 WHERE status = 'pending' AND deleted_at IS NULL
		 ORDER BY id
		 LIMIT ?`,
		[limit])
	return rows
}
/**
 * Local provider order: the hermes agent first, OpenAI as the fallback.
 *
 * OpenAI is only offered when it is actually credentialed, so the log says
 * "not configured" once here instead of a confusing auth error per batch.
 */
export function provider_a1():provider_T[] {
	const a1:provider_T[] = [{ name: 'hermes', judge: hermes__judge }]
	if (process.env.OPENAI_API_KEY) {
		a1.push(openai__provider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL))
	} else console.warn('guestbook-moderate: OPENAI_API_KEY not set, no fallback provider')
	return a1
}
/**
 * Primary provider: the local hermes agent in one-shot mode.
 *
 * Tools and project rules are switched off (`-t ''`, `--ignore-rules`). This is
 * a security requirement, not a tidiness one — the prompt embeds untrusted
 * visitor text, and a moderation pass has no business holding shell, browser,
 * or filesystem tools while it reads that.
 *
 * hermes exits 0 even when the run fails, printing `hermes -z: agent failed:`
 * to stdout, so success is decided by inspecting the output rather than by the
 * exit code.
 */
export async function hermes__judge(batch:pending_entry_T[]) {
	const bin = process.env.HERMES_BIN ?? 'hermes'
	const arg_a1 = [
		'-z', `${system}\n\n${batch__prompt(batch)}\n\n`
			+ 'Reply with JSON only, matching this shape, and nothing else — no '
			+ 'prose, no code fence:\n'
			+ '{"decisions":[{"id":<integer>,"decision":"approve|reject|escalate",'
			+ '"reason":"<one short sentence>"}]}',
		'-t', '',
		'--ignore-rules',
	]
	if (process.env.HERMES_MODEL) arg_a1.push('-m', process.env.HERMES_MODEL)
	const timeout_ms = Number(process.env.HERMES_TIMEOUT_MS) || 180_000
	const proc = Bun.spawn([bin, ...arg_a1], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const timer = setTimeout(()=>proc.kill(), timeout_ms)
	let stdout:string
	let stderr:string
	try {
		[stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		])
		await proc.exited
	} finally {
		clearTimeout(timer)
	}
	const text = stdout.trim()
	if (!text) throw new Error(`no output (${stderr.trim().slice(0, 200) || 'empty stderr'})`)
	// hermes reports its own failures on stdout with a zero exit status.
	if (/^hermes( -z)?:.*(failed|error)/im.test(text)) {
		throw new Error(text.split('\n').find(line=>/failed|error/i.test(line))!.slice(0, 200))
	}
	return text
}
async function decision_a1__apply(decision_a1:decision_T[]) {
	for (const decision of decision_a1) {
		if (decision.decision === 'escalate') continue
		await d1_query(
			`UPDATE guestbook_entry
			 SET status = ?, moderated_at = datetime('now'), moderation_reason = ?
			 WHERE id = ? AND status = 'pending'`,
			[
				decision.decision === 'approve' ? 'approved' : 'rejected',
				`AI moderation: ${decision.reason}`.slice(0, 500),
				decision.id,
			])
	}
}
async function d1_query<row_T = unknown>(sql:string, params:unknown[] = []) {
	const account_id = env__require('CLOUDFLARE_ACCOUNT_ID')
	const d1_token = env__require('CLOUDFLARE_API_TOKEN')
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account_id}/d1/database/${d1_database_id}/query`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${d1_token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ sql, params }),
		})
	const body = await res.json() as {
		success:boolean
		errors?:{ message:string }[]
		result?:{ results:row_T[] }[]
	}
	if (!res.ok || !body.success) {
		throw new Error(
			`D1 query failed (${res.status}): `
			+ (body.errors?.map(e=>e.message).join('; ') ?? 'unknown error'))
	}
	return body.result?.[0]?.results ?? []
}
function env__require(name:string) {
	const value = process.env[name]
	if (!value) throw new Error(`guestbook-moderate: ${name} is not set`)
	return value
}
function limit__parse() {
	const i = process.argv.indexOf('--limit')
	if (i < 0) return null
	const value = Number(process.argv[i + 1])
	return Number.isInteger(value) && value > 0 ? value : null
}
