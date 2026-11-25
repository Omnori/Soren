const assert = require('node:assert');
const fs = require('node:fs');
const { getGuildConfig, clearGuildKeys, upsertNotionItem, searchNotionItems, deleteNotionItem } = require('../lib/database');
const { handleSetModel } = require('../commands/utility/notes/config');
const { DEFAULT_MODELS, normalizeNvidiaModel, normalizeGeminiModel } = require('../lib/aiConfig');
const {
    parseMeetingActionItemsAndWorkingDetails,
    parseValidIsoDate,
    createActionItem,
} = require('../lib/memberAssistant');
const { summarizeTranscriptWithGroq } = require('../lib/groqService');
const { executeTool } = require('../lib/assistantEngine');

async function runTests() {
    console.log('🚀 Running Provider, Model, Cleanup, and Bugfix Verification Suite...\n');
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

    const testGuildId = 'test_guild_provider_retry_' + Date.now();
    clearGuildKeys(testGuildId);

    // -----------------------------------------------------------------
    // 1. handleSetModel & Retired Model Normalization
    // -----------------------------------------------------------------
    console.log('--- [Area 1] handleSetModel & Retired Model Normalization ---');
    await asyncTest('handleSetModel sets provider: nvidia and normalizes retired nemotron-3-super', async () => {
        let replyContent = '';
        const mockInteraction = {
            guildId: testGuildId,
            guild: { name: 'Omnori Test Guild' },
            memberPermissions: {
                has: () => true,
            },
            options: {
                getString: (key) => {
                    if (key === 'provider') return 'nvidia';
                    if (key === 'nvidia_model') return 'nvidia/nemotron-3-super-120b-a12b';
                    return null;
                },
            },
            reply: async (payload) => {
                replyContent = payload.content;
            },
        };

        await handleSetModel(mockInteraction);
        const config = getGuildConfig(testGuildId);
        assert.strictEqual(config.summaryProvider, 'nvidia');
        assert.strictEqual(config.nvidiaModel, DEFAULT_MODELS.nvidia);
        assert.ok(replyContent.includes('**Summary Provider:** **nvidia**'));
        assert.ok(replyContent.includes(DEFAULT_MODELS.nvidia));
    });

    await asyncTest('handleSetModel automatically reroutes nvidia/... models passed into groq_model', async () => {
        const mockInteraction = {
            guildId: testGuildId,
            guild: { name: 'Omnori Test Guild' },
            memberPermissions: {
                has: () => true,
            },
            options: {
                getString: (key) => {
                    if (key === 'groq_model') return 'nvidia/nemotron-3.5-super-vl-120b-a12b';
                    return null;
                },
            },
            reply: async () => {},
        };

        await handleSetModel(mockInteraction);
        const config = getGuildConfig(testGuildId);
        assert.strictEqual(config.summaryProvider, 'nvidia');
        assert.strictEqual(config.nvidiaModel, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
    });

    await asyncTest('handleSetModel normalizes deprecated gemini models to gemini-3.8-flash', async () => {
        const mockInteraction = {
            guildId: testGuildId,
            guild: { name: 'Omnori Test Guild' },
            memberPermissions: {
                has: () => true,
            },
            options: {
                getString: (key) => {
                    if (key === 'gemini_model') return 'gemini-2.5-flash';
                    return null;
                },
            },
            reply: async () => {},
        };

        await handleSetModel(mockInteraction);
        const config = getGuildConfig(testGuildId);
        assert.strictEqual(config.geminiModel, 'gemini-3.8-flash');
    });

    test('aiConfig normalizers replace retired models across env & guild configs', () => {
        assert.strictEqual(normalizeNvidiaModel('nvidia/nemotron-3-super-120b-a12b'), DEFAULT_MODELS.nvidia);
        assert.strictEqual(normalizeGeminiModel('gemini-3.5-flash'), DEFAULT_MODELS.gemini);
        assert.strictEqual(normalizeGeminiModel('gemini-2.5-flash'), DEFAULT_MODELS.gemini);
        assert.strictEqual(normalizeGeminiModel('gemini-3.8-flash'), 'gemini-3.8-flash');
    });

    // -----------------------------------------------------------------
    // 2. Gemini VertexAI & Notice Import Checks
    // -----------------------------------------------------------------
    console.log('\n--- [Area 2] Gemini VertexAI & Module Wiring ---');

    test('Gemini client creation never hardcodes vertexai: true across services', () => {
        for (const rel of ['../lib/aiConfig', '../lib/geminiService', '../lib/orgInfoSync', '../lib/memberAssistant']) {
            const code = fs.readFileSync(require.resolve(rel), 'utf-8');
            assert.ok(!code.includes('{ vertexai: true'), `Must not hardcode vertexai: true in ${rel}`);
        }
    });

    test('notice.js imports sanitizeErrorMessage from safeError cleanly', () => {
        const noticeMod = require('../commands/utility/notes/notice');
        assert.strictEqual(typeof noticeMod.handleNotice, 'function');
    });

    // -----------------------------------------------------------------
    // 3. Action Item Due Date Parsing & Notion Schema Fix
    // -----------------------------------------------------------------
    console.log('\n--- [Area 3] Action Item Due Date & Notion Schema ---');

    test('parseMeetingActionItemsAndWorkingDetails does not treat @Abhi (Abhyudaya) as a Due date', () => {
        const md = [
            '## Action Items',
            '* [ ] **Set up mail server** - @Abhi (Abhyudaya)',
            '* [ ] **Finish landing page** - @Abhi (Abhyudaya) (Due: 2026-11-30)',
            '* [ ] **Check trademark** - @Himanshu Yadav (Due: Today, before 6:00 PM)',
            '* [ ] **Review SOP** - @Abhi (Abhyudaya) (Due: Not specified)',
        ].join('\n');

        const { actionItems } = parseMeetingActionItemsAndWorkingDetails(md);
        assert.strictEqual(actionItems.length, 4);
        assert.strictEqual(actionItems[0].owner, 'Abhi (Abhyudaya)');
        assert.strictEqual(actionItems[0].due, null);
        assert.strictEqual(actionItems[1].due, '2026-11-30');
        assert.strictEqual(actionItems[2].due, 'Today, before 6:00 PM');
        assert.strictEqual(actionItems[3].due, null);
    });

    test('parseValidIsoDate validates strict ISO 8601 dates and rejects natural language', () => {
        assert.strictEqual(parseValidIsoDate('2026-11-30'), '2026-11-30');
        assert.strictEqual(parseValidIsoDate('2026-11-30T18:00:00Z'), '2026-11-30T18:00:00Z');
        assert.strictEqual(parseValidIsoDate('Abhyudaya'), null);
        assert.strictEqual(parseValidIsoDate('Today, before 6:00 PM'), null);
        assert.strictEqual(parseValidIsoDate('2026-02-30'), null);
    });

    await asyncTest('createActionItem omits Due date property for non-ISO due strings instead of failing validation', async () => {
        let capturedProps = null;
        const mockClient = {
            pages: {
                create: async ({ properties }) => {
                    capturedProps = properties;
                    return { id: 'page_1', url: 'https://notion.so/page_1' };
                },
            },
        };

        const res = await createActionItem(mockClient, 'db_action_items', {
            task: 'Call client',
            assignee: 'Abhi',
            due: 'Today, before 6:00 PM',
        });

        assert.ok(res);
        assert.strictEqual(capturedProps.Due, undefined, 'Non-ISO due string must not be sent as Notion date property');
        assert.strictEqual(capturedProps.Task.title[0].text.content, 'Call client');
    });

    await asyncTest('executeTool create_user_task uses Task/Assignee rich_text/Due schema matching Action Items DB', async () => {
        const originalGetClient = require('../lib/notion').getNotionClient;
        let capturedProps = null;

        const { setGuildNotionConfig, clearGuildNotionConfig } = require('../lib/database');
        setGuildNotionConfig(testGuildId, {
            notionToken: 'ntn_test_token',
            wikiPageId: 'wiki_123',
            actionItemsDbId: 'action_db_123',
        });

        require('../lib/notion').getNotionClient = () => ({
            pages: {
                create: async ({ properties }) => {
                    capturedProps = properties;
                    return { id: 'task-created-1', url: 'https://notion.so/task-created-1' };
                },
            },
        });

        try {
            const raw = await executeTool(testGuildId, 'create_user_task', {
                task_title: 'Verify deployment',
                assignee_name: 'Abhi',
                due_date: '2026-12-01',
                status: 'Not started',
            });
            const parsed = JSON.parse(raw);
            assert.strictEqual(parsed.success, true);
            assert.ok(capturedProps.Task, 'Must use Task title property instead of Name');
            assert.strictEqual(capturedProps.Name, undefined);
            assert.deepStrictEqual(capturedProps.Assignee, { rich_text: [{ text: { content: 'Abhi' } }] });
            assert.deepStrictEqual(capturedProps.Due, { date: { start: '2026-12-01' } });
        } finally {
            require('../lib/notion').getNotionClient = originalGetClient;
            deleteNotionItem('taskcreated1');
            clearGuildNotionConfig(testGuildId);
        }
    });

    // -----------------------------------------------------------------
    // 4. FTS5 Query Sanitization & Groq Chunked Summarization
    // -----------------------------------------------------------------
    console.log('\n--- [Area 4] FTS5 Sanitization & Groq Chunked Summarization ---');

    test('searchNotionItems handles special characters like & without throwing FTS5 syntax error', () => {
        upsertNotionItem({
            id: 'fts_amp_1',
            guildId: testGuildId,
            type: 'page',
            title: 'R&D and Clients & Partnerships',
            contentMarkdown: 'Tracking R&D budget and Q&A notes.',
            updatedAt: Date.now(),
        });

        try {
            const results = searchNotionItems(testGuildId, 'Clients & Partnerships');
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].id, 'fts_amp_1');
            assert.deepStrictEqual(searchNotionItems(testGuildId, '&&& --- ***'), []);
        } finally {
            deleteNotionItem('fts_amp_1');
        }
    });

    await asyncTest('summarizeTranscriptWithGroq chunks long transcripts to avoid 413 TPM limit', async () => {
        const { setGuildKeys } = require('../lib/database');
        const chunkGuildId = 'test_guild_chunk_' + Date.now();
        setGuildKeys(chunkGuildId, { groqApiKey: 'gsk_test_chunking_key' });
        const originalFetch = global.fetch;
        const callBodies = [];
        global.fetch = async (_url, opts) => {
            const body = JSON.parse(opts.body);
            callBodies.push(body);
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: '## Meeting Summary\nChunked summary.' } }],
                    usage: { total_tokens: 200 },
                }),
            };
        };

        try {
            const longTranscript = Array.from({ length: 400 }, (_, i) => `[10:00:00] Abhi: Discussing item ${i} with enough words to fill space.`).join('\n');
            const res = await summarizeTranscriptWithGroq(longTranscript, 'gsk_test_chunking_key', 'openai/gpt-oss-120b', chunkGuildId, 'Org context');
            assert.ok(res.summary.includes('Chunked summary'));
            assert.ok(callBodies.length >= 3, `Expected map-reduce calls >= 3, got ${callBodies.length}`);
            for (const body of callBodies) {
                const chars = JSON.stringify(body.messages).length;
                assert.ok(chars < 18000, `Each Groq request must stay well below 8K TPM (${chars} chars)`);
            }
        } finally {
            global.fetch = originalFetch;
            clearGuildKeys(chunkGuildId);
        }
    });

    // Clean up
    clearGuildKeys(testGuildId);

    console.log('\n======================================================');
    console.log(`📊 Provider & Bugfix Verification Summary: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
