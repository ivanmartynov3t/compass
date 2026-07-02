# Compass AI — Privacy & Data-Sharing Reference

This document is a precise, source-verified audit of what data the Compass AI features
(Natural Language Query and the AI Assistant) collect, transmit, redact, and retain.
Every claim cites the exact file and line where the behaviour is implemented.

---

## 1. Opt-in / Consent Flow

Compass AI features are **opt-in by default**.

| Preference | Default | Source |
|---|---|---|
| `optInGenAIFeatures` | `false` | `packages/compass-preferences-model/src/preferences-schema.tsx:890` (`z.boolean().default(false)`) |
| `enableGenAIFeatures` | depends on cloud rollout flag | `packages/compass-preferences-model/src/utils.ts:isAIFeatureEnabled()` |

**What the user sees before opting in.**
The opt-in modal (`packages/compass-generative-ai/src/components/ai-optin-modal.tsx`) displays a
single notice:

> "Features powered by generative AI may produce inaccurate responses. Please see our FAQ for more
> information. Continue to opt into all AI-powered features."

A link labelled "Use AI Features" triggers the opt-in. There is no embedded EULA or legal
agreement text in the Compass source code. The modal links out to:

```
https://www.mongodb.com/docs/generative-ai-faq/
```

(`ai-optin-modal.tsx` line 21: `const GEN_AI_FAQ_LINK = ...`)

Clicking the button calls `atlasAiService.optIntoGenAIFeatures()`, which:
- POSTs to `settings/optInDataExplorerGenAIFeatures` (Atlas cloud path) for cloud-connected
  sessions.
- Sets `optInGenAIFeatures: true` in local Compass preferences.

**Master AI kill switches (three-way AND gate)**
`packages/compass-preferences-model/src/utils.ts` — `isAIFeatureEnabled()` requires all three to
be true simultaneously:

1. `enableGenAIFeatures` — user-level toggle.
2. `enableGenAIFeaturesAtlasOrg` — Atlas organisation-level policy (controlled by MongoDB Atlas
   project admin, not by the end user).
3. `cloudFeatureRolloutAccess.GEN_AI_COMPASS` — MongoDB-controlled rollout flag.

An Atlas org admin can therefore disable AI for all users in their organisation without any user
action by setting `enableGenAIFeaturesAtlasOrg = false`.

---

## 2. What Data Is Sent to the LLM

### 2a. Natural Language Query (SLIM model — `mongodb-slim-2.1-mini`)

The SLIM model is used for NLQ (find/aggregation generation) and mock data generation.
The exact user message is assembled in
`packages/compass-generative-ai/src/utils/gen-ai-prompt.ts` by `buildFindQueryPrompt()` /
`buildAggregateQueryPrompt()` (lines 204–237).

**Fields always included in the user message:**

| Field | Content | Source |
|---|---|---|
| `Database name: "…"` | Database name (plain string) | `gen-ai-prompt.ts:114–115` |
| `Collection name: "…"` | Collection name (plain string) | `gen-ai-prompt.ts:117–118` |
| `<user_schema>…</user_schema>` | Field names + BSON types only, no values (via `flattenSchemaToObject`) | `gen-ai-prompt.ts:120–126` |
| `<user_prompt>…</user_prompt>` | User's verbatim NL query (XML-escaped) | `gen-ai-prompt.ts:111` |

**Field included only when `enableGenAISampleDocumentPassing = true`:**

| Field | Content | Source |
|---|---|---|
| `<sample_documents>…</sample_documents>` | Up to 4 raw documents in MongoDB shell syntax | `gen-ai-prompt.ts:128–158` |

Sample documents are fetched via `dataService.sample()` with `size: 4`
(`ai-query-reducer.ts:207–211`). Documents are serialised with `toJSString()` from
`mongodb-query-parser`, which produces **MongoDB shell syntax** (e.g.
`ObjectId('…')`, not `{"$oid":"…"}`). **All field values are included verbatim; no value
masking is applied.** The test suite confirms this format at
`gen-ai-prompt.spec.ts:44–50`.

**`enableGenAISampleDocumentPassing` preference:**

| | |
|---|---|
| Default | `false` (opt-out by default — samples are **not** sent unless explicitly enabled) |
| Source | `preferences-schema.tsx:965` (`z.boolean().default(false)`) |
| UI-exposed | Yes (`ui: true`) — users can toggle in Settings |
| Read at NLQ call sites | `ai-query-reducer.ts:172–173`, `pipeline-ai.ts:242–243` |

**Prompt length limiting:**
`MAX_TOTAL_PROMPT_LENGTH = 250_000` characters (`gen-ai-prompt.ts:6`).
Trimming order (`gen-ai-prompt.ts:128–171`):
1. Try all fetched documents — if total prompt fits, use them all.
2. Fall back to 1 document (`MIN_SAMPLE_DOCUMENTS = 1`, `gen-ai-prompt.ts:7`) — if that fits, use it.
3. If no documents are included and the base prompt (schema + user input) still exceeds the limit,
   an `AiChatbotPromptTooLargeError` is thrown and the user sees a friendly error message.

### 2b. AI Assistant / CHAT Model (`mongodb-chat-2.1-mini-reasoning`)

The system message sent to the CHAT model is assembled by `buildContextPrompt()`
(`packages/compass-assistant/src/prompts.ts` lines 264–444).

**Metadata always sent in the system message:**

| Field | Redaction | Source |
|---|---|---|
| Connection string | Password replaced with `<credentials>` via `redactConnectionString()` | `prompts.ts:240, 291` |
| Server version | Plain string | `prompts.ts` |
| Database name | Plain string | `prompts.ts` |
| Collection name | Plain string | `prompts.ts` |
| Collection namespace | Plain string | `prompts.ts` |

`redactConnectionString()` is imported from the `mongodb-connection-string-url` npm package.
It replaces userinfo (username:password) in the URI with `<credentials>`.

For Atlas-managed connections where `connectionInfo.atlasMetadata` is present, the connection
string is **omitted entirely** from error prompts — only the error message text is sent
(`buildConnectionErrorPrompt()` at `prompts.ts:233–262`).

**Tool calling and live document retrieval**

When `enableGenAIToolCalling = true` (default) and `enableToolCalling = true`, the CHAT model has
access to the following read-only database tools registered in
`packages/compass-generative-ai/src/available-tools.ts`:

| Tool | Can return document values? |
|---|---|
| `find` | **Yes** — returns raw query results |
| `aggregate` | **Yes** — returns raw pipeline results |
| `count` | No |
| `list-databases` | No |
| `list-collections` | No |
| `collection-schema` | No (field names + types only) |
| `collection-indexes` | No |
| `collection-storage-size` | No |
| `db-stats` | No |
| `explain` | No |
| `mongodb-logs` | No (log metadata, no document data) |
| `get-current-query` | No |
| `get-current-pipeline` | No |

All tools have `needsApproval: true` (`tools-controller.ts` lines 150, 169, 210), meaning the
user must explicitly approve each invocation before it executes. The MCP server is declared
`readOnly: true` (`tools-controller.ts:101`).

**The CHAT model can therefore retrieve live document content from the database via `find` and
`aggregate` tools, but only after explicit per-call user approval.**

### 2c. Mock Data Generation (SLIM model)

`getMockDataSchema()` in `packages/compass-generative-ai/src/atlas-ai-service.ts` sends:
- Schema structure (field names and BSON types) — **no document values**.
- When `includeSampleValues = false` (the default), `sampleValues` entries are stripped from the
  schema object before serialisation (lines 526–600).

---

## 3. What Data Is NOT Redacted

The following data is sent to the LLM without modification:

- Database name and collection name (both models, always).
- The user's verbatim natural language query (`<user_prompt>`).
- Raw document field values when `enableGenAISampleDocumentPassing = true` (NLQ path).
- Raw `find`/`aggregate` tool results when the user approves a tool call (CHAT path).
- Full explain plan JSON (sent verbatim by the explain plan entry point in the CHAT model).
- Current query bar / aggregation pipeline text (via `get-current-query` / `get-current-pipeline`
  tools).
- MongoDB server version string.

---

## 4. What Data Is Redacted Before Sending

| Data | Redaction mechanism | Where applied |
|---|---|---|
| Connection string password / userinfo | `redactConnectionString()` → `<credentials>` | `prompts.ts:240, 291` |
| SSH tunnel password | Set to `'<redacted>'` | `data-service/src/redact.ts:22` |
| SSH identity key passphrase | Set to `'<redacted>'` | `data-service/src/redact.ts:25–26` |
| Atlas connection string in error context | Omitted entirely | `prompts.ts:233–262` |
| Schema field values (schema path) | Only field names + BSON types emitted via `flattenSchemaToObject()` | `gen-ai-prompt.ts:120–126` |
| Sample document values (when flag is off) | Documents not fetched / not included | `ai-query-reducer.ts:172–173` |
| Mock data sample values | Stripped when `includeSampleValues=false` | `atlas-ai-service.ts:526–600` |
| User analytics ID | SHA-256 hex-digest of internal user ID via `crypto.subtle.digest` | `compass-assistant/src/utils.ts:130–155` |

---

## 5. Network Routing — Where Traffic Goes

**All LLM traffic routes through MongoDB's Atlas Knowledge Server. No traffic goes directly to
OpenAI or Azure.**

Production endpoint:

```
https://knowledge.mongodb.com/api/v1
```

(`packages/atlas-service/src/util.ts:216`)

The URL can be overridden per-environment via the `COMPASS_ASSISTANT_BASE_URL_OVERRIDE`
environment variable (`util.ts:226–233`). No override is set in production builds.

### Authentication

**SLIM model (NLQ):** Uses `authenticatedFetch()` in
`packages/atlas-service/src/atlas-service.ts` (lines 161–174), which calls
`authService.getAuthHeaders()` and merges the result into the request headers.
`getAuthHeaders()` is implemented in `compass-atlas-auth-service.ts` (lines 27–31) and
returns `{ Authorization: '******' }` where `<token>` is an OIDC access token
obtained via `this.ipc.maybeGetToken()` — an IPC call to the Electron main process in
standalone Compass, or a web session token in Atlas Data Explorer.

**CHAT model:** Uses `globalThis.fetch` directly (`compass-assistant-provider.tsx:824`). No
explicit `Authorization` header is added by the Compass client. The Knowledge Server endpoint
authenticates via the runtime session context (browser session cookie in Atlas Data Explorer;
in standalone Compass the Electron session provides the authentication context).

---

## 6. Data Retention — `store: false` and `sensitive_storage`

### `store: false`

Both models set `store: false` in `providerOptions.openai`:

| Model | File | Line |
|---|---|---|
| SLIM (NLQ) | `gen-ai-response.ts` | 23 |
| SLIM (mock data) | `atlas-ai-service.ts` | 628 |
| CHAT | `docs-provider-transport.ts` | 125 |

For the **CHAT model**, `store: false` is also a client-side SDK workaround (internal ticket
EAI-1506): when `store: true` is used, the AI SDK compresses prior assistant messages into
`{ type: 'item_reference', id: itemId }` references to reduce payload size, but the MongoDB
Knowledge Server backend does not return a valid `itemId`, causing message loss. `store: false`
prevents this compression. Independently, the backend itself does not forward `store: true` to
OpenAI, so no conversation data is retained at the OpenAI layer regardless of this client flag.

### `sensitive_storage` metadata

Sent alongside every LLM call in `metadata.sensitive_storage`:

| Value | Meaning | Condition |
|---|---|---|
| `'false'` | FLE (Field-Level Encryption) active — backend should not attempt to store prompt | Any active connection has `fleOptions` set |
| `'true'` | No FLE — normal storage policy applies | No active connection uses FLE |

The **name is counter-intuitive**: `'true'` means "storage is permitted" (not "data is sensitive").
The derivation is `enableStorage = !isFLE` → `sensitiveStorage = enableStorage ? 'true' : 'false'`.

- NLQ path: `ai-query-reducer.ts:222, 240` and `pipeline-ai.ts:290, 310`
- CHAT path: `compass-assistant-provider.tsx:418–420` and `docs-provider-transport.ts:70–71, 130`

---

## 7. Telemetry (Analytics / Segment)

**The user's natural language query text is never sent to Segment/analytics.**

The following are sent for NLQ events:

| Field | Type | Value |
|---|---|---|
| `user_input_length` | integer | Character count of the NL prompt (not the text) |
| `has_sample_documents` | boolean | Whether sample docs were included in the prompt |
| `request_id` | UUID string | Correlates client events with backend logs |
| `query_shape` | string[] | Operator/field names only (e.g. `['$match','$group']`) — no values |

Sources: `ai-query-reducer.ts:183`, `pipeline-ai.ts:260`,
`compass-telemetry/src/telemetry-events.ts:1515, 1665`.

For explicit user feedback events (`Assistant Feedback Submitted`), the user-typed feedback text
is included — but only when the user deliberately submits feedback through the feedback UI.

---

## 8. Enterprise / Org-level Controls

| Control | Mechanism | Who controls it |
|---|---|---|
| Disable AI for all org users | `enableGenAIFeaturesAtlasOrg = false` | Atlas org/project admin |
| Disable tool calling org-wide | `enableGenAIToolCallingAtlasProject = false` | Atlas project admin (CLI/global flag) |
| Sample document passing | `enableGenAISampleDocumentPassing` (default `false`) | End user (Settings UI) |
| Enable AI features for user | `optInGenAIFeatures` (default `false`) | End user (opt-in modal) |
| Cloud rollout gate | `cloudFeatureRolloutAccess.GEN_AI_COMPASS` | MongoDB infrastructure |

There is no `COMPASS_DISABLE_AI` environment variable for disabling AI in standalone Compass.
The only environment-level escape hatch is `COMPASS_E2E_SKIP_AI_OPT_IN=true`, which bypasses
`throwIfAINotEnabled()` in test/E2E contexts only (`atlas-ai-service.ts`).
