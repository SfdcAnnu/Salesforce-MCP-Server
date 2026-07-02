# Salesforce MCP — Run Guide

## Step 1: Open in VS Code

```bash
# Unzip the project
unzip sf-mcp-final.zip
cd sf-mcp-final

# Open in VS Code
code .
```

---

## Step 2: Install dependencies

Open the **integrated terminal** in VS Code (`` Ctrl+` `` or `View → Terminal`):

```bash
npm install
```

---

## Step 3: Create your .env file

In VS Code, duplicate `.env.example` and rename it `.env`.
Then fill in your values:

```env
PORT=3000
BASE_URL=https://YOUR_NGROK_URL_HERE     ← fill this after Step 5
SF_LOGIN_URL=https://login.salesforce.com

# Only needed for standalone clients (n8n, Cursor) — not needed for Claude connector
SF_CLIENT_ID=YOUR_CONNECTED_APP_CLIENT_ID
SF_CLIENT_SECRET=YOUR_CONNECTED_APP_CLIENT_SECRET
SF_REDIRECT_URI=https://YOUR_NGROK_URL_HERE/auth/callback
```

> **SF_LOGIN_URL**: Use `https://test.salesforce.com` if you are on a sandbox org.

---

## Step 4: Create Salesforce Connected App

> Skip this if you already have one.

1. Go to **Salesforce Setup** → search "App Manager" → **New Connected App**
2. Fill in:
   - Connected App Name: `My Salesforce MCP`
   - API Name: auto-fills
   - Contact Email: your email
3. Check **Enable OAuth Settings**
4. Callback URL: `https://claude.ai/oauth/callback` ← for Claude connector
   - Also add: `https://YOUR_NGROK_URL/auth/callback` ← for standalone clients
5. Selected OAuth Scopes: Add **Full access (full)** + **Perform requests at any time (refresh_token)**
6. Click Save → wait 2-10 minutes for SF to activate
7. Copy **Consumer Key** (= Client ID) and **Consumer Secret** (= Client Secret)

---

## Step 5: Start ngrok

Open a **second terminal** in VS Code (`+` button in terminal panel):

```bash
# If ngrok not installed:
# Mac:     brew install ngrok
# Windows: download from ngrok.com

# Authenticate ngrok (one time only)
ngrok config add-authtoken YOUR_NGROK_TOKEN

# Get your free static domain at: https://dashboard.ngrok.com/domains
# Then run:
ngrok http --domain=your-name.ngrok-free.app 3000

# OR without a static domain (URL changes on restart):
ngrok http 3000
```

Copy the `https://` URL from ngrok output, e.g.: `https://your-name.ngrok-free.app`

---

## Step 6: Update .env with ngrok URL

Back in your `.env` file, replace `YOUR_NGROK_URL_HERE` with the actual ngrok URL:

```env
BASE_URL=https://your-name.ngrok-free.app
SF_REDIRECT_URI=https://your-name.ngrok-free.app/auth/callback
```

---

## Step 7: Run the MCP server

In your **first terminal**:

```bash
npm run dev
```

You should see:
```
╔═══════════════════════════════════════════════════════════════╗
║           Salesforce MCP Server — Ready                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Local:          http://localhost:3000                        ║
...
```

---

## Step 8: Test endpoints in browser / Postman

Before connecting Claude, verify your server works:

| URL | Expected response |
|-----|-------------------|
| `https://YOUR_NGROK_URL/` | JSON with server info |
| `https://YOUR_NGROK_URL/.well-known/oauth-authorization-server` | JSON with SF auth endpoints |
| `https://YOUR_NGROK_URL/.well-known/oauth-protected-resource` | JSON with resource metadata |

---

## Step 9: Add as Claude connector

1. Open **Claude.ai** → click your profile icon → **Settings**
2. Go to **Connectors** (or **Integrations**)
3. Click `+` → **Add custom connector**
4. Fill in:
   - **Name**: `Salesforce MCP`
   - **Remote MCP server URL**: `https://YOUR_NGROK_URL/mcp`
   - **Advanced settings → OAuth Client ID**: your SF Consumer Key
   - **Advanced settings → OAuth Client Secret**: your SF Consumer Secret
5. Click **Add**
6. Claude will open a Salesforce login window → log in with your SF credentials
7. After login you see "Salesforce connected" → close tab → return to Claude

---

## Step 10: Test in Claude

Start a new conversation and try:

```
Show me all Salesforce objects available
```
or
```
Find the lead for Annu Choudhary
```

Claude will now use your 11 tools automatically.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module` | Run `npm install` again |
| `PORT already in use` | Change PORT in .env to 3001 |
| ngrok URL changed | Update BASE_URL + SF_REDIRECT_URI in .env, restart `npm run dev` |
| Claude shows "not connected" | Check ngrok is running, server is running, BASE_URL is correct |
| SF login fails | Make sure `https://claude.ai/oauth/callback` is in your Connected App callback URLs |
| `INVALID_TYPE` error in Claude | That's working correctly — Claude will call getObjectSchema to fix it |

---

## File structure

```
sf-mcp-final/
├── src/
│   ├── server.ts              ← entry point — all endpoints wired here
│   ├── middleware/
│   │   └── auth.ts            ← Bearer token check for /mcp
│   ├── routes/
│   │   ├── wellknown.ts       ← /.well-known endpoints (tells Claude SF login URL)
│   │   └── auth.ts            ← /auth + /auth/callback (standalone clients only)
│   ├── lib/
│   │   ├── sf.ts              ← SF connection resolver + error helpers
│   │   └── session.ts         ← token store (PATH B standalone clients)
│   └── tools/
│       ├── index.ts           ← registers all 11 tools
│       ├── schema.ts          ← getObjectSchema
│       ├── query.ts           ← soqlQuery, find
│       ├── records.ts         ← getUserInfo, listRecent, create, update, delete
│       └── relationships.ts   ← getRelatedRecords, updateRelated, deleteRelated
├── .env.example               ← copy to .env and fill in values
├── package.json
└── tsconfig.json
```
