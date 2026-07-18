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
	// Clearing `deleted_at` makes this the undelete path too: setting a status
	// on a deleted entry brings it back, which is the same "undo an accidental
	// decision" affordance applied to an accidental delete.
	const result = await env.DB
		.prepare(`
			UPDATE guestbook_entry
			SET status = ?,
			    moderated_at = datetime('now'),
			    moderation_reason = ?,
			    deleted_at = NULL
			WHERE id = ?`)
		.bind(status as decision_T, reason, id)
		.run()
	if (!result.meta.changes) return error_(404, 'No such entry.')
	return json_({ id, status, reason })
}
/**
 * `DELETE /guestbook/api/admin/entries/:id` — hide an entry from every read
 * path.
 *
 * This is a soft delete. The row, and the message a visitor wrote, is retained
 * in full; only `deleted_at` is set, and the read paths filter on it. Nothing
 * here removes a message from the table.
 *
 * Reversible: a `POST` to this route restores the entry along with the status
 * it is given, so an accidental delete is undone the same way an accidental
 * decision is.
 */
export const onRequestDelete:PagesFunction<env_T> = async ({ request, env, params })=>{
	const denied = await admin__guard(request, env)
	if (denied) return denied
	const id = Number(params.id)
	if (!Number.isInteger(id) || id <= 0) return error_(400, 'Invalid entry id.')
	// `deleted_at IS NULL` keeps a repeat delete from moving the timestamp,
	// so the record of when it was first removed survives.
	const result = await env.DB
		.prepare(`
			UPDATE guestbook_entry
			SET deleted_at = datetime('now')
			WHERE id = ? AND deleted_at IS NULL`)
		.bind(id)
		.run()
	if (!result.meta.changes) {
		// Either no such id, or it was already deleted. Distinguish the two so a
		// double-delete is not reported as a missing entry.
		const existing = await env.DB
			.prepare('SELECT deleted_at FROM guestbook_entry WHERE id = ?')
			.bind(id)
			.first<{ deleted_at:string|null }>()
		if (!existing) return error_(404, 'No such entry.')
		return json_({ id, deleted: true, deleted_at: existing.deleted_at })
	}
	return json_({ id, deleted: true })
}
