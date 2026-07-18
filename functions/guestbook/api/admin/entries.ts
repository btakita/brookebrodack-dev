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
 * `GET /guestbook/api/admin/entries?status=pending` — the moderation queue.
 *
 * Unlike the public endpoint this returns every field, including the
 * moderation decision and its reason.
 */
export const onRequestGet:PagesFunction<env_T> = async ({ request, env })=>{
	const denied = await admin__guard(request, env)
	if (denied) return denied
	const url = new URL(request.url)
	const status = url.searchParams.get('status') ?? 'pending'
	if (!(status_a1 as readonly string[]).includes(status)) {
		return json_({ error: `Unknown status "${status}".` }, { status: 400 })
	}
	const { results } = await env.DB
		.prepare(`
			SELECT id, name, message, create_dts, status, moderated_at, moderation_reason
			FROM guestbook_entry
			WHERE status = ?
			ORDER BY create_dts DESC, id DESC
			LIMIT ?`)
		.bind(status, entry__page_size)
		.all<guestbook_entry_row_T>()
	const counts = await env.DB
		.prepare('SELECT status, COUNT(*) AS count FROM guestbook_entry GROUP BY status')
		.all<{ status:string, count:number }>()
	return json_({
		status,
		counts: Object.fromEntries(
			status_a1.map(s=>[
				s,
				counts.results.find(row=>row.status === s)?.count ?? 0
			])),
		entries: results.map(row=>({
			id: row.id,
			name: row.name,
			message: row.message,
			created_at: created_at_(row.create_dts),
			status: row.status,
			moderated_at: row.moderated_at ? created_at_(row.moderated_at) : null,
			moderation_reason: row.moderation_reason,
		})),
	})
}
