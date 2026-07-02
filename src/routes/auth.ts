/**
 * OAuth routes for PATH B — standalone clients (n8n, Cursor, custom apps)
 * NOT used when connecting via Claude connector (Claude handles auth itself).
 *
 * GET /auth?session=<id>        → redirects to SF login
 * GET /auth/callback            → receives auth code, exchanges for tokens
 * POST /auth/register           → Dynamic Client Registration (RFC 7591)
 * GET /auth/status?session=<id> → check if session is authenticated
 */

import { Router, Request, Response } from 'express'
import axios from 'axios'
import jsforce from 'jsforce'
import crypto from 'crypto'
import { linkSession } from '../lib/session'

const router = Router()

// ── 1. Start OAuth flow ───────────────────────────────────────────────────
router.get('/auth', (req: Request, res: Response) => {
  const sessionId = req.query.session as string
  if (!sessionId) {
    res.status(400).json({ error: 'Missing session parameter' })
    return
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SF_CLIENT_ID!,
    redirect_uri: process.env.SF_REDIRECT_URI!,
    state: sessionId,
    scope: 'full refresh_token openid'
  })

  res.redirect(`${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params}`)
})

// ── 2. OAuth callback ─────────────────────────────────────────────────────
router.get('/auth/callback', async (req: Request, res: Response) => {
  const { code, state: sessionId, error, error_description } = req.query

  if (error) {
    res.status(400).send(errorPage(String(error_description ?? error)))
    return
  }

  if (!code || !sessionId) {
    res.status(400).send(errorPage('Missing code or state parameter'))
    return
  }

  try {
    // Exchange auth code for tokens
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      client_id: process.env.SF_CLIENT_ID!,
      client_secret: process.env.SF_CLIENT_SECRET!,
      redirect_uri: process.env.SF_REDIRECT_URI!
    })

    const tokenRes = await axios.post(
      `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    const { access_token, refresh_token, instance_url } = tokenRes.data

    // Get stable SF user ID to key tokens by
    const conn = new jsforce.Connection({ accessToken: access_token, instanceUrl: instance_url })
    const identity = await conn.identity()
    const sfUserId = (identity as any).user_id as string

    // Store tokens in two-layer session store
    linkSession(sessionId as string, sfUserId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      instanceUrl: instance_url,
      issuedAt: Date.now()
    })

    console.log(`[Auth] User ${sfUserId} connected from session ${sessionId}`)
    res.send(successPage(instance_url))

  } catch (err) {
    console.error('[Auth] Callback error:', err)
    res.status(500).send(errorPage(String(err)))
  }
})

// ── 3. Dynamic Client Registration (RFC 7591) ─────────────────────────────
// Optional — allows MCP clients to auto-register without user entering credentials
router.post('/auth/register', (req: Request, res: Response) => {
  const clientId = crypto.randomUUID()
  const clientSecret = crypto.randomBytes(32).toString('hex')

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: req.body.client_name ?? 'MCP Client',
    redirect_uris: req.body.redirect_uris ?? [],
    grant_types: ['authorization_code', 'refresh_token'],
    scope: 'full refresh_token',
    client_id_issued_at: Math.floor(Date.now() / 1000)
  })
})

// ── 4. Auth status check ──────────────────────────────────────────────────
router.get('/auth/status', (req: Request, res: Response) => {
  const sessionId = req.query.session as string
  const { getSessionTokens } = require('../lib/session.js')
  const session = getSessionTokens(sessionId)
  res.json({
    connected: !!session,
    sessionId,
    instanceUrl: session?.instanceUrl ?? null
  })
})

// ── HTML helpers ─────────────────────────────────────────────────────────
function successPage(instanceUrl: string): string {
  return `
    <html><body style="font-family:-apple-system,sans-serif;padding:2rem;max-width:420px;margin:0 auto">
      <div style="background:#EAF3DE;border-radius:8px;padding:1.5rem;text-align:center">
        <div style="font-size:2rem;margin-bottom:8px">✅</div>
        <h2 style="margin:0 0 8px;color:#27500A">Salesforce connected</h2>
        <p style="margin:0;color:#3B6D11">You can close this tab and return to Claude.</p>
      </div>
      <p style="font-size:11px;color:#aaa;margin-top:1rem;text-align:center">Instance: ${instanceUrl}</p>
    </body></html>`
}

function errorPage(message: string): string {
  return `
    <html><body style="font-family:-apple-system,sans-serif;padding:2rem;max-width:420px;margin:0 auto">
      <div style="background:#FCEBEB;border-radius:8px;padding:1.5rem">
        <h2 style="margin:0 0 8px;color:#791F1F">Connection failed</h2>
        <p style="margin:0;color:#A32D2D">${message}</p>
        <p style="margin:8px 0 0;color:#999;font-size:12px">Close this tab and try again.</p>
      </div>
    </body></html>`
}

export default router
