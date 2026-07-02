/**
 * Session store for PATH B (standalone clients — n8n, Cursor, custom apps)
 * NOT used when Claude connector injects the token via Authorization header (PATH A)
 *
 * Two-layer store:
 *   Layer 1: sessionId (ephemeral, changes per SSE connection) → sfUserId (stable)
 *   Layer 2: sfUserId (stable, permanent SF user ID)          → SF tokens
 *
 * This means: user authenticates once, tokens persist across new Claude sessions.
 * Even when a new SSE connection opens (new sessionId), the user's tokens are found
 * by looking up sfUserId via the cookie set in /auth/callback.
 *
 * For production: replace Maps with Upstash Redis (instructions below)
 */

export interface SFSession {
  accessToken: string
  refreshToken: string
  instanceUrl: string
  issuedAt: number
}

// Layer 1: ephemeral sessionId → stable sfUserId
const sessionToUser = new Map<string, string>()

// Layer 2: stable sfUserId → SF tokens
const userTokenStore = new Map<string, SFSession>()

// ── Token vault for PATH A (any AI portal / Claude connector) ──────────────
// Keyed by the access_token the client sends as Bearer. Captured at /token so
// the SERVER owns refresh — the client never has to implement OAuth refresh.
export interface VaultEntry {
  accessToken: string      // current live access token (updated on refresh)
  refreshToken: string
  instanceUrl: string
  clientId?: string
  clientSecret?: string
  loginUrl: string
  issuedAt: number
}

const accessTokenVault = new Map<string, VaultEntry>()

// Called in /token after a successful authorization_code exchange
export function storeVaultTokens(entry: VaultEntry): void {
  accessTokenVault.set(entry.accessToken, entry)
}

// Called by resolveSFConnection() on every PATH A tool call
export function getVaultTokens(accessToken: string): VaultEntry | undefined {
  return accessTokenVault.get(accessToken)
}

// Called from the jsforce 'refresh' event when SF hands us a new access token.
// The client keeps sending the ORIGINAL bearer, so we keep that key pointing at
// the same (mutated) entry, and also index the new token in case the client adopts it.
export function updateVaultAccessToken(originalAccessToken: string, newAccessToken: string): void {
  const entry = accessTokenVault.get(originalAccessToken)
  if (!entry) return
  entry.accessToken = newAccessToken
  entry.issuedAt = Date.now()
  accessTokenVault.set(newAccessToken, entry)
}

// Called in /auth/callback after OAuth exchange
export function linkSession(sessionId: string, sfUserId: string, session: SFSession): void {
  sessionToUser.set(sessionId, sfUserId)
  userTokenStore.set(sfUserId, session)
}

// Called in /mcp when a returning user connects with a cookie
export function relinkSession(sessionId: string, sfUserId: string): void {
  sessionToUser.set(sessionId, sfUserId)
}

// Called by resolveSFConnection() in every tool handler
export function getSessionTokens(sessionId: string): SFSession | undefined {
  const userId = sessionToUser.get(sessionId)
  if (!userId) return undefined
  return userTokenStore.get(userId)
}

// Called after token refresh to update stored access token
export function updateSessionTokens(
  sessionId: string,
  updated: { accessToken: string; instanceUrl: string }
): void {
  const userId = sessionToUser.get(sessionId)
  if (!userId) return
  const existing = userTokenStore.get(userId)
  if (!existing) return
  userTokenStore.set(userId, { ...existing, ...updated, issuedAt: Date.now() })
}

export function getSfUserId(sessionId: string): string | undefined {
  return sessionToUser.get(sessionId)
}

export function hasUserTokens(sfUserId: string): boolean {
  return userTokenStore.has(sfUserId)
}

// When SSE disconnects — remove sessionId link but KEEP user tokens
// (other sessions from same user still valid)
export function unlinkSession(sessionId: string): void {
  sessionToUser.delete(sessionId)
}

// ── Production Redis swap (uncomment when deploying) ──────────────────────
// import { Redis } from '@upstash/redis'
// const redis = new Redis({ url: process.env.REDIS_URL!, token: process.env.REDIS_TOKEN! })
//
// export async function linkSession(sessionId: string, sfUserId: string, session: SFSession) {
//   await redis.set(`sess:${sessionId}`, sfUserId, { ex: 86400 })
//   await redis.set(`tokens:${sfUserId}`, JSON.stringify(session))
// }
// export async function getSessionTokens(sessionId: string): Promise<SFSession | undefined> {
//   const userId = await redis.get<string>(`sess:${sessionId}`)
//   if (!userId) return undefined
//   const raw = await redis.get<string>(`tokens:${userId}`)
//   return raw ? JSON.parse(raw) : undefined
// }
// export async function updateSessionTokens(sessionId: string, updated: Partial<SFSession>) {
//   const userId = await redis.get<string>(`sess:${sessionId}`)
//   if (!userId) return
//   const existing = JSON.parse(await redis.get<string>(`tokens:${userId}`) ?? '{}')
//   await redis.set(`tokens:${userId}`, JSON.stringify({ ...existing, ...updated, issuedAt: Date.now() }))
// }
