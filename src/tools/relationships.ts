import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

const REL_PATH_DESC =
  'Relationship name from parent to child. Must be the relationshipName from ' +
  "getObjectSchema childRelationships — NOT the child object API name. " +
  "Examples: 'Contacts' not 'Contact', 'EMI_Schedules__r' not 'EMI_Schedule__c', 'Cases' not 'Case'. " +
  "Multi-level: 'Account/Owner'."

export function registerGetRelatedRecords(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'getRelatedRecords',
    `Retrieves all child records related to a parent via a named relationship.

PREREQUISITE: relationship-path must be the relationshipName from getObjectSchema
childRelationships on the parent — NOT the child object API name.
Example: getObjectSchema('Loan_Application__c') → childRelationships includes
  { childObject: 'EMI_Schedule__c', relationshipName: 'EMI_Schedules__r' }
Pass 'EMI_Schedules__r' — not 'EMI_Schedule__c'.

Returns ALL fields. For field-level control use soqlQuery with WHERE clause instead.`,

    {
      'sobject-name': z.string().describe("Parent object API name (e.g. 'Account', 'Loan_Application__c')"),
      id: z.string().describe('18-character SF record ID of the parent'),
      'relationship-path': z.string().describe(REL_PATH_DESC)
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const url = `/sobjects/${args['sobject-name']}/${args.id}/${args['relationship-path']}`
        const result = await (conn as any).requestGet(url)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerUpdateRelatedRecord(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'updateRelatedRecord',
    `Updates a child record via parent relationship traversal.

FOR 1-TO-MANY: If parent has multiple children of same type (e.g. 36 EMIs),
relationship-path alone is ambiguous. Instead:
  1. Use getRelatedRecords or soqlQuery to get specific child IDs
  2. Use updateSobjectRecord with the exact child ID

Best for 1-to-1 relationships (e.g. updating a record's Owner).`,

    {
      'sobject-name': z.string().describe('Parent object API name'),
      id: z.string().describe('18-character SF record ID of the parent'),
      'relationship-path': z.string().describe(REL_PATH_DESC),
      body: z.record(z.unknown()).describe('Field-value pairs to update on the child record')
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const url = `/sobjects/${args['sobject-name']}/${args.id}/${args['relationship-path']}`
        const result = await (conn as any).requestPatch(url, args.body)
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerDeleteRelatedRecord(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'deleteRelatedRecord',
    `Deletes a child record via parent relationship traversal.

SAFETY: Confirm with user before calling. Deleted records go to Recycle Bin (15 days).
FOR 1-TO-MANY: Get specific child ID first via soqlQuery, then use deleteSobjectRecord.`,

    {
      'sobject-name': z.string().describe('Parent object API name'),
      id: z.string().describe('18-character SF record ID of the parent'),
      'relationship-path': z.string().describe(REL_PATH_DESC)
    },

    async (args) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const url = `/sobjects/${args['sobject-name']}/${args.id}/${args['relationship-path']}`
        const result = await (conn as any).requestDelete(url)
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
