import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

export function registerSoqlQuery(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'soqlQuery',
    `Executes a SOQL query to retrieve Salesforce records.

PREREQUISITES:
• CUSTOM objects (__c): ALWAYS call getObjectSchema(object-name) first.
  Reason: 'Loan Application' → Loan_Application__c (not Loan__c). Wrong name = runtime error.
• STANDARD objects: Call getObjectSchema only when field names are uncertain or you need
  org-specific custom fields (e.g. Case.Loan_Application__c only exists if admin created it).

RULES:
• Always include WHERE and LIMIT clauses
• Filter on indexed fields (Id, Name, foreign key IDs) to avoid timeouts
• Parent traversal: SELECT Contact.Account.Name FROM Contact
• Child subquery: SELECT Id, (SELECT Id, Subject FROM Cases) FROM Account WHERE Id = 'xxx'`,

    {
      query: z.string().describe(
        'Valid SOQL string. Field/object names must match SF API names exactly. ' +
        "Example: SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 10"
      )
    },

    async ({ query }) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await conn.query(query)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}

export function registerFind(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'find',
    `Executes a SOSL text search across multiple Salesforce objects simultaneously.

USE find INSTEAD OF soqlQuery WHEN:
• Searching for a term that could exist across multiple object types
• You don't know which object contains the data
• You need relevance-ranked results (e.g. searching a person's name)

SOSL SYNTAX: FIND {term} IN SEARCH_GROUP RETURNING Object1(fields), Object2(fields)

SEARCH GROUPS: IN NAME FIELDS | IN EMAIL FIELDS | IN PHONE FIELDS | IN ALL FIELDS

ALWAYS include RETURNING clause with explicit fields.
Max 2,000 records total. Cannot ORDER BY. Cannot traverse relationships.`,

    {
      search: z.string().describe(
        'Valid SOSL string. Always include RETURNING clause. ' +
        'Examples:\n' +
        '- FIND {Annu Choudhary} IN NAME FIELDS RETURNING Lead(Id,FirstName,LastName,Email,Status), Contact(Id,FirstName,LastName)\n' +
        '- FIND {9999999999} IN PHONE FIELDS RETURNING Contact(Id,Name,Phone), Lead(Id,Name,Phone)'
      )
    },

    async ({ search }) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        const result = await conn.search(search)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
