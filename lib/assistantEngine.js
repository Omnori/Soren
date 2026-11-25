const notion = require('./notion');
const { withRetry, markdownToBlocks } = notion;
const { fetchBlocksToMarkdown, refreshStaleWikiIfNeeded } = require('./notionScanner');
const { DEFAULT_MODELS, normalizeGeminiModel, normalizeNvidiaModel } = require('./aiConfig');
const { createActionItem, parseValidIsoDate } = require('./memberAssistant');
const { executeGroqRequest, recordActualTokens } = require('./groqRateLimiter');
const {
    getGuildConfig,
    getGuildWiki,
    getNotionItem,
    upsertNotionItem,
    deleteNotionItem,
    searchNotionItems,
    getUserMapping,
    logApiRequest,
    logAudit,
} = require('./database');

// Pending high-impact / destructive confirmations awaiting Discord button click
const pendingConfirmations = new Map();
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function prunePendingConfirmations() {
    const now = Date.now();
    for (const [id, entry] of pendingConfirmations.entries()) {
        if (now - entry.createdAt > CONFIRMATION_TTL_MS) {
            pendingConfirmations.delete(id);
        }
    }
}

function createPendingConfirmation({ guildId, userId, callerContext, toolName, args, description }) {
    prunePendingConfirmations();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingConfirmations.set(id, {
        id,
        guildId,
        userId,
        callerContext,
        toolName,
        args,
        description,
        createdAt: Date.now(),
    });
    return id;
}

function getPendingConfirmation(confirmId) {
    prunePendingConfirmations();
    return pendingConfirmations.get(confirmId) || null;
}

function deletePendingConfirmation(confirmId) {
    pendingConfirmations.delete(confirmId);
}

/**
 * Base system prompt containing Soren identity, behavioral rules, anti-hallucination policies,
 * and available tool descriptions. Invariant across all guilds.
 */
function getBaseSystemPrompt() {
    return `You are "Soren", the dedicated AI organizational assistant and single source of truth for Omnori.
Your role is to act as the coordination hub and organizational brain for the team, grounded strictly in the Omnori Central Wiki on Notion.

STRICT GROUNDING & BEHAVIORAL RULES:
1. **Never Hallucinate Facts**: If asked a question about company policies, products, team members, or tasks, you MUST use the appropriate tools (\`search_workspace\`, \`read_page\`, \`list_user_tasks\`, \`read_org_info\`, \`read_member_notes\`, etc.) to look up the actual content. Do not guess or assume.
2. **Always Reference Sources**: When answering based on workspace documents, always mention the document title or domain (e.g. "[Central Wiki: Agency Services & Operations]") and include its exact Notion URL so users can navigate to it.
3. **Write/Update with Care**: You can create/update pages and tasks when requested. Ensure the titles and body text are clean, well-formatted Markdown, and clearly structured.
4. **Task Assignment**: When creating tasks/action items, link them strictly to the actual individual assignee (Abhi, Himanshu, or specific designated owners). Never use collective terms.
5. **Tone & Brevity**: Be extremely crisp, concise, and minimal. Avoid overwhelming the user with massive walls of text. State the direct answer or main takeaway immediately in 1-3 short sentences. Use bullet points for lists, and keep explanations highly focused. Do not use verbose preambles or post-summaries.
6. **Caller Identity & Personal Queries**: The organizational context and user query block specify the identity of the current team member speaking to you. When the user asks about "my tasks", "my projects", "my action items", "my notes", or "what am I working on", they are referring to THEMSELVES. NEVER ask the user who they are or which team member they are (e.g. NEVER ask "Are you Abhi or Himanshu?"). Immediately use their identified name to query \`list_user_tasks\` or \`read_member_notes\` without hesitation.

AVAILABLE TOOLS & HOW TO USE THEM:
- \`search_workspace(query)\`: Searches both local database index and Notion workspace for keywords.
- \`read_page(page_id)\`: Reads full Markdown body and properties of a specific page/item.
- \`create_page(parent_page_id, title, content_markdown)\`: Creates a new child page.
- \`update_page(page_id, title, content_markdown)\`: Updates/overwrites the title and content of an existing page.
- \`delete_page(page_id)\`: Archives/deletes a page.
- \`create_user_task(task_title, assignee_name, due_date, status)\`: Creates a task/action item in the team's database.
- \`read_notice_board()\`: Reads the current live Sprint Focus & Notice Board announcements directly from the Central Wiki.
- \`update_notice_board(text, action, category)\`: Directly edits, appends to, or updates announcements on the Central Wiki Sprint Focus & Notice Board callout banner.
- \`list_user_tasks(assignee, status, limit)\`: Lists action items and tasks from Action Items DB (pass assignee: "all" for whole team).
- \`update_user_task(task_id, task_title, status, assignee, due_date, title)\`: Updates status, assignee, title, or due date of an existing task (accepts either task_id UUID or fuzzy task_title).
- \`delete_user_task(task_id, task_title)\`: Archives/deletes an existing task from Action Items DB.
- \`get_recent_meetings(limit)\`: Retrieves recent team meeting summaries and sync notes.
- \`read_org_info(section)\`: Reads dynamic company facts, decisions, and living memory from Org Info.
- \`update_org_info(section, content, action)\`: Records or updates live company facts, client updates, or policies in Org Info.
- \`read_member_notes(member_name)\`: Reads personal meeting notes and individual action items for a team member.
- \`append_member_note(note, member_name)\`: Appends a personal note to a team member's Notion page.`;
}

/**
 * Resolves the calling member's identity from Discord member/user object, database mappings,
 * and canonical Omnori team co-founders.
 */
function resolveCallerIdentity(guildId, userId, options = {}) {
    const member = options.targetMember || null;
    const effectiveUserId = userId || member?.id || options.userId || null;

    let dbMapping = null;
    if (guildId && effectiveUserId) {
        try {
            dbMapping = getUserMapping(guildId, effectiveUserId);
        } catch {
            dbMapping = null;
        }
    }

    const discordUsername = member?.user?.username || member?.username || '';
    const discordDisplayName = member?.displayName || member?.globalName || member?.user?.globalName || member?.user?.displayName || discordUsername || '';
    const combined = `${discordDisplayName} ${discordUsername}`.trim().toLowerCase();

    let resolvedName = '';
    let roleDescription = 'Team Member';
    let notionAssignee = '';

    if (dbMapping?.notion_user_name) {
        resolvedName = dbMapping.discord_display_name || dbMapping.notion_user_name;
        notionAssignee = dbMapping.notion_user_name;
        roleDescription = 'Team Member (Mapped in Workspace)';
    }

    if (!resolvedName) {
        if (combined.includes('abhi') || combined.includes('abhyudaya')) {
            resolvedName = 'Abhi';
            roleDescription = 'Co-Founder & Executive Lead';
            notionAssignee = 'Abhi';
        } else if (combined.includes('himanshu') || combined.includes('yadav')) {
            resolvedName = 'Himanshu';
            roleDescription = 'Co-Founder & Executive Lead';
            notionAssignee = 'Himanshu';
        } else if (discordDisplayName) {
            resolvedName = discordDisplayName;
            notionAssignee = discordDisplayName;
        } else if (discordUsername) {
            resolvedName = discordUsername;
            notionAssignee = discordUsername;
        } else {
            resolvedName = 'Team Member';
            notionAssignee = '';
        }
    }

    return {
        userId: effectiveUserId,
        username: discordUsername,
        displayName: discordDisplayName || resolvedName,
        resolvedName,
        roleDescription,
        notionAssignee: notionAssignee || resolvedName,
        hasMapping: !!dbMapping,
    };
}

/**
 * Organizational context block containing Omnori core facts, 6 Hubs architecture,
 * workspace Table of Contents (TOC), and active member focus if applicable.
 */
function getOrgContextBlock(guildId, options = {}) {
    const wiki = getGuildWiki(guildId);
    const toc = wiki?.wiki_toc_markdown || '_No Central Wiki mapped or scanned yet. Use /notion scan to build the index._';
    const caller = options.caller || resolveCallerIdentity(guildId, options.userId, options);

    const hasExplicitMember = !!(options.targetMember || caller.userId || (caller.resolvedName && caller.resolvedName !== 'Team Member'));
    const targetHint = hasExplicitMember
        ? `\n\nACTIVE MEMBER FOCUS & CALLER IDENTITY:
- **Active Team Member Speaking**: **${caller.resolvedName}** (${caller.roleDescription})
- **Discord Handle**: @${caller.username || caller.displayName} (Display: "${caller.displayName}", ID: ${caller.userId || 'Unknown'})
- **Notion Assignee Filter**: "${caller.notionAssignee}"
- **CRITICAL DIRECTIVE (DO NOT ASK WHO THEY ARE)**:
  - The person asking you this question IS **${caller.resolvedName}**.
  - When the user asks "what are my tasks", "my action items", "my notes", "what should I do", or "what am I working on", they are referring to THEMSELVES (**${caller.resolvedName}**).
  - NEVER ASK THE USER: "Who are you?", "Are you Abhi or Himanshu?", or "What is your name?". You already know their identity.
  - You MUST immediately execute \`list_user_tasks(assignee: "${caller.notionAssignee}")\` or \`read_member_notes(member_name: "${caller.notionAssignee}")\` using their resolved name without asking for clarification.`
        : '';

    return `ORGANIZATIONAL CONTEXT (OMNORI):
- **Current UTC Time**: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
- **Core Leadership**: Co-founded by Abhi (Abhyudaya) and Himanshu Yadav.
- **North Star Metric**: Validate & scale users/clients → reinvest cashflow into proprietary tech.
- **Core Corporate Policy**: Never dilute more than 5% of the company under any circumstances.
- **Business Model**: Omnori operates a hybrid model: high-touch client agency services alongside high-upside proprietary technology products.
- **Central Wiki Architecture (6 Core Hubs)**:
  1. Hub — Company:
     - Purpose: Who we are, why we exist, how we operate.
     - Sub-Pages: Org Info, Company Philosophy & Culture, Executive Leadership & Co-Founders.
     - Core Tenets: 15-Minute CRM logging rule, 2-retainer active client cap, financial separation, open-source and self-hosted tooling first.
  2. Hub — People & Team Ops:
     - Purpose: Who's doing what, when we meet, what's in flight.
     - Sub-Pages & Databases: Members DB, Meetings DB, Action Items DB, Task Manager & Active Projects.
     - Core Tenets: Strict single-owner task assignment, per-member task workspaces, recurring sprint cadences.
  3. Hub — Product & Design:
     - Purpose: How ideas become shipped products, how we look doing it.
     - Sub-Pages: Idea to Product Lifecycle (4-phase agile engine: Discovery & Validation -> Prototyping -> Internal Dogfooding -> Commercial Packaging), Products & Media Lab (Soren Bot, Nori V-Cam, camera gesture navigation, self-hosted enterprise mail platform, Thorium browser, Penpot), Design Assets & Brand Guidelines (Filmora/VSDC audiovisual pipeline, standardized wireframe skeletons).
  4. Hub — Growth & Clients:
     - Purpose: Revenue, relationships, distribution.
     - Sub-Pages: Agency Services & Operations (4-Pillar Proposal: Naming, Trademark search, Web design, SOPs; 5-step onboarding sequence; commercial mail IT services), Client Accounts & CRM (Active engagements: Real estate client, Nadis; mandatory next touchpoint dates, 30% advance deposit policy), Strategic Partnerships & Alliances (External IP attorneys for trademarks, certified accountants, creative freelancer network).
  5. Hub — Finance & Capital:
     - Purpose: Money in, money out, how we raise.
     - Sub-Pages: Term Sheet & Startup Finance (Sole Proprietorship registration, Provident Fund compliance, Google Sheets bookkeeping in Notion, startup grant/ad credits), Pitch Deck & Investor Materials (Hybrid agency + software narrative, IP safeguards, live demos and traction metrics).
     - Mandatory Policy Callout: "Core Policy: Do not dilute more than 5% of the company."
  6. Hub — Public Presence:
     - Purpose: Everything external-facing.
     - Sub-Pages: Public Website & Team Roster (Omnori agency portal, client demonstration sandboxes, Bangalore creative recruitment, Kannada outreach), Design Assets & Brand Guidelines (cross-link).

WORKSPACE TABLE OF CONTENTS & REGISTRY MAP:
"""
${toc}
"""${targetHint}`;
}

/**
 * User query block encapsulating the user question and query metadata.
 */
function getUserQueryBlock(question, options = {}) {
    if (!question) return '';
    const cleanQuestion = typeof question === 'string' ? question.trim() : String(question);
    const caller = options.caller || (options.targetMember ? resolveCallerIdentity(null, null, options) : null);
    const callerHeader = caller?.resolvedName && caller.resolvedName !== 'Team Member'
        ? `[USER QUERY from ${caller.resolvedName} (@${caller.username || caller.displayName})]\n`
        : '[USER QUERY]\n';
    return `${callerHeader}${cleanQuestion}`;
}

/**
 * Formats a message with an organizational context block and a user query block.
 */
function formatAskPrompt(question, orgContextBlock, options = {}) {
    const userQueryBlock = getUserQueryBlock(question, options);
    return `[ORGANIZATIONAL CONTEXT]\n${orgContextBlock}\n\n${userQueryBlock}`;
}

/**
 * Generates the full combined system prompt grounded in the server's Table of Contents (TOC).
 * Kept for backwards compatibility with existing callers and tests.
 */
function getSystemPrompt(guildId, options = {}) {
    return `${getBaseSystemPrompt()}\n\n${getOrgContextBlock(guildId, options)}`;
}

/**
 * Unified tool schemas in OpenAI / Groq tool format.
 */
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_workspace',
            description: 'Search the Notion wiki workspace for pages, documents, or tasks matching keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query or keywords.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_page',
            description: 'Read the full text content and metadata of a specific page, document, or task by its Notion ID.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The 32-character Notion page or block UUID.' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_page',
            description: 'Create a new child document or page under a specified parent page.',
            parameters: {
                type: 'object',
                properties: {
                    parent_page_id: { type: 'string', description: 'The parent page UUID.' },
                    title: { type: 'string', description: 'The title of the new page.' },
                    content_markdown: { type: 'string', description: 'The initial content formatted in Markdown.' },
                },
                required: ['parent_page_id', 'title', 'content_markdown'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_page',
            description: 'Update or replace the title and markdown content of an existing page.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The page UUID to update.' },
                    title: { type: 'string', description: 'The new title (optional).' },
                    content_markdown: { type: 'string', description: 'The new markdown body content (optional).' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_page',
            description: 'Archive or delete a page/document in Notion.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The page UUID to archive.' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_user_task',
            description: 'Create a task or action item in the team Action Items database.',
            parameters: {
                type: 'object',
                properties: {
                    task_title: { type: 'string', description: 'The title of the task.' },
                    assignee_name: { type: 'string', description: 'The name of the assignee (e.g., Discord or Notion name).' },
                    due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
                    status: { type: 'string', description: 'Task status like "Not started", "In progress", "Completed" (optional).' },
                },
                required: ['task_title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_notice_board',
            description: 'Read the current live Sprint Focus & Notice Board callout from the Central Wiki Hub.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_notice_board',
            description: 'Directly edit, append to, or update announcements on the Central Wiki Sprint Focus & Notice Board callout banner.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The announcement or sprint priority text to add or update.',
                    },
                    action: {
                        type: 'string',
                        enum: ['append', 'replace', 'clear'],
                        description: 'Action: "append" (default, adds a new notice item), "replace" (replaces notice items), or "clear" (clears dynamic announcements).',
                    },
                    category: {
                        type: 'string',
                        description: 'Optional category prefix (e.g. "Product Launch", "Services & Accounts", "Team Ops", "Notice").',
                    },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_user_tasks',
            description: 'List action items and tasks from the team Action Items database. Use when the user asks about open tasks, assigned workload, or what is on someone\'s plate.',
            parameters: {
                type: 'object',
                properties: {
                    assignee: {
                        type: 'string',
                        description: 'Member name or @mention to filter tasks by. Optional.',
                    },
                    status: {
                        type: 'string',
                        description: 'Filter tasks by status (e.g. "Not started", "In progress", "Done"). Optional.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of tasks to return (default: 20).',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_user_task',
            description: 'Update status, assignee, title, or due date of an existing task in Action Items database. Accepts task_id or fuzzy task_title.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: {
                        type: 'string',
                        description: 'The Notion UUID or 32-character ID of the task page (optional if task_title is given).',
                    },
                    task_title: {
                        type: 'string',
                        description: 'Title or keywords of the existing task to match if task_id is unknown.',
                    },
                    status: {
                        type: 'string',
                        description: 'New status: "Not started", "In progress", or "Done".',
                    },
                    assignee: {
                        type: 'string',
                        description: 'New assignee name or @mention.',
                    },
                    due_date: {
                        type: 'string',
                        description: 'Due date in YYYY-MM-DD format.',
                    },
                    title: {
                        type: 'string',
                        description: 'Updated task title or description.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_user_task',
            description: 'Archive or remove a task from the Action Items database by task_id or fuzzy task_title.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: {
                        type: 'string',
                        description: 'The Notion task page UUID (optional if task_title is given).',
                    },
                    task_title: {
                        type: 'string',
                        description: 'Title or keywords of the task to archive.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_recent_meetings',
            description: 'Retrieve recent team meeting summaries and sync notes. Use when the user asks about recent discussions, what was decided in meetings, or meeting history.',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'integer',
                        description: 'Number of recent meetings to retrieve (default: 5, max: 10).',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_org_info',
            description: 'Read dynamic company working memory and operational facts from the Org Info page. Use when the user asks about active clients, tech lab products, company decisions, or policies.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        description: 'Optional section to filter (e.g. "Clients & Partnerships", "Active Products & Tech Lab", "Decisions & Policies", "Sprint Focus & Priorities", "People & Roles").',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_org_info',
            description: 'Add or update a fact, decision, client update, or policy in the Org Info living memory page.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        description: 'Canonical section (e.g. "Decisions & Policies", "Clients & Partnerships", "Active Products & Tech Lab", "Sprint Focus & Priorities", "People & Roles", "Agency Services & Operations", "Capital, Finance & Corporate", "Active Projects").',
                    },
                    content: {
                        type: 'string',
                        description: 'Clear, concise factual statement to record.',
                    },
                    action: {
                        type: 'string',
                        enum: ['add', 'update'],
                        description: 'Whether to add a new bullet ("add", default) or update an existing bullet ("update").',
                    },
                },
                required: ['section', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_member_notes',
            description: 'Read personal meeting notes and individualized action items for a team member. Use when querying specific notes or personal records for a member.',
            parameters: {
                type: 'object',
                properties: {
                    member_name: {
                        type: 'string',
                        description: 'The display name or username of the member.',
                    },
                },
                required: ['member_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'append_member_note',
            description: 'Append a timestamped personal note to a team member\'s Notion page. Use when a user says "take a note for me" or "remember this".',
            parameters: {
                type: 'object',
                properties: {
                    note: {
                        type: 'string',
                        description: 'The note content to save.',
                    },
                    member_name: {
                        type: 'string',
                        description: 'Optional member name (defaults to the speaking member).',
                    },
                },
                required: ['note'],
            },
        },
    },
];

function auditToolAction(guildId, callerContext, action, details, targetMemberId = null) {
    if (!guildId || !callerContext?.userId) return;
    logAudit({
        guildId,
        userId: callerContext.userId,
        userTag: callerContext.username || callerContext.displayName || callerContext.userId,
        action,
        targetMemberId,
        details,
    });
}

function isTaskOwnedByCaller(taskItem, callerContext) {
    if (!callerContext) return true;
    if (callerContext.isAdmin) return true;
    const assignee = (taskItem?.assignee || '').toLowerCase().trim();
    if (!assignee || assignee === 'unassigned') return false;
    const candidates = [
        callerContext.notionAssignee,
        callerContext.resolvedName,
        callerContext.displayName,
        callerContext.username,
    ]
        .filter(Boolean)
        .map((c) => c.toLowerCase().trim());

    // Exact match or comma-separated multi-owner match (never substring like Dan matching Daniel)
    const assigneeTokens = assignee.split(',').map((t) => t.trim()).filter(Boolean);
    return assigneeTokens.some((tok) => candidates.includes(tok));
}

async function resolveTaskByIdOrTitle(client, actionItemsDbId, taskIdArg, taskTitleArg) {
    const cleanId = (taskIdArg || '').replace(/-/g, '').trim();
    if (/^[0-9a-fA-F]{32}$/.test(cleanId)) {
        try {
            const page = await withRetry(() => client.pages.retrieve({ page_id: cleanId }));
            const title = page.properties?.Task?.title?.[0]?.plain_text || page.properties?.Name?.title?.[0]?.plain_text || 'Task';
            const assignee = page.properties?.Assignee?.rich_text?.[0]?.plain_text || 'Unassigned';
            const status = page.properties?.Status?.status?.name || page.properties?.Status?.select?.name || 'Not started';
            return { task: { id: page.id, url: page.url, task: title, assignee, status } };
        } catch {
            // Fall through to title search if ID wasn't found directly
        }
    }

    const query = (taskTitleArg || taskIdArg || '').trim();
    if (!query || !actionItemsDbId) {
        return { error: 'Please provide a valid task_id or task_title.' };
    }

    const { fetchActionItems } = require('./memberAssistant');
    const items = await fetchActionItems(client, actionItemsDbId, { limit: 50 });
    const qLower = query.toLowerCase();
    const exact = items.filter((i) => (i.task || '').toLowerCase().trim() === qLower);
    if (exact.length === 1) return { task: exact[0] };

    const partial = items.filter((i) => (i.task || '').toLowerCase().includes(qLower));
    if (partial.length === 1) return { task: partial[0] };
    if (partial.length > 1) {
        return {
            ambiguous: partial.slice(0, 5).map((t) => ({ id: t.id, task: t.task, assignee: t.assignee, status: t.status })),
        };
    }
    return { error: `No task found matching "${query}".` };
}

/**
 * Executes a tool called by the LLM.
 */
async function executeTool(guildId, name, args, callerContext = null) {
    const config = getGuildConfig(guildId);
    const safeArgs = (args && typeof args === 'object') ? args : {};
    const enforceRbac = Boolean(callerContext && callerContext.userId);
    const isAdmin = Boolean(callerContext?.isAdmin);
    const interactiveConfirm = Boolean(callerContext?.interactiveConfirm && !callerContext?.confirmed);

    // Special tools that do not require Notion connection
    if (name === 'get_recent_meetings') {
        try {
            const { getRecentSessions } = require('./guildConfig');
            const sessions = getRecentSessions(guildId, safeArgs.limit || 5);
            if (!sessions || sessions.length === 0) {
                return JSON.stringify({ message: 'No recorded meeting sessions found.', sessions: [] });
            }
            const formatted = sessions.map((s) => ({
                id: s.id,
                channel: s.channel_name,
                startedAt: s.started_at,
                summary: s.summary_text || 'No summary available.',
            }));
            return JSON.stringify({ count: formatted.length, sessions: formatted }, null, 2);
        } catch (err) {
            console.error('[assistantEngine] get_recent_meetings error:', err);
            return `Error retrieving recent meetings: ${err.message}`;
        }
    }

    if (!config.notionToken) {
        return 'Error: Notion token is not configured for this server. Ask an admin to set it up.';
    }

    const client = notion.getNotionClient(config.notionToken);

    try {
        switch (name) {
            case 'search_workspace': {
                const query = safeArgs.query || '';
                // 1. Local Cache search (FTS5)
                const localResults = searchNotionItems(guildId, query);

                // 2. Live Notion search
                let liveResults = [];
                try {
                    const res = await withRetry(() => client.search({
                        query,
                        page_size: 10,
                    }));
                    liveResults = res.results || [];
                } catch {
                    // Fail gracefully
                }

                // Merge results
                const mergedMap = new Map();
                for (const item of localResults) {
                    mergedMap.set(item.id, {
                        id: item.id,
                        title: item.title,
                        type: item.type,
                        url: item.url,
                        source: 'Local Cache',
                    });
                }

                for (const item of liveResults) {
                    const id = item.id.replace(/-/g, '');
                    let title = 'Untitled';
                    if (item.properties?.title?.title) {
                        title = item.properties.title.title.map((t) => t.plain_text).join('');
                    } else if (item.properties?.Name?.title) {
                        title = item.properties.Name.title.map((t) => t.plain_text).join('');
                    } else if (item.title) {
                        title = item.title.map((t) => t.plain_text).join('');
                    }

                    mergedMap.set(id, {
                        id,
                        title,
                        type: item.object || 'page',
                        url: item.url,
                        source: 'Live Notion',
                    });
                }

                const merged = Array.from(mergedMap.values()).slice(0, 10);
                if (merged.length === 0) return 'No matching items found in the workspace.';

                return JSON.stringify(merged, null, 2);
            }

            case 'read_page': {
                const rawPageId = safeArgs.page_id;
                if (!rawPageId) return 'Error: page_id is required.';
                const pageId = String(rawPageId).replace(/-/g, '');
                // Try cache first
                const cached = getNotionItem(pageId);
                let contentMarkdown = '';
                let title = cached?.title || '';
                let url = cached?.url || `https://notion.so/${pageId}`;

                try {
                    // Fetch live for fresh content
                    contentMarkdown = await fetchBlocksToMarkdown(client, pageId, 3, 0);

                    // Fetch page details for properties
                    const page = await withRetry(() => client.pages.retrieve({ page_id: pageId }));
                    url = page.url || url;
                    if (page.properties?.title?.title) {
                        title = page.properties.title.title.map((t) => t.plain_text).join('');
                    } else if (page.properties?.Name?.title) {
                        title = page.properties.Name.title.map((t) => t.plain_text).join('');
                    }

                    // Update cache
                    upsertNotionItem({
                        id: pageId,
                        guildId,
                        parentId: page.parent?.page_id || page.parent?.database_id || null,
                        databaseId: page.parent?.database_id || null,
                        type: page.object || 'page',
                        title,
                        url,
                        contentMarkdown,
                        updatedAt: Date.now(),
                    });
                } catch (err) {
                    if (cached) {
                        return JSON.stringify({
                            id: cached.id,
                            title: cached.title,
                            type: cached.type,
                            url: cached.url,
                            contentMarkdown: cached.content_markdown,
                            source: 'Cached (Offline/Error reading live)',
                        }, null, 2);
                    }
                    throw err;
                }

                return JSON.stringify({ id: pageId, title, url, contentMarkdown }, null, 2);
            }

            case 'create_page': {
                const { parent_page_id, title, content_markdown } = safeArgs;
                if (!parent_page_id || !title) return 'Error: parent_page_id and title are required.';
                const parentIdClean = String(parent_page_id).replace(/-/g, '');

                const newPage = await withRetry(() => client.pages.create({
                    parent: { page_id: parentIdClean },
                    properties: {
                        title: [{ text: { content: title } }],
                    },
                }));

                const newPageId = newPage.id.replace(/-/g, '');

                // Append content blocks
                const blocks = markdownToBlocks(content_markdown || '');
                if (blocks && blocks.length > 0) {
                    // Notion blocks list append has a limit of 100 blocks per request
                    const chunkSize = 100;
                    for (let i = 0; i < blocks.length; i += chunkSize) {
                        const chunk = blocks.slice(i, i + chunkSize);
                        await withRetry(() => client.blocks.children.append({
                            block_id: newPageId,
                            children: chunk,
                        }));
                    }
                }

                // Cache it
                upsertNotionItem({
                    id: newPageId,
                    guildId,
                    parentId: parentIdClean,
                    type: 'page',
                    title,
                    url: newPage.url,
                    contentMarkdown: content_markdown || '',
                    updatedAt: Date.now(),
                });

                auditToolAction(guildId, callerContext, 'assistant_create_page', { pageId: newPageId, title });

                return JSON.stringify({
                    success: true,
                    message: `Page "${title}" successfully created under parent ${parent_page_id}.`,
                    url: newPage.url,
                    id: newPageId,
                });
            }

            case 'update_page': {
                const { page_id, title, content_markdown } = safeArgs;
                if (!page_id) return 'Error: page_id is required.';
                const pageIdClean = String(page_id).replace(/-/g, '');

                // Retrieve page object to get details
                const page = await withRetry(() => client.pages.retrieve({ page_id: pageIdClean }));

                if (title) {
                    const titleProp = page.object === 'page' ? 'title' : 'Name';
                    await withRetry(() => client.pages.update({
                        page_id: pageIdClean,
                        properties: {
                            [titleProp]: [{ text: { content: title } }],
                        },
                    }));
                }

                if (content_markdown !== undefined) {
                    // Replace block children: first archive old blocks, then add new
                    const existingChildren = await withRetry(() => client.blocks.children.list({ block_id: pageIdClean }));
                    for (const child of (existingChildren.results || [])) {
                        await withRetry(() => client.blocks.delete({ block_id: child.id }));
                    }

                    const blocks = markdownToBlocks(content_markdown);
                    if (blocks && blocks.length > 0) {
                        const chunkSize = 100;
                        for (let i = 0; i < blocks.length; i += chunkSize) {
                            const chunk = blocks.slice(i, i + chunkSize);
                            await withRetry(() => client.blocks.children.append({
                                block_id: pageIdClean,
                                children: chunk,
                            }));
                        }
                    }
                }

                // Update cache
                const freshContent = content_markdown !== undefined ? content_markdown : (getNotionItem(pageIdClean)?.content_markdown || '');
                const freshTitle = title || getNotionItem(pageIdClean)?.title || 'Untitled';

                upsertNotionItem({
                    id: pageIdClean,
                    guildId,
                    parentId: page.parent?.page_id || page.parent?.database_id || null,
                    databaseId: page.parent?.database_id || null,
                    type: page.object || 'page',
                    title: freshTitle,
                    url: page.url,
                    contentMarkdown: freshContent,
                    updatedAt: Date.now(),
                });

                auditToolAction(guildId, callerContext, 'assistant_update_page', { pageId: pageIdClean, title: freshTitle });

                return JSON.stringify({
                    success: true,
                    message: `Page ${page_id} updated successfully.`,
                    url: page.url,
                });
            }

            case 'delete_page': {
                if (!safeArgs.page_id) return 'Error: page_id is required.';
                if (enforceRbac && !isAdmin) {
                    return '⛔ Permission Denied: Only server administrators can archive or delete Notion pages.';
                }
                const pageIdClean = String(safeArgs.page_id).replace(/-/g, '');
                if (interactiveConfirm) {
                    const cached = getNotionItem(pageIdClean);
                    const confirmId = createPendingConfirmation({
                        guildId,
                        userId: callerContext.userId,
                        callerContext: { ...callerContext, interactiveConfirm: false, confirmed: true },
                        toolName: 'delete_page',
                        args: { page_id: pageIdClean },
                        description: `Archive Notion page **${cached?.title || pageIdClean}**`,
                    });
                    return JSON.stringify({
                        requires_confirmation: true,
                        confirmId,
                        message: `Confirmation button queued to archive page "${cached?.title || pageIdClean}". Tell the user to click Confirm below.`,
                    });
                }

                await withRetry(() => client.pages.update({
                    page_id: pageIdClean,
                    archived: true,
                }));

                deleteNotionItem(pageIdClean);
                auditToolAction(guildId, callerContext, 'assistant_delete_page', { pageId: pageIdClean });

                return JSON.stringify({
                    success: true,
                    message: `Page ${safeArgs.page_id} successfully archived/deleted in Notion and local cache.`,
                });
            }

            case 'create_user_task': {
                const { task_title, assignee_name, due_date, status } = safeArgs;
                if (!task_title) return 'Error: task_title is required.';

                if (!config.actionItemsDbId) {
                    return 'Error: Action Items database is not configured. Run /notion status or /notes notionprovision to set up structural databases.';
                }

                const assignee = assignee_name || callerContext?.notionAssignee || 'Unassigned';
                const created = await createActionItem(client, config.actionItemsDbId, {
                    task: task_title,
                    assignee,
                    due: due_date || null,
                    status: status || 'Not started',
                });

                if (!created) {
                    return 'Error: Failed to create task in Notion Action Items database.';
                }

                const taskIdClean = created.id.replace(/-/g, '');

                upsertNotionItem({
                    id: taskIdClean,
                    guildId,
                    parentId: config.actionItemsDbId,
                    databaseId: config.actionItemsDbId,
                    type: 'task',
                    title: created.task,
                    status: status || 'Not started',
                    assignee,
                    dueDate: created.due || null,
                    propertiesJson: JSON.stringify({ Task: created.task, Status: status || 'Not started', Assignee: assignee, Due: created.due }),
                    contentMarkdown: '',
                    url: created.url,
                    updatedAt: Date.now(),
                });

                auditToolAction(guildId, callerContext, 'assistant_create_task', { task: created.task, assignee });

                return JSON.stringify({
                    success: true,
                    message: `Task "${created.task}" created in Action Items database.`,
                    url: created.url,
                    id: taskIdClean,
                });
            }

            case 'read_notice_board': {
                if (!config.wikiPageId) {
                    return 'Error: Central Wiki Page ID is not configured. Ask an admin to set it up.';
                }
                const { readNoticeBoard } = require('./noticeBoard');
                const nb = await readNoticeBoard(client, config.wikiPageId);
                return JSON.stringify(nb, null, 2);
            }

            case 'update_notice_board': {
                if (!config.wikiPageId) {
                    return 'Error: Central Wiki Page ID is not configured. Ask an admin to set it up.';
                }
                if (enforceRbac && !isAdmin) {
                    return '⛔ Permission Denied: Only server administrators can modify the Central Wiki Notice Board.';
                }
                const { updateNoticeBoardCallout } = require('./noticeBoard');
                const { text, action = 'append', category } = safeArgs;
                const nbAction = (action === 'append' || action === 'add') ? 'add' : action;

                if (interactiveConfirm && (nbAction === 'clear' || nbAction === 'replace' || nbAction === 'set')) {
                    const confirmId = createPendingConfirmation({
                        guildId,
                        userId: callerContext.userId,
                        callerContext: { ...callerContext, interactiveConfirm: false, confirmed: true },
                        toolName: 'update_notice_board',
                        args: { text, action: nbAction, category },
                        description: `${nbAction === 'clear' ? 'Clear' : 'Replace'} Central Wiki Notice Board`,
                    });
                    return JSON.stringify({
                        requires_confirmation: true,
                        confirmId,
                        message: `Confirmation button queued to ${nbAction} the Notice Board. Tell the user to click Confirm below.`,
                    });
                }

                const res = await updateNoticeBoardCallout(client, config.wikiPageId, {
                    action: nbAction,
                    text,
                    category,
                });
                auditToolAction(guildId, callerContext, 'assistant_update_notice_board', { action: nbAction, category, text });
                return JSON.stringify({
                    success: true,
                    message: `Notice board successfully updated on Central Wiki Hub (${res.action}).`,
                    items: res.items,
                    blockId: res.blockId,
                }, null, 2);
            }

            case 'list_user_tasks': {
                if (!config.actionItemsDbId) {
                    return 'Error: Action Items database is not configured. Ask an admin to set it up.';
                }
                const { fetchActionItems } = require('./memberAssistant');
                const rawAssignee = safeArgs.assignee;
                const wantsAll = rawAssignee && ['all', '*', 'team', 'everyone'].includes(String(rawAssignee).toLowerCase().trim());
                const targetAssignee = wantsAll ? null : (rawAssignee || callerContext?.notionAssignee || null);
                const items = await fetchActionItems(client, config.actionItemsDbId, {
                    assignee: targetAssignee,
                    limit: safeArgs.limit || 20,
                });
                let filtered = items;
                if (safeArgs.status) {
                    const s = safeArgs.status.toLowerCase();
                    filtered = items.filter((it) => (it.status || '').toLowerCase().includes(s));
                }
                if (filtered.length === 0) {
                    const assigneeMsg = targetAssignee ? ` for ${targetAssignee}` : '';
                    return JSON.stringify({ message: `No tasks found matching criteria${assigneeMsg}.`, count: 0, items: [] });
                }
                return JSON.stringify({ count: filtered.length, items: filtered }, null, 2);
            }

            case 'update_user_task': {
                const resolved = await resolveTaskByIdOrTitle(client, config.actionItemsDbId, safeArgs.task_id, safeArgs.task_title);
                if (resolved.ambiguous) {
                    return JSON.stringify({
                        error: 'Multiple tasks matched. Ask the user to clarify which one:',
                        candidates: resolved.ambiguous,
                    });
                }
                if (resolved.error || !resolved.task) {
                    return `Error: ${resolved.error || 'Task not found.'}`;
                }

                const targetTask = resolved.task;
                if (enforceRbac && !isTaskOwnedByCaller(targetTask, callerContext)) {
                    return `⛔ Permission Denied: "${targetTask.task}" is assigned to ${targetTask.assignee}. Regular members can only update tasks assigned to themselves.`;
                }

                const taskId = targetTask.id.replace(/-/g, '');
                const { updateActionItemStatus } = require('./memberAssistant');
                const propsToUpdate = {};
                if (safeArgs.status) {
                    await updateActionItemStatus(client, taskId, safeArgs.status);
                }
                if (safeArgs.title) {
                    propsToUpdate.Task = { title: [{ text: { content: safeArgs.title } }] };
                }
                if (safeArgs.assignee) {
                    propsToUpdate.Assignee = { rich_text: [{ text: { content: safeArgs.assignee } }] };
                }
                if (safeArgs.due_date) {
                    const validIsoDue = parseValidIsoDate(safeArgs.due_date);
                    if (validIsoDue) {
                        propsToUpdate.Due = { date: { start: validIsoDue } };
                    }
                }
                if (Object.keys(propsToUpdate).length > 0) {
                    await withRetry(() => client.pages.update({
                        page_id: taskId,
                        properties: propsToUpdate,
                    }));
                }

                auditToolAction(guildId, callerContext, 'assistant_update_task', {
                    taskId,
                    taskTitle: safeArgs.title || targetTask.task,
                    status: safeArgs.status || targetTask.status,
                });

                return JSON.stringify({
                    success: true,
                    message: `Task "${safeArgs.title || targetTask.task}" (${taskId}) successfully updated.`,
                    taskId,
                    url: targetTask.url,
                });
            }

            case 'delete_user_task': {
                if (!config.actionItemsDbId && !safeArgs.task_id) {
                    return 'Error: Action Items database is not configured.';
                }
                const resolved = await resolveTaskByIdOrTitle(client, config.actionItemsDbId, safeArgs.task_id, safeArgs.task_title);
                if (resolved.ambiguous) {
                    return JSON.stringify({
                        error: 'Multiple tasks matched. Ask the user to clarify which one:',
                        candidates: resolved.ambiguous,
                    });
                }
                if (resolved.error || !resolved.task) {
                    return `Error: ${resolved.error || 'Task not found.'}`;
                }

                const targetTask = resolved.task;
                if (enforceRbac && !isTaskOwnedByCaller(targetTask, callerContext)) {
                    return `⛔ Permission Denied: "${targetTask.task}" is assigned to ${targetTask.assignee}. Only admins or the assignee can remove it.`;
                }

                const taskId = targetTask.id.replace(/-/g, '');
                if (interactiveConfirm) {
                    const confirmId = createPendingConfirmation({
                        guildId,
                        userId: callerContext.userId,
                        callerContext: { ...callerContext, interactiveConfirm: false, confirmed: true },
                        toolName: 'delete_user_task',
                        args: { task_id: taskId },
                        description: `Archive task **${targetTask.task}**`,
                    });
                    return JSON.stringify({
                        requires_confirmation: true,
                        confirmId,
                        message: `Confirmation button queued to archive task "${targetTask.task}". Tell the user to click Confirm below.`,
                    });
                }

                await withRetry(() => client.pages.update({
                    page_id: taskId,
                    archived: true,
                }));
                deleteNotionItem(taskId);
                auditToolAction(guildId, callerContext, 'assistant_delete_task', { taskId, taskTitle: targetTask.task });

                return JSON.stringify({
                    success: true,
                    message: `Task "${targetTask.task}" (${taskId}) archived.`,
                    taskId,
                });
            }

            case 'get_recent_meetings': {
                const { getRecentSessions } = require('./guildConfig');
                const sessions = getRecentSessions(guildId, safeArgs.limit || 5);
                if (!sessions || sessions.length === 0) {
                    return JSON.stringify({ message: 'No recorded meeting sessions found.', sessions: [] });
                }
                const formatted = sessions.map((s) => ({
                    id: s.id,
                    channel: s.channel_name,
                    startedAt: s.started_at,
                    summary: s.summary_text || 'No summary available.',
                }));
                return JSON.stringify({ count: formatted.length, sessions: formatted }, null, 2);
            }

            case 'read_org_info': {
                if (!config.orgInfoPageId) {
                    return 'Error: Org Info page is not configured.';
                }
                const { fetchOrgInfoStructure } = require('./orgInfoSync');
                const structure = await fetchOrgInfoStructure(client, config.orgInfoPageId);
                if (!structure) return 'Error fetching Org Info page.';
                if (safeArgs.section) {
                    const sec = Object.keys(structure.sections || {}).find(
                        (k) => k.toLowerCase().includes(safeArgs.section.toLowerCase())
                    );
                    if (sec && structure.sections[sec]) {
                        const secData = structure.sections[sec];
                        const itemsText = (secData.items || []).map((it) => `• ${it.text}`).join('\n');
                        return `## ${sec}\n${itemsText || 'No items recorded in this section.'}`;
                    }
                }
                return structure.plainText || 'No content found on Org Info page.';
            }

            case 'update_org_info': {
                if (!config.orgInfoPageId) {
                    return 'Error: Org Info page is not configured.';
                }
                if (!safeArgs.content || !String(safeArgs.content).trim()) {
                    return 'Error: content is required.';
                }
                const {
                    withGuildLock,
                    fetchOrgInfoStructure,
                    normalizeSection,
                    sanitizeContent,
                    applyOrgInfoPatch,
                } = require('./orgInfoSync');
                const { setGuildNotionConfig } = require('./guildConfig');

                const canonicalSection = normalizeSection(safeArgs.section || 'Decisions & Policies');
                const cleanContent = sanitizeContent(safeArgs.content);
                const action = safeArgs.action === 'update' ? 'update' : 'add';

                const patchRes = await withGuildLock(guildId, async () => {
                    const structure = await fetchOrgInfoStructure(client, config.orgInfoPageId);
                    const res = await applyOrgInfoPatch(client, config.orgInfoPageId, structure.sections, [
                        { action, section: canonicalSection, content: cleanContent },
                    ]);
                    setGuildNotionConfig(guildId, { sectionBlockMap: res.sectionBlockMap });
                    return res;
                });

                auditToolAction(guildId, callerContext, 'assistant_update_org_info', {
                    action,
                    section: canonicalSection,
                    content: cleanContent,
                });

                const patchStatus = patchRes.patches?.[0]?.status || 'applied';
                return JSON.stringify({
                    success: patchStatus === 'applied',
                    status: patchStatus,
                    section: canonicalSection,
                    content: cleanContent,
                    reason: patchRes.patches?.[0]?.reason,
                }, null, 2);
            }

            case 'read_member_notes': {
                if (!config.membersDbId) {
                    return 'Error: Members database is not configured.';
                }
                const memberName = safeArgs.member_name || callerContext?.notionAssignee;
                if (!memberName) {
                    return 'Error: member_name is required.';
                }
                const { getOrCreateMemberPage, fetchMemberPersonalNotes } = require('./memberAssistant');
                const memberPage = await getOrCreateMemberPage(client, config.membersDbId, {
                    displayName: memberName,
                });
                if (!memberPage || !memberPage.pageId) {
                    return `Could not find personal member page for "${memberName}".`;
                }
                const notes = await fetchMemberPersonalNotes(client, memberPage.pageId);
                return JSON.stringify({
                    memberName: memberPage.name,
                    pageUrl: memberPage.url,
                    notes: notes || 'No personal notes recorded yet.',
                }, null, 2);
            }

            case 'append_member_note': {
                if (!config.membersDbId) {
                    return 'Error: Members database is not configured.';
                }
                const noteText = (safeArgs.note || '').trim();
                if (!noteText) {
                    return 'Error: note is required.';
                }
                const requestedName = (safeArgs.member_name || '').trim();
                const selfNames = [
                    callerContext?.notionAssignee,
                    callerContext?.resolvedName,
                    callerContext?.displayName,
                    callerContext?.username,
                ]
                    .filter(Boolean)
                    .map((s) => s.toLowerCase().trim());

                const isSelf = !requestedName || selfNames.includes(requestedName.toLowerCase());
                if (enforceRbac && !isAdmin && !isSelf) {
                    return `⛔ Permission Denied: Only administrators can add personal notes to ${requestedName}'s page.`;
                }

                const targetName = requestedName || callerContext?.notionAssignee || callerContext?.displayName;
                if (!targetName) {
                    return 'Error: Could not determine target member name.';
                }

                const { getOrCreateMemberPage, appendMemberPersonalNote } = require('./memberAssistant');
                const memberPage = await getOrCreateMemberPage(client, config.membersDbId, {
                    discordUserId: isSelf ? callerContext?.userId : undefined,
                    displayName: targetName,
                    username: isSelf ? callerContext?.username : targetName,
                });
                if (!memberPage?.pageId) {
                    return `Could not find or create member page for "${targetName}".`;
                }
                const ok = await appendMemberPersonalNote(client, memberPage.pageId, noteText);
                if (!ok) {
                    return `Error: Failed to append note to ${targetName}'s Notion page.`;
                }

                auditToolAction(guildId, callerContext, 'assistant_append_member_note', noteText, isSelf ? callerContext?.userId : null);

                return JSON.stringify({
                    success: true,
                    memberName: memberPage.name,
                    pageUrl: memberPage.url,
                    note: noteText,
                });
            }

            default:
                return `Error: Unknown tool "${name}"`;
        }
    } catch (err) {
        console.error(`[assistantEngine] Tool ${name} execution error:`, err);
        return `Error executing tool ${name}: ${err.message}`;
    }
}

function parseToolArgs(rawArgs, toolName) {
    if (typeof rawArgs !== 'string') {
        return rawArgs || {};
    }
    try {
        return JSON.parse(rawArgs);
    } catch (parseErr) {
        console.warn(`[assistantEngine] Failed to parse tool arguments for ${toolName}:`, parseErr.message);
        return {};
    }
}

function formatMessagesForGemini(messages) {
    return messages.map((m) => {
        if (m.role === 'system') return null;
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts = [];
        if (m.content) parts.push({ text: m.content });

        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                parts.push({
                    functionCall: {
                        name: tc.function.name,
                        args: parseToolArgs(tc.function.arguments, tc.function.name),
                    },
                });
            }
        }

        if (m.role === 'tool') {
            parts.push({
                functionResponse: {
                    name: m.name,
                    response: { result: m.content },
                },
            });
        }

        return { role, parts };
    }).filter(Boolean);
}

function formatMessagesForOpenAi(messages) {
    return messages.map((m) => {
        if (m.role === 'system') return null;
        const formatted = { role: m.role, content: m.content };
        if (m.tool_calls) formatted.tool_calls = m.tool_calls;
        if (m.tool_call_id) formatted.tool_call_id = m.tool_call_id;
        if (m.role === 'tool') {
            formatted.name = m.name;
        } else if (m.name && /^[a-zA-Z0-9_-]{1,64}$/.test(m.name)) {
            formatted.name = m.name;
        }
        return formatted;
    }).filter(Boolean);
}

function resolveAssistantProviderConfig(provider, config) {
    if (provider === 'nvidia') {
        const apiKey = config.nvidiaApiKey || process.env.NVIDIA_API_KEY;
        if (!apiKey) {
            throw new Error('NVIDIA API Key is not configured for this server or environment.');
        }
        return {
            url: 'https://integrate.api.nvidia.com/v1/chat/completions',
            apiKey,
            model: normalizeNvidiaModel(config.nvidiaModel),
            serviceName: 'nvidia_assistant',
        };
    }

    const apiKey = config.groqApiKey || process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('Groq API Key is not configured for this server.');
    }
    return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey,
        model: config.groqModel || process.env.GROQ_SUMMARY_MODEL || DEFAULT_MODELS.groq,
        serviceName: 'groq_assistant',
    };
}

function getCandidateAssistantProviders(preferredProvider, config) {
    const preferred = (preferredProvider || 'nvidia').toLowerCase().trim();
    const order = [preferred];
    for (const p of ['nvidia', 'gemini', 'groq']) {
        if (!order.includes(p)) order.push(p);
    }

    return order.filter((p) => {
        if (p === 'nvidia') return Boolean(config.nvidiaApiKey || process.env.NVIDIA_API_KEY);
        if (p === 'gemini') return Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY);
        if (p === 'groq') return Boolean(config.groqApiKey || process.env.GROQ_API_KEY);
        return false;
    });
}

async function runProviderToolLoop({
    guildId,
    config,
    provider,
    baseSystemPrompt,
    initialMessages,
    caller,
}) {
    const messages = initialMessages.map((m) => ({ ...m }));
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;
    const executedToolCalls = new Map();
    const pendingConfirms = [];
    const listedTasks = [];
    let mutatingToolExecuted = false;
    let forceSynthesis = false;

    while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        const isNearCap = loopCount >= (MAX_TOOL_LOOPS - 1);
        const shouldForceSynthesis = forceSynthesis || isNearCap;

        if (shouldForceSynthesis && messages.some((m) => m.role === 'tool')) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role !== 'user' || !lastMsg.content?.includes('SYSTEM DIRECTIVE')) {
                messages.push({
                    role: 'user',
                    content: '[SYSTEM DIRECTIVE: Synthesize your final grounded response now using the information gathered above. Do not attempt any further tool calls.]',
                });
            }
        }

        let turnText;
        let turnToolCalls;

        if (provider === 'gemini' && (config.geminiApiKey || process.env.GEMINI_API_KEY)) {
            const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
            const model = normalizeGeminiModel(config.geminiModel);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

            const payload = {
                contents: formatMessagesForGemini(messages),
                systemInstruction: { parts: [{ text: baseSystemPrompt }] },
            };
            if (!shouldForceSynthesis) {
                payload.tools = [{
                    functionDeclarations: TOOL_DEFINITIONS.map((td) => ({
                        name: td.function.name,
                        description: td.function.description,
                        parameters: td.function.parameters,
                    })),
                }];
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(60000),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gemini API Tool-Loop Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            logApiRequest({
                guildId,
                service: 'gemini_assistant',
                model,
                status: 'success',
                tokensUsed: data.usageMetadata?.totalTokenCount || 0,
            });

            const modelParts = data.candidates?.[0]?.content?.parts || [];
            turnText = modelParts.find((p) => p.text)?.text || '';
            turnToolCalls = modelParts.filter((p) => p.functionCall).map((p) => ({
                id: `call_${Math.random().toString(36).substring(2, 9)}`,
                type: 'function',
                function: {
                    name: p.functionCall.name,
                    arguments: JSON.stringify(p.functionCall.args || {}),
                },
            }));
        } else {
            const providerCfg = resolveAssistantProviderConfig(provider, config);
            const res = await callOpenAiCompatibleTurn({
                ...providerCfg,
                guildId,
                baseSystemPrompt,
                messages,
                shouldForceSynthesis,
            });
            turnText = res.text;
            turnToolCalls = res.toolCalls;
        }

        if (turnToolCalls.length > 0 && !shouldForceSynthesis) {
            messages.push({
                role: 'assistant',
                content: turnText || null,
                tool_calls: turnToolCalls,
            });

            let duplicateCount = 0;
            for (const tc of turnToolCalls) {
                const args = parseToolArgs(tc.function.arguments, tc.function.name);
                const callKey = `${tc.function.name}:${JSON.stringify(args)}`;
                let result;
                if (executedToolCalls.has(callKey)) {
                    duplicateCount++;
                    result = `[Notice: You have already executed "${tc.function.name}" with identical parameters earlier. The result was: ${executedToolCalls.get(callKey)}. Do not repeat this call; formulate your final grounded response now based on the information already retrieved.]`;
                } else {
                    if (['create_page', 'update_page', 'delete_page', 'create_user_task', 'update_user_task', 'delete_user_task', 'update_notice_board', 'update_org_info', 'append_member_note'].includes(tc.function.name)) {
                        mutatingToolExecuted = true;
                    }
                    result = await executeTool(guildId, tc.function.name, args, caller);
                    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '');
                    executedToolCalls.set(callKey, resultStr);

                    // Track confirmation prompts or open tasks for interactive Discord buttons
                    try {
                        const parsed = JSON.parse(resultStr);
                        if (parsed?.requires_confirmation && parsed?.confirmId) {
                            const pending = getPendingConfirmation(parsed.confirmId);
                            if (pending) pendingConfirms.push(pending);
                        }
                        if (tc.function.name === 'list_user_tasks' && Array.isArray(parsed?.items)) {
                            for (const it of parsed.items) {
                                if (it.id && (it.status || '').toLowerCase() !== 'done') {
                                    listedTasks.push(it);
                                }
                            }
                        }
                    } catch {
                        // Non-JSON tool output
                    }
                }

                messages.push({
                    role: 'tool',
                    name: tc.function.name,
                    tool_call_id: tc.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
                });
            }

            if (duplicateCount === turnToolCalls.length) {
                forceSynthesis = true;
            }
        } else if (turnText && turnText.trim().length > 0) {
            return {
                answer: turnText.trim(),
                pendingConfirmations: pendingConfirms,
                quickTasks: listedTasks.slice(0, 3),
                provider,
                mutatingToolExecuted,
            };
        }
    }

    // Loop finished without returning text. Perform graceful fallback:
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].content && messages[i].content.trim().length > 0) {
            return {
                answer: messages[i].content.trim(),
                pendingConfirmations: pendingConfirms,
                quickTasks: listedTasks.slice(0, 3),
                provider,
                mutatingToolExecuted,
            };
        }
    }

    let fallbackAnswer = null;
    try {
        fallbackAnswer = await performDirectSynthesis({
            provider,
            config,
            baseSystemPrompt,
            messages,
            guildId,
        });
    } catch (fallbackErr) {
        console.warn('[assistantEngine] Direct synthesis fallback error:', fallbackErr.message);
    }

    if (fallbackAnswer && fallbackAnswer.trim().length > 0) {
        return {
            answer: fallbackAnswer.trim(),
            pendingConfirmations: pendingConfirms,
            quickTasks: listedTasks.slice(0, 3),
            provider,
            mutatingToolExecuted,
        };
    }

    const gatheredToolResults = messages
        .filter((m) => m.role === 'tool' && m.content)
        .map((m) => {
            const snippet = typeof m.content === 'string' ? m.content.slice(0, 300) : '';
            return `• **${m.name}**: ${snippet}`;
        })
        .join('\n');

    if (gatheredToolResults) {
        return {
            answer: `I queried the workspace tools for information, but reached the iteration limit before finalizing the summary. Here are the findings retrieved:\n\n${gatheredToolResults}\n\nPlease ask a more specific question if you need further details.`,
            pendingConfirmations: pendingConfirms,
            quickTasks: listedTasks.slice(0, 3),
            provider,
            mutatingToolExecuted,
        };
    }

    return {
        answer: 'I was unable to complete the request within the iteration limit. Please try rephrasing your question or checking your workspace configuration.',
        pendingConfirmations: pendingConfirms,
        quickTasks: listedTasks.slice(0, 3),
        provider,
        mutatingToolExecuted,
    };
}

/**
 * Handles multi-turn tool loops with Gemini / NVIDIA / Groq and returns structured metadata
 * (answer + optional confirmation/quick-task buttons).
 */
async function runGroundedAssistantWithMeta(guildId, userId, messageHistory, options = {}) {
    const config = getGuildConfig(guildId);
    const preferredProvider = options.provider || options.providerOverride || config.summaryProvider || process.env.SUMMARY_PROVIDER || 'nvidia';

    // Non-blocking background refresh if local Notion index is stale
    if (options.autoRefreshWiki !== false) {
        try {
            refreshStaleWikiIfNeeded(guildId);
        } catch {
            // Non-fatal
        }
    }

    const optionsWithUser = {
        ...options,
        userId: options.userId || userId,
    };
    const caller = resolveCallerIdentity(guildId, userId, optionsWithUser);
    caller.isAdmin = Boolean(options.isAdmin);
    caller.interactiveConfirm = Boolean(options.interactiveConfirm);
    optionsWithUser.caller = caller;

    const baseSystemPrompt = getBaseSystemPrompt();
    const orgContextBlock = getOrgContextBlock(guildId, optionsWithUser);

    // Format message history with org context block and user query block
    const historyArray = Array.isArray(messageHistory) ? messageHistory : [{ role: 'user', content: String(messageHistory || '') }];
    const lastUserIdx = historyArray.map((m) => m.role).lastIndexOf('user');

    const formattedHistory = historyArray.map((m, idx) => {
        if (m.role === 'user') {
            const content = m.content || '';
            if (content.includes('[ORGANIZATIONAL CONTEXT]')) {
                return { ...m };
            }
            if (idx === lastUserIdx || historyArray.length === 1) {
                return {
                    ...m,
                    content: formatAskPrompt(content, orgContextBlock, optionsWithUser),
                };
            }
        }
        return { ...m };
    });

    const initialMessages = [
        { role: 'system', content: baseSystemPrompt },
        ...formattedHistory,
    ];

    const candidates = getCandidateAssistantProviders(preferredProvider, config);
    if (candidates.length === 0) {
        // Let resolveAssistantProviderConfig throw the canonical missing-key error
        resolveAssistantProviderConfig(preferredProvider, config);
    }

    let lastErr = null;
    for (const candidateProvider of candidates) {
        try {
            return await runProviderToolLoop({
                guildId,
                config,
                provider: candidateProvider,
                baseSystemPrompt,
                initialMessages,
                caller,
            });
        } catch (err) {
            lastErr = err;
            console.warn(`[assistantEngine] Provider ${candidateProvider} failed, trying fallback if available:`, err.message);
        }
    }

    throw lastErr || new Error('All configured AI providers failed to respond.');
}

/**
 * Handles multi-turn tool loops with Gemini / NVIDIA / Groq to answer grounded questions.
 */
async function runGroundedAssistant(guildId, userId, messageHistory, options = {}) {
    const res = await runGroundedAssistantWithMeta(guildId, userId, messageHistory, options);
    return res.answer;
}

/**
 * Executes a previously queued confirmation action after a user clicks the Confirm button.
 */
async function executePendingConfirmation(confirmId, actingUserId, actingGuildId) {
    const entry = getPendingConfirmation(confirmId);
    if (!entry) {
        return { ok: false, message: 'This confirmation prompt has expired or was already handled.' };
    }
    if (entry.guildId !== actingGuildId) {
        return { ok: false, message: '⛔ Access Denied: Cross-server confirmation is not allowed.' };
    }
    if (entry.userId !== actingUserId) {
        return { ok: false, message: '⛔ Only the user who initiated this action can confirm it.' };
    }

    deletePendingConfirmation(confirmId);
    const result = await executeTool(entry.guildId, entry.toolName, entry.args, entry.callerContext);
    return {
        ok: true,
        description: entry.description,
        result: typeof result === 'string' ? result : JSON.stringify(result),
    };
}

/**
 * Executes a single OpenAI-compatible LLM turn (NVIDIA NIM or Groq).
 */
async function callOpenAiCompatibleTurn({
    url,
    apiKey,
    model,
    serviceName,
    guildId,
    baseSystemPrompt,
    messages,
    shouldForceSynthesis,
}) {
    const bodyMessages = formatMessagesForOpenAi(messages);

    const payload = {
        model,
        messages: [
            { role: 'system', content: baseSystemPrompt },
            ...bodyMessages,
        ],
        temperature: 0.2,
    };

    if (!shouldForceSynthesis) {
        payload.tools = TOOL_DEFINITIONS;
        payload.tool_choice = 'auto';
    } else {
        payload.tools = TOOL_DEFINITIONS;
        payload.tool_choice = 'none';
    }

    const runFetch = async () => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${serviceName} Tool-Loop Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const totalTokens = data.usage?.total_tokens || 0;
        if (serviceName === 'groq_assistant') {
            recordActualTokens(apiKey, totalTokens);
        }
        logApiRequest({
            guildId,
            service: serviceName,
            model,
            status: 'success',
            tokensUsed: totalTokens,
        });

        const message = data.choices?.[0]?.message;
        const toolCalls = message?.tool_calls || [];
        const text = message?.content || (toolCalls.length === 0 ? message?.reasoning_content : '') || '';

        return { text, toolCalls, reasoning: message?.reasoning_content || null };
    };

    if (serviceName === 'groq_assistant') {
        const approxChars = JSON.stringify(payload.messages).length;
        const estimatedTokens = Math.ceil(approxChars / 4) + 500;
        return executeGroqRequest(runFetch, { apiKey, estimatedTokens, guildId });
    }

    return runFetch();
}

/**
 * Performs a single non-tool completion to synthesize an answer from accumulated context.
 */
async function performDirectSynthesis({
    provider,
    config,
    baseSystemPrompt,
    messages,
}) {
    const directive = '[SYSTEM DIRECTIVE: Synthesize your final grounded response now using the information gathered above. Do not attempt any further tool calls.]';

    if (provider === 'gemini' && (config.geminiApiKey || process.env.GEMINI_API_KEY)) {
        const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
        const model = normalizeGeminiModel(config.geminiModel);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

        const contents = formatMessagesForGemini(messages);
        contents.push({ role: 'user', parts: [{ text: directive }] });

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents,
                systemInstruction: { parts: [{ text: baseSystemPrompt }] },
            }),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) return null;
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || null;
    }

    let providerCfg;
    try {
        providerCfg = resolveAssistantProviderConfig(provider, config);
    } catch {
        return null;
    }

    const bodyMessages = formatMessagesForOpenAi(messages);
    bodyMessages.push({ role: 'user', content: directive });

    const response = await fetch(providerCfg.url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${providerCfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: providerCfg.model,
            messages: [
                { role: 'system', content: baseSystemPrompt },
                ...bodyMessages,
            ],
            temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    return message?.content || message?.reasoning_content || null;
}

module.exports = {
    runGroundedAssistant,
    runGroundedAssistantWithMeta,
    executePendingConfirmation,
    deletePendingConfirmation,
    getPendingConfirmation,
    executeTool,
    getBaseSystemPrompt,
    getOrgContextBlock,
    getUserQueryBlock,
    formatAskPrompt,
    getSystemPrompt,
    resolveCallerIdentity,
    TOOL_DEFINITIONS,
};
