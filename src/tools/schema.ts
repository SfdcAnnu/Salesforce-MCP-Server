import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

export function registerGetObjectSchema(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'getObjectSchema',
    `Returns Salesforce schema information optimized for LLM consumption.

TWO MODES:

• INDEX MODE (no parameters): Returns compact list of ALL objects in the org — labels, API names, queryable/createable flags. Call this FIRST when unfamiliar with the org or when you need to find a custom object API name.

• DETAIL MODE (object-name provided): Returns full field schema — field API names, types, required flags, picklist values, child relationship names.

WHEN TO CALL THIS:
1. CUSTOM OBJECTS (__c suffix) — ALWAYS call detail mode before ANY query/create/update/delete.
   - Label 'Loan Application' → API name Loan_Application__c (NOT Loan__c — you cannot guess this)
   - Field 'EMI Amount' → EMI_Amount__c (NOT EMI_Amount)
   - Child relationship name for EMI_Schedule__c → EMI_Schedules__r (NOT EMI_Schedule__c)

2. STANDARD OBJECTS — Call detail mode ONLY when:
   - You need a custom field an admin added (e.g. Case.Loan_Application__c — only exists if admin created it)
   - You are unsure of a field name (Case uses CaseNumber not Name; Opportunity uses StageName not Status)`,

    {
      'object-name': z.string().optional().describe(
        "API name of a single object to describe (e.g. 'Account', 'Loan_Application__c'). " +
        "OMIT entirely to get the full index of all objects. " +
        "If unsure of API name, omit first to get the index."
      )
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)

      try {
        if (!args['object-name']) {
          // INDEX MODE
          const result = await conn.describeGlobal()
          const compact = result.sobjects
            .filter((o: any) => o.queryable)
            .map((o: any) => ({
              label: o.label,
              name: o.name,
              custom: o.custom,
              queryable: o.queryable,
              createable: o.createable,
              updateable: o.updateable,
              deletable: o.deletable
            }))
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ mode: 'index', totalObjects: compact.length, objects: compact })
            }]
          }
        }

        // DETAIL MODE
        const meta = await conn.describe(args['object-name'])
        const fields = (meta.fields as any[]).map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          length: f.length || undefined,
          picklistValues: f.picklistValues?.length
            ? f.picklistValues.filter((p: any) => p.active).map((p: any) => p.value)
            : undefined,
          referenceTo: f.referenceTo?.length ? f.referenceTo : undefined,
          relationshipName: f.relationshipName || undefined
        }))
        const childRelationships = (meta.childRelationships as any[])
          .filter(r => r.relationshipName)
          .map(r => ({
            childObject: r.childSObject,
            field: r.field,
            relationshipName: r.relationshipName
          }))
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ mode: 'detail', name: meta.name, label: meta.label, fields, childRelationships })
          }]
        }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
