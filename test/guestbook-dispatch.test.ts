/**
 * Edge half of the freehold transport. Every test here asks "can this path
 * publish something it shouldn't?" rather than "does the happy path work?".
 */
import { describe, expect, test } from 'bun:test'
import {
	bearer_,
	decision_a1_,
	frame_,
	panel_id_,
	secret__matches,
} from '../workers/guestbook-dispatch/index.ts'
import { decision_a1__apply } from '../scripts/_lib/guestbook-moderation.ts'

describe('connect auth', ()=>{
	test('a matching secret is accepted', ()=>{
		expect(secret__matches('s3cret', 's3cret')).toBe(true)
	})
	test('a wrong secret is refused, including at the same length', ()=>{
		expect(secret__matches('s3cret', 's3crey')).toBe(false)
		expect(secret__matches('short', 'much-longer-secret')).toBe(false)
		expect(secret__matches('', '')).toBe(true)
	})
	test('bearer parsing tolerates case and rejects everything else', ()=>{
		expect(bearer_('Bearer abc')).toBe('abc')
		expect(bearer_('bearer abc')).toBe('abc')
		expect(bearer_('Basic abc')).toBeNull()
		expect(bearer_('Bearer   ')).toBeNull()
		expect(bearer_(null)).toBeNull()
	})
})

describe('frame parsing', ()=>{
	test('an unparseable frame is ignored, not fatal', ()=>{
		expect(frame_('not json')).toBeNull()
		expect(frame_('[]')).toBeNull()
		expect(frame_('null')).toBeNull()
		expect(frame_('{"no_type":1}')).toBeNull()
	})
	test('an unknown frame type still parses so the protocol can grow', ()=>{
		expect(frame_('{"type":"invented_later"}')).toEqual({ type: 'invented_later' } as never)
	})
})

describe('decisions returned by a host', ()=>{
	const dispatched = [1, 2]
	test('a decision for an entry that was not in the job is dropped', ()=>{
		// A host answering a question it was not asked must not move an
		// unrelated entry — the same rule the host applies to its plugins.
		const out = decision_a1_({
			decisions: [
				{ id: 1, decision: 'approve', reason: 'ok' },
				{ id: 99, decision: 'approve', reason: 'ok' },
			],
		}, dispatched)
		expect(out.map((d)=>d.id)).toEqual([1])
	})
	test('a decision outside the vocabulary is dropped', ()=>{
		const out = decision_a1_({
			decisions: [
				{ id: 1, decision: 'publish', reason: 'ok' },
				{ id: 2, decision: 'approve', reason: 'ok' },
			],
		}, dispatched)
		expect(out.map((d)=>d.id)).toEqual([2])
	})
	test('a malformed result is no decisions rather than an error', ()=>{
		expect(decision_a1_(null, dispatched)).toEqual([])
		expect(decision_a1_({ decisions: 'nope' }, dispatched)).toEqual([])
		expect(decision_a1_({}, dispatched)).toEqual([])
		expect(decision_a1_({ decisions: [null, 'x', 3] }, dispatched)).toEqual([])
	})
	test('a non-string reason does not smuggle a value through', ()=>{
		const out = decision_a1_({
			decisions: [{ id: 1, decision: 'approve', reason: { nested: true } }],
		}, dispatched)
		expect(out[0]!.reason).toBe('')
	})
})

/** Minimal D1 stand-in recording the statements a decision batch produces. */
function db_() {
	const bound:unknown[][] = []
	const sql_a1:string[] = []
	return {
		bound,
		sql_a1,
		prepare(sql:string) {
			sql_a1.push(sql)
			return {
				bind(...args:unknown[]) {
					bound.push(args)
					return this
				},
			}
		},
		async batch(statements:unknown[]) {
			return statements
		},
	}
}

describe('panel identity', ()=>{
	test('the same plugins are the same panel however they are listed', ()=>{
		expect(panel_id_(['agent', 'rules'])).toBe(panel_id_(['rules', 'agent']))
	})
	test('a different set of plugins is a different panel', ()=>{
		// Otherwise adding a model plugin would inherit the rules-only panel's
		// escalations and never see the entries it was added to judge.
		expect(panel_id_(['rules'])).not.toBe(panel_id_(['rules', 'agent']))
	})
	test('an unusable advert is no panel rather than a made-up one', ()=>{
		// A bogus id would exclude entries from a panel that never saw them,
		// which is worse than the re-judging loop it is meant to prevent.
		expect(panel_id_(null)).toBeNull()
		expect(panel_id_([])).toBeNull()
		expect(panel_id_('rules')).toBeNull()
		expect(panel_id_([1, {}, ''])).toBeNull()
	})
})

describe('applying decisions', ()=>{
	test('escalate never changes status', async ()=>{
		const db = db_()
		const tally = await decision_a1__apply(db as never, [
			{ id: 1, decision: 'escalate', reason: 'unsure' },
		], 'rules')
		expect(tally.escalate).toBe(1)
		for (const sql of db.sql_a1) expect(sql).not.toContain('SET status')
	})
	test('escalate records which panel declined, guarded on pending', async ()=>{
		// The record is what stops the hub re-offering the entry to this same
		// panel on every notify and every alarm, forever.
		const db = db_()
		await decision_a1__apply(db as never, [
			{ id: 1, decision: 'escalate', reason: 'unsure' },
		], 'agent+rules')
		expect(db.sql_a1.length).toBe(1)
		expect(db.sql_a1[0]!).toContain('escalated_by')
		expect(db.sql_a1[0]!).toContain("status = 'pending'")
		expect(db.bound[0]).toEqual(['agent+rules', 1])
	})
	test('a caller that cannot name its panel records nothing', async ()=>{
		const db = db_()
		const tally = await decision_a1__apply(db as never, [
			{ id: 1, decision: 'escalate', reason: 'unsure' },
		])
		expect(tally.escalate).toBe(1)
		expect(db.bound.length).toBe(0)
	})
	test('every update is guarded on status = pending', async ()=>{
		// Otherwise a late verdict could re-open an entry an admin already
		// handled, or apply twice after a retry.
		const db = db_()
		await decision_a1__apply(db as never, [
			{ id: 1, decision: 'approve', reason: 'ok' },
			{ id: 2, decision: 'reject', reason: 'spam' },
		])
		expect(db.sql_a1.length).toBe(2)
		for (const sql of db.sql_a1) expect(sql).toContain("status = 'pending'")
		expect(db.bound[0]![0]).toBe('approved')
		expect(db.bound[1]![0]).toBe('rejected')
	})
	test('a flooding reason is bounded before it reaches the database', async ()=>{
		const db = db_()
		await decision_a1__apply(db as never, [
			{ id: 1, decision: 'approve', reason: 'x'.repeat(5_000) },
		])
		expect((db.bound[0]![1] as string).length).toBeLessThanOrEqual(500)
	})
})
