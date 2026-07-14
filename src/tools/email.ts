/**
 * sendEmail — standard REST invocable action `emailSimple`, no custom Apex:
 *   POST /services/data/v65.0/actions/standard/emailSimple
 *
 * v65+ covers the full feature set: recipientAddresses + ccAddresses +
 * bccAddresses (v65), emailTemplateId + recipientId/relatedRecordId merge
 * fields + logEmailOnSend (v58), attachmentId (v63), rich-text body,
 * org-wide sender. The tool exposes friendly parameter names and maps
 * them onto the action's inputs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Request } from 'express'
import { resolveSFConnection, notAuthenticatedError, sfApiError } from '../lib/sf'

// ccAddresses/bccAddresses need v65+; independent of the v62 pin used
// by the CRUD tools.
const EMAIL_ACTION_VERSION = '65.0'

interface InvocableResponse {
  actionName: string
  isSuccess: boolean
  errors: unknown
  outputValues: Record<string, unknown> | null
}

const splitCsv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
const cleanId  = (s: string) => String(s).replace(/['\\]/g, '')

export function registerSendEmail(server: McpServer, req: Request, sessionId: string) {
  server.tool(
    'sendEmail',
    `Sends an email from Salesforce (standard emailSimple action). Two modes:

• TEMPLATE mode — pass templateIdOrName (EmailTemplate Id 00X... or its
  DeveloperName). targetObjectId (Contact/Lead Id) is REQUIRED — it is the
  recipient and the merge-field source. whatId supplies merge fields from
  a second, non-person record (Account/Opportunity/Case/custom).
• CUSTOM mode — pass subject + htmlBody (rich text) or plainTextBody.

RECIPIENTS: toAddresses (comma-separated emails), plus optional
ccAddresses / bccAddresses. targetObjectId also receives the email.
Combined recipient count must be 150 or fewer.

SENDER: orgWideEmailAddressId accepts an OrgWideEmailAddress Id (0D2...)
or a verified org-wide email address string — find them via soqlQuery:
SELECT Id, Address, DisplayName FROM OrgWideEmailAddress. Omit to send
as the connected user.

LOGGING: saveAsActivity=true (default) logs the email on the
targetObjectId / whatId record timelines — requires one of them; silently
skipped otherwise.

ATTACHMENTS: contentDocumentIds — comma-separated ContentDocumentIds
(069...); latest file versions are attached.

SAFETY: ALWAYS show the user the recipients + subject (or template name)
and get confirmation BEFORE sending — emails cannot be unsent.`,
    {
      toAddresses:           z.string().optional().describe('Comma-separated recipient emails. Optional when targetObjectId is the recipient.'),
      ccAddresses:           z.string().optional().describe('Comma-separated CC emails (visible to all).'),
      bccAddresses:          z.string().optional().describe('Comma-separated BCC emails (hidden).'),
      subject:               z.string().optional().describe('Subject (CUSTOM mode; ignored with a template).'),
      htmlBody:              z.string().optional().describe('Rich-text/HTML body (CUSTOM mode).'),
      plainTextBody:         z.string().optional().describe('Plain-text body (CUSTOM mode; used when htmlBody absent).'),
      templateIdOrName:      z.string().optional().describe('EmailTemplate Id (00X...) or DeveloperName (TEMPLATE mode).'),
      targetObjectId:        z.string().optional().describe('Contact/Lead Id — recipient and template merge source. Required with a template.'),
      whatId:                z.string().optional().describe('Related non-person record Id (Account, Opportunity, Case, custom) for merge fields and logging.'),
      orgWideEmailAddressId: z.string().optional().describe('OrgWideEmailAddress Id (0D2...) or verified address to send from a shared address.'),
      saveAsActivity:        z.boolean().optional().describe('Log the email on the record timeline (default true; needs targetObjectId or whatId).'),
      contentDocumentIds:    z.string().optional().describe('Comma-separated ContentDocumentIds (069...) to attach.')
    },
    async (input) => {
      const conn = await resolveSFConnection(req, sessionId)
      if (!conn) return notAuthenticatedError(process.env.BASE_URL!)
      try {
        // Guardrails — clear tool errors instead of action errors.
        if (!input.toAddresses && !input.targetObjectId) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'MISSING_RECIPIENT',
            message: 'Provide toAddresses and/or targetObjectId — the email needs at least one recipient.'
          }) }], isError: true }
        }
        if (input.templateIdOrName && !input.targetObjectId) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'MISSING_TARGET',
            message: 'targetObjectId (Contact/Lead Id) is required when sending with a template — it is the recipient and merge-field source (emailSimple recipientId).'
          }) }], isError: true }
        }
        if (!input.templateIdOrName && !input.subject && !input.htmlBody && !input.plainTextBody) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'MISSING_CONTENT',
            message: 'Provide either templateIdOrName, or subject + htmlBody/plainTextBody.'
          }) }], isError: true }
        }

        // Template DeveloperName → Id (standard SOQL).
        let templateId: string | null = null
        if (input.templateIdOrName) {
          const v = input.templateIdOrName.trim()
          if (/^00X[a-zA-Z0-9]{12,15}$/.test(v)) {
            templateId = v
          } else {
            const t = await conn.query<{ Id: string }>(
              `SELECT Id FROM EmailTemplate WHERE DeveloperName = '${cleanId(v)}' LIMIT 1`)
            if (t.records.length === 0) {
              return { content: [{ type: 'text', text: JSON.stringify({
                error: 'TEMPLATE_NOT_FOUND',
                message: `Email template not found: ${v}. Look templates up via soqlQuery on EmailTemplate (Id, Name, DeveloperName).`
              }) }], isError: true }
            }
            templateId = t.records[0].Id
          }
        }

        // Org-wide sender: the action wants the ADDRESS; resolve 0D2 ids.
        let senderAddress: string | null = null
        if (input.orgWideEmailAddressId) {
          const v = input.orgWideEmailAddressId.trim()
          if (/^0D2[a-zA-Z0-9]{12,15}$/.test(v)) {
            const o = await conn.query<{ Address: string }>(
              `SELECT Address FROM OrgWideEmailAddress WHERE Id = '${cleanId(v)}' LIMIT 1`)
            if (o.records.length === 0) {
              return { content: [{ type: 'text', text: JSON.stringify({
                error: 'ORG_WIDE_ADDRESS_NOT_FOUND',
                message: `OrgWideEmailAddress ${v} not found. List them via soqlQuery: SELECT Id, Address, DisplayName FROM OrgWideEmailAddress.`
              }) }], isError: true }
            }
            senderAddress = o.records[0].Address
          } else {
            senderAddress = v   // already an address string
          }
        }

        // Attachments: ContentDocumentId → latest ContentVersion ids
        // (the action accepts ContentVersion ids in attachmentId).
        let attachmentIds: string[] = []
        if (input.contentDocumentIds) {
          const docIds = splitCsv(input.contentDocumentIds).map(cleanId)
          if (docIds.length > 0) {
            const cv = await conn.query<{ Id: string }>(
              `SELECT Id FROM ContentVersion WHERE ContentDocumentId IN (${docIds.map(d => `'${d}'`).join(',')}) AND IsLatest = true`)
            attachmentIds = cv.records.map(r => r.Id)
            if (attachmentIds.length === 0) {
              return { content: [{ type: 'text', text: JSON.stringify({
                error: 'ATTACHMENTS_NOT_FOUND',
                message: 'None of the given ContentDocumentIds resolved to files. Check the 069... ids.'
              }) }], isError: true }
            }
          }
        }

        // Map friendly params → emailSimple inputs. Input names verified
        // against the live action describe (GET .../actions/standard/
        // emailSimple) — they differ from the doc page's display labels:
        // emailAddresses / ccRecipientAddressList / bccRecipientAddressList.
        const action: Record<string, unknown> = {}
        if (input.toAddresses)  action.emailAddresses          = splitCsv(input.toAddresses).join(',')
        if (input.ccAddresses)  action.ccRecipientAddressList  = splitCsv(input.ccAddresses).join(',')
        if (input.bccAddresses) action.bccRecipientAddressList = splitCsv(input.bccAddresses).join(',')
        if (templateId) {
          action.emailTemplateId = templateId
        } else {
          action.emailSubject = input.subject ?? ''
          if (input.htmlBody) {
            action.emailBody    = input.htmlBody
            action.sendRichBody = true
            action.useLineBreaks = true
          } else {
            action.emailBody = input.plainTextBody ?? ''
          }
        }
        if (input.targetObjectId) action.recipientId     = cleanId(input.targetObjectId)
        if (input.whatId)         action.relatedRecordId = cleanId(input.whatId)
        if (senderAddress) {
          action.senderType    = 'OrgWideEmailAddress'
          action.senderAddress = senderAddress
        }
        // Logging needs recipientId or relatedRecordId — skip otherwise.
        const wantLog = input.saveAsActivity ?? true
        if (wantLog && (input.targetObjectId || input.whatId)) action.logEmailOnSend = true
        if (attachmentIds.length > 0) action.attachmentId = attachmentIds.join(',')

        const res = await conn.request<InvocableResponse[]>({
          method: 'POST',
          url:    `/services/data/v${EMAIL_ACTION_VERSION}/actions/standard/emailSimple`,
          body:   JSON.stringify({ inputs: [action] }),
          headers: { 'Content-Type': 'application/json' }
        })

        const r = res[0]
        if (r?.isSuccess === true) {
          return { content: [{ type: 'text', text: JSON.stringify({
            success: true,
            message: 'Email sent.',
            logged: action.logEmailOnSend === true
          }) }] }
        }
        return { content: [{ type: 'text', text: JSON.stringify({
          success: false,
          message: 'Send failed.',
          errors: r?.errors ?? 'unknown error'
        }) }], isError: true }
      } catch (err) {
        return sfApiError(err)
      }
    }
  )
}
