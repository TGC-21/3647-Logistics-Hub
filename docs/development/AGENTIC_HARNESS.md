# AGENTIC_HARNESS.md

# Partshelf Agentic Harness Roadmap

## Goals
Build a local AI orchestration layer that converts natural-language requests into safe, validated operations against Partshelf.

### Core principles
- LLM plans, backend executes.
- Never allow arbitrary SQL generation.
- Never expose internal helper functions directly.
- All actions flow through a service layer.
- Read operations may execute immediately; destructive writes require confirmation.
- Every tool invocation is logged.

## High-level architecture

User
→ Chat UI
→ Agent Harness API
→ Prompt Builder
→ Local LLM (llama.cpp)
→ Tool Planner Loop
→ Service Layer
→ Repository Layer
→ SQL Database

## Suggested project structure

```text
/server
  /agent
    harness.js
    planner.js
    promptBuilder.js
    registry.js
    executor.js
    memory.js
    retrieval.js
    validator.js
    confirmation.js
    audit.js

  /services
  /repositories
```

## Phases

### Phase 1
- Refactor business logic into services.
- Eliminate direct SQL from routes.
- Add structured logging.

### Phase 2
Create tool registry.

Each tool contains:
- name
- description
- JSON schema
- execute()

Example tools:
- search_parts
- create_part
- update_quantity
- move_part
- delete_part
- create_purchase_order
- search_suppliers
- inventory_statistics
- describe_database

### Phase 3
Implement planner loop.

1. Receive user request.
2. Build prompt.
3. Call local LLM.
4. Parse tool call.
5. Validate parameters.
6. Execute service.
7. Return result.
8. Repeat until complete.

### Phase 4
Context retrieval.

Retrieve only relevant records before prompting.

Never place the full database into context.

### Phase 5
Conversation memory.

Maintain:
- current task
- prior tool outputs
- pending confirmations

### Phase 6
Confirmation system.

Require approval for:
- delete
- bulk edits
- inventory resets
- schema changes

### Phase 7
Audit log

Record:
- prompt
- tool
- parameters
- user
- timestamp
- result

## Prompt template

System prompt:
- You are an inventory planning assistant.
- Never invent tools.
- Use only registered tools.
- Ask for clarification if required.
- Prefer searches before updates.

## Model recommendations

RTX 3070 Ti (8 GB)

Recommended:
- Qwen3 8B Q4_K_M
- Qwen3 14B Q4_K_M (if acceptable latency)
- Gemma 3 12B quantized

Host with llama.cpp server.

## Security

- No raw SQL from model.
- Parameter validation.
- Transactions for writes.
- Rate limiting.
- Authentication.
- Tool whitelist.
- Read-only schema access.

## Future

- Vision (image-based inventory)
- Voice interface
- Supplier APIs
- BOM reasoning
- Predictive purchasing
- Multi-agent architecture

## Milestone checklist

- [ ] Service layer complete
- [ ] Tool registry
- [ ] Prompt builder
- [ ] Planner loop
- [ ] Retrieval
- [ ] Validation
- [ ] Confirmation
- [ ] Audit logging
- [ ] Chat UI
- [ ] Local model integration
- [ ] Benchmarking
- [ ] Production hardening
