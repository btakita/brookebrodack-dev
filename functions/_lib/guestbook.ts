/**
 * Shared helpers for the guestbook Pages Functions.
 *
 * Files and directories under `functions/` whose name starts with `_` are not
 * routed — this module is import-only.
 */
export type env_T = {
	DB:D1Database
	/** Admin dashboard password. `wrangler pages secret put GUESTBOOK_ADMIN_PASSWORD` */
	GUESTBOOK_ADMIN_PASSWORD?:string
	/** HMAC key for the admin session cookie + IP hashing. `wrangler pages secret put GUESTBOOK_ADMIN_SECRET` */
	GUESTBOOK_ADMIN_SECRET?:string
	/**
	 * Enables inline moderation at submit time. Without it entries are simply
	 * left `pending` for the cron Worker or the admin dashboard.
	 * `wrangler pages secret put OPENAI_API_KEY`
	 */
	OPENAI_API_KEY?:string
	/** Optional model override for inline moderation; defaults to gpt-4o-mini. */
	OPENAI_MODEL?:string
}
export type guestbook_entry_row_T = {
	id:number
	name:string
	message:string
	create_dts:string
	status:'pending'|'approved'|'rejected'
	moderated_at:string|null
	moderation_reason:string|null
	/**
	 * Set when an admin deletes the entry. Entries are never removed from the
	 * table, so this is the only thing that hides one from every read path.
	 */
	deleted_at?:string|null
}
export const guestbook_entry__name__maxlength = 80
export const guestbook_entry__message__maxlength = 1000
/** Max submissions accepted from one IP per hour. */
export const guestbook_entry__rate_limit = 5
export const admin_session__cookie = 'guestbook_admin'
/** Admin session lifetime, in seconds. */
export const admin_session__ttl = 60 * 60 * 12
export function json_(body:unknown, init?:ResponseInit) {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}
export function error_(status:number, message:string) {
	return json_({ error: message }, { status })
}
/**
 * D1 stores timestamps as `YYYY-MM-DD HH:MM:SS` in UTC. The API speaks
 * ISO-8601 so the browser can localise them.
 */
export function created_at_(create_dts:string) {
	return create_dts.replace(' ', 'T') + 'Z'
}
export function entry__public_(row:guestbook_entry_row_T) {
	return {
		id: row.id,
		name: row.name,
		message: row.message,
		created_at: created_at_(row.create_dts),
	}
}
/**
 * Validates a submitted entry. Mirrors the browser-side check in
 * `@btakita/domain--any--brookebrodack/guestbook` — the browser copy is a
 * convenience, this one is the one that counts.
 *
 * @returns an error message, or `null` when the entry is valid.
 */
export function entry__validate(entry:{ name?:unknown, message?:unknown }) {
	const name = typeof entry.name === 'string' ? entry.name.trim() : ''
	const message = typeof entry.message === 'string' ? entry.message.trim() : ''
	if (!name) return 'Please enter your name.'
	if (name.length > guestbook_entry__name__maxlength) {
		return `Please keep your name under ${guestbook_entry__name__maxlength} characters.`
	}
	if (!message) return 'Please enter a message.'
	if (message.length > guestbook_entry__message__maxlength) {
		return `Please keep your message under ${guestbook_entry__message__maxlength} characters.`
	}
	return null
}
async function hmac_(secret:string, data:string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'])
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
	return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2, '0')).join('')
}
/** Salted hash of the client IP. The raw address is never persisted. */
export function ip_hash_(request:Request, secret:string) {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
	return hmac_(secret, `ip:${ip}`)
}
/** Constant-time string comparison, to keep the password check timing-flat. */
export function timing_safe_equal(a:string, b:string) {
	const a_bytes = new TextEncoder().encode(a)
	const b_bytes = new TextEncoder().encode(b)
	// Compare the lengths without early-return, then the bytes. Unequal
	// lengths still walk the full loop.
	let mismatch = a_bytes.length ^ b_bytes.length
	for (let i = 0; i < Math.max(a_bytes.length, b_bytes.length); i++) {
		mismatch |= (a_bytes[i] ?? 0) ^ (b_bytes[i] ?? 0)
	}
	return mismatch === 0
}
export async function admin_session__sign(secret:string, expires_at:number) {
	return `${expires_at}.${await hmac_(secret, `session:${expires_at}`)}`
}
/** Verifies the admin session cookie. Returns false on any malformed value. */
export async function admin_session__verify(secret:string, cookie:string|null) {
	if (!cookie) return false
	const dot = cookie.indexOf('.')
	if (dot < 0) return false
	const expires_at = Number(cookie.slice(0, dot))
	if (!Number.isFinite(expires_at) || expires_at <= Date.now() / 1000) return false
	return timing_safe_equal(cookie, await admin_session__sign(secret, expires_at))
}
export function cookie_(request:Request, name:string) {
	const header = request.headers.get('Cookie')
	if (!header) return null
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq < 0) continue
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
	}
	return null
}
/**
 * Gate for every admin endpoint.
 *
 * @returns a `Response` to return immediately, or `null` when authorised.
 */
export async function admin__guard(request:Request, env:env_T) {
	if (!env.GUESTBOOK_ADMIN_SECRET || !env.GUESTBOOK_ADMIN_PASSWORD) {
		return error_(503, 'The guestbook admin is not configured.')
	}
	const ok = await admin_session__verify(
		env.GUESTBOOK_ADMIN_SECRET,
		cookie_(request, admin_session__cookie))
	return ok ? null : error_(401, 'Not signed in.')
}
