import {
	admin__guard,
	type env_T,
	error_,
	json_
} from '../../../../_lib/guestbook.js'
const decision_a1 = ['approved', 'rejected', 'pending'] as const
type decision_T = typeof decision_a1[number]
/**
 * `POST /guestbook/api/admin/entries/:id` — set an entry's moderation status.
 *
 * Accepts `pending` as well, so an admin can put an entry back in the queue
 * after an accidental decision.
 */
export const onRequestPost:PagesFunction<env_T> = async ({ request, env, params })=>{
	const denied = await admin__guard(request, env)
	if (denied) return denied
	const id = Number(params.id)
	if (!Number.isInteger(id) || id <= 0) return error_(400, 'Invalid entry id.')
	let body:{ status?:unknown, reason?:unknown }
	try {
		body = await request.json()
	} catch {
		return error_(400, 'Could not read the request.')
	}
	const status = body.status
	if (typeof status !== 'string' || !(decision_a1 as readonly string[]).includes(status)) {
		return error_(400, `Status must be one of ${decision_a1.join(', ')}.`)
	}
	const reason = typeof body.reason === 'string' && body.reason.trim()
		? body.reason.trim().slice(0, 500)
		: 'Reviewed in the admin dashboard'
	const result = await env.DB
		.prepare(`
			UPDATE guestbook_entry
			SET status = ?,
			    moderated_at = datetime('now'),
			    moderation_reason = ?
			WHERE id = ?`)
		.bind(status as decision_T, reason, id)
		.run()
	if (!result.meta.changes) return error_(404, 'No such entry.')
	return json_({ id, status, reason })
}
/** `DELETE /guestbook/api/admin/entries/:id` — permanently remove an entry. */
export const onRequestDelete:PagesFunction<env_T> = async ({ request, env, params })=>{
	const denied = await admin__guard(request, env)
	if (denied) return denied
	const id = Number(params.id)
	if (!Number.isInteger(id) || id <= 0) return error_(400, 'Invalid entry id.')
	const result = await env.DB
		.prepare('DELETE FROM guestbook_entry WHERE id = ?')
		.bind(id)
		.run()
	if (!result.meta.changes) return error_(404, 'No such entry.')
	return json_({ id, deleted: true })
}
