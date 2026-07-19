// Flat config. Replaces .eslintrc.json, which eslint 10 cannot read at all —
// eslintrc support was removed, so the old config plus a bumped eslint would
// have been a lint setup that silently could not run.
//
// The stylistic rules below (indent, block-spacing, comma-spacing, ...) were
// removed from eslint core in v9 and now live in @stylistic/eslint-plugin.
// They are carried over unchanged from .eslintrc.json so this migration does
// not quietly change what the codebase is held to.
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import tseslint from 'typescript-eslint'
export default tseslint.config(
	{
		// The app is its own repository with its own toolchain; dist/ and the
		// yalc store are vendored code.
		ignores: [
			'app/**',
			'dist/**',
			'node_modules/**',
			'.yalc/**',
			'.wrangler/**',
			'public/**',
		],
	},
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts', '**/*.js'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		plugins: { '@stylistic': stylistic },
		rules: {
			// The codebase already marks intentionally-unused bindings with a
			// leading underscore (WebSocket close handlers, unused fetch ctx).
			// Honour that convention rather than rewriting the call signatures.
			'@typescript-eslint/no-unused-vars': ['error', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_',
			}],
			'@stylistic/block-spacing': ['error', 'always'],
			'@stylistic/comma-spacing': 'error',
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/multiline-ternary': ['error', 'always-multiline'],
			'@stylistic/no-mixed-spaces-and-tabs': ['error', 'smart-tabs'],
			'@stylistic/no-multi-spaces': 'error',
			'@stylistic/object-curly-spacing': ['error', 'always'],
		},
	},
)
