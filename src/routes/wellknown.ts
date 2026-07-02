import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env') })
import { Router } from 'express'
const router = Router()

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = process.env.BASE_URL!
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json({
    resource: base,
    authorization_servers: ['https://login.salesforce.com'],
    scopes_supported: ['api', 'refresh_token'],
    bearer_methods_supported: ['header']
  })
})

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = process.env.BASE_URL!
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json({
    // Endpoints point at THIS server's proxy (not SF directly) so the server
    // sees the token exchange and can vault tokens for server-side refresh.
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/auth/register`,
    scopes_supported: ['api', 'refresh_token', 'openid'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256']
  })
})

export default router
