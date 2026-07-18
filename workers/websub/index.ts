/**
 * Cloudflare Worker: WebSub subscriber for YouTube channel feed.
 *
 * Handles:
 * - GET: Hub verification (responds with hub.challenge)
 * - POST: Push notifications (verifies HMAC, triggers GitHub Actions rebuild)
 *
 * Required secrets (set via `wrangler secret put`):
 * - GH_TOKEN: GitHub PAT with `actions:write` scope
 * - WEBSUB_SECRET: Shared secret for HMAC-SHA1 verification
 *
 * Required vars (set in wrangler.toml [vars]):
 * - GH_OWNER: GitHub repo owner
 * - GH_REPO: GitHub repo name
 * - GH_WORKFLOW: Workflow filename (e.g., "deploy.yml")
 * - NOTIFICATION_EMAIL: Recipient email for new video alerts
 * - FROM_EMAIL: Sender email address
 *
 * Live indicator (near-zero quota, WebSub-driven):
 * - POST (WebSub push) or cron -> 1-unit videos.list on the videoId to read
 *   liveBroadcastContent; stores {videoId,title} in the LIVE KV namespace when
 *   live, clears it when the stream ends.
 * - GET /live -> reads KV only (0 units); returns { live, videoId?, title? }.
 *   Edge-cached LIVE_CACHE_TTL_SECONDS to coalesce visitor polls.
 * - Cron (every 5 min) confirms a stored live video is still live.
 * CORS is open (the static site is served from a different origin).
 *
 * DNS setup for Mailchannels:
 * Add a TXT record for the sender domain (brookebrodack.net):
 *   _mailchannels.brookebrodack.net  TXT  "v=mc1 cfid=brookebrodack-websub.brian-takita.workers.dev"
 * Add an SPF record if not already present:
 *   brookebrodack.net  TXT  "v=spf1 include:relay.mailchannels.net -all"
 */
export interface Env {
	GH_TOKEN: string
	WEBSUB_SECRET: string
	GH_OWNER: string
	GH_REPO: string
	GH_WORKFLOW: string
	YOUTUBE_CHANNELID: string
	NOTIFICATION_EMAIL: string
	FROM_EMAIL: string
	GOOGLE_API_KEY: string
	/** KV namespace holding the current live-stream status (key: 'live'). */
	LIVE: KVNamespace
}
interface VideoInfo {
	videoId: string
	title: string
	channelTitle: string
	publishedAt: string
}
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/live') {
			return handle_live(request, env, ctx)
		}
		if (request.method === 'GET') {
			return handle_verification(url)
		}
		if (request.method === 'POST') {
			return handle_notification(request, env, ctx)
		}
		return new Response('Method not allowed', { status: 405 })
	},
	async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		if (event.cron === '0 0 */7 * *') {
			await renew_subscription(env)
		} else {
			await verify_live_status(env)
		}
	},
}
/**
 * Re-subscribe to YouTube WebSub feed.
 * Called by cron trigger every 7 days to keep the lease active.
 */
async function renew_subscription(env: Env): Promise<void> {
	const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${env.YOUTUBE_CHANNELID}`
	const hub = 'https://pubsubhubbub.appspot.com/subscribe'
	// Worker URL is derived from the worker name
	const callback = `https://brookebrodack-websub.brian-takita.workers.dev`
	const body = new URLSearchParams({
		'hub.callback': callback,
		'hub.topic': topic,
		'hub.verify': 'async',
		'hub.mode': 'subscribe',
		'hub.secret': env.WEBSUB_SECRET,
		'hub.lease_seconds': '864000',
	})
	const response = await fetch(hub, {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	console.info(`WebSub renewal: ${response.status} ${response.statusText}`)
}
/**
 * WebSub hub verification callback.
 * The hub sends a GET with hub.mode, hub.topic, hub.challenge, hub.lease_seconds.
 * We must respond with the hub.challenge value to confirm the subscription.
 */
function handle_verification(url: URL): Response {
	const mode = url.searchParams.get('hub.mode')
	const challenge = url.searchParams.get('hub.challenge')
	const topic = url.searchParams.get('hub.topic')
	if (!challenge) {
		return new Response('Missing hub.challenge', { status: 400 })
	}
	console.info(`WebSub verification: mode=${mode} topic=${topic}`)
	// Accept both subscribe and unsubscribe
	if (mode === 'subscribe' || mode === 'unsubscribe') {
		return new Response(challenge, {
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
		})
	}
	return new Response('Unknown mode', { status: 400 })
}
/**
 * Live-stream indicator endpoint.
 * Returns { live, videoId?, title? } from the LIVE KV namespace (no API call).
 * Edge-cached briefly to coalesce concurrent visitor polls.
 */
const LIVE_CACHE_TTL_SECONDS = 30
interface LiveStatus { live:boolean; videoId?:string; title?:string }
async function handle_live(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors_headers() })
	}
	const cors = cors_headers()
	const cache = caches.default
	const cache_key = live_cache_key(request)
	const cached = await cache.match(cache_key)
	if (cached) {
		return rehydrate(cached, cors)
	}
	const status = await live__get(env)
	const body = json_response(status, cors, LIVE_CACHE_TTL_SECONDS)
	ctx.waitUntil(cache.put(cache_key, body.clone()))
	return body
}
const KV_KEY_LIVE = 'live'
interface LiveRecord { videoId:string; title?:string }
/** Read current live status from KV. Returns { live:false } if none/unconfigured. */
async function live__get(env: Env): Promise<LiveStatus> {
	if (!env.LIVE) return { live: false }
	const raw = await env.LIVE.get(KV_KEY_LIVE)
	if (!raw) return { live: false }
	try {
		const parsed = JSON.parse(raw) as LiveRecord
		if (parsed.videoId) return { live: true, videoId: parsed.videoId, title: parsed.title }
	} catch (err) {
		console.error('live__get parse error:', err)
	}
	return { live: false }
}
/** Store the active stream. expirationTtl is a safety net in case pings/cron stop. */
async function live__set(env: Env, videoId: string, title?: string): Promise<void> {
	if (!env.LIVE) return
	await env.LIVE.put(KV_KEY_LIVE, JSON.stringify({ videoId, title } satisfies LiveRecord), {
		expirationTtl: 6 * 60 * 60,
	})
}
async function live__clear(env: Env): Promise<void> {
	if (!env.LIVE) return
	await env.LIVE.delete(KV_KEY_LIVE)
}
/**
 * 1-unit videos.list on a videoId to read liveBroadcastContent + title.
 * Returns null if the API is unavailable (caller leaves existing state).
 */
async function videos__live_status(
	env: Env, videoId: string,
): Promise<{ live:boolean, title?:string }|null> {
	if (!env.GOOGLE_API_KEY) return null
	const api_url =
		`https://www.googleapis.com/youtube/v3/videos`
		+ `?part=snippet&id=${encodeURIComponent(videoId)}`
		+ `&key=${encodeURIComponent(env.GOOGLE_API_KEY)}`
	const response = await fetch(api_url)
	if (!response.ok) {
		console.warn(`videos.list ${videoId}: ${response.status}`)
		return null
	}
	const data = await response.json() as {
		items?: { snippet?: { title?:string, liveBroadcastContent?:string } }[]
	}
	const item = data.items?.[0]
	if (!item) return { live: false }
	return {
		live: item.snippet?.liveBroadcastContent === 'live',
		title: item.snippet?.title,
	}
}
/** Called on WebSub push: set live if broadcasting, clear if this video ended. */
async function live_status__refresh(env: Env, videoId: string): Promise<void> {
	const status = await videos__live_status(env, videoId)
	if (!status) return
	if (status.live) {
		await live__set(env, videoId, status.title)
	} else if ((await live__get(env)).videoId === videoId) {
		await live__clear(env)
	}
}
/** Cron: confirm a stored live stream is still live (1 unit only when one is set). */
async function verify_live_status(env: Env): Promise<void> {
	const current = await live__get(env)
	if (!current.videoId) return
	const status = await videos__live_status(env, current.videoId)
	if (!status || !status.live) {
		await live__clear(env)
	} else if (status.title && status.title !== current.title) {
		await live__set(env, current.videoId, status.title)
	}
}
function live_cache_key(request: Request): Request {
	const url = new URL(request.url)
	url.search = ''
	return new Request(url.toString(), { method: 'GET' })
}
function cors_headers(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	}
}
function json_response(
	status: LiveStatus,
	cors: Record<string, string>,
	max_age?: number,
): Response {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json; charset=utf-8',
		...cors,
	}
	if (max_age !== undefined) {
		headers['Cache-Control'] = `public, max-age=${max_age}, s-maxage=${max_age}`
	}
	return new Response(JSON.stringify(status), { headers })
}
async function rehydrate(cached: Response, cors: Record<string, string>): Promise<Response> {
	const status = await cached.json() as LiveStatus
	return json_response(status, cors)
}
/**
 * WebSub push notification handler.
 * The hub sends a POST with Atom XML body and X-Hub-Signature header.
 * We verify the HMAC and trigger a GitHub Actions workflow_dispatch.
 */
async function handle_notification(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const body = await request.text()
	// Verify HMAC signature if secret is configured
	const signature = request.headers.get('X-Hub-Signature')
	if (env.WEBSUB_SECRET) {
		if (!signature) {
			console.warn('WebSub notification: missing X-Hub-Signature')
			return new Response('Missing signature', { status: 403 })
		}
		const valid = await verify_hmac(env.WEBSUB_SECRET, body, signature)
		if (!valid) {
			console.warn('WebSub notification: invalid HMAC signature')
			return new Response('Invalid signature', { status: 403 })
		}
	}
	console.info(`WebSub notification received (${body.length} bytes)`)
	// Parse video details from Atom XML and send email notification
	const video = parse_atom_xml(body)
	if (video) {
		try {
			await send_email_notification(env, video)
		} catch (err) {
			console.error('Email notification error:', err)
		}
		// Refresh live status from this push (1-unit videos.list); don't block the hub ack
		ctx.waitUntil(live_status__refresh(env, video.videoId))
	}
	// Trigger GitHub Actions workflow_dispatch
	try {
		const gh_url =
			`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`
		const response = await fetch(gh_url, {
			method: 'POST',
			headers: {
				Authorization: `token ${env.GH_TOKEN}`,
				Accept: 'application/vnd.github.v3+json',
				'Content-Type': 'application/json',
				'User-Agent': 'brookebrodack-websub-worker',
			},
			body: JSON.stringify({
				ref: 'main',
				inputs: {
					trigger: 'websub',
				},
			}),
		})
		if (!response.ok) {
			const error_text = await response.text()
			console.error(`GitHub dispatch failed: ${response.status} ${error_text}`)
			// Still return 200 to the hub so it doesn't retry
			return new Response('Accepted (dispatch failed)', { status: 200 })
		}
		console.info('GitHub Actions workflow_dispatch triggered successfully')
	} catch (err) {
		console.error('GitHub dispatch error:', err)
	}
	// Always return 200 to acknowledge receipt
	return new Response('OK', { status: 200 })
}
/**
 * Parse YouTube Atom XML feed to extract video details.
 * YouTube WebSub pushes a single <entry> element with video info.
 */
function parse_atom_xml(xml: string): VideoInfo | null {
	const get_tag = (tag: string): string => {
		const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`))
		return match?.[1] ?? ''
	}
	const videoId_match = xml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)
	if (!videoId_match) {
		console.warn('Could not parse videoId from Atom XML')
		return null
	}
	return {
		videoId: videoId_match[1],
		title: get_tag('title'),
		channelTitle: get_tag('name'),
		publishedAt: get_tag('published'),
	}
}
/**
 * Send email notification about a new YouTube video via Mailchannels API.
 * Mailchannels authenticates via Cloudflare Worker origin (no API key needed).
 */
async function send_email_notification(env: Env, video: VideoInfo): Promise<void> {
	const video_url = `https://www.youtube.com/watch?v=${video.videoId}`
	const thumbnail_url = `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
	const published = video.publishedAt
		? new Date(video.publishedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
		: 'Unknown'
	const html_body = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a; margin-bottom: 4px;">${escape_html(video.title)}</h2>
  <p style="color: #666; margin-top: 0;">by ${escape_html(video.channelTitle)} &middot; ${published}</p>
  <a href="${video_url}" style="display: block; margin: 16px 0;">
    <img src="${thumbnail_url}" alt="Video thumbnail" style="width: 100%; max-width: 480px; border-radius: 8px;" />
  </a>
  <p>
    <a href="${video_url}" style="display: inline-block; padding: 10px 20px; background: #ff0000; color: #fff; text-decoration: none; border-radius: 4px; font-weight: 600;">
      Watch on YouTube
    </a>
  </p>
  <p style="color: #999; font-size: 13px; margin-top: 24px;">
    A blog post will be auto-generated after transcription completes.
  </p>
</div>`.trim()
	const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			personalizations: [{ to: [{ email: env.NOTIFICATION_EMAIL }] }],
			from: { email: env.FROM_EMAIL, name: 'Brooke Brodack Updates' },
			subject: `New Brooke Brodack video: ${video.title}`,
			content: [{ type: 'text/html', value: html_body }],
		}),
	})
	if (!response.ok) {
		const error_text = await response.text()
		console.error(`Mailchannels send failed: ${response.status} ${error_text}`)
	} else {
		console.info(`Email notification sent to ${env.NOTIFICATION_EMAIL}`)
	}
}
function escape_html(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}
/**
 * Verify HMAC-SHA1 signature from the WebSub hub.
 * Signature format: "sha1=<hex>"
 */
async function verify_hmac(secret: string, body: string, signature: string): Promise<boolean> {
	const [algo, hex] = signature.split('=')
	if (algo !== 'sha1' || !hex) return false
	const encoder = new TextEncoder()
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	)
	const sig_bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
	const computed_hex = Array.from(new Uint8Array(sig_bytes))
		.map(b=>b.toString(16).padStart(2, '0'))
		.join('')
	// Constant-time comparison
	if (computed_hex.length !== hex.length) return false
	let result = 0
	for (let i = 0; i < computed_hex.length; i++) {
		result |= computed_hex.charCodeAt(i) ^ hex.charCodeAt(i)
	}
	return result === 0
}
