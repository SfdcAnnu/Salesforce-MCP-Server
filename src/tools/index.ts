import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Request } from 'express'
import { registerGetObjectSchema } from './schema'
import { registerSoqlQuery, registerFind } from './query'
import {
  registerGetUserInfo,
  registerListRecentRecords,
  registerCreateRecord,
  registerUpdateRecord,
  registerDeleteRecord
} from './records'
import {
  registerGetRelatedRecords,
  registerUpdateRelatedRecord,
  registerDeleteRelatedRecord
} from './relationships'

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
  registerDeleteRecord(server, req, sessionId)
  registerUpdateRelatedRecord(server, req, sessionId)
  registerDeleteRelatedRecord(server, req, sessionId)
  console.log('[MCP] 11 tools registered')
}
