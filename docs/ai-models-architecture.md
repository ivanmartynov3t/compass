# Compass AI Models — Architecture & Use Cases

This document is intended for engineers and technical specialists who are **not** familiar with the Compass codebase but want to understand:

- How Compass communicates with LLMs
- What the two model constants represent and why they exist
- What features each model drives
- The end-to-end data flows

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
| **Output type** | Free-form natural language + tool invocations | Strict XML/JSON (parsed by machine) |
| **Conversation history** | Full history sent every turn | Stateless — one prompt, one response |
| **Prompt size** | Large (system prompt + history + context) | Capped at ~250 k characters (schema + sample docs) |
| **Reasoning capability** | Yes (the `-reasoning` suffix signals this) | Not needed; speed and precision matter more |
| **Primary package** | `packages/compass-assistant` | `packages/compass-generative-ai` |

Using two models lets the team independently tune, replace, or upgrade each without affecting the other feature.

---

## Model 1: `mongodb-chat-2.1-mini-reasoning` — Conversational Assistant

### What it does

Powers the Compass AI assistant drawer — a side-panel chat that users interact with conversationally to ask general MongoDB questions, get explain-plan interpretations, understand performance insights, and (optionally) invoke database tools.

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

3. **Tool calling.** When tool calling is enabled, a `ToolsController` starts an in-memory MCP (Model Context Protocol) server backed by `mongodb-mcp-server`. The assistant can invoke tools like `run_query`, `list_collections`, etc. The LLM decides when to call tools; the human can approve or deny destructive operations before they execute.

4. **Entry points.** Three pre-built entry-point flows exist that inject a structured prompt into the chat automatically when a user clicks a UI button:
   - *Explain plan* — sends an explain-plan JSON and asks the model to interpret it
   - *Performance insights* — sends proactive insight data for deeper explanation
   - *Connection error* — sends an error object for diagnosis

5. **Authentication and routing.** `createOpenAI()` from `@ai-sdk/openai` is initialised with a placeholder `baseURL`. A custom `fetch` interceptor replaces the placeholder at call-time with `atlasService.assistantApiEndpoint()`, and authentication headers are injected by `atlasService.authenticatedFetch()`. This allows the base URL to change dynamically without recreating the model instance.

### Data flow

```
User types message
  → ensureOptInAndSend (Redux thunk)
    → buildContextPrompt()          ← current workspace / connection state
    → setToolsContext()             ← registers available MCP tools
    → chat.sendMessage()
      → DocsProviderTransport.sendMessages()
        → streamText(
            model = AI_MODEL_CHAT_VERSION,
            messages = filtered conversation history,
            tools = MCP tool set,
            providerOptions.openai.instructions = system prompt
          )
          → Atlas Knowledge Server (streaming SSE)
        → UIMessageStream
      → rendered incrementally in the side-panel
```

### System prompt (summarised)

```
You are an assistant running inside MongoDB Compass.
You should:
1. Provide instructions specific to Compass when asked about the UI.
2. Answer general MongoDB questions.
3. Always call the 'search_content' tool.
4. Use humility for complex questions; avoid encouraging destructive operations.
```

---

## Model 2: `mongodb-slim-2.1-mini` — Structured Output

This model is used for two distinct, non-conversational tasks inside `packages/compass-generative-ai/src/atlas-ai-service.ts`.

### Task A: Natural Language Query (NLQ) Generation

#### What it does

Users describe what data they want in plain English; the model produces a MongoDB `find` filter / sort / projection or an aggregation pipeline, which is then populated directly into the query bar or aggregation builder.

#### Two code paths (controlled by the `enableChatbotEndpointForGenAI` preference flag)

**Path 1 — Legacy REST endpoint** (flag off):
`getQueryOrAggregationFromUserInput()` POSTs a JSON body to Atlas REST endpoints (`/unauth/ai/api/v1/mql-query` or `/mql-aggregation`). The model is not called directly from the client; the backend resolves it internally. The response is parsed and validated with `validateAIQueryResponse` / `validateAIAggregationResponse`.

**Path 2 — Chatbot endpoint** (flag on):
`generateQueryUsingChatbot()` calls `streamText()` on `this.nlqAiModel` (SLIM). The prompt explicitly instructs the model to output XML-wrapped MQL syntax. The response stream is consumed and parsed by `parseXmlToJsonResponse()`.

#### Prompt design

Prompts are deliberately **machine-readable**. The model is told upfront:

> "Reduce prose to the minimum, your output will be parsed by a machine."

Find query output format:
```xml
<filter>{}</filter>
<project>{}</project>
<sort>{}</sort>
<skip>0</skip>
<limit>0</limit>
<aggregation>[]</aggregation>
```

Aggregation output format:
```xml
<aggregation>[{ $match: … }, { $group: … }]</aggregation>
```

#### Prompt size management

The total prompt is capped at ~250 k characters (the SLIM model's context window):
- If `schema + sampleDocuments` exceeds the limit, sample documents are trimmed to 1.
- If still too large, an `AiChatbotPromptTooLargeError` is thrown and the user sees a friendly error.

#### Data flow

```
User types NL description in query bar
  → getQueryFromUserInput() / getAggregationFromUserInput()
    → buildFindQueryPrompt() / buildAggregateQueryPrompt()
        (structured prompt: database name, collection name,
         schema snippet, sample docs, XML output instructions)
    → generateQueryUsingChatbot(nlqAiModel=SLIM)
        → streamText → Atlas Knowledge Server
        → parseXmlToJsonResponse()
        → validateAIQueryResponse / validateAIAggregationResponse
  → MQL populated into query bar / aggregation pipeline builder
```

---

### Task B: Mock Data Generation

#### What it does

Given the schema of a MongoDB collection, the model generates a set of `faker.js` field mappings. These mappings are used to insert realistic synthetic sample documents into the collection — useful for development, demos, and testing.

#### Architecture

1. `AtlasAiService.getMockDataSchema()` validates the schema and checks whether batching is needed.

2. For **small schemas**: a single call to `generateSchemaForSingleChunk()` is made.

3. For **large schemas**: `splitSchemaIntoChunks()` breaks the schema into smaller pieces, all chunks are processed concurrently via `Promise.all()`, and results are merged with `mergeChunkResponses()`.

4. Each chunk call uses `streamText()` with **forced tool calling**:
   ```ts
   toolChoice: { type: 'tool', toolName: 'mockDataSchema' }
   ```
   This guarantees the model always responds by invoking the `mockDataSchema` tool rather than producing free text.

5. The tool's input schema is a strict Zod-validated JSON structure:
   ```ts
   { fieldPath: string, fakerMethod: string, fakerArgs: [...] }
   ```

6. A detailed system prompt (`MOCK_DATA_SCHEMA_PROMPT`) guides the model: it maps MongoDB types (String, Number, Date, ObjectId, GeoJSON coordinates, etc.) to specific `faker.js v10` methods, explains how to format `fakerArgs`, and gives a worked example.

#### Data flow

```
User requests mock data generation
  → AtlasAiService.getMockDataSchema()
    → validateSchemaSize()
    → if large schema: splitSchemaIntoChunks()
    → Promise.all(chunks.map(chunk =>
        generateSchemaForSingleChunk(mockDataAiModel=SLIM)
          → streamText(
              model = AI_MODEL_SLIM_VERSION,
              messages = [{ role:'user', content: formatted schema prompt }],
              tools = { mockDataSchema: mockDataTool },
              toolChoice = { type:'tool', toolName:'mockDataSchema' },
              providerOptions.openai.instructions = MOCK_DATA_SCHEMA_PROMPT
            )
            → Atlas Knowledge Server
          → toolCalls[0].input  (validated MockDataSchemaToolOutput)
      ))
    → mergeChunkResponses()
  → Synthetic documents inserted into collection
```

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
      utils/gen-ai-prompt.ts        ← prompt builders for NLQ
      mock-data-generator/
        prompt.ts                   ← system prompt for mock data (MOCK_DATA_SCHEMA_PROMPT)
        schema-batching.ts          ← chunk/merge logic for large schemas
      tools-controller.ts           ← in-memory MCP server for tool calling

  compass-assistant/
    src/
      compass-assistant-provider.tsx  ← chat orchestration, Redux store, entry points (CHAT model)
      docs-provider-transport.ts      ← streaming transport wrapping streamText()
      prompts.ts                      ← system prompt + entry-point prompt builders
```

---

## Summary

| | CHAT model | SLIM model |
|---|---|---|
| **Identifier** | `mongodb-chat-2.1-mini-reasoning` | `mongodb-slim-2.1-mini` |
| **Feature** | AI assistant chat panel | NLQ query generation + mock data |
| **Output** | Natural language + tool calls | Strict XML / JSON tool call |
| **State** | Stateful (conversation history) | Stateless (single prompt/response) |
| **Reasoning** | Yes | No |
| **Transport** | `DocsProviderTransport` + `streamText` | Direct `streamText` / REST fallback |
| **Backend auth** | `atlasService.authenticatedFetch` | `atlasService.authenticatedFetch` |
