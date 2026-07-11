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

const UPDATE_CHUNK = 200   // sobject collection update limit

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ── recallApprovals ─────────────────────────────────────────────────

export function registerRecallApprovals(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'recallApprovals',
    `Bulk-recalls (revokes) pending approval submissions. Handles BOTH
approval frameworks automatically: the unified framework (resolves the
ApprovalSubmission id and calls recallApprovalSubmission) and classic
approval processes (/process/approvals actionType=Removed). Removes the
workitems from every approver's queue.

SAFETY: ALWAYS confirm with the user before recalling — recall cannot be
undone; records must be re-submitted for approval.

INPUT: pass whichever ids you have — target RECORD Ids (Opportunity 006...,
Case 500..., custom object...), ProcessInstanceWorkitem Ids (04i...), or
ProcessInstance Ids (04g...). Workitem/instance ids are resolved to their
target records automatically.

LIMITS: the calling user must be the original submitter or a System
Administrator, and the approval process must have "Allow submitters to
recall approval requests" enabled — otherwise items fail with an
insufficient-privileges error.`,
    {
      ids: z.array(z.string()).min(1).describe('Record Ids pending approval, or ProcessInstanceWorkitem (04i...) / ProcessInstance (04g...) Ids.'),
      comment: z.string().optional().describe('Optional comment stored in the approval history.')
    },
    async ({ ids, comment }) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const clean = (s: string) => String(s).replace(/['\\]/g, '')
        const quoted = (arr: string[]) => arr.map(id => `'${clean(id)}'`).join(',')
        const comments = comment ?? 'Recalled via Archon AI'

        // Resolve every input to its target record. Keep classic ids when
        // we have them — the classic fallback path needs them.
        interface Target { record: string; workitemId?: string; instanceId?: string; inputs: string[] }
        const byRecord = new Map<string, Target>()
        const failed: Array<{ id: string; errors: unknown }> = []
        const addTarget = (record: string, input: string, wi?: string, pi?: string) => {
          const t = byRecord.get(record) ?? { record, inputs: [] }
          t.inputs.push(input)
          if (wi) t.workitemId = wi
          if (pi) t.instanceId = pi
          byRecord.set(record, t)
        }
        // SF returns 18-char ids; users may pass 15-char — key both.
        const lookupOf = <T extends { Id: string }>(rows: T[]) => {
          const m = new Map<string, T>()
          for (const r of rows) { m.set(r.Id, r); m.set(r.Id.slice(0, 15), r) }
          return m
        }

        const wiIds = ids.filter(id => id.startsWith('04i'))
        if (wiIds.length > 0) {
          const res = await conn.query<{ Id: string; ProcessInstanceId: string; ProcessInstance: { TargetObjectId: string } | null }>(
            `SELECT Id, ProcessInstanceId, ProcessInstance.TargetObjectId FROM ProcessInstanceWorkitem WHERE Id IN (${quoted(wiIds)})`)
          const found = lookupOf(res.records)
          for (const id of wiIds) {
            const r = found.get(clean(id)) ?? found.get(clean(id).slice(0, 15))
            if (r?.ProcessInstance?.TargetObjectId) addTarget(r.ProcessInstance.TargetObjectId, id, r.Id, r.ProcessInstanceId)
            else failed.push({ id, errors: 'workitem not found or already processed (approved/rejected/recalled)' })
          }
        }

        const piIds = ids.filter(id => id.startsWith('04g'))
        if (piIds.length > 0) {
          const res = await conn.query<{ Id: string; TargetObjectId: string }>(
            `SELECT Id, TargetObjectId FROM ProcessInstance WHERE Id IN (${quoted(piIds)})`)
          const found = lookupOf(res.records)
          for (const id of piIds) {
            const r = found.get(clean(id)) ?? found.get(clean(id).slice(0, 15))
            if (r) addTarget(r.TargetObjectId, id, undefined, r.Id)
            else failed.push({ id, errors: 'process instance not found' })
          }
        }

        for (const id of ids) {
          if (!id.startsWith('04i') && !id.startsWith('04g')) addTarget(clean(id), id)
        }

        const actionUrl    = `/services/data/v${conn.version}/actions/standard/recallApprovalSubmission`
        const approvalsUrl = `/services/data/v${conn.version}/process/approvals`
        const recalled: Array<{ recordId: string; method: string; status?: string }> = []

        // One record per request: invocable-action batches share a
        // transaction, so a single bad record must not roll back the rest.
        for (const t of byRecord.values()) {
          const errs: Record<string, unknown> = {}
          let done = false

          // PATH 1 — unified approvals framework. recallApprovalSubmission
          // requires an ApprovalSubmission id (9iP...), resolved via SOQL by
          // the target record. Classic approval processes have no such row —
          // fall through to PATH 2.
          try {
            const subs = await conn.query<{ Id: string }>(
              `SELECT Id FROM ApprovalSubmission WHERE RelatedRecordId = '${clean(t.record)}' ORDER BY CreatedDate DESC LIMIT 1`)
            const subId = subs.records[0]?.Id
            if (subId) {
              const res = await conn.request<Array<{ isSuccess: boolean; errors: unknown; outputValues?: { instanceStatus?: string } | null }>>({
                method: 'POST',
                url:    actionUrl,
                body:   JSON.stringify({ inputs: [{ approvalSubmissionId: subId, comments }] }),
                headers: { 'Content-Type': 'application/json' }
              })
              const r = res[0]
              if (r?.isSuccess === true) {
                recalled.push({ recordId: t.record, method: 'approvalSubmission', status: r.outputValues?.instanceStatus })
                done = true
              } else {
                errs.approvalSubmission = r?.errors ?? 'unknown error'
              }
            } else {
              errs.approvalSubmission = 'no ApprovalSubmission row for this record (classic approval process)'
            }
          } catch (e: any) {
            errs.approvalSubmission = e?.message ?? String(e)
          }

          // PATH 2 — classic approval processes: /process/approvals with
          // actionType Removed on the workitem (then the process instance).
          if (!done) {
            try {
              let wi = t.workitemId
              let pi = t.instanceId
              if (!wi && !pi) {
                const q = await conn.query<{ Id: string; ProcessInstanceId: string }>(
                  `SELECT Id, ProcessInstanceId FROM ProcessInstanceWorkitem
                   WHERE ProcessInstance.TargetObjectId = '${clean(t.record)}'
                   ORDER BY CreatedDate DESC LIMIT 1`)
                wi = q.records[0]?.Id
                pi = q.records[0]?.ProcessInstanceId
              }
              let classicErr: unknown = 'no pending approval workitem found for this record'
              for (const ctx of [wi, pi].filter(Boolean) as string[]) {
                try {
                  const res = await conn.request<Array<{ success: boolean; errors?: unknown }>>({
                    method: 'POST',
                    url:    approvalsUrl,
                    body:   JSON.stringify({ requests: [{ actionType: 'Removed', contextId: ctx, comments }] }),
                    headers: { 'Content-Type': 'application/json' }
                  })
                  const r = res[0]
                  if (r?.success === true) {
                    recalled.push({ recordId: t.record, method: 'processApprovals' })
                    done = true
                    break
                  }
                  classicErr = r?.errors ?? classicErr
                } catch (e: any) {
                  classicErr = e?.message ?? String(e)
                }
              }
              if (!done) errs.processApprovals = classicErr
            } catch (e: any) {
              errs.processApprovals = e?.message ?? String(e)
            }
          }

          if (!done) {
            for (const id of t.inputs) failed.push({ id, errors: errs })
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({
          requested: ids.length,
          recalled:  recalled.length,
          records:   recalled,
          failed
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
