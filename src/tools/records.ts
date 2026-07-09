import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

export function registerGetUserInfo(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'getUserInfo',
    `Returns the currently authenticated Salesforce user's identity and context.
Use to personalize responses, filter SOQL to 'my' records (WHERE OwnerId = returned userId),
or interpret date requests using the user's timezone. No parameters required.`,
    {},
    async () => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const identity = await conn.identity()
        return { content: [{ type: 'text', text: JSON.stringify(identity) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerListRecentRecords(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'listRecentSobjectRecords',
    `Returns records recently viewed or modified by the current user.
Use when user says 'my accounts', 'recent cases', 'that lead I was looking at'.

LIMITATIONS:
• Returns default fields only — follow up with soqlQuery using returned IDs for specific fields
• No pagination — max 2,000 records most recent first
• Current user only`,

    {
      'sobject-name': z.string().describe(
        "Object API name (e.g. 'Account', 'Case', 'Loan_Application__c'). " +
        "For custom objects use full name with __c suffix."
      )
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await (conn as any).recent(args['sobject-name'])
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerCreateRecord(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'createSobjectRecord',
    `Creates a new Salesforce record. Returns the new record ID.

PREREQUISITE: ALWAYS call getObjectSchema(object-name) first to get:
• Required fields (omitting them causes failure)
• Valid picklist values (invalid values cause failure)
• Exact field API names (e.g. 'LastName' not 'Last_Name')`,

    {
      'sobject-name': z.string().describe("Object API name (e.g. 'Lead', 'Contact', 'Loan_Application__c')"),
      body: z.record(z.unknown()).describe(
        'Field-value pairs. All names must match API names from getObjectSchema. ' +
        'Example: {"LastName":"Choudhary","FirstName":"Annu","Company":"Acme","Status":"New"}'
      )
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await conn.sobject(args['sobject-name']).create(args.body as Record<string, unknown>)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerUpdateRecord(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'updateSobjectRecord',
    `Updates an existing record by ID. PATCH — only fields in body are changed.
Call getObjectSchema if unsure of field names or picklist values.
Fails if: record not found, no permission, validation rule violated, required field set to null.`,

    {
      'sobject-name': z.string().describe("Object API name (e.g. 'Lead', 'Case', 'Loan_Application__c')"),
      id: z.string().describe('18-character Salesforce record ID'),
      body: z.record(z.unknown()).describe('Fields to update. Only included fields change.')
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await conn.sobject(args['sobject-name']).update({
          Id: args.id,
          ...(args.body as Record<string, unknown>)
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerBulkUpdateRecords(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'bulkUpdateSobjectRecords',
    `Updates MANY records of one object in a single call (up to 200 per API
round-trip; larger lists are auto-chunked). PATCH semantics — only fields
present on each record change.

USE THIS INSTEAD OF repeated updateSobjectRecord calls whenever updating
2+ records ("mark all these leads Contacted", "close these 30 cases").

Each record MUST include Id. Records can have DIFFERENT field values.
Partial success: one record's failure does not roll back the others —
per-record results are returned.

SAFETY: confirm with the user before mass updates.`,
    {
      'sobject-name': z.string().describe("Object API name (e.g. 'Lead', 'Case', 'ProcessInstanceWorkitem')"),
      records: z.array(z.record(z.unknown())).min(1).describe(
        'Records to update. Each must include Id plus the fields to change. ' +
        'Example: [{"Id":"00Q...1","Status":"Contacted"},{"Id":"00Q...2","Status":"Qualified","Rating":"Hot"}]'
      )
    },
    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const records = args.records as Array<Record<string, unknown>>
        const missingId = records.findIndex(r => !r.Id)
        if (missingId >= 0) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'MISSING_ID', message: `records[${missingId}] has no Id field — every record must include Id.`
          }) }], isError: true }
        }

        const results: Array<{ id?: string; success: boolean; errors?: unknown }> = []
        for (let i = 0; i < records.length; i += 200) {
          const batch = records.slice(i, i + 200)
          const res = await conn.sobject(args['sobject-name']).update(batch as any, { allOrNone: false }) as Array<{ id?: string; success: boolean; errors?: unknown[] }>
          res.forEach((r, j) => results.push({
            id: r.id ?? String(batch[j].Id),
            success: r.success,
            ...(r.success ? {} : { errors: r.errors })
          }))
        }
        const updated = results.filter(r => r.success).length
        return { content: [{ type: 'text', text: JSON.stringify({
          requested: records.length,
          updated,
          failed: results.filter(r => !r.success)
        }) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerDeleteRecord(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'deleteSobjectRecord',
    `Permanently deletes a Salesforce record by ID.

SAFETY: ALWAYS confirm with user before calling. Deletion cannot be undone via MCP.
Deleted records go to Recycle Bin — recoverable in SF UI within 15 days.`,

    {
      'sobject-name': z.string().describe("Object API name (e.g. 'Lead', 'Case', 'EMI_Schedule__c')"),
      id: z.string().describe('18-character Salesforce record ID to delete')
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await conn.sobject(args['sobject-name']).delete(args.id)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
