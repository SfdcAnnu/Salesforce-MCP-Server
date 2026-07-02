/**
 * Auth middleware for the /mcp endpoint
 *
 * Checks for Authorization: Bearer header.
 * If missing → returns 401 with WWW-Authenticate header pointing to
 * /.well-known/oauth-protected-resource (RFC 9728 — June 2025 MCP spec).
 *
 * This is what triggers Claude's connector UI to start the OAuth flow
 * when the user first connects.
 */

import { Request, Response, NextFunction } from 'express'

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers['authorization']

  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="salesforce-mcp", resource_metadata="${process.env.BASE_URL}/.well-known/oauth-protected-resource"`
      )
      .json({
        error: 'unauthorized',
        message: 'Bearer token required. Connect via the Salesforce MCP connector in Claude Settings.'
      })
    return
  }

  next()
}
