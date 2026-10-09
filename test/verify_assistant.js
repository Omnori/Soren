const assert = require('node:assert');
const {
    upsertNotionItem,
    getNotionItem,
    deleteNotionItem,
    searchNotionItems,
    upsertGuildWiki,
    getGuildWiki,
    upsertUserMapping,
    getUserMapping,
    getUserMappingByNotionName,
    deleteUserMapping,
} = require('../lib/database');
const { scanNotionWiki } = require('../lib/notionScanner');
const { runGroundedAssistant, getSystemPrompt, getBaseSystemPrompt, getOrgContextBlock, getUserQueryBlock, formatAskPrompt } = require('../lib/assistantEngine');

async function runAssistantTests() {
    console.log('🚀 Starting Soren Assistant Verification & Integration Suite...\n');
    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(`     ${err.stack || err.message}`);
            failed++;
        }
    }

    async function asyncTest(name, fn) {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(`     ${err.stack || err.message}`);
            failed++;
        }
    }

    const testGuildId = 'test-guild-assistant-123';

    // Clean up any leftovers from previous test runs to ensure a clean state
    deleteNotionItem('page_abc123');
    deleteNotionItem('fts_1');
    deleteNotionItem('fts_2');
    deleteNotionItem('root_page');
    deleteNotionItem('child_doc');
    deleteNotionItem('task_row_1');

    // -------------------------------------------------------------
    // 1. Database Operations & FTS5 Verification
    // -------------------------------------------------------------
    console.log('--- [Area 1] Database Operations & FTS5 Indexing ---');

    test('upsertNotionItem, getNotionItem, and deleteNotionItem CRUD flow', () => {
        const itemId = 'page_abc123';
        const item = {
            id: itemId,
            guildId: testGuildId,
            parentId: 'root_xyz',
            type: 'page',
            title: 'Test Document Page',
            contentMarkdown: '# Welcome\nThis is a mock page content.',
            url: 'https://notion.so/page_abc123',
            updatedAt: Date.now(),
        };

        const success = upsertNotionItem(item);
        assert.ok(success, 'Upsert should return true');

        const retrieved = getNotionItem(itemId);
        assert.ok(retrieved, 'Should retrieve item');
        assert.strictEqual(retrieved.title, item.title);
        assert.strictEqual(retrieved.content_markdown, item.contentMarkdown);

        // Update item
        item.title = 'Updated Test Document Page';
        upsertNotionItem(item);
        const updated = getNotionItem(itemId);
        assert.strictEqual(updated.title, 'Updated Test Document Page');

        // Delete item
        const deletedSuccess = deleteNotionItem(itemId);
        assert.ok(deletedSuccess);
        const postDelete = getNotionItem(itemId);
        assert.strictEqual(postDelete, undefined, 'Item should be deleted');
    });

    test('FTS5 full-text search index correctly matches items', () => {
        const item1 = {
            id: 'fts_1',
            guildId: testGuildId,
            type: 'page',
            title: 'Onboarding Guidelines',
            contentMarkdown: 'Welcome to the team! Our PTO policy allows 20 days off per year.',
            updatedAt: Date.now(),
        };
        const item2 = {
            id: 'fts_2',
            guildId: testGuildId,
            type: 'page',
            title: 'Stripe Integration Guide',
            contentMarkdown: 'To finalize the stripe webhook, configure the secrets on AWS.',
            updatedAt: Date.now(),
        };

        upsertNotionItem(item1);
        upsertNotionItem(item2);

        // Search for PTO
        const ptoResults = searchNotionItems(testGuildId, 'PTO');
        assert.strictEqual(ptoResults.length, 1);
        assert.strictEqual(ptoResults[0].id, 'fts_1');

        // Search for stripe
        const stripeResults = searchNotionItems(testGuildId, 'stripe');
        assert.strictEqual(stripeResults.length, 1);
        assert.strictEqual(stripeResults[0].id, 'fts_2');

        // Search for team
        const teamResults = searchNotionItems(testGuildId, 'team');
        assert.strictEqual(teamResults.length, 1);
        assert.strictEqual(teamResults[0].id, 'fts_1');

        deleteNotionItem('fts_1');
        deleteNotionItem('fts_2');
    });

    test('upsertGuildWiki and getGuildWiki flow', () => {
        const rootId = 'wiki_root_999';
        const toc = '- Page 1\n- Page 2';
        const struct = [{ id: '1', title: 'Page 1' }];

        const success = upsertGuildWiki(testGuildId, rootId, toc, struct, Date.now());
        assert.ok(success);

        const wiki = getGuildWiki(testGuildId);
        assert.ok(wiki);
        assert.strictEqual(wiki.wiki_root_page_id, rootId);
        assert.strictEqual(wiki.wiki_toc_markdown, toc);
        assert.strictEqual(JSON.parse(wiki.structure_json)[0].title, 'Page 1');
    });

    test('upsertUserMapping, getUserMapping, and deleteUserMapping flow', () => {
        const discordUserId = '1122334455';
        const mapping = {
            guildId: testGuildId,
            discordUserId,
            discordDisplayName: 'John Doe',
            notionUserName: 'johndoe@notion.so',
            notionUserId: 'notion-usr-777',
        };

        const success = upsertUserMapping(
            testGuildId,
            discordUserId,
            mapping.discordDisplayName,
            mapping.notionUserName,
            mapping.notionUserId
        );
        assert.ok(success);

        const ret = getUserMapping(testGuildId, discordUserId);
        assert.ok(ret);
        assert.strictEqual(ret.discord_display_name, 'John Doe');
        assert.strictEqual(ret.notion_user_name, 'johndoe@notion.so');

        // Search by Notion name
        const matchName = getUserMappingByNotionName(testGuildId, 'johndoe@notion.so');
        assert.ok(matchName);
        assert.strictEqual(matchName.discord_user_id, discordUserId);

        deleteUserMapping(testGuildId, discordUserId);
        const postDel = getUserMapping(testGuildId, discordUserId);
        assert.strictEqual(postDel, undefined);
    });

    // -------------------------------------------------------------
    // 2. Notion Scanner Verification
    // -------------------------------------------------------------
    console.log('\n--- [Area 2] Notion Recursive Scanner ---');

    await asyncTest('scanNotionWiki correctly crawls mock structure and updates database cache', async () => {
        // Mock Notion Client
        const mockClient = {
            blocks: {
                retrieve: async ({ block_id }) => {
                    if (block_id === 'root_page') {
                        return { id: 'root_page', type: 'child_page', child_page: { title: 'Central Wiki Hub' } };
                    }
                    if (block_id === 'child_doc') {
                        return { id: 'child_doc', type: 'child_page', child_page: { title: 'Product Spec' } };
                    }
                    if (block_id === 'task_db') {
                        return { id: 'task_db', type: 'child_database', child_database: { title: 'Sprint Tasks' } };
                    }
                    throw new Error('Not found');
                },
                children: {
                    list: async ({ block_id }) => {
                        if (block_id === 'root_page') {
                            return {
                                results: [
                                    { id: 'child_doc', type: 'child_page', child_page: { title: 'Product Spec' } },
                                    { id: 'task_db', type: 'child_database', child_database: { title: 'Sprint Tasks' } },
                                ],
                                has_more: false,
                            };
                        }
                        if (block_id === 'child_doc') {
                            return {
                                results: [
                                    {
                                        id: 'text_block_1',
                                        type: 'paragraph',
                                        paragraph: { rich_text: [{ plain_text: 'Specs for Soren bot.' }] },
                                    },
                                ],
                                has_more: false,
                            };
                        }
                        return { results: [], has_more: false };
                    },
                },
            },
            databases: {
                query: async ({ database_id }) => {
                    if (database_id === 'task_db') {
                        return {
                            results: [
                                {
                                    id: 'task_row_1',
                                    url: 'https://notion.so/task_row_1',
                                    properties: {
                                        Name: { type: 'title', title: [{ plain_text: 'Fix Stripe Webhook' }] },
                                        Status: { type: 'status', status: { name: 'In progress' } },
                                    },
                                },
                            ],
                            has_more: false,
                        };
                    }
                    return { results: [], has_more: false };
                },
            },
        };

        // Temporary swap getNotionClient
        const originalGetClient = require('../lib/notion').getNotionClient;
        require('../lib/notion').getNotionClient = () => mockClient;

        try {
            const scanRes = await scanNotionWiki(testGuildId, 'mock-token', 'root_page', {
                maxDepth: 2,
                maxItems: 10,
                notionClient: mockClient,
            });
            assert.ok(scanRes.success);
            assert.ok(scanRes.itemsScannedCount >= 3);

            // Check if items are in cache
            const cachedRoot = getNotionItem('root_page');
            assert.ok(cachedRoot);
            assert.strictEqual(cachedRoot.title, 'Central Wiki Hub');

            const cachedDoc = getNotionItem('child_doc');
            assert.ok(cachedDoc);
            assert.strictEqual(cachedDoc.title, 'Product Spec');
            assert.ok(cachedDoc.content_markdown.includes('Specs for Soren bot.'));

            const cachedTask = getNotionItem('task_row_1');
            assert.ok(cachedTask);
            assert.strictEqual(cachedTask.title, 'Fix Stripe Webhook');
            assert.strictEqual(cachedTask.status, 'In progress');

            // Verify Table of Contents was generated and stored
            const wiki = getGuildWiki(testGuildId);
            assert.ok(wiki);
            assert.ok(wiki.wiki_toc_markdown.includes('Central Wiki Hub'));
            assert.ok(wiki.wiki_toc_markdown.includes('Product Spec'));
            assert.ok(wiki.wiki_toc_markdown.includes('Fix Stripe Webhook'));
        } finally {
            deleteNotionItem('root_page');
            deleteNotionItem('child_doc');
            deleteNotionItem('task_row_1');
            require('../lib/notion').getNotionClient = originalGetClient;
        }
    });

    // -------------------------------------------------------------
    // 3. Grounded Assistant Engine Prompt Builder
    // -------------------------------------------------------------
    console.log('\n--- [Area 3] Grounded Assistant Prompting ---');

    test('TOOL_DEFINITIONS includes read_notice_board and update_notice_board', () => {
        const { TOOL_DEFINITIONS } = require('../lib/assistantEngine');
        const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);
        assert.ok(toolNames.includes('read_notice_board'), 'Must register read_notice_board tool');
        assert.ok(toolNames.includes('update_notice_board'), 'Must register update_notice_board tool');
    });

    test('TOOL_DEFINITIONS includes autonomous task, meeting, org info, and notes tools', () => {
        const { TOOL_DEFINITIONS } = require('../lib/assistantEngine');
        const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);
        assert.ok(toolNames.includes('list_user_tasks'), 'Must register list_user_tasks tool');
        assert.ok(toolNames.includes('update_user_task'), 'Must register update_user_task tool');
        assert.ok(toolNames.includes('get_recent_meetings'), 'Must register get_recent_meetings tool');
        assert.ok(toolNames.includes('read_org_info'), 'Must register read_org_info tool');
        assert.ok(toolNames.includes('read_member_notes'), 'Must register read_member_notes tool');
    });

    test('getSystemPrompt correctly injects workspace Table of Contents and Notice Board tools', () => {
        const sysPrompt = getSystemPrompt(testGuildId);
        assert.ok(sysPrompt.includes('Central Wiki Hub'), 'Prompt must contain the indexed Wiki Title');
        assert.ok(sysPrompt.includes('Product Spec'), 'Prompt must contain indexed child page');
        assert.ok(sysPrompt.includes('Fix Stripe Webhook'), 'Prompt must contain cached task titles');
        assert.ok(sysPrompt.includes('read_notice_board()'), 'Prompt must mention read_notice_board tool');
        assert.ok(sysPrompt.includes('update_notice_board'), 'Prompt must mention update_notice_board tool');
        assert.ok(sysPrompt.includes('list_user_tasks'), 'Prompt must mention list_user_tasks tool');
        assert.ok(sysPrompt.includes('update_user_task'), 'Prompt must mention update_user_task tool');
        assert.ok(sysPrompt.includes('get_recent_meetings'), 'Prompt must mention get_recent_meetings tool');
        assert.ok(sysPrompt.includes('read_org_info'), 'Prompt must mention read_org_info tool');
        assert.ok(sysPrompt.includes('read_member_notes'), 'Prompt must mention read_member_notes tool');
    });

    test('getSystemPrompt correctly injects ACTIVE MEMBER FOCUS when targetMember is supplied', () => {
        const sysPrompt = getSystemPrompt(testGuildId, {
            targetMember: { id: 'user_123', displayName: 'Abhi' },
        });
        assert.ok(sysPrompt.includes('ACTIVE MEMBER FOCUS'), 'Prompt must include ACTIVE MEMBER FOCUS header');
        assert.ok(sysPrompt.includes('Abhi'), 'Prompt must mention member display name');
        assert.ok(sysPrompt.includes('user_123'), 'Prompt must mention member id');
    });

    test('getBaseSystemPrompt returns invariant base prompt without guild TOC', () => {
        const basePrompt = getBaseSystemPrompt();
        assert.ok(basePrompt.includes('You are "Soren"'), 'Must define Soren identity');
        assert.ok(basePrompt.includes('STRICT GROUNDING & BEHAVIORAL RULES'), 'Must include behavioral rules');
        assert.ok(basePrompt.includes('read_notice_board()'), 'Must include notice board tool description');
        assert.ok(basePrompt.includes('list_user_tasks'), 'Must include task list tool description');
        assert.ok(!basePrompt.includes('Central Wiki Hub'), 'Base prompt must not contain guild TOC');
        assert.ok(!basePrompt.includes('ACTIVE MEMBER FOCUS'), 'Base prompt must not contain active member focus');
    });

    test('getOrgContextBlock formats Omnori context, hubs, and guild workspace TOC', () => {
        const orgBlock = getOrgContextBlock(testGuildId, {
            targetMember: { id: 'user_456', displayName: 'Himanshu' },
        });
        assert.ok(orgBlock.includes('ORGANIZATIONAL CONTEXT (OMNORI)'), 'Must include org context header');
        assert.ok(orgBlock.includes('Never dilute more than 5%'), 'Must enforce 5% dilution policy');
        assert.ok(orgBlock.includes('Hub — Company'), 'Must include 6 Hubs architecture');
        assert.ok(orgBlock.includes('Central Wiki Hub'), 'Must include guild TOC');
        assert.ok(orgBlock.includes('ACTIVE MEMBER FOCUS'), 'Must include active member focus');
        assert.ok(orgBlock.includes('Himanshu'), 'Must include target member display name');
        assert.ok(orgBlock.includes('user_456'), 'Must include target member ID');
    });

    test('getUserQueryBlock encapsulates user question cleanly', () => {
        const queryBlock = getUserQueryBlock('What is our target client cap?');
        assert.strictEqual(queryBlock, '[USER QUERY]\nWhat is our target client cap?');
    });

    test('formatAskPrompt combines organizational context block and user query block', () => {
        const orgBlock = getOrgContextBlock(testGuildId);
        const prompt = formatAskPrompt('What is our dilution policy?', orgBlock);
        assert.ok(prompt.startsWith('[ORGANIZATIONAL CONTEXT]\n'), 'Must start with org context block');
        assert.ok(prompt.includes('Never dilute more than 5%'), 'Must contain org facts');
        assert.ok(prompt.includes('[USER QUERY]\nWhat is our dilution policy?'), 'Must contain user query block');
    });

    console.log('\n======================================================');
    console.log(`📊 Assistant Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runAssistantTests();
}
