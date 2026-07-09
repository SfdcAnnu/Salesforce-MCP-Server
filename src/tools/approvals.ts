/**
 * Approval-process tools.
 *
 * READING pending approvals is deliberately NOT a tool — soqlQuery covers it
 * (the recipe lives in soqlQuery's description). These two tools cover the
 * parts CRUD can't do safely:
 *   • recallApprovals   — recall is an approval ACTION (REST /process/approvals),
 *                         not a record update.
 *   • reassignApprovals — manager-resolution mapping must stay deterministic
 *                         (server-side), never assembled inside the LLM.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

const APPROVAL_REST_CHUNK = 25    // /process/approvals limit per call
const UPDATE_CHUNK        = 200   // sobject collection update limit

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ── recallApprovals ─────────────────────────────────────────────────

export function registerRecallApprovals(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'recallApprovals',
    `Bulk-recalls (revokes) pending approval requests. Removes the workitems
from every approver's queue and sets the process to Removed.

SAFETY: ALWAYS confirm with the user before recalling — recall cannot be
undone; records must be re-submitted for approval.

INPUT: ProcessInstanceWorkitem Ids (04i...) — get them via soqlQuery on
ProcessInstanceWorkitem first. Processes any number of ids (auto-chunked).`,
    {
      workitemIds: z.array(z.string()).min(1).describe('ProcessInstanceWorkitem Ids (04i...) to recall.'),
      comment: z.string().optional().describe('Optional comment stored on each recall action.')
    },
    async ({ workitemIds, comment }) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const results: Array<{ workitemId: string; success: boolean; errors?: unknown }> = []
        for (const batch of chunk(workitemIds, APPROVAL_REST_CHUNK)) {
          const payload = {
            requests: batch.map(id => ({
              actionType: 'Removed',
              contextId:  id,
              comments:   comment ?? 'Recalled via Archon AI'
            }))
          }
          const res = await conn.request<Array<{ success: boolean; errors?: unknown; instanceStatus?: string }>>({
            method: 'POST',
            url:    '/process/approvals',
            body:   JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
          })
          res.forEach((r, i) => results.push({
            workitemId: batch[i],
            success:    r.success === true,
            ...(r.success !== true && { errors: r.errors })
          }))
        }
        const recalled = results.filter(r => r.success).length
        return { content: [{ type: 'text', text: JSON.stringify({
          requested: workitemIds.length, recalled,
          failed: results.filter(r => !r.success)
        }) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

// ── reassignApprovals ───────────────────────────────────────────────

interface WorkitemRow {
  Id: string
  ActorId: string
  Actor: { Name?: string; Type?: string } | null
  ProcessInstance: {
    TargetObjectId?: string
    SubmittedById?: string
    SubmittedBy?: { Name?: string; ManagerId?: string; Manager?: { Name?: string; IsActive?: boolean } | null } | null
  } | null
}

export function registerReassignApprovals(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'reassignApprovals',
    `Bulk-reassigns pending approval workitems to a new approver. The
workitem→new-approver mapping is resolved SERVER-SIDE (deterministic) —
never build the mapping yourself with bulk updates.

MODES:
• user             → everything goes to targetUserId (required)
• submitterManager → each item goes to its submitter's manager
• approverManager  → each item escalates to the CURRENT approver's manager
                     (items whose approver is a queue are skipped — queues
                     have no manager)

Returns per-item results: reassigned changes (with names), skipped items
with reasons (no manager, queue approver, already assigned), and failures.

SAFETY: confirm the reassignment plan with the user before calling.`,
    {
      workitemIds: z.array(z.string()).min(1).describe('ProcessInstanceWorkitem Ids (04i...) — from soqlQuery.'),
      mode: z.enum(['user', 'submitterManager', 'approverManager']).describe('How to resolve the new approver.'),
      targetUserId: z.string().optional().describe("New approver's User Id (005...). Required when mode='user'.")
    },
    async ({ workitemIds, mode, targetUserId }) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        if (mode === 'user' && !targetUserId) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'MISSING_TARGET', message: "mode='user' requires targetUserId."
          }) }], isError: true }
        }

        // Step 1 — ground truth for every requested workitem
        const idList = workitemIds.map(id => `'${String(id).replace(/['\\]/g, '')}'`).join(',')
        const wiRes = await conn.query<WorkitemRow>(
          `SELECT Id, ActorId, Actor.Name, Actor.Type,
                  ProcessInstance.TargetObjectId, ProcessInstance.SubmittedById,
                  ProcessInstance.SubmittedBy.Name, ProcessInstance.SubmittedBy.ManagerId,
                  ProcessInstance.SubmittedBy.Manager.Name, ProcessInstance.SubmittedBy.Manager.IsActive
           FROM ProcessInstanceWorkitem WHERE Id IN (${idList})`)
        const rows = wiRes.records
        const foundIds = new Set(rows.map(r => r.Id))

        const skipped: Array<{ workitemId: string; reason: string }> = []
        for (const id of workitemIds) {
          if (!foundIds.has(id)) skipped.push({ workitemId: id, reason: 'not found or already processed (approved/rejected/recalled)' })
        }

        // Step 2 — resolve supporting users per mode
        const userInfo = new Map<string, { Name?: string; IsActive?: boolean; ManagerId?: string; ManagerName?: string; ManagerActive?: boolean }>()
        const needUserLookup = new Set<string>()
        if (mode === 'user' && targetUserId) needUserLookup.add(targetUserId)
        if (mode === 'approverManager') {
          for (const r of rows) if (r.Actor?.Type === 'User' && r.ActorId) needUserLookup.add(r.ActorId)
        }
        if (needUserLookup.size > 0) {
          const uIds = Array.from(needUserLookup).map(id => `'${id.replace(/['\\]/g, '')}'`).join(',')
          const uRes = await conn.query<{ Id: string; Name: string; IsActive: boolean; ManagerId?: string; Manager?: { Name?: string; IsActive?: boolean } | null }>(
            `SELECT Id, Name, IsActive, ManagerId, Manager.Name, Manager.IsActive FROM User WHERE Id IN (${uIds})`)
          for (const u of uRes.records) {
            userInfo.set(u.Id, {
              Name: u.Name, IsActive: u.IsActive,
              ManagerId: u.ManagerId, ManagerName: u.Manager?.Name, ManagerActive: u.Manager?.IsActive
            })
          }
        }

        // Step 3 — build the deterministic mapping
        const updates: Array<{ Id: string; ActorId: string }> = []
        const changes: Array<{ workitemId: string; from: string; to: string; targetRecordId?: string }> = []
        for (const r of rows) {
          const fromName = r.Actor?.Name ?? r.ActorId
          let newActorId: string | null = null
          let newActorName = ''
          let skipReason: string | null = null

          if (mode === 'user') {
            const t = userInfo.get(targetUserId!)
            if (!t)                 skipReason = `target user ${targetUserId} not found`
            else if (!t.IsActive)   skipReason = `target user ${t.Name} is inactive`
            else { newActorId = targetUserId!; newActorName = t.Name ?? targetUserId! }
          } else if (mode === 'submitterManager') {
            const mgrId = r.ProcessInstance?.SubmittedBy?.ManagerId
            const mgr   = r.ProcessInstance?.SubmittedBy?.Manager
            if (!mgrId)                       skipReason = `submitter ${r.ProcessInstance?.SubmittedBy?.Name ?? ''} has no manager set`
            else if (mgr && mgr.IsActive === false) skipReason = `submitter's manager ${mgr.Name} is inactive`
            else { newActorId = mgrId; newActorName = mgr?.Name ?? mgrId }
          } else { // approverManager
            if (r.Actor?.Type !== 'User') {
              skipReason = `current approver is a queue (${r.Actor?.Name ?? 'unknown'}) — no manager to escalate to`
            } else {
              const u = userInfo.get(r.ActorId)
              if (!u?.ManagerId)                    skipReason = `approver ${u?.Name ?? r.ActorId} has no manager set`
              else if (u.ManagerActive === false)   skipReason = `approver's manager ${u.ManagerName} is inactive`
              else { newActorId = u.ManagerId; newActorName = u.ManagerName ?? u.ManagerId }
            }
          }

          if (!skipReason && newActorId === r.ActorId) {
            skipReason = `already assigned to ${newActorName}`
          }

          if (skipReason) {
            skipped.push({ workitemId: r.Id, reason: skipReason })
          } else if (newActorId) {
            updates.push({ Id: r.Id, ActorId: newActorId })
            changes.push({
              workitemId: r.Id, from: fromName, to: newActorName,
              targetRecordId: r.ProcessInstance?.TargetObjectId
            })
          }
        }

        // Step 4 — bulk update (partial success allowed)
        const failed: Array<{ workitemId: string; error: unknown }> = []
        let reassigned = 0
        for (const batch of chunk(updates, UPDATE_CHUNK)) {
          const res = await conn.sobject('ProcessInstanceWorkitem').update(batch, { allOrNone: false }) as Array<{ id?: string; success: boolean; errors?: unknown[] }>
          res.forEach((r, i) => {
            if (r.success) reassigned++
            else failed.push({ workitemId: batch[i].Id, error: r.errors })
          })
        }
        const failedIds = new Set(failed.map(f => f.workitemId))

        return { content: [{ type: 'text', text: JSON.stringify({
          requested: workitemIds.length,
          reassigned,
          skipped,
          failed,
          changes: changes.filter(c => !failedIds.has(c.workitemId))
        }) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
