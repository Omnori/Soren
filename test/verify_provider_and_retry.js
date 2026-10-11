const assert = require('node:assert');
const { getGuildConfig, setGuildKeys, clearGuildKeys } = require('../lib/database');
const { handleSetModel, handleKeyInfo } = require('../commands/utility/notes/config');

async function runTests() {
    console.log('🚀 Running Provider, Model, and Retry Verification Suite...\n');
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
    // 1. handleSetModel correctly sets provider to nvidia & nvidia_model
    // -----------------------------------------------------------------
    console.log('--- [Area 1] handleSetModel & Guild Config Persistence ---');
    await asyncTest('handleSetModel sets provider: nvidia and nvidia_model', async () => {
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
        assert.strictEqual(config.nvidiaModel, 'nvidia/nemotron-3-super-120b-a12b');
        assert.ok(replyContent.includes('**Summary Provider:** **nvidia**'));
        assert.ok(replyContent.includes('nvidia/nemotron-3-super-120b-a12b'));
    });

    await asyncTest('handleSetModel automatically reroutes nvidia/... models passed into groq_model', async () => {
        let replyContent = '';
        const mockInteraction = {
            guildId: testGuildId,
            guild: { name: 'Omnori Test Guild' },
            memberPermissions: {
                has: () => true,
            },
            options: {
                getString: (key) => {
                    if (key === 'groq_model') return 'nvidia/nemotron-3-super-120b-a12b';
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
        assert.strictEqual(config.nvidiaModel, 'nvidia/nemotron-3-super-120b-a12b');
    });

    await asyncTest('handleSetModel normalizes gemini-3.5-flash to gemini-2.5-flash', async () => {
        const mockInteraction = {
            guildId: testGuildId,
            guild: { name: 'Omnori Test Guild' },
            memberPermissions: {
                has: () => true,
            },
            options: {
                getString: (key) => {
                    if (key === 'gemini_model') return 'gemini-3.5-flash';
                    return null;
                },
            },
            reply: async () => {},
        };

        await handleSetModel(mockInteraction);
        const config = getGuildConfig(testGuildId);
        assert.strictEqual(config.geminiModel, 'gemini-2.5-flash');
    });

    // -----------------------------------------------------------------
    // 2. Multi-provider fallback in voice notes
    // -----------------------------------------------------------------
    console.log('\n--- [Area 2] Voice Notes Multi-Provider Resilience ---');

    test('Gemini client does not enable vertexai by default', () => {
        // Inspect lib/geminiService getClient
        const fs = require('fs');
        const code = fs.readFileSync(require.resolve('../lib/geminiService'), 'utf-8');
        assert.ok(!code.includes('vertexai: true,'), 'Must not hardcode vertexai: true in getClient');
    });

    // Clean up
    clearGuildKeys(testGuildId);

    console.log('\n======================================================');
    console.log(`📊 Provider Verification Summary: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
