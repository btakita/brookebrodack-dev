import {
	admin_session__cookie,
	admin_session__sign,
	admin_session__ttl,
	admin_session__verify,
	cookie_,
	type env_T,
	error_,
	json_,
	timing_safe_equal
} from '../../../_lib/guestbook.js'
function cookie__set(value:string, max_age:number) {
	return [
		`${admin_session__cookie}=${value}`,
		'Path=/guestbook',
		'HttpOnly',
		'Secure',
		'SameSite=Strict',
		`Max-Age=${max_age}`,
	].join('; ')
}
/** `GET /guestbook/api/admin/session` — is the current cookie still valid? */
export const onRequestGet:PagesFunction<env_T> = async ({ request, env })=>{
	if (!env.GUESTBOOK_ADMIN_SECRET || !env.GUESTBOOK_ADMIN_PASSWORD) {
		return error_(503, 'The guestbook admin is not configured.')
	}
	const signed_in = await admin_session__verify(
		env.GUESTBOOK_ADMIN_SECRET,
		cookie_(request, admin_session__cookie))
	return json_({ signed_in })
}
/** `POST /guestbook/api/admin/session` — sign in with the admin password. */
export const onRequestPost:PagesFunction<env_T> = async ({ request, env })=>{
	if (!env.GUESTBOOK_ADMIN_SECRET || !env.GUESTBOOK_ADMIN_PASSWORD) {
		return error_(503, 'The guestbook admin is not configured.')
	}
	let body:{ password?:unknown }
	try {
		body = await request.json()
	} catch {
		return error_(400, 'Could not read the sign-in request.')
	}
	const password = typeof body.password === 'string' ? body.password : ''
	if (!timing_safe_equal(password, env.GUESTBOOK_ADMIN_PASSWORD)) {
		return error_(401, 'Incorrect password.')
	}
	const expires_at = Math.floor(Date.now() / 1000) + admin_session__ttl
	const value = await admin_session__sign(env.GUESTBOOK_ADMIN_SECRET, expires_at)
	return json_({ signed_in: true }, {
		headers: { 'Set-Cookie': cookie__set(value, admin_session__ttl) },
	})
}
/** `DELETE /guestbook/api/admin/session` — sign out. */
export const onRequestDelete:PagesFunction<env_T> = ()=>
	json_({ signed_in: false }, {
		headers: { 'Set-Cookie': cookie__set('', 0) },
	})
