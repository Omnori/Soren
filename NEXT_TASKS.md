# Soren Tool Expansion & Autonomous Architecture — Next Tasks

## Executive Summary
Unify Soren into **One Brain, All Entrances** where all conversational queries (`@Soren`, `/ask`, and `/notes ask`) route through the Autonomous Agent Engine (`lib/assistantEngine.js`) powered by an expanded 42-tool suite across 7 domains with thread memory, policy guardrails, and audit logging.

---

## 1. The Core Fix: One Brain, All Entrances

### The Problem
Currently, Soren has 3 entry points, but only 2 support autonomous tool calling:
- `@Soren` mentions: Runs `assistantEngine.js` with tool calling.
- `/ask`: Runs `assistantEngine.js` with tool calling.
- `/notes ask`: Runs `memberAssistant.js` with **static string injection** (no tools, dead-end fork).

### Architecture Transition
```
[BEFORE: Fragmented]
@Soren       ──┐
/ask         ──┼──► AssistantEngine (tools) ──► Notion + SQLite
/notes ask   ──┴──► memberAssistant (NO tools, static inject) ──► Dead End

[AFTER: Unified]
@Soren       ──┐
/ask         ──┼──► AssistantEngine (tools, thread memory) ──► Notion + SQLite
/notes ask   ──┘        │
                        └─ Pre-seeds context: user's notes + last 3 meetings
                           (as tool results, not injected strings)
```

### Architectural Rule
Every entry point passes `{ user_id, channel_id, thread_id, entry_point }` into `assistantEngine.js`. The engine decides everything. `/notes ask` simply adds a hint to prefer member-scoped tools — it does not bypass tool calling.

---

## 2. Recommended Tool Expansion — 7 Domains (42 Tools Total)

### 🗂️ Domain 1 — Task Lifecycle (Highest ROI)
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `update_user_task` | `(task_id, status?, assignee?, due_date?, title?, priority?)` | Update any field on an existing task in Action Items DB. |
| `list_user_tasks` | `(assignee?, status?, due_date?, limit=20)` | Query and filter tasks (e.g. "What tasks are assigned to me?"). |
| `delete_user_task` | `(task_id)` | Archive or close a task. |
| `bulk_update_tasks` | `(filter, patch)` | "Mark everything for Abhi this week as done". |
| `get_task_history` | `(task_id)` | Audit trail of who changed what. |

*Why: Unlocks ~40% of the current slash-command surface area into natural conversation.*

---

### 🧠 Domain 2 — Org Info Living Memory
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `read_org_info` | `(section?)` | Pull Clients / Tech Lab / Policies / People sections on demand. |
| `update_org_info` | `(section, content, action='append'\|'replace')` | Live on-demand policy recording (e.g. "@Soren record this policy: 30% advance on all invoices"). |
| `search_org_info` | `(query)` | Semantic search inside Org Info only. |
| `get_org_info_diff` | `(since_date)` | Inspect recent updates made to Org Info. |

*Why: Enables live writes to company memory without waiting for meeting sync.*

---

### 📅 Domain 3 — Meetings & Transcripts
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `get_recent_meetings` | `(limit=5)` | Inspect the last N meeting summaries. |
| `get_meeting_by_date` | `(date)` | Pull a specific meeting sync. |
| `search_meetings` | `(query)` | "When did we decide X?". |
| `get_meeting_action_items` | `(meeting_id)` | Extract action items from a specific meeting. |
| `summarize_meeting_range` | `(from, to)` | Weekly or monthly meeting rollup. |

*Why: Eliminates the static "last 3 meetings" injection hack.*

---

### 👤 Domain 4 — Members & Personal Notes
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `get_member` | `(name_or_id)` | Lookup canonical member record. |
| `list_members` | `(role?, active?)` | Roster queries across team members. |
| `read_member_notes` | `(member_name)` | Fetch personal notes page from Notion. |
| `append_member_note` | `(member_name, note)` | "@Soren take a personal note for me: ...". |
| `update_member_record` | `(member_id, field, value)` | Role, status, or contact changes. |

---

### 💼 Domain 5 — Clients & CRM
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `get_client` | `(client_name)` | Pull CRM record. |
| `list_clients` | `(status?, owner?)` | Pipeline view across active engagements. |
| `update_client_stage` | `(client_id, stage)` | Move clients through onboarding/active pipeline. |
| `log_client_interaction` | `(client_id, note, date?)` | Append touchpoint / meeting note. |
| `get_client_deliverables` | `(client_id)` | Inspect what's owed vs delivered. |

*Why: Moves client-facing operations from rigid commands into fluid conversation.*

---

### 💰 Domain 6 — Finance & Capital (Read-Heavy, Write-Gated)
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `read_cap_table` | `()` | Current ownership + dilution math. |
| `check_dilution_policy` | `(proposed_raise)` | Enforce the **5% Core Policy** before any financial action. |
| `get_runway` | `()` | Burn rate vs cash on hand. |
| `read_term_sheet` | `(investor?)` | Term sheet lookup. |

*Why: Strict guardrail tool — Soren refuses to log or model any raise that violates the 5% cap.*

---

### 🌐 Domain 7 — Meta / System
| Tool | Signature | What it does |
| :--- | :--- | :--- |
| `link_pages` | `(from_page, to_page)` | Create Notion page relations / cross-links. |
| `move_page` | `(page_id, new_parent)` | Reorganize hub structures programmatically. |
| `create_database_view` | `(db_id, filter, sort)` | Generate filtered views on demand. |
| `query_database` | `(db_id, filter, sort, limit)` | Generic database query. |
| `batch_operations` | `(ops[])` | Execute multi-step operations atomically. |
| `audit_log` | `(since_date, actor?)` | Inspect who modified workspace resources. |

---

### 🧩 Consolidated Tool Belt Summary

| Domain | Live Now | New Tools | Total |
| :--- | :---: | :---: | :---: |
| **Notice Board** | 2 | 0 | 2 |
| **Search / Page CRUD** | 5 | 0 | 5 |
| **Tasks** | 1 | 5 | 6 |
| **Org Info** | 0 | 4 | 4 |
| **Meetings** | 0 | 5 | 5 |
| **Members** | 0 | 5 | 5 |
| **Clients / CRM** | 0 | 5 | 5 |
| **Finance & Capital** | 0 | 4 | 4 |
| **Meta / System** | 0 | 6 | 6 |
| **TOTAL** | **8** | **34** | **42** |

---

## 3. Design Rules & Guardrails Before Shipping

1. **Read vs. Write Split**: Tag every tool `read_only: true/false`. Read tools execute instantly; write tools require verification.
2. **Policy Gates**: `check_dilution_policy`, `confirm_destructive`, and `require_founder_approval` must intercept before mutations.
3. **Idempotency Keys**: Every write tool accepts an optional `idempotency_key` so network retries never double-create tasks or pages.
4. **Audit Trail**: Every tool invocation logs `{ actor, tool, args, timestamp, result }` to SQLite audit logs and Notion Audit Log.
5. **Rate Limiting**: Cap per-user Discord usage at 10 tool calls/min to prevent runaway loops in the 8-cycle engine.
6. **Structured Errors**: Tools return `{ ok: true, data }` or `{ ok: false, code, message, hint }` so the LLM can self-correct.
7. **Tool Description Discipline**: Each tool description must be $\le 2$ sentences and answer **"when should the LLM call this?"**, not just "what it does".
8. **Fail Closed on Ambiguity**: If a target cannot be uniquely resolved (e.g., two members named "Abhi"), return candidates and ask the user to disambiguate.

---

## 4. Thread Memory Architecture

### The Problem
Currently, Soren only receives the single user message per turn, forcing users to repeat context on follow-ups.

### Target Implementation
Soren inspects the last 6 messages in the Discord thread/channel, filtering bot noise, plus the active message.

```javascript
// lib/assistantEngine.js
async function buildContext(message) {
    const history = await fetchThreadHistory(
        message.channel.id,
        { limit: 6, excludeBots: false, includeSoren: true }
    );

    return {
        system: SYSTEM_PROMPT,
        workspace_toc: await getWorkspaceTOC(),
        tools: REGISTERED_TOOLS,
        messages: [
            ...history.map((m) => ({
                role: m.author.bot ? 'assistant' : 'user',
                content: m.content,
                name: m.author.username,
            })),
            { role: 'user', content: message.content, name: message.author.username },
        ],
    };
}
```

### Memory Guardrails
- Cap history at 6 messages or 2,000 tokens (whichever hits first).
- Drop messages older than 30 minutes (prevent stale context leakage).
- Always attach `author.username` so Soren differentiates participants.
- Wrap user-generated content in `<user_content>...</user_content>` to prevent prompt injection.

---

## 5. The 3 Real User Flows Post-Upgrade

### Flow A — Personal Task Query
> **User**: *"@Soren what are my assigned action items?"*  
> **Tool Call**: `list_user_tasks(assignee="@Himanshu", status="open")` $\rightarrow$ returns 4 tasks.  
> **Soren**: *"You have 4 open items: [list with due dates + Notion links]"*

### Flow B — Meeting Recall
> **User**: *"@Soren what did we decide about pricing in yesterday's call?"*  
> **Tool Call**: `get_recent_meetings(limit=3)` $\rightarrow$ identifies meeting by date timestamp.  
> **Soren**: *"In yesterday's sync (Oct 9), the team agreed on: [bullets]"*

### Flow C — Multi-Turn Conversation
> **User**: *"@Soren mark my bug fix task as done"*  
> **Soren**: *"Which one? You have 2 open bugs: 'Login timeout' and 'Avatar upload'."*  
> **User**: *"the login one"*  
> **Tool Call**: `update_user_task(task_id="...", status="Done")`  
> **Soren**: *"✅ Marked 'Login timeout' as done. Anything else?"*

---

## 6. Rollout Plan

### Sprint 1 — Close Audit Gaps
- **Week 1**:
  - [ ] Implement `list_user_tasks`, `update_user_task`, and `get_recent_meetings`.
  - [ ] Add thread history window (6 messages, 30-min TTL) to `assistantEngine.js`.
  - [ ] Unify `/notes ask` into `assistantEngine.js` with member-context hint.
- **Week 2**:
  - [ ] Implement `read_org_info` and `update_org_info`.
  - [ ] Implement `get_member`, `resolve_member`, and `append_member_note`.
  - [ ] Add audit logging to all mutating tools.

### Sprint 2 — Polish, Guardrails & Meta Operations
- [ ] Add evals for tool calling (10 canned test scenarios $\rightarrow$ expected tool call sequence).
- [ ] Implement Client/CRM tools (`get_client`, `list_clients`, `update_client_stage`).
- [ ] Implement Finance guardrail tools (`read_cap_table`, `check_dilution_policy`).
- [ ] Implement Meta tools (`move_page`, `batch_operations`, `audit_log`).
- [ ] Add Soren feedback buttons under responses (👍 / 👎 / "wrong tool").

---

## 7. Definition of Done

1. `@Soren`, `/ask`, and `/notes ask` all route through `assistantEngine.js`.
2. `list_user_tasks`, `update_user_task`, `get_recent_meetings`, `read_org_info`, and `update_org_info` are fully operational.
3. Thread memory (6 messages, 30-min TTL) works natively in Discord channels and threads.
4. Every write tool logs to SQLite and Notion audit logs.
5. These 3 queries work end-to-end without extra clarification:
   - *"@Soren what are my open tasks?"*
   - *"@Soren what did we decide about pricing yesterday?"*
   - *"@Soren record this policy: 30% advance on all invoices."*
6. `/notes ask` no longer exists as a separate execution path — it is a wrapper around the unified engine.

---

## 8. What This Unlocks
Once Phase 4 is complete, full autonomous operations can be triggered by simple Discord instructions:
- *"@Soren restructure the wiki into 6 hubs"* $\rightarrow$ `move_page` + `batch_operations`
- *"@Soren who's blocked on what?"* $\rightarrow$ `list_user_tasks(status='blocked')`
- *"@Soren summarize this week's decisions"* $\rightarrow$ `get_recent_meetings(limit=10)` + synthesis
- *"@Soren draft a client update for Nadis"* $\rightarrow$ `get_client` + `get_client_deliverables` + LLM draft
