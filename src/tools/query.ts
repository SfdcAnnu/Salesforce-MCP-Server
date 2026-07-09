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
• Child subquery: SELECT Id, (SELECT Id, Subject FROM Cases) FROM Account WHERE Id = 'xxx'

APPROVAL PROCESS RECIPE (pending items live in ProcessInstanceWorkitem):
• "MY pending approvals" is AMBIGUOUS — it can mean (a) items waiting for MY
  approval (ActorId = my user id) OR (b) items I SUBMITTED that are still
  pending (ProcessInstance.SubmittedById = my user id). Fetch BOTH in one
  query and group the results when presenting — do not silently pick one:
  SELECT Id, ActorId, Actor.Name, Actor.Type,
         ProcessInstance.TargetObjectId, ProcessInstance.Status,
         ProcessInstance.SubmittedById, ProcessInstance.SubmittedBy.Name,
         ProcessInstance.SubmittedBy.Manager.Name
  FROM ProcessInstanceWorkitem
  WHERE ProcessInstance.Status = 'Pending'
    AND (ActorId = '<myUserId>' OR ProcessInstance.SubmittedById = '<myUserId>')
  LIMIT 50
  (Call getUserInfo first for <myUserId>. Drop the whole AND(...) clause for
  org-wide pending approvals.)
• Actor (current approver) is POLYMORPHIC — a User OR a Queue. Actor.Type says
  which. To get an approver's manager: collect ActorIds where Actor.Type = 'User',
  then run a second query:
  SELECT Id, Name, ManagerId, Manager.Name FROM User WHERE Id IN ('005...','005...')
  Queues have no manager. Do NOT write Actor.Manager.Name — polymorphic traversal fails.
• To ACT on results, pass the workitem Ids (04i...) to recallApprovals or
  reassignApprovals — do not hand-edit approver assignments with update tools.
• Recall REMOVES the request entirely (record must be re-submitted).
  To hand the approval to a different approver, use reassignApprovals instead.`,

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
