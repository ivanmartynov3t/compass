# Compass AI Models — Architecture & Use Cases

This document is intended for engineers and technical specialists who are **not** familiar with the Compass codebase but want to understand:

- How Compass communicates with LLMs
- What the two model constants represent and why they exist
- What features each model drives
- The end-to-end data flows
- Whether and how RAG (Retrieval-Augmented Generation) is used
- Exactly which system prompts are sent and what they constrain

---

## The Two Model Constants

Both model identifiers are defined in a single file so every caller in the monorepo (including tests and eval harnesses) always uses the same pinned version:

```ts
// packages/compass-generative-ai/src/model-version.ts

export const AI_MODEL_CHAT_VERSION = 'mongodb-chat-2.1-mini-reasoning';
export const AI_MODEL_SLIM_VERSION  = 'mongodb-slim-2.1-mini';
```

**Why pin explicit versions instead of `latest`?**

Both models are served by MongoDB's own backend (the Atlas "Knowledge Server"). If the server promoted a new model under a `latest` alias it could silently break the released desktop app. By pinning here, the team controls exactly when a model upgrade rolls out and can validate it against the bundled AI SDK libraries first.

---

## Why Two Models?

The two models serve completely different user-facing features with different performance and quality requirements:

| Concern | `mongodb-chat-2.1-mini-reasoning` (CHAT) | `mongodb-slim-2.1-mini` (SLIM) |
|---|---|---|
| **Primary feature** | Conversational AI assistant (side-panel) | Natural language query (NLQ) generation; mock data generation |
| **Interaction style** | Multi-turn, streaming, tool-calling, context-aware | Single-shot, deterministic structured output |
| **Output type** | Free-form natural language + tool invocations | Strict XML/JSON (parsed by machine) — never free-form prose |
| **Conversation history** | Full history sent every turn | Stateless — one prompt, one response; no history |
| **Prompt size** | Large (system prompt + history + context) | Capped at ~250 k characters (schema + sample docs) |
| **Reasoning capability** | Yes (the `-reasoning` suffix signals this) | Not needed; speed and precision matter more |
| **Primary package** | `packages/compass-assistant` | `packages/compass-generative-ai` |
| **`search_content` tool** | Yes — always instructed to call it | No — never used; no retrieval at all |

Using two models lets the team independently tune, replace, or upgrade each without affecting the other feature.

---

## Decision Matrix: Which Model Is Used When

The code never decides at runtime which model to pick for a given message type — the choice is hard-coded by feature boundary at construction time.

| User action | Code path | Model used |
|---|---|---|
| Types in AI assistant side-panel | `compass-assistant-provider.tsx` → `createDefaultChat()` → `DocsProviderTransport` → `streamText` | **CHAT** |
| Clicks "Explain plan" button | `buildExplainPlanPrompt()` → same chat with per-message `instructions` override | **CHAT** |
| Proactive performance insight appears | `buildProactiveInsightsPrompt()` → same chat | **CHAT** |
| Connection error diagnosis | `buildConnectionErrorPrompt()` → same chat | **CHAT** |
| Types in query bar "Generate Query" | `compass-query-bar` → `atlasAiService.getQueryFromUserInput()` → `generateQueryUsingChatbot(nlqAiModel)` | **SLIM** |
| Types in aggregation builder "Generate Pipeline" | `compass-aggregations` → `atlasAiService.getAggregationFromUserInput()` → `generateQueryUsingChatbot(nlqAiModel)` | **SLIM** |
| Opens "Generate Mock Data Script" modal | `compass-collection` → `atlasAiService.getMockDataSchema()` → `generateSchemaForSingleChunk(mockDataAiModel)` | **SLIM** |

`nlqAiModel` and `mockDataAiModel` are both `AI_MODEL_SLIM_VERSION` instances created in `AtlasAiService`'s constructor (`packages/compass-generative-ai/src/atlas-ai-service.ts`). The CHAT model is created in `createDefaultChat()` in `packages/compass-assistant/src/compass-assistant-provider.tsx`.

---

## Model 1: `mongodb-chat-2.1-mini-reasoning` — Conversational Assistant

### What it does

Powers the Compass AI assistant drawer — a side-panel chat that users interact with conversationally to ask general MongoDB questions, get explain-plan interpretations, understand performance insights, and (optionally) invoke database tools.

**CHAT is never used for query generation or mock data.** These are exclusively handled by the SLIM model.

### Key packages

- `packages/compass-assistant/src/compass-assistant-provider.tsx` — orchestration, Redux store, entry points
- `packages/compass-assistant/src/docs-provider-transport.ts` — the streaming transport layer
- `packages/compass-assistant/src/prompts.ts` — system prompt and entry-point prompt builders

### Architecture walkthrough

1. **`createDefaultChat()`** instantiates a `Chat<AssistantMessage>` object (Vercel AI SDK) backed by `DocsProviderTransport`.

2. **`DocsProviderTransport`** wraps `streamText()` from the AI SDK. Every call sends:
   - Filtered conversation history (all previous user + assistant turns, minus any internal confirmation messages)
   - A system prompt (`instructions`) defining persona, capabilities, and tool list — unless the triggering message supplies its own `instructions` override
   - Any registered MCP tools (see below)
   - Headers: `X-Request-Origin`, `X-Client-Request-Id`

3. **Tool calling.** When tool calling is enabled, a `ToolsController` starts an in-memory MCP (Model Context Protocol) server backed by `mongodb-mcp-server`. The assistant can invoke read-only database tools (`find`, `aggregate`, `count`, `list-databases`, `list-collections`, `collection-schema`, `collection-indexes`, `collection-storage-size`, `db-stats`, `explain`, `mongodb-logs`) as well as context-aware tools (`get-current-query`, `get-current-pipeline`). The LLM decides when to call tools; the user can approve or deny destructive operations before they execute. Tool calling is gated behind two feature preferences (`enableToolCalling`, `enableGenAIToolCalling`).

4. **Entry points.** Four pre-built entry-point flows exist that inject a structured prompt into the chat automatically when a user clicks a UI button. Each uses a per-message `instructions` override instead of the default system prompt:
   - *Explain plan* (`buildExplainPlanPrompt`) — sends an explain-plan JSON and asks the model to interpret it
   - *Performance insights* (`buildProactiveInsightsPrompt`) — sends proactive insight data for deeper explanation
   - *Connection error* (`buildConnectionErrorPrompt`) — sends an error object for diagnosis
   - *Context update* (`buildContextPrompt`) — injected automatically as a system message whenever workspace state changes; describes the active tab, namespace, collection metadata, and (if tool calling is on) which tools are available

5. **Authentication and routing.** `createOpenAI()` from `@ai-sdk/openai` is initialised with a placeholder `baseURL`. A custom `fetch` interceptor replaces the placeholder at call-time with `atlasService.assistantApiEndpoint()`, and authentication headers are injected by `atlasService.authenticatedFetch()`. This allows the base URL to change dynamically without recreating the model instance.

### Data flow

```
User types message
  → ensureOptInAndSend (Redux thunk)
    → buildContextPrompt()          ← current workspace / connection state (injected as system message)
    → setToolsContext()             ← registers available MCP tools
    → chat.sendMessage()
      → DocsProviderTransport.sendMessages()
        → streamText(
            model = AI_MODEL_CHAT_VERSION,
            messages = filtered conversation history,
            tools = MCP tool set (if tool calling enabled),
            providerOptions.openai.instructions = system prompt
              (default: buildConversationInstructionsPrompt
               or per-message override for entry-point flows)
          )
          → Atlas Knowledge Server (streaming SSE)
        → UIMessageStream
      → rendered incrementally in the side-panel
```

### System prompts — full citations

All prompts are defined in `packages/compass-assistant/src/prompts.ts`.

#### Default conversation system prompt (`buildConversationInstructionsPrompt`)

This is the default `instructions` string passed to every chat turn when no per-message override is present.

```
You are an assistant running in a side-panel inside ${target}.

${version ? `This is version ${version} of ${target}. The release notes can be found at https://www.mongodb.com/docs/compass/release-notes/` : ''}

<instructions>
You should:
1. Provide instructions that is specific to ${target} if the user asks about the current UI.
2. Answer general questions about MongoDB and its products. Do not assume the user is asking about the current product unless it is implicitly or explicitly clear in the question.
3. Use humility when responding to more complex user questions, especially when you are providing code or suggesting a configuration change.
   - Encourage the user to understand what they are doing before they act, e.g. by reading the official documentation or other related resources.
   - Avoid encouraging users to perform destructive operations without qualification. Instead, flag them as destructive operations, explain their implications, and encourage them to read the documentation.
4. Always call the 'search_content' tool.
5. When writing aggregations, remember that stage operators start with '$' (e.g., '$match', '$group', etc.).
</instructions>

<abilities>
You are able to:
1. Answer technical questions
</abilities>
```

Key constraints imposed:
- Must always invoke `search_content` (a backend-provided retrieval tool; see RAG section below).
- Must respond with Compass-specific UI guidance when asked about the UI.
- Must not encourage destructive operations without qualification.
- Receives the app name and version at runtime via template substitution.

#### Explain plan entry-point (`buildExplainPlanPrompt`)

When a user opens an explain plan and clicks the AI interpretation button, a message with a custom `instructions` override is injected:

```
<instructions>
You will always need to use sources. Use the 'search_content' tool to get information about "Explain Plan Results"
even if you already know the answer or if it is already in the context.
Follow the guidelines strictly.
</instructions>
<goal>
Analyze the MongoDB ${actionName} .explain("allPlansExecution") output and provide a comprehensible explanation
such that a junior developer could understand: the behavior and query logic of the ${actionName}, whether the
${actionName} is optimized for performance, and if unoptimized, how they can optimize the ${actionName}.
</goal>
<output-format>
## Summary
- **Query Logic:** [1 sentence summary of the query logic.]
- **Performance:** ["Good" | "Fair" | "Poor"]
- **Recommendations:** ["None" if no recommendations; otherwise, explicitly state recommendations]

## Details
### Query Logic / Performance Analysis / Recommendations / Follow-Up Questions
[structured sections]
</output-format>
<guidelines>
- Respond clearly, directly, formally (no emojis) and concisely, in the same language as the post.
- Do not include details about guidelines, the original pipeline, server info, git version, internal collection names.
- Follow the output-format strictly.
- Do NOT make recommendations that would meaningfully change the output.
[Atlas Search-specific anti-pattern rules when operationType === 'aggregation']
</guidelines>
```

The user-visible message sent alongside is: `"Use the 'search_content' tool to get information about 'Interpret Explain Plan Results' ... and interpret the explain plan: <explain plan JSON>"`

#### Proactive performance insight entry-points (`buildProactiveInsightsPrompt`)

Three variants exist (all use default conversation instructions, not a custom override):
- **`aggregation-executed-without-index`**: sends aggregation stages, asks for explanation of index impact and whether to create an index (with cons), instructs to use `explain` and `list-indexes` tools if available.
- **`query-executed-without-index`**: sends a query, asks for human-readable explanation of index impact, pros and cons of creating one, and how to do it in Compass.
- **`rerank-first-stage`**: explains `$rerank` best practices (must follow retrieval stage, `numDocsToRerank` tradeoffs, `path` field selection).

#### Connection error entry-point (`buildConnectionErrorPrompt`)

Sends the (password-redacted) connection string and error message. The model is asked to provide debugging instructions. No custom `instructions` override — uses the default system prompt.

#### Context system message (`buildContextPrompt`)

Injected automatically as a `system` role message on every workspace navigation. This is not a model instructions string but a message in the conversation history that gives the model situational awareness:

- Active connection name and redacted connection string
- Current tab (Documents, Aggregations, Schema, etc.) and namespace
- Collection metadata (time-series, view, clustered, FLE, Atlas Search support, Data Lake, Atlas, server version)
- With tool calling **on**: `<abilities>` block listing what the model CAN do (query DB, access schema, get current query/pipeline) and `<instructions>` for when to use those tools.
- With tool calling **off**: `<inabilities>` block listing what the model CANNOT do, plus instructions to tell the user to enable read-only tool access.

---

## Model 2: `mongodb-slim-2.1-mini` — Structured Output

This model is used for two distinct, non-conversational tasks inside `packages/compass-generative-ai/src/atlas-ai-service.ts`.

**SLIM is never used in the conversational assistant, never receives conversation history, and never calls `search_content`.** Every call is a fresh single-turn exchange with a machine-readable structured output requirement.

### Task A: Natural Language Query (NLQ) Generation

#### What it does

Users describe what data they want in plain English; the model produces a MongoDB `find` filter / sort / projection or an aggregation pipeline, which is then populated directly into the query bar or aggregation builder.

**UI entry points:**
- Query bar → "Generate Query" button → `packages/compass-query-bar/src/stores/ai-query-reducer.ts` → `atlasAiService.getQueryFromUserInput()`
- Aggregation builder → "Generate Pipeline" button → `packages/compass-aggregations/src/modules/pipeline-builder/pipeline-ai.ts` → `atlasAiService.getAggregationFromUserInput()`

#### Code path (flag `enableChatbotEndpointForGenAI` is `stage: 'released'` — always on)

The `enableChatbotEndpointForGenAI` preference flag is `stage: 'released'`, which per the preferences model means it is **always enabled and cannot be disabled from settings**. The legacy REST endpoint (Path 1 below) is therefore unreachable in production builds. It remains in the codebase only as a reference.

**Path 1 — Legacy REST endpoint** (flag off, unreachable in production):
`getQueryOrAggregationFromUserInput()` POSTs a JSON body to Atlas REST endpoints (`/unauth/ai/api/v1/mql-query` or `/mql-aggregation`). The model is not called directly from the client. The response is parsed and validated with `validateAIQueryResponse` / `validateAIAggregationResponse`.

**Path 2 — Chatbot endpoint** (always active):
`generateQueryUsingChatbot()` → `getAiQueryResponse(this.nlqAiModel, …)` in `packages/compass-generative-ai/src/utils/gen-ai-response.ts`. This calls `streamText()` on `this.nlqAiModel` (SLIM). The prompt explicitly instructs the model to output XML-wrapped MQL syntax. The response stream is consumed and parsed by `parseXmlToJsonResponse()`.

#### NLQ prompt structure — full citation

Prompts are built in `packages/compass-generative-ai/src/utils/gen-ai-prompt.ts`.

The **user message** (sent as `messages[0].content`) contains:
```
Database name: "<db>"
Collection name: "<collection>"
Schema from a sample of documents from the collection:
```
<user_schema>{ field: type, ... }</user_schema>
```
Sample documents from the collection:
```
<sample_documents>[…]</sample_documents>
```
Write a query [or: Generate an aggregation] that does the following:
<user_prompt>{escaped user input}</user_prompt>
```

The **system instructions** string (`providerOptions.openai.instructions`) varies by type:

**Find query instructions** (`buildInstructionsForFindQuery`):
```
Reduce prose to the minimum, your output will be parsed by a machine.
You generate MongoDB find query arguments. Provide filter, project, sort, skip,
limit and aggregation in shell syntax, wrap each argument with XML delimiters as follows:
<filter>{}</filter>
<project>{}</project>
<sort>{}</sort>
<skip>0</skip>
<limit>0</limit>
<aggregation>[]</aggregation>
Additional instructions:
- Only use the aggregation field when the request cannot be represented with the other fields.
- Do not use the aggregation field if a find query fulfills the objective.
- If specifying latitude and longitude coordinates, list the longitude first, and then latitude.
- The current date is <runtime date>
```

**Aggregation instructions** (`buildInstructionsForAggregateQuery`):
```
Reduce prose to the minimum, your output will be parsed by a machine.
You generate MongoDB aggregation pipelines. Provide only the aggregation
pipeline contents in an array in shell syntax, wrapped with XML delimiters as follows:
<aggregation>[]</aggregation>
Additional instructions:
- If specifying latitude and longitude coordinates, list the longitude first, and then latitude.
- Only pass the contents of the aggregation, no surrounding syntax.
- Do not use database-level aggregation stages such as $documents, $changeStream,
  $changeStreamSplitLargeEvent, $currentOp, $listLocalSessions, or $queryStats.
  This aggregation runs against a collection, not a database.
- The current date is <runtime date>
```

Key constraints imposed:
- No free-form prose whatsoever (`"Reduce prose to the minimum"`).
- Output is always XML-delimited MQL — machine-parsed, not displayed to users.
- User input is XML-escaped and wrapped in `<user_prompt>` tags to prevent injection.
- Schema is wrapped in `<user_schema>` tags; sample documents in `<sample_documents>` tags.
- Current date/time is injected at call time to support date-relative queries.

#### Prompt size management

The total prompt is capped at ~250 k characters (`MAX_TOTAL_PROMPT_LENGTH` in `gen-ai-prompt.ts`), matching the SLIM model's context window:
1. If `schema + sampleDocuments` exceeds the limit, sample documents are trimmed to 1.
2. If still too large, an `AiChatbotPromptTooLargeError` is thrown and the user sees a friendly error.

#### Data flow

```
User types NL description in query bar / aggregation builder
  → atlasAiService.getQueryFromUserInput() / getAggregationFromUserInput()
      (compass-query-bar / compass-aggregations call sites)
    → buildFindQueryPrompt() / buildAggregateQueryPrompt()
        (packages/compass-generative-ai/src/utils/gen-ai-prompt.ts)
        user message: db name, collection name, schema, sample docs, user input
        instructions: XML output format + constraints
    → generateQueryUsingChatbot(this.nlqAiModel)
      → getAiQueryResponse(nlqAiModel=SLIM, message, signal)
          (packages/compass-generative-ai/src/utils/gen-ai-response.ts)
        → streamText(
            model = AI_MODEL_SLIM_VERSION,
            messages = [{ role:'user', content: user message }],
            providerOptions.openai.instructions = XML format instructions,
            headers: { 'X-Assistant-Entrypoint': 'natural-language-to-mql' }
          )
          → Atlas Knowledge Server
        → parseXmlToJsonResponse()   ← parses <filter>…</filter> etc.
        → validateAIQueryResponse / validateAIAggregationResponse
  → MQL populated into query bar / aggregation pipeline builder
```

---

### Task B: Mock Data Generation

#### What it does

Given the schema of a MongoDB collection, the model generates a set of `faker.js` field mappings. These mappings are used to generate a Node.js script that, when run, inserts realistic synthetic documents into the collection — useful for development, demos, and testing.

**Important:** Mock data generation requires an **Atlas connection** (`atlasMetadata` must be present). It is not available for standalone MongoDB deployments.

#### UI entry points

The "Generate Mock Data Script" flow is accessible from the **Documents tab toolbar** via the "Add Data" button menu in `packages/compass-crud/src/components/add-data-menu.tsx`.

The menu item "Generate mock data script" is shown only when all of the following conditions are met (enforced in `packages/compass-collection/src/components/collection-tab.tsx`):
- The connection has `atlasMetadata` (Atlas-only feature)
- The collection is not read-only (not a view)
- The collection is not a time-series collection
- The schema has been analyzed (`hasSchemaAnalysisData`)
- The schema nesting depth does not exceed `MAX_COLLECTION_NESTING_DEPTH`
- The user is assigned to the mock data generator experiment (`ExperimentTestNames.mockDataGenerator`)

Clicking the menu item emits `open-mock-data-generator-modal` on the local app registry, which opens the `MockDataGeneratorModal` in `packages/compass-collection/src/components/mock-data-generator-modal/`.

#### Modal flow (three steps)

1. **Schema Confirmation** — Shows the detected schema fields; user can review before proceeding.
2. **Preview and Doc Count** — User picks how many synthetic documents to generate; AI mapping generation (`generateFakerMappings` thunk) is triggered when navigating to this step.
3. **Script Result** — Displays the generated Node.js/faker.js script; user can copy and run it.

The `generateFakerMappings` thunk in `packages/compass-collection/src/modules/collection-tab.ts` calls `atlasAiService.getMockDataSchema()` with the processed schema from prior schema analysis. Whether sample values are included is controlled by the `enableGenAISampleDocumentPassing` preference.

#### Architecture

1. `AtlasAiService.getMockDataSchema()` validates the schema and checks whether batching is needed.

2. For **small schemas** (≤ 30 fields): a single call to `generateSchemaForSingleChunk()` is made.

3. For **large schemas** (> 30 fields, up to 450 fields max): `splitSchemaIntoChunks()` breaks the schema into 30-field chunks, all chunks are processed concurrently via `Promise.all()`, and results are merged with `mergeChunkResponses()`.

4. Each chunk call uses `streamText()` with **forced tool calling**:
   ```ts
   toolChoice: { type: 'tool', toolName: 'mockDataSchema' }
   ```
   This guarantees the model always responds by invoking the `mockDataSchema` tool rather than producing free text. The model cannot output prose — the forced tool call is the only valid response format.

5. The tool's input schema is a strict Zod-validated JSON structure:
   ```ts
   { fieldPath: string, fakerMethod: string, fakerArgs: [...] }
   ```

6. A detailed system prompt (`MOCK_DATA_SCHEMA_PROMPT`, defined in `packages/compass-generative-ai/src/mock-data-generator/prompt.ts`) guides the model.

#### `MOCK_DATA_SCHEMA_PROMPT` — key sections

The prompt is approximately 500 lines of detailed instructions. Key sections:

**Identity and task:**
> "You are an expert programmer specializing in MongoDB schema analysis and faker.js library integration. You analyze MongoDB collection schemas (including complex nested structures) and generate accurate faker.js factory function mappings that produce realistic synthetic data."

**Critical requirements (summarised):**
- `fieldPath` must exactly match the schema field key (dot notation for nested, `[]` for arrays). No modification or shortening.
- Faker method must be a valid `faker.js ^10.4.0` method in `<module>.<method>` format.
- Extensive mapping tables from MongoDB types to faker methods (String, Number, Date, ObjectId, Boolean, Binary, GeoJSON, etc.).
- **GeoJSON coordinates**: must use `location.latitude` (range `[-90, 90]`), never `location.longitude` — because the generator calls the same method for both array slots, and longitude range `[-180, 180]` would break latitude validation.
- **Type vs name conflicts**: field's declared type is authoritative (e.g., a `Number`-typed field named `createdAt` must use `number.int`, not `date.past`).
- **Array fields**: use `helpers.arrayElement`, never `helpers.arrayElements` (generator handles the array dimension by calling the method N times).
- `fakerArgs` must always be an array; object/array arguments use `{"json": "<escaped JSON string>"}` format.
- Use `"unrecognized"` only as a last resort (no reasonable faker method exists).

**When to include arguments:**
> "Only include `fakerArgs` if they add value — prefer empty array `[]` when method defaults are sufficient"

**Validation rule compliance:** if MongoDB schema validation rules are provided, the prompt instructs the model to respect `min`/`max` constraints, regex patterns, and type enforcement.

**Worked example:** The prompt includes a complete input/output example with an automotive collection schema and the expected `fields` array, demonstrating field path preservation, enum-like pattern recognition with `helpers.arrayElement`, and numeric range derivation.

#### Data flow

```
User clicks "Generate mock data script" → "Add Data" menu → Documents tab toolbar
  → open-mock-data-generator-modal (app registry event)
    → MockDataGeneratorModal opens (packages/compass-collection/…/mock-data-generator-modal/)
      → Step 1: Schema Confirmation (user reviews fields)
      → Step 2: Preview and Doc Count
        → generateFakerMappings thunk (packages/compass-collection/src/modules/collection-tab.ts)
          → atlasAiService.getMockDataSchema(
               schema = processedSchema from prior schema analysis,
               validationRules,
               includeSampleValues (per enableGenAISampleDocumentPassing pref),
               databaseName, collectionName, signal
             )
            → if schema > 30 fields: splitSchemaIntoChunks() (30 fields/chunk, max 15 chunks)
            → Promise.all(chunks.map(chunk =>
                generateSchemaForSingleChunk(this.mockDataAiModel)
                  → streamText(
                      model = AI_MODEL_SLIM_VERSION,
                      messages = [{ role:'user', content: formatSchemaForPrompt(...) }],
                      tools = { mockDataSchema: mockDataTool },
                      toolChoice = { type:'tool', toolName:'mockDataSchema' },
                      providerOptions.openai.instructions = MOCK_DATA_SCHEMA_PROMPT,
                      headers: { 'X-Assistant-Entrypoint': 'mock-data-generator' }
                    )
                    → Atlas Knowledge Server
                  → toolCalls[0].input  (Zod-validated MockDataSchemaToolOutput)
              ))
            → mergeChunkResponses()   ← concatenates fields arrays from all chunks
          → transformFakerSchemaToObject() → validateFakerSchema()
      → Step 3: Script Result — generated faker.js script displayed for copy/run
```

---

## RAG in Compass: What Exists Today

### The `search_content` tool

The CHAT model's default system prompt explicitly mandates:

> "4. Always call the 'search_content' tool."

The explain-plan entry-point instructions reinforce this:

> "You will always need to use sources. Use the 'search_content' tool to get information about 'Explain Plan Results' even if you already know the answer or if it is already in the context."

**What is `search_content`?**

`search_content` is **not defined anywhere in the Compass client code**. Searching the entire monorepo for `search_content` yields only the three prompt strings in `packages/compass-assistant/src/prompts.ts`. It is not registered in `available-tools.ts`, `tools-controller.ts`, or any other client-side tool registry.

This means `search_content` is a **backend-provided tool** exposed by the Atlas Knowledge Server to the CHAT model at inference time. The client simply instructs the model to call it; the actual retrieval happens on the server side.

### Is this RAG?

From the **client code perspective**, Compass itself does not perform retrieval. The client sends a prompt and conversation history; the backend handles all retrieval.

From an **architectural perspective**, the `search_content` tool almost certainly implements retrieval-augmented generation on the backend — the model calls the tool with a query, the backend retrieves relevant documentation or content, and the results are injected into the model's context. However, the implementation of `search_content` is entirely **backend / server-side** and is not observable from the Compass client code.

**Summary of what is known from client code vs. inferred backend behaviour:**

| Claim | Evidence source |
|---|---|
| CHAT model is always instructed to call `search_content` | `prompts.ts` (client code, confirmed) |
| Explain-plan prompts explicitly require `search_content` results | `prompts.ts` (client code, confirmed) |
| `search_content` is not a client-side tool | Absence from `available-tools.ts`, `tools-controller.ts`, entire monorepo scan (client code, confirmed) |
| `search_content` performs document/content retrieval on the backend | Inferred from tool name and usage pattern; not verifiable from client code |
| Retrieved content is injected into the model's context | Inferred (standard tool-calling pattern); not verifiable from client code |
| SLIM model does NOT use `search_content` or any retrieval | `atlas-ai-service.ts`, `gen-ai-response.ts` — no tools registered for SLIM calls (client code, confirmed) |

### How does Compass answer questions about the Compass UI or MongoDB?

For **general MongoDB questions** and **Compass UI guidance**, the CHAT model answers from its parametric knowledge, supplemented by the `search_content` tool call. Because the system prompt says "Always call the 'search_content' tool", the model fetches relevant documentation via the backend tool before formulating a response. This is a RAG-like pattern, but the retrieval is performed server-side.

For **connection-specific questions** (e.g., "what collections are in my database?"), if tool calling is enabled, the CHAT model invokes client-side MCP tools (`list-collections`, `collection-schema`, etc.) to read live data from the user's MongoDB connection.

---

## How Both Models Reach the Backend

Both models are instantiated with `createOpenAI()` from `@ai-sdk/openai` using the same pattern:

```ts
createOpenAI({
  apiKey: '',
  baseURL: 'http://PLACEHOLDER_BASE_URL_TO_BE_REPLACED.invalid',
  fetch: (url, init) => {
    // Replace placeholder with the live endpoint at call-time
    const uri = String(url).replace(
      PLACEHOLDER_BASE_URL,
      atlasService.assistantApiEndpoint()
    );
    return atlasService.authenticatedFetch(uri, init);
  },
}).responses(AI_MODEL_SLIM_VERSION /* or CHAT */);
```

Key points:

- **Placeholder base URL**: `createOpenAI()` does not allow changing `baseURL` after construction. The placeholder trick lets the actual endpoint be resolved dynamically on every request — important because the Atlas endpoint can change during a session.
- **`atlasService.authenticatedFetch()`**: injects the user's Atlas authentication token on every request. Neither model is called with a direct OpenAI API key.
- **OpenAI Responses API** (`.responses(modelId)`): both models use the OpenAI Responses API format rather than the Chat Completions format. The `developer` role in messages is transparently mapped to `system` before dispatch, since the MongoDB backend does not yet support the `developer` role.

---

## Package Map

```
packages/
  compass-generative-ai/
    src/
      model-version.ts              ← single source of truth for both model IDs
      atlas-ai-service.ts           ← NLQ generation + mock data (SLIM model)
      utils/
        gen-ai-prompt.ts            ← prompt builders for NLQ (find + aggregation)
        gen-ai-response.ts          ← streamText wrapper + XML response parser
      mock-data-generator/
        prompt.ts                   ← system prompt for mock data (MOCK_DATA_SCHEMA_PROMPT)
        schema-batching.ts          ← chunk/merge logic for large schemas (30 fields/chunk)
      tools-controller.ts           ← in-memory MCP server for CHAT tool calling
      available-tools.ts            ← list of client-side MCP tool names and descriptions

  compass-assistant/
    src/
      compass-assistant-provider.tsx  ← chat orchestration, Redux store, entry points (CHAT model)
      docs-provider-transport.ts      ← streaming transport wrapping streamText()
      prompts.ts                      ← all system prompts + entry-point prompt builders

  compass-query-bar/
    src/stores/ai-query-reducer.ts    ← calls atlasAiService.getQueryFromUserInput() (SLIM)

  compass-aggregations/
    src/modules/pipeline-builder/
      pipeline-ai.ts                  ← calls atlasAiService.getAggregationFromUserInput() (SLIM)

  compass-collection/
    src/
      modules/collection-tab.ts                          ← generateFakerMappings thunk (SLIM)
      components/
        collection-tab.tsx                               ← mock data eligibility logic
        mock-data-generator-modal/                       ← 3-step modal UI
        collection-header/collection-header.tsx          ← MockDataGeneratorModal mount point

  compass-crud/
    src/components/add-data-menu.tsx  ← "Generate mock data script" menu item (Documents tab)
```

---

## Summary

| | CHAT model | SLIM model |
|---|---|---|
| **Identifier** | `mongodb-chat-2.1-mini-reasoning` | `mongodb-slim-2.1-mini` |
| **Feature** | AI assistant chat panel | NLQ query generation + mock data generation |
| **Output** | Natural language + tool calls | Strict XML (NLQ) / JSON tool call (mock data) — no prose |
| **State** | Stateful (full conversation history every turn) | Stateless (single prompt/response, no history) |
| **Reasoning** | Yes | No |
| **Transport** | `DocsProviderTransport` → `streamText` | Direct `streamText` (via `getAiQueryResponse` or `generateSchemaForSingleChunk`) |
| **Backend auth** | `atlasService.authenticatedFetch` | `atlasService.authenticatedFetch` |
| **`search_content` (RAG)** | Always instructed to call it (backend tool) | Never used |
| **Client-side tools** | MCP database tools (when tool calling enabled) | Forced `mockDataSchema` tool call only (mock data); no tools for NLQ |
| **Conversational use** | Yes — full multi-turn chat | No — each call is independent |
| **Used for query generation** | No | Yes — exclusively |
