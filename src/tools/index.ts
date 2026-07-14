import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Request } from 'express'
import { registerGetObjectSchema } from './schema'
import { registerSoqlQuery, registerFind } from './query'
import {
  registerGetUserInfo,
  registerListRecentRecords,
  registerCreateRecord,
  registerUpdateRecord,
  registerBulkUpdateRecords,
  registerDeleteRecord
} from './records'
import {
  registerGetRelatedRecords,
  registerUpdateRelatedRecord,
  registerDeleteRelatedRecord
} from './relationships'
import {
  registerRecallApprovals,
  registerReassignApprovals
} from './approvals'
import { registerSendEmail } from './email'

/**
 * Static tool catalog for the public GET /tools endpoint.
 * Lets portals render an accurate tool picker BEFORE any org is
 * connected (the authenticated path is MCP tools/list on /mcp).
 * Keep in sync with registerAllTools below.
 */
export const TOOL_SUMMARIES = [
  { name: 'getObjectSchema',          readOnly: true,  description: 'Describe an SObject: fields, types, picklists, relationships' },
  { name: 'soqlQuery',                readOnly: true,  description: 'Run a SOQL query (incl. pending-approval lookups)' },
  { name: 'find',                     readOnly: true,  description: 'SOSL text search across multiple objects' },
  { name: 'getUserInfo',              readOnly: true,  description: 'Connected Salesforce user identity' },
  { name: 'listRecentSobjectRecords', readOnly: true,  description: 'Recently viewed records for an SObject' },
  { name: 'getRelatedRecords',        readOnly: true,  description: 'Child/related records for a parent record' },
  { name: 'createSobjectRecord',      readOnly: false, description: 'Insert a new record' },
  { name: 'updateSobjectRecord',      readOnly: false, description: 'Update fields on one record' },
  { name: 'bulkUpdateSobjectRecords', readOnly: false, description: 'Update many records in one call (up to 200/batch)' },
  { name: 'deleteSobjectRecord',      readOnly: false, description: 'Delete a record' },
  { name: 'updateRelatedRecord',      readOnly: false, description: 'Update a related child record' },
  { name: 'deleteRelatedRecord',      readOnly: false, description: 'Delete a related child record' },
  { name: 'recallApprovals',          readOnly: false, description: 'Bulk recall/revoke pending approval requests' },
  { name: 'reassignApprovals',        readOnly: false, description: 'Bulk reassign approvals: to a user, submitter’s manager, or escalate to approver’s manager' },
  { name: 'sendEmail',                readOnly: false, description: 'Send an email: templates or custom body, To/CC/BCC, org-wide sender, merge fields, attachments' }
]

export function registerAllTools(
  server: McpServer,
  req: Request,
  sessionId: string = 'default'
): void {
  registerGetObjectSchema(server, req, sessionId)
  registerSoqlQuery(server, req, sessionId)
  registerFind(server, req, sessionId)
  registerGetUserInfo(server, req, sessionId)
  registerListRecentRecords(server, req, sessionId)
  registerGetRelatedRecords(server, req, sessionId)
  registerCreateRecord(server, req, sessionId)
  registerUpdateRecord(server, req, sessionId)
  registerBulkUpdateRecords(server, req, sessionId)
  registerDeleteRecord(server, req, sessionId)
  registerUpdateRelatedRecord(server, req, sessionId)
  registerDeleteRelatedRecord(server, req, sessionId)
  registerRecallApprovals(server, req, sessionId)
  registerReassignApprovals(server, req, sessionId)
  registerSendEmail(server, req, sessionId)
  console.log('[MCP] 15 tools registered')
}
