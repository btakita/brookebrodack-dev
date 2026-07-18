import { describe, expect, it } from 'bun:test'
import { admin_session__cookie, admin_session__sign } from '../functions/_lib/guestbook.ts'
import { onRequestGet as admin_entries__get } from '../functions/guestbook/api/admin/entries.ts'
import {
	onRequestDelete as admin_entry__delete,
	onRequestPost as admin_entry__post
} from '../functions/guestbook/api/admin/entries/[id].ts'
import { onRequestGet as public_entries__get } from '../functions/guestbook/api/entries.ts'

/**
 * Retention tests.
 *
 * The invariant under test is that a visitor's message is never removed from
 * the table. Admin "delete" is a soft delete, and every read path filters on
 * `deleted_at` instead. These assert on the SQL each handler issues, because
 * the property being protected is "no statement destroys a row" — which is a
 * statement about the query, not about a return value.
 */
const secret = 'test-secret'
const password = 'test-password'

/** Records every statement, so a test can assert on what was issued. */
function db__spy(rows:{ deleted_at?:string|null }[] = []) {
	const sql_a1:string[] = []
	const stmt_ = ()=>{
		const stmt:Record<string, unknown> = {
			bind: ()=>stmt,
			run: async ()=>({ meta: { changes: 1 } }),
			first: async ()=>rows[0] ?? { count: 0 },
			all: async ()=>({ results: rows }),
		}
		return stmt
	}
	return {
		sql_a1,
		db: {
			prepare(text:string) {
				sql_a1.push(text)
				return stmt_()
			},
		},
	}
}

async function env_(rows?:{ deleted_at?:string|null }[]) {
	const spy = db__spy(rows)
	return {
		spy,
		env: {
			DB: spy.db,
			GUESTBOOK_ADMIN_SECRET: secret,
			GUESTBOOK_ADMIN_PASSWORD: password,
		},
	}
}

/** A request carrying a valid, unexpired admin session. */
async function request_(method:string, body?:unknown) {
	const expires_at = Math.floor(Date.now() / 1000) + 3_600
	const cookie = await admin_session__sign(secret, expires_at)
	return new Request('https://example.test/guestbook/api/admin/entries/1', {
		method,
		headers: { Cookie: `${admin_session__cookie}=${cookie}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const ctx_ = (request:Request, env:unknown)=>
	({ request, env, params: { id: '1' } }) as never

describe('guestbook retention', ()=>{
	it('admin delete never issues a destructive statement', async ()=>{
		const { spy, env } = await env_()
		await admin_entry__delete(ctx_(await request_('DELETE'), env))
		const joined = spy.sql_a1.join('\n').toUpperCase()
		expect(joined).not.toContain('DELETE FROM')
		expect(joined).not.toContain('DROP ')
		expect(joined).not.toContain('TRUNCATE')
	})

	it('admin delete sets deleted_at instead of removing the row', async ()=>{
		const { spy, env } = await env_()
		await admin_entry__delete(ctx_(await request_('DELETE'), env))
		const update = spy.sql_a1.find(text=>text.includes('UPDATE guestbook_entry'))
		expect(update).toBeDefined()
		expect(update).toContain('deleted_at = datetime(\'now\')')
		// Guards the first-deletion timestamp against a repeat delete.
		expect(update).toContain('deleted_at IS NULL')
	})

	it('the public page never serves a deleted entry', async ()=>{
		const { spy, env } = await env_()
		await public_entries__get(ctx_(new Request('https://example.test/guestbook/api/entries'), env))
		const select = spy.sql_a1.find(text=>text.includes('FROM guestbook_entry'))
		expect(select).toContain('deleted_at IS NULL')
	})

	it('the admin queue excludes deleted entries', async ()=>{
		const { spy, env } = await env_()
		const request = new Request('https://example.test/guestbook/api/admin/entries?status=pending', {
			headers: (await request_('GET')).headers,
		})
		await admin_entries__get(ctx_(request, env))
		const select = spy.sql_a1.find(text=>text.includes('SELECT id, name, message'))
		expect(select).toContain('deleted_at IS NULL')
	})

	it('deleted entries stay reachable through ?status=deleted', async ()=>{
		const { spy, env } = await env_()
		const request = new Request('https://example.test/guestbook/api/admin/entries?status=deleted', {
			headers: (await request_('GET')).headers,
		})
		const response = await admin_entries__get(ctx_(request, env))
		expect(response.status).toBe(200)
		const select = spy.sql_a1.find(text=>text.includes('SELECT id, name, message'))
		expect(select).toContain('deleted_at IS NOT NULL')
	})

	it('setting a status restores a deleted entry', async ()=>{
		const { spy, env } = await env_()
		await admin_entry__post(ctx_(await request_('POST', { status: 'approved' }), env))
		const update = spy.sql_a1.find(text=>text.includes('UPDATE guestbook_entry'))
		expect(update).toContain('deleted_at = NULL')
	})

	it('the moderation sweep skips deleted entries', async ()=>{
		// The sweeper reads pending work directly; a deleted entry must not be
		// handed to a model or flipped back to approved behind the admin.
		const worker = await Bun.file('workers/guestbook-moderate/index.ts').text()
		const script = await Bun.file('scripts/guestbook-moderate.ts').text()
		expect(worker).toContain('status = \'pending\' AND deleted_at IS NULL')
		expect(script).toContain('status = \'pending\' AND deleted_at IS NULL')
	})
})
