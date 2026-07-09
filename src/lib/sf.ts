import 'dotenv/config'
import jsforce from 'jsforce'
import { Request } from 'express'
import {
  getSessionTokens,
  updateSessionTokens,
  getVaultTokens,
  updateVaultAccessToken
} from './session'

export async function resolveSFConnection(req: Request, sessionId: string): Promise<jsforce.Connection | null> {
  console.log('[SF] resolveSFConnection called, sessionId:', sessionId)
  
  // PATH A: Bearer token in Authorization header
  const authHeader = req.headers['authorization'] as string | undefined
  console.log('[SF] Authorization header:', authHeader ? 'YES: ' + authHeader.slice(0, 30) + '...' : 'NONE')
  
  if (authHeader?.startsWith('Bearer ')) {
    const accessToken = authHeader.slice(7)
    console.log('[SF] PATH A — Bearer token received')

    // Vaulted token (captured at /token): we hold the refresh token, so build a
    // connection that auto-refreshes. jsforce catches INVALID_SESSION_ID, mints a
    // new access token via the refresh grant, retries the call, and emits 'refresh'.
    const vault = getVaultTokens(accessToken)
    if (vault) {
      console.log('[SF] PATH A — vault hit, auto-refresh enabled')
      const oauth2 = new jsforce.OAuth2({
        loginUrl: vault.loginUrl,
        clientId: vault.clientId ?? process.env.SF_CLIENT_ID,
        clientSecret: vault.clientSecret ?? process.env.SF_CLIENT_SECRET
      })
      const conn = new jsforce.Connection({
        version: '62.0',
        oauth2,
        instanceUrl: vault.instanceUrl,
        accessToken: vault.accessToken,
        refreshToken: vault.refreshToken
      })
      conn.on('refresh', (newAccessToken: string) => {
        console.log('[SF] PATH A — access token auto-refreshed')
        updateVaultAccessToken(accessToken, newAccessToken)
      })
      return conn
    }

    // Fallback: no vault entry (e.g. server restarted and lost the in-memory vault,
    // or a token we never proxied). Probe /userinfo for the instance URL. No refresh
    // token available here, so this connection cannot auto-refresh.
    console.log('[SF] PATH A — no vault entry, falling back to stateless probe')
    try {
      const axios = (await import('axios')).default
      const loginUrl = process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com'
      const identityRes = await axios.get(`${loginUrl}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const rawUrl = identityRes.data.instance_url
        ?? identityRes.data.urls?.profile?.split('/id/')[0]
        ?? loginUrl
      const instanceUrl = rawUrl.replace(/\/[0-9A-Za-z]{15,18}$/, '').replace(/\/$/, '')
      console.log('[SF] PATH A — instanceUrl:', instanceUrl)
      return new jsforce.Connection({ accessToken, instanceUrl, version: '62.0' })
    } catch (err: any) {
      console.error('[SF] PATH A — identity lookup failed (token likely expired):', err.message)
      // Signal "needs re-auth" rather than returning a broken connection.
      return null
    }
  }

  // PATH B: Session store
  console.log('[SF] PATH B � checking session store for sessionId:', sessionId)
  const session = getSessionTokens(sessionId)
  console.log('[SF] Session found:', session ? 'YES instanceUrl=' + session.instanceUrl : 'NO')
  
  if (!session) {
    console.log('[SF] No session � trying username/password login')
    console.log('[SF] Username:', process.env.SF_USERNAME)
    console.log('[SF] Password set:', process.env.SF_PASSWORD ? 'YES length=' + process.env.SF_PASSWORD.length : 'NO')
    console.log('[SF] LoginUrl:', process.env.SF_LOGIN_URL)
    try {
      const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com', version: '62.0' })
      const result = await conn.login(process.env.SF_USERNAME!, process.env.SF_PASSWORD!)
      console.log('[SF] Login SUCCESS � userId:', result.id)
      return conn
    } catch (loginErr: any) {
      console.error('[SF] Login FAILED:', loginErr.message ?? loginErr)
      return null
    }
  }

  // Build an auto-refreshing connection from the stored session tokens.
  // jsforce refreshes on INVALID_SESSION_ID using the refresh token + oauth2 config,
  // so we no longer guess expiry with a timer.
  console.log('[SF] PATH B — using session token (auto-refresh enabled)')
  const oauth2 = new jsforce.OAuth2({
    loginUrl: process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com',
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET
  })
  const conn = new jsforce.Connection({
        version: '62.0',
    oauth2,
    instanceUrl: session.instanceUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken
  })
  conn.on('refresh', (newAccessToken: string) => {
    console.log('[SF] PATH B — access token auto-refreshed')
    updateSessionTokens(sessionId, { accessToken: newAccessToken, instanceUrl: session.instanceUrl })
  })
  return conn
}

export function notAuthenticatedError(baseUrl: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'NOT_AUTHENTICATED',
        message: 'No Salesforce connection found.',
        resolution: {
          claude_connector: 'Make sure Salesforce MCP connector is connected in Claude Settings.',
          standalone: `Visit ${baseUrl}/auth to authenticate.`
        }
      })
    }],
    isError: true
  }
}

export function sfApiError(err: unknown) {
  const e = err as { errorCode?: string; message?: string; name?: string }
  const errorCode = e.errorCode ?? e.name ?? 'UNKNOWN_ERROR'
  const message = e.message ?? String(err)
  console.error('[SF] API Error:', errorCode, message)
  
  let hint: string | undefined
  if (errorCode === 'INVALID_TYPE') hint = 'Object API name does not exist. Call getObjectSchema with no parameters first.'
  else if (errorCode === 'INVALID_FIELD') hint = 'Field name invalid. Call getObjectSchema with object name.'
  else if (errorCode === 'MALFORMED_QUERY') hint = 'SOQL syntax error. Check field names and clause order.'
  
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ errorCode, message, ...(hint && { hint }) }) }],
    isError: true
  }
}




