import { GlobalRegistrator } from '@happy-dom/global-registrator'
// happy-dom registers DOM globals process-wide, and `bun test` runs every file
// in one process — leaving it registered replaces `fetch`/`Response` for the
// server route tests and fails them. Register here, hand the globals back in
// afterAll.
GlobalRegistrator.register()
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
afterAll(async()=>{ await GlobalRegistrator.unregister() })
import { guestbook__hyop } from '../lib/ui--browser--brookebrodack/guestbook/hyop/index.ts'

/**
 * Guestbook hydration tests.
 *
 * These exercise the Lazily state layer through the DOM it derives: set state
 * by driving real events, then assert on what rendered. Nothing here reaches
 * into the reactive graph directly, so the tests stay honest about what a
 * visitor actually sees.
 */
const entry_a1 = [
	{ id: 1, name: 'Ann', message: 'Loved your videos!', created_at: '2026-01-01T00:00:00Z' },
	{ id: 2, name: 'Bo', message: 'Hello from Boston', created_at: '2026-01-02T00:00:00Z' },
]
function section_() {
	document.body.innerHTML = `
		<section>
			<div id="guestbook__entries"></div>
			<form id="guestbook__form">
				<input name="name">
				<textarea name="message"></textarea>
				<p id="guestbook__form_error" class="hidden"></p>
				<button type="submit">Sign</button>
			</form>
		</section>`
	return document.body.querySelector('section')! as unknown as HTMLElement
}
function entries__text() {
	return document.querySelector('#guestbook__entries')!.textContent ?? ''
}
function notice__el() {
	return document.querySelector('#guestbook__form_error')!
}
function form__fill(name:string, message:string) {
	document.querySelector<HTMLInputElement>('input[name=name]')!.value = name
	document.querySelector<HTMLTextAreaElement>('textarea[name=message]')!.value = message
}
async function submit__drive() {
	document.querySelector('#guestbook__form')!
		.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
	// let the submit handler's promise chain settle
	await new Promise(res=>setTimeout(res, 0))
	await new Promise(res=>setTimeout(res, 0))
}
const real_fetch = globalThis.fetch
afterEach(()=>{ globalThis.fetch = real_fetch })
beforeEach(()=>{ document.body.innerHTML = '' })

describe('guestbook__hyop load states', ()=>{
	it('renders entries returned by the API', async()=>{
		globalThis.fetch = (async()=>Response.json(entry_a1)) as typeof fetch
		await guestbook__hyop(section_())
		expect(entries__text()).toContain('Loved your videos!')
		expect(entries__text()).toContain('Hello from Boston')
	})
	it('shows an empty-state message when there are no entries', async()=>{
		globalThis.fetch = (async()=>Response.json([])) as typeof fetch
		await guestbook__hyop(section_())
		expect(entries__text()).toContain('Be the first to sign the guestbook')
	})
	it('shows an error state when the API fails', async()=>{
		globalThis.fetch = (async()=>new Response('nope', { status: 500 })) as typeof fetch
		await guestbook__hyop(section_())
		expect(entries__text()).toContain('could not be loaded')
	})
	it('renders entry text as text, never as markup', async()=>{
		globalThis.fetch = (async()=>Response.json([{
			id: 9, name: '<img src=x onerror=alert(1)>', message: '<script>alert(2)</script>',
			created_at: '2026-01-01T00:00:00Z',
		}])) as typeof fetch
		await guestbook__hyop(section_())
		const entries = document.querySelector('#guestbook__entries')!
		expect(entries.querySelector('img')).toBeNull()
		expect(entries.querySelector('script')).toBeNull()
		expect(entries.textContent).toContain('<script>alert(2)</script>')
	})
})

describe('guestbook__hyop submit states', ()=>{
	it('shows a validation error without calling the API', async()=>{
		let posts = 0
		globalThis.fetch = (async(_u:unknown, init?:RequestInit)=>{
			if (init?.method === 'POST') posts++
			return Response.json([])
		}) as typeof fetch
		await guestbook__hyop(section_())
		form__fill('', '')
		await submit__drive()
		expect(posts).toBe(0)
		expect(notice__el().classList.contains('hidden')).toBe(false)
		expect(notice__el().classList.contains('text-red-700')).toBe(true)
	})
	it('shows the API message as an info notice on success', async()=>{
		globalThis.fetch = (async(_u:unknown, init?:RequestInit)=>init?.method === 'POST'
			? Response.json({ status: 'approved', message: 'Your message is now on the page.' })
			: Response.json(entry_a1)) as typeof fetch
		await guestbook__hyop(section_())
		form__fill('Ann', 'Hello there')
		await submit__drive()
		expect(notice__el().textContent).toContain('now on the page')
		expect(notice__el().classList.contains('text-gray-700')).toBe(true)
		expect(notice__el().classList.contains('text-red-700')).toBe(false)
	})
	it('reports a held entry as pending rather than silently clearing', async()=>{
		globalThis.fetch = (async(_u:unknown, init?:RequestInit)=>init?.method === 'POST'
			? Response.json({ status: 'pending', message: 'will appear once it has been reviewed.' })
			: Response.json([])) as typeof fetch
		await guestbook__hyop(section_())
		form__fill('Ann', 'Hello there')
		await submit__drive()
		expect(notice__el().textContent).toContain('once it has been reviewed')
		expect(notice__el().classList.contains('hidden')).toBe(false)
	})
	it('surfaces a rejected submission as an error and re-enables the button', async()=>{
		globalThis.fetch = (async(_u:unknown, init?:RequestInit)=>init?.method === 'POST'
			? new Response('Too many messages.', { status: 429 })
			: Response.json([])) as typeof fetch
		await guestbook__hyop(section_())
		form__fill('Ann', 'Hello there')
		await submit__drive()
		expect(notice__el().textContent).toContain('Too many messages')
		expect(notice__el().classList.contains('text-red-700')).toBe(true)
		// The effect that owns the button must have re-run on the way out.
		expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
	})
	it('clears a previous error once a later submit succeeds', async()=>{
		let fail = true
		globalThis.fetch = (async(_u:unknown, init?:RequestInit)=>{
			if (init?.method !== 'POST') return Response.json([])
			if (fail) { fail = false; return new Response('Nope.', { status: 400 }) }
			return Response.json({ status: 'approved', message: 'Your message is now on the page.' })
		}) as typeof fetch
		await guestbook__hyop(section_())
		form__fill('Ann', 'Hello there')
		await submit__drive()
		expect(notice__el().classList.contains('text-red-700')).toBe(true)
		form__fill('Ann', 'Hello again')
		await submit__drive()
		expect(notice__el().classList.contains('text-red-700')).toBe(false)
		expect(notice__el().classList.contains('text-gray-700')).toBe(true)
	})
})
