import {
	admin__guard,
	created_at_,
	type env_T,
	type guestbook_entry_row_T,
	json_
} from '../../../_lib/guestbook.js'
const entry__page_size = 200
const status_a1 = ['pending', 'approved', 'rejected'] as const
/**
 * `deleted` is not a status — it is the soft-delete flag — but the dashboard
 * needs a way to reach retained entries, so it is accepted as a filter here.
 */
const filter_a1 = [...status_a1, 'deleted'] as const
/**
 * `GET /guestbook/api/admin/entries?status=pending` — the moderation queue.
 *
 * Unlike the public endpoint this returns every field, including the
 * moderation decision and its reason.
 *
 * Soft-deleted entries are excluded from the status views and reachable via
 * `?status=deleted`. They are never removed from the table, so this is the
 * only place they can be read back.
 */
export const onRequestGet:PagesFunction<env_T> = async ({ request, env })=>{
	const denied = await admin__guard(request, env)
	if (denied) return denied
	const url = new URL(request.url)
	const status = url.searchParams.get('status') ?? 'pending'
	if (!(filter_a1 as readonly string[]).includes(status)) {
		return json_({ error: `Unknown status "${status}".` }, { status: 400 })
	}
	const deleted_view = status === 'deleted'
	const { results } = await env.DB
		.prepare(`
			SELECT id, name, message, create_dts, status, moderated_at, moderation_reason, deleted_at
			FROM guestbook_entry
			WHERE ${deleted_view ? 'deleted_at IS NOT NULL' : 'status = ? AND deleted_at IS NULL'}
			ORDER BY create_dts DESC, id DESC
			LIMIT ?`)
		.bind(...(deleted_view ? [entry__page_size] : [status, entry__page_size]))
		.all<guestbook_entry_row_T>()
	// Status counts describe the live queue, so they exclude deleted entries;
	// `deleted` is counted separately rather than folded into a status.
	const counts = await env.DB
		.prepare(`
			SELECT status, COUNT(*) AS count
			FROM guestbook_entry
			WHERE deleted_at IS NULL
			GROUP BY status`)
		.all<{ status:string, count:number }>()
	const deleted_count = await env.DB
		.prepare('SELECT COUNT(*) AS count FROM guestbook_entry WHERE deleted_at IS NOT NULL')
		.first<{ count:number }>()
	return json_({
		status,
		counts: {
			...Object.fromEntries(
				status_a1.map(s=>[
					s,
					counts.results.find(row=>row.status === s)?.count ?? 0
				])),
			deleted: deleted_count?.count ?? 0,
		},
		entries: results.map(row=>({
			id: row.id,
			name: row.name,
			message: row.message,
			created_at: created_at_(row.create_dts),
			status: row.status,
			moderated_at: row.moderated_at ? created_at_(row.moderated_at) : null,
			moderation_reason: row.moderation_reason,
			deleted_at: row.deleted_at ? created_at_(row.deleted_at) : null,
		})),
	})
}
