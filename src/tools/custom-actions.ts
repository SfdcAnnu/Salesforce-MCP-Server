/**
 * DYNAMIC custom tools — the org's own automation exposed as first-class
 * MCP tools (Salesforce "Add Tools" style, Option B).
 *
 * The connecting client passes ?custom=apex:ClassName,flow:Flow_Api_Name
 * on the /mcp URL. At session init we describe each action via the
 * standard invocable-actions REST API and register it as a named tool
 * with its REAL input schema, so the model never guesses input names:
 *
 *   list/describe: GET  /services/data/vXX/actions/custom/{apex|flow}[/name]
 *   execute:       POST /services/data/vXX/actions/custom/{apex|flow}/{name}
 *
 * Tool names: apex__ClassName / flow__Flow_Api_Name (≤64 chars).
 * Execution runs with the session's Salesforce token — the org's CRUD/FLS/
 * sharing for that user is the security boundary, same as every other tool.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

export interface CustomToolSpec {
  type: 'apex' | 'flow'
  name: string
}

/** Parse "apex:Foo,flow:Bar_Baz" (the ?custom= query param). */
export function parseCustomToolSpecs(raw: unknown): CustomToolSpec[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const out: CustomToolSpec[] = []
  for (const part of raw.split(',')) {
    const [type, ...rest] = part.trim().split(':')
    const name = rest.join(':').trim()
    if ((type === 'apex' || type === 'flow') && /^[a-zA-Z0-9_.]{1,255}$/.test(name)) {
      out.push({ type, name })
    }
  }
  // De-dupe, cap at 25 per session to keep the toolset sane for the model
  const seen = new Set<string>()
  return out.filter(s => {
    const k = `${s.type}:${s.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 25)
}

export function mcpToolName(spec: CustomToolSpec): string {
  const safe = spec.name.replace(/[^a-zA-Z0-9_]/g, '_')
  return `${spec.type}__${safe}`.slice(0, 64)
}

// ── describe cache (10 min) — schema fetches add session-init latency ──
interface ActionInput {
  name: string
  label?: string
  description?: string
  type?: string
  required?: boolean
  maxOccurs?: number
}
interface ActionDescribe {
  label?: string
  description?: string
  inputs: ActionInput[]
}
const describeCache = new Map<string, { at: number; value: ActionDescribe }>()
const DESCRIBE_TTL_MS = 10 * 60 * 1000

async function describeAction(conn: any, spec: CustomToolSpec): Promise<ActionDescribe> {
  const key = `${conn.instanceUrl}|${spec.type}:${spec.name}`
  const hit = describeCache.get(key)
  if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.value

  const res = await conn.request<{ label?: string; description?: string; inputs?: ActionInput[] }>({
    method: 'GET',
    url: `/services/data/v${conn.version}/actions/custom/${spec.type}/${encodeURIComponent(spec.name)}`
  })
  const value: ActionDescribe = {
    label: res?.label,
    description: res?.description,
    inputs: Array.isArray(res?.inputs) ? res.inputs : []
  }
  describeCache.set(key, { at: Date.now(), value })
  return value
}

/** Map a Salesforce action input type onto a zod schema. */
function zodFor(input: ActionInput): z.ZodTypeAny {
  const t = String(input.type ?? '').toLowerCase()
  let base: z.ZodTypeAny
  if (t.includes('boolean'))                                   base = z.boolean()
  else if (t.includes('int') || t.includes('long'))            base = z.number().int()
  else if (t.includes('double') || t.includes('decimal') || t.includes('number') || t.includes('currency') || t.includes('percent')) base = z.number()
  else if ((input.maxOccurs ?? 1) > 1 || t.includes('list'))   base = z.array(z.any())
  else                                                         base = z.string()

  const desc = [input.label, input.description].filter(Boolean).join(' — ')
  if (desc) base = base.describe(desc)
  return input.required === true ? base : base.optional()
}

/**
 * Register the requested custom actions as MCP tools. Called per session
 * from server.ts. A single failing describe never blocks the session —
 * that action is skipped and logged.
 */
export async function registerCustomActionTools(
  server: McpServer,
  req: Request,
  sessionId: string,
  specs: CustomToolSpec[]
): Promise<void> {
  if (specs.length === 0) return
  const conn = await resolveSFConnection(req, sessionId)
  if (!conn) {
    console.warn('[custom-tools] no SF connection at session init — skipping', specs.length, 'custom tools')
    return
  }

  for (const spec of specs) {
    try {
      const desc = await describeAction(conn, spec)

      const shape: Record<string, z.ZodTypeAny> = {}
      for (const input of desc.inputs) {
        if (input?.name) shape[input.name] = zodFor(input)
      }

      const kind = spec.type === 'apex' ? 'Apex invocable action' : 'autolaunched Flow'
      const title = desc.label || spec.name
      const description =
        `${title} — a custom ${kind} from this Salesforce org.` +
        (desc.description ? `\n${desc.description}` : '') +
        `\nRuns with the connected user's permissions.` +
        ` If it creates or changes data, confirm with the user before calling.`

      server.tool(
        mcpToolName(spec),
        description,
        shape,
        async (args: Record<string, unknown>) => {
          const runConn = await resolveSFConnection(req, sessionId)
          if (!runConn) return notAuthenticatedError(process.env.BASE_URL!)
          try {
            // Drop undefined/null so the action sees only provided inputs
            const inputs: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(args ?? {})) {
              if (v !== undefined && v !== null) inputs[k] = v
            }
            const res = await runConn.request<Array<{ isSuccess: boolean; errors: unknown; outputValues: Record<string, unknown> | null }>>({
              method: 'POST',
              url: `/services/data/v${runConn.version}/actions/custom/${spec.type}/${encodeURIComponent(spec.name)}`,
              body: JSON.stringify({ inputs: [inputs] }),
              headers: { 'Content-Type': 'application/json' }
            })
            const r = res[0]
            if (r?.isSuccess === true) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({
                success: true,
                outputs: r.outputValues ?? {}
              }) }] }
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify({
              success: false,
              errors: r?.errors ?? 'unknown error'
            }) }], isError: true }
          } catch (err) {
            return sfApiError(err)
          }
        }
      )
      console.log('[custom-tools] registered', mcpToolName(spec))
    } catch (err: any) {
      console.warn('[custom-tools] skipped', `${spec.type}:${spec.name}`, '-', err?.message ?? err)
    }
  }
}

// ── Design-time catalog (proxied to portals via the Node server) ──────

/** List the org's invocable Apex actions and autolaunched Flows. */
export async function listCustomActions(conn: any): Promise<Array<{ type: string; name: string; label: string }>> {
  const out: Array<{ type: string; name: string; label: string }> = []
  for (const type of ['apex', 'flow'] as const) {
    try {
      const res = await conn.request<{ actions?: Array<{ name: string; label?: string }> }>({
        method: 'GET',
        url: `/services/data/v${conn.version}/actions/custom/${type}`
      })
      for (const a of res?.actions ?? []) {
        out.push({ type, name: a.name, label: a.label || a.name })
      }
    } catch (err: any) {
      console.warn('[custom-tools] list failed for', type, '-', err?.message ?? err)
    }
  }
  return out
}

export { describeAction }
