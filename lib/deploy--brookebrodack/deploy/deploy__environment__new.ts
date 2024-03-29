import { type wide_ctx_T } from 'ctx-core/be'
import { deploy__env } from './deploy__env.js'
import { NODE_ENV_ } from './stage.js'
export function deploy__environment__new(ctx:wide_ctx_T) {
	const NODE_ENV = NODE_ENV_(ctx)
	return {
		BROOKEBRODACK_PORT: deploy__env.BROOKEBRODACK_PORT,
		NODE_ENV,
	}
}
