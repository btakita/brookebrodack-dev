import {
	type env_T,
	entry__public_,
	entry__validate,
	error_,
	guestbook_entry__rate_limit,
	type guestbook_entry_row_T,
	ip_hash_,
	json_
} from '../../_lib/guestbook.js'
import { entry__judge_now } from '../../../scripts/_lib/guestbook-moderation.ts'
/** Most recent approved entries returned to the public page. */
const entry__page_size = 200
/**
 * `GET /guestbook/api/entries` — approved entries, newest first.
 *
 * Only `status = 'approved'` is ever served. Pending and rejected entries are
 * visible solely through the admin dashboard, and a soft-deleted entry is
 * served by nothing.
 */
export const onRequestGet:PagesFunction<env_T> = async ({ env })=>{
	const { results } = await env.DB
		.prepare(`
			SELECT id, name, message, create_dts
			FROM guestbook_entry
			WHERE status = 'approved' AND deleted_at IS NULL
			ORDER BY create_dts DESC, id DESC
			LIMIT ?`)
		.bind(entry__page_size)
		.all<guestbook_entry_row_T>()
	return json_(results.map(entry__public_))
}
/**
 * `POST /guestbook/api/entries` — submit an entry.
 *
 * Entries are stored as `pending` and do not appear on the page until the
 * moderation pass or an admin approves them, so the success response
 * deliberately does not echo the entry back.
 */
export const onRequestPost:PagesFunction<env_T> = async ({ request, env })=>{
	if (!env.GUESTBOOK_ADMIN_SECRET) {
		return error_(503, 'The guestbook is not accepting messages right now.')
	}
	let body:{ name?:unknown, message?:unknown }
	try {
		body = await request.json()
	} catch {
		return error_(400, 'Could not read your message.')
	}
	const invalid = entry__validate(body)
	if (invalid) return error_(400, invalid)
	const ip_hash = await ip_hash_(request, env.GUESTBOOK_ADMIN_SECRET)
	const recent = await env.DB
		.prepare(`
			SELECT COUNT(*) AS count
			FROM guestbook_entry
			WHERE ip_hash = ? AND create_dts > datetime('now', '-1 hour')`)
		.bind(ip_hash)
		.first<{ count:number }>()
	if ((recent?.count ?? 0) >= guestbook_entry__rate_limit) {
		return error_(429, 'You have signed the guestbook a few times already. Please try again later.')
	}
	const name = String(body.name).trim()
	const message = String(body.message).trim()
	// RETURNING gives us the id without a second round-trip, so the entry can be
	// judged immediately below.
	const row = await env.DB
		.prepare(`
			INSERT INTO guestbook_entry (name, message, status, ip_hash)
			VALUES (?, ?, 'pending', ?)
			RETURNING id, create_dts`)
		.bind(name, message, ip_hash)
		.first<{ id:number, create_dts:string }>()
	// Judge inline so an ordinary message goes live while the visitor is still
	// looking at the page. This is best-effort: the row is already committed as
	// `pending`, and every failure path leaves it that way for the cron sweep or
	// the admin dashboard. A moderation problem never fails the submission.
	let status:'approved'|'rejected'|'pending' = 'pending'
	if (row) {
		try {
			status = await entry__judge_now(
				{ id: row.id, name, message, create_dts: row.create_dts },
				{
					db: {
						update: (next_status, reason, id)=>env.DB
							.prepare(`
								UPDATE guestbook_entry
								SET status = ?, moderated_at = datetime('now'), moderation_reason = ?
								WHERE id = ? AND status = 'pending'`)
							.bind(next_status, reason, id)
							.run(),
					},
					api_key: env.OPENAI_API_KEY,
					model: env.OPENAI_MODEL,
				})
		} catch (err) {
			console.error('guestbook: inline moderation failed', err)
		}
	}
	// `rejected` and `pending` deliberately read the same to the submitter: a
	// spammer learns nothing from the difference, and a false positive still
	// looks like a normal outcome to a real visitor.
	return json_({
		status,
		message: status === 'approved'
			? 'Thank you! Your message is now on the page.'
			: 'Thank you! Your message will appear once it has been reviewed.',
	}, { status: 201 })
}
