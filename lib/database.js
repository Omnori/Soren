const path = require('path');
const fs = require('fs');
const { encrypt, decrypt, isEncrypted } = require('./crypto');

const DB_PATH = path.join(__dirname, '../soren.sqlite');
const LEGACY_JSON_PATH = path.join(__dirname, '../guild_configs.json');

let db;
try {
    const BetterSqlite3 = require('better-sqlite3');
    db = new BetterSqlite3(DB_PATH);
} catch {
    const { DatabaseSync } = require('node:sqlite');
    class BetterSqlite3Compat {
        constructor(filename) {
            this._db = new DatabaseSync(filename);
        }
        exec(sql) {
            return this._db.exec(sql);
        }
        pragma(pragmaStr) {
            try {
                return this._db.exec(`PRAGMA ${pragmaStr};`);
            } catch {
                // Ignore pragma failures on some platforms
            }
        }
        prepare(sql) {
            return this._db.prepare(sql);
        }
        transaction(fn) {
            return (...args) => {
                this._db.exec('BEGIN');
                try {
                    const res = fn(...args);
                    this._db.exec('COMMIT');
                    return res;
                } catch (e) {
                    this._db.exec('ROLLBACK');
                    throw e;
                }
            };
        }
    }
    db = new BetterSqlite3Compat(DB_PATH);
}

// Optimize SQLite
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        groq_api_key TEXT,
        gemini_api_key TEXT,
        summary_provider TEXT DEFAULT 'groq',
        groq_model TEXT,
        gemini_model TEXT,
        notes_channel_id TEXT,
        daily_request_limit INTEGER DEFAULT 0,
        notion_token TEXT,
        wiki_page_id TEXT,
        meetings_db_id TEXT,
        org_info_page_id TEXT,
        action_items_db_id TEXT,
        members_db_id TEXT,
        sync_mode TEXT DEFAULT 'manual',
        section_block_map TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        channel_name TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_seconds INTEGER DEFAULT 0,
        participant_count INTEGER DEFAULT 0,
        participants TEXT,
        summary_provider TEXT,
        summary_model TEXT,
        transcript_entries_count INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        summary_text TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        service TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_tag TEXT,
        action TEXT NOT NULL,
        target_member_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_guild ON meeting_sessions(guild_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON meeting_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_guild_time ON api_requests(guild_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_guild_time ON audit_logs(guild_id, created_at);

    CREATE TABLE IF NOT EXISTS guild_notion_wiki (
        guild_id TEXT PRIMARY KEY,
        wiki_root_page_id TEXT NOT NULL,
        wiki_toc_markdown TEXT,
        structure_json TEXT,
        last_scanned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notion_items (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        parent_id TEXT,
        database_id TEXT,
        type TEXT,
        title TEXT,
        status TEXT,
        assignee TEXT,
        due_date TEXT,
        properties_json TEXT,
        content_markdown TEXT,
        url TEXT,
        updated_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notion_items_fts USING fts5(
        id,
        guild_id,
        title,
        content_markdown,
        tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS guild_user_mappings (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        discord_display_name TEXT,
        notion_user_name TEXT,
        notion_user_id TEXT,
        PRIMARY KEY (guild_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT,
        role TEXT NOT NULL,
        author_name TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conv_guild_channel_time ON conversation_messages(guild_id, channel_id, created_at);

    -- Sync triggers to keep FTS5 in sync with notion_items
    CREATE TRIGGER IF NOT EXISTS after_notion_items_insert AFTER INSERT ON notion_items BEGIN
        INSERT INTO notion_items_fts(id, guild_id, title, content_markdown)
        VALUES (new.id, new.guild_id, new.title, new.content_markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS after_notion_items_delete AFTER DELETE ON notion_items BEGIN
        DELETE FROM notion_items_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS after_notion_items_update AFTER UPDATE ON notion_items BEGIN
        UPDATE notion_items_fts
        SET title = new.title,
            content_markdown = new.content_markdown
        WHERE id = new.id;
    END;
`);

// Migration safeguards for schema updates
const columnsToAdd = [
    { col: 'daily_request_limit', type: 'INTEGER DEFAULT 0' },
    { col: 'notion_token', type: 'TEXT' },
    { col: 'wiki_page_id', type: 'TEXT' },
    { col: 'meetings_db_id', type: 'TEXT' },
    { col: 'org_info_page_id', type: 'TEXT' },
    { col: 'action_items_db_id', type: 'TEXT' },
    { col: 'members_db_id', type: 'TEXT' },
    { col: 'sync_mode', type: "TEXT DEFAULT 'manual'" },
    { col: 'section_block_map', type: 'TEXT' },
    { col: 'nvidia_api_key', type: 'TEXT' },
    { col: 'nvidia_model', type: 'TEXT' },
    { col: 'assistant_channel_id', type: 'TEXT' },
    { col: 'digest_channel_id', type: 'TEXT' },
    { col: 'last_digest_at', type: 'INTEGER DEFAULT 0' },
];

for (const { col, type } of columnsToAdd) {
    try {
        db.exec(`ALTER TABLE guild_configs ADD COLUMN ${col} ${type}`);
    } catch {
        // Column already exists
    }
}

for (const { col, type } of [
    { col: 'summary_text', type: 'TEXT' },
    { col: 'raw_transcript', type: 'TEXT' },
]) {
    try {
        db.exec(`ALTER TABLE meeting_sessions ADD COLUMN ${col} ${type}`);
    } catch {
        // Column already exists
    }
}

const GROQ_LIMITS = {
    requestsPerMinute: 18,
    requestsPerDay: 1000,
    tokensPerMinute: 8000,
    tokensPerDay: 200000,
};

const stmts = {
    getGuild: db.prepare('SELECT * FROM guild_configs WHERE guild_id = ?'),
    getAllGuilds: db.prepare('SELECT * FROM guild_configs'),
    upsertGuildKeys: db.prepare(`
        INSERT INTO guild_configs (
            guild_id, groq_api_key, gemini_api_key, nvidia_api_key, summary_provider, groq_model, gemini_model, nvidia_model, notes_channel_id, created_at, updated_at
        ) VALUES (
            @guild_id, @groq_api_key, @gemini_api_key, @nvidia_api_key, @summary_provider, @groq_model, @gemini_model, @nvidia_model, @notes_channel_id, @created_at, @updated_at
        )
        ON CONFLICT(guild_id) DO UPDATE SET
            groq_api_key = COALESCE(@groq_api_key, groq_api_key),
            gemini_api_key = COALESCE(@gemini_api_key, gemini_api_key),
            nvidia_api_key = COALESCE(@nvidia_api_key, nvidia_api_key),
            summary_provider = COALESCE(@summary_provider, summary_provider),
            groq_model = COALESCE(@groq_model, groq_model),
            gemini_model = COALESCE(@gemini_model, gemini_model),
            nvidia_model = COALESCE(@nvidia_model, nvidia_model),
            notes_channel_id = COALESCE(@notes_channel_id, notes_channel_id),
            updated_at = @updated_at
    `),
    upsertNotionConfig: db.prepare(`
        INSERT INTO guild_configs (
            guild_id, notion_token, wiki_page_id, meetings_db_id, org_info_page_id, action_items_db_id, members_db_id, sync_mode, section_block_map, created_at, updated_at
        ) VALUES (
            @guild_id, @notion_token, @wiki_page_id, @meetings_db_id, @org_info_page_id, @action_items_db_id, @members_db_id, @sync_mode, @section_block_map, @created_at, @updated_at
        )
        ON CONFLICT(guild_id) DO UPDATE SET
            notion_token = @notion_token,
            wiki_page_id = @wiki_page_id,
            meetings_db_id = COALESCE(@meetings_db_id, meetings_db_id),
            org_info_page_id = COALESCE(@org_info_page_id, org_info_page_id),
            action_items_db_id = COALESCE(@action_items_db_id, action_items_db_id),
            members_db_id = COALESCE(@members_db_id, members_db_id),
            sync_mode = COALESCE(@sync_mode, sync_mode),
            section_block_map = COALESCE(@section_block_map, section_block_map),
            updated_at = @updated_at
    `),
    clearGuildKeys: db.prepare(`
        UPDATE guild_configs
        SET groq_api_key = NULL,
            gemini_api_key = NULL,
            nvidia_api_key = NULL,
            summary_provider = 'groq',
            groq_model = NULL,
            gemini_model = NULL,
            nvidia_model = NULL,
            updated_at = ?
        WHERE guild_id = ?
    `),
    clearNotionConfig: db.prepare(`
        UPDATE guild_configs
        SET notion_token = NULL,
            wiki_page_id = NULL,
            meetings_db_id = NULL,
            org_info_page_id = NULL,
            action_items_db_id = NULL,
            members_db_id = NULL,
            sync_mode = 'manual',
            section_block_map = NULL,
            updated_at = ?
        WHERE guild_id = ?
    `),
    setChannelId: db.prepare(`
        INSERT INTO guild_configs (guild_id, notes_channel_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            notes_channel_id = excluded.notes_channel_id,
            updated_at = excluded.updated_at
    `),
    setAssistantChannelId: db.prepare(`
        INSERT INTO guild_configs (guild_id, assistant_channel_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            assistant_channel_id = excluded.assistant_channel_id,
            updated_at = excluded.updated_at
    `),
    setDigestChannelId: db.prepare(`
        INSERT INTO guild_configs (guild_id, digest_channel_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            digest_channel_id = excluded.digest_channel_id,
            updated_at = excluded.updated_at
    `),
    setLastDigestAt: db.prepare(`
        UPDATE guild_configs SET last_digest_at = ?, updated_at = ? WHERE guild_id = ?
    `),
    getGuildsWithDigest: db.prepare(`
        SELECT guild_id, digest_channel_id, last_digest_at FROM guild_configs
        WHERE digest_channel_id IS NOT NULL AND digest_channel_id != ''
    `),
    setQuota: db.prepare(`
        INSERT INTO guild_configs (guild_id, daily_request_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            daily_request_limit = excluded.daily_request_limit,
            updated_at = excluded.updated_at
    `),
    insertSession: db.prepare(`
        INSERT INTO meeting_sessions (
            guild_id, channel_id, channel_name, started_at, ended_at, duration_seconds,
            participant_count, participants, summary_provider, summary_model,
            transcript_entries_count, status, error_message, summary_text, raw_transcript, created_at
        ) VALUES (
            @guild_id, @channel_id, @channel_name, @started_at, @ended_at, @duration_seconds,
            @participant_count, @participants, @summary_provider, @summary_model,
            @transcript_entries_count, @status, @error_message, @summary_text, @raw_transcript, @created_at
        )
    `),
    getSessionById: db.prepare('SELECT * FROM meeting_sessions WHERE id = ?'),
    getLatestCompletedSession: db.prepare(`
        SELECT * FROM meeting_sessions
        WHERE guild_id = ? AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1
    `),
    getGuildStats: db.prepare(`
        SELECT 
            COUNT(*) as total_meetings,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed_meetings,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed_meetings,
            COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
        FROM meeting_sessions
        WHERE guild_id = ?
    `),
    getRecentSessions: db.prepare(`
        SELECT * FROM meeting_sessions
        WHERE guild_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `),
    insertApiRequest: db.prepare(`
        INSERT INTO api_requests (
            guild_id, service, model, status, tokens_used, error_message, created_at
        ) VALUES (
            @guild_id, @service, @model, @status, @tokens_used, @error_message, @created_at
        )
    `),
    getDailyRequestStats: db.prepare(`
        SELECT 
            COUNT(*) as total_requests_24h,
            COALESCE(SUM(tokens_used), 0) as total_tokens_24h,
            COALESCE(SUM(CASE WHEN service LIKE 'groq%' THEN 1 ELSE 0 END), 0) as groq_requests_24h,
            COALESCE(SUM(CASE WHEN service LIKE 'groq%' THEN tokens_used ELSE 0 END), 0) as groq_tokens_24h,
            COALESCE(SUM(CASE WHEN service = 'groq_stt' THEN 1 ELSE 0 END), 0) as stt_requests_24h,
            COALESCE(SUM(CASE WHEN service IN ('groq_summary', 'gemini_summary') THEN 1 ELSE 0 END), 0) as summary_requests_24h,
            COALESCE(SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END), 0) as rate_limit_hits_24h
        FROM api_requests
        WHERE guild_id = ? AND created_at >= ?
    `),
    getMinuteRequestStats: db.prepare(`
        SELECT 
            COUNT(*) as total_requests_1m,
            COALESCE(SUM(tokens_used), 0) as total_tokens_1m,
            COALESCE(SUM(CASE WHEN service LIKE 'groq%' THEN 1 ELSE 0 END), 0) as groq_requests_1m,
            COALESCE(SUM(CASE WHEN service LIKE 'groq%' THEN tokens_used ELSE 0 END), 0) as groq_tokens_1m
        FROM api_requests
        WHERE guild_id = ? AND created_at >= ?
    `),
    getLifetimeRequestStats: db.prepare(`
        SELECT 
            COUNT(*) as total_lifetime_requests,
            COALESCE(SUM(tokens_used), 0) as total_lifetime_tokens
        FROM api_requests
        WHERE guild_id = ?
    `),
    countRequestsSince: db.prepare(`
        SELECT COUNT(*) as total
        FROM api_requests
        WHERE guild_id = ? AND created_at >= ?
    `),
    getGroqUsageSince: db.prepare(`
        SELECT 
            COUNT(*) as total_requests,
            COALESCE(SUM(tokens_used), 0) as total_tokens
        FROM api_requests
        WHERE service LIKE 'groq%' AND status != 'rate_limited' AND created_at >= ?
    `),
    getGuildGroqUsageSince: db.prepare(`
        SELECT 
            COUNT(*) as total_requests,
            COALESCE(SUM(tokens_used), 0) as total_tokens
        FROM api_requests
        WHERE guild_id = ? AND service LIKE 'groq%' AND status != 'rate_limited' AND created_at >= ?
    `),
    insertAuditLog: db.prepare(`
        INSERT INTO audit_logs (guild_id, user_id, user_tag, action, target_member_id, details, created_at)
        VALUES (@guild_id, @user_id, @user_tag, @action, @target_member_id, @details, @created_at)
    `),
    getAuditLogs: db.prepare(`
        SELECT * FROM audit_logs
        WHERE guild_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `),
    upsertNotionItem: db.prepare(`
        INSERT INTO notion_items (
            id, guild_id, parent_id, database_id, type, title, status, assignee, due_date, properties_json, content_markdown, url, updated_at
        ) VALUES (
            @id, @guild_id, @parent_id, @database_id, @type, @title, @status, @assignee, @due_date, @properties_json, @content_markdown, @url, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            parent_id = excluded.parent_id,
            database_id = excluded.database_id,
            type = excluded.type,
            title = excluded.title,
            status = excluded.status,
            assignee = excluded.assignee,
            due_date = excluded.due_date,
            properties_json = excluded.properties_json,
            content_markdown = excluded.content_markdown,
            url = excluded.url,
            updated_at = excluded.updated_at
    `),
    deleteNotionItem: db.prepare('DELETE FROM notion_items WHERE id = ?'),
    getNotionItem: db.prepare('SELECT * FROM notion_items WHERE id = ?'),
    getNotionItemsByGuild: db.prepare('SELECT * FROM notion_items WHERE guild_id = ?'),
    searchNotionItems: db.prepare(`
        SELECT i.*
        FROM notion_items i
        JOIN notion_items_fts f ON i.id = f.id
        WHERE f.guild_id = ? AND notion_items_fts MATCH ?
    `),
    upsertGuildWiki: db.prepare(`
        INSERT INTO guild_notion_wiki (
            guild_id, wiki_root_page_id, wiki_toc_markdown, structure_json, last_scanned_at
        ) VALUES (
            @guild_id, @wiki_root_page_id, @wiki_toc_markdown, @structure_json, @last_scanned_at
        )
        ON CONFLICT(guild_id) DO UPDATE SET
            wiki_root_page_id = excluded.wiki_root_page_id,
            wiki_toc_markdown = excluded.wiki_toc_markdown,
            structure_json = excluded.structure_json,
            last_scanned_at = excluded.last_scanned_at
    `),
    getGuildWiki: db.prepare('SELECT * FROM guild_notion_wiki WHERE guild_id = ?'),
    upsertUserMapping: db.prepare(`
        INSERT INTO guild_user_mappings (
            guild_id, discord_user_id, discord_display_name, notion_user_name, notion_user_id
        ) VALUES (
            @guild_id, @discord_user_id, @discord_display_name, @notion_user_name, @notion_user_id
        )
        ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
            discord_display_name = excluded.discord_display_name,
            notion_user_name = excluded.notion_user_name,
            notion_user_id = excluded.notion_user_id
    `),
    getUserMapping: db.prepare('SELECT * FROM guild_user_mappings WHERE guild_id = ? AND discord_user_id = ?'),
    getUserMappingByNotionName: db.prepare('SELECT * FROM guild_user_mappings WHERE guild_id = ? AND LOWER(notion_user_name) = LOWER(?)'),
    getUserMappingsByGuild: db.prepare('SELECT * FROM guild_user_mappings WHERE guild_id = ?'),
    deleteUserMapping: db.prepare('DELETE FROM guild_user_mappings WHERE guild_id = ? AND discord_user_id = ?'),
    insertConversationMsg: db.prepare(`
        INSERT INTO conversation_messages (guild_id, channel_id, user_id, role, author_name, content, created_at)
        VALUES (@guild_id, @channel_id, @user_id, @role, @author_name, @content, @created_at)
    `),
    getRecentConversationMsgs: db.prepare(`
        SELECT * FROM (
            SELECT * FROM conversation_messages
            WHERE guild_id = ? AND channel_id = ? AND created_at >= ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        ) ORDER BY created_at ASC, id ASC
    `),
    clearConversationMsgs: db.prepare('DELETE FROM conversation_messages WHERE guild_id = ? AND channel_id = ?'),
    pruneConversationMsgs: db.prepare('DELETE FROM conversation_messages WHERE created_at < ?'),
    likeSearchNotionItems: db.prepare(`
        SELECT * FROM notion_items
        WHERE guild_id = ? AND (
            LOWER(title) LIKE ? OR
            LOWER(content_markdown) LIKE ? OR
            LOWER(COALESCE(assignee, '')) LIKE ? OR
            LOWER(COALESCE(status, '')) LIKE ? OR
            LOWER(COALESCE(properties_json, '')) LIKE ?
        )
        ORDER BY updated_at DESC
        LIMIT 15
    `),
};

// Saves current SQLite guild configs to guild_configs.json with encrypted tokens atomically
function syncToJson() {
    try {
        const rows = stmts.getAllGuilds.all();
        const output = {};
        for (const r of rows) {
            let sectionBlockMap;
            if (r.section_block_map) {
                try {
                    sectionBlockMap = JSON.parse(r.section_block_map);
                } catch {
                    sectionBlockMap = undefined;
                }
            }

            output[r.guild_id] = {
                groqApiKey: r.groq_api_key || undefined,
                geminiApiKey: r.gemini_api_key || undefined,
                nvidiaApiKey: r.nvidia_api_key || undefined,
                summaryProvider: r.summary_provider || 'groq',
                groqModel: r.groq_model || undefined,
                geminiModel: r.gemini_model || undefined,
                nvidiaModel: r.nvidia_model || undefined,
                notesChannelId: r.notes_channel_id || undefined,
                assistantChannelId: r.assistant_channel_id || undefined,
                digestChannelId: r.digest_channel_id || undefined,
                dailyRequestLimit: r.daily_request_limit || undefined,
                notionToken: r.notion_token || undefined,
                wikiPageId: r.wiki_page_id || undefined,
                meetingsDbId: r.meetings_db_id || undefined,
                orgInfoPageId: r.org_info_page_id || undefined,
                actionItemsDbId: r.action_items_db_id || undefined,
                membersDbId: r.members_db_id || undefined,
                syncMode: r.sync_mode || undefined,
                sectionBlockMap,
            };
        }
        const tempPath = `${LEGACY_JSON_PATH}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(output, null, 2), 'utf-8');
        fs.renameSync(tempPath, LEGACY_JSON_PATH);
    } catch (err) {
        console.error('[database] Failed to sync guild configs to JSON:', err);
    }
}

// Automatic migration from legacy guild_configs.json: encrypts keys at rest in both JSON and SQLite
function migrateFromLegacyJson() {
    try {
        if (!fs.existsSync(LEGACY_JSON_PATH)) return;
        const raw = fs.readFileSync(LEGACY_JSON_PATH, 'utf-8');
        if (!raw.trim()) return;
        const legacyData = JSON.parse(raw);
        const now = Date.now();
        let changed = false;

        const runMigrationTx = db.transaction(() => {
            for (const [guildId, cfg] of Object.entries(legacyData)) {
                if (!cfg || typeof cfg !== 'object') continue;

                let groqApiKey = cfg.groqApiKey || null;
                if (groqApiKey && !isEncrypted(groqApiKey)) {
                    groqApiKey = encrypt(groqApiKey);
                    cfg.groqApiKey = groqApiKey;
                    changed = true;
                }

                let geminiApiKey = cfg.geminiApiKey || null;
                if (geminiApiKey && !isEncrypted(geminiApiKey)) {
                    geminiApiKey = encrypt(geminiApiKey);
                    cfg.geminiApiKey = geminiApiKey;
                    changed = true;
                }

                let nvidiaApiKey = cfg.nvidiaApiKey || null;
                if (nvidiaApiKey && !isEncrypted(nvidiaApiKey)) {
                    nvidiaApiKey = encrypt(nvidiaApiKey);
                    cfg.nvidiaApiKey = nvidiaApiKey;
                    changed = true;
                }

                let notionToken = cfg.notionToken || null;
                if (notionToken && !isEncrypted(notionToken)) {
                    notionToken = encrypt(notionToken);
                    cfg.notionToken = notionToken;
                    changed = true;
                }

                stmts.upsertGuildKeys.run({
                    guild_id: guildId,
                    groq_api_key: groqApiKey,
                    gemini_api_key: geminiApiKey,
                    nvidia_api_key: nvidiaApiKey,
                    summary_provider: cfg.summaryProvider || 'groq',
                    groq_model: cfg.groqModel || null,
                    gemini_model: cfg.geminiModel || null,
                    nvidia_model: cfg.nvidiaModel || null,
                    notes_channel_id: cfg.notesChannelId || null,
                    created_at: now,
                    updated_at: now,
                });

                if (notionToken || cfg.wikiPageId) {
                    stmts.upsertNotionConfig.run({
                        guild_id: guildId,
                        notion_token: notionToken,
                        wiki_page_id: cfg.wikiPageId || null,
                        meetings_db_id: cfg.meetingsDbId || null,
                        org_info_page_id: cfg.orgInfoPageId || null,
                        action_items_db_id: cfg.actionItemsDbId || null,
                        members_db_id: cfg.membersDbId || null,
                        sync_mode: cfg.syncMode || 'manual',
                        section_block_map: cfg.sectionBlockMap ? JSON.stringify(cfg.sectionBlockMap) : null,
                        created_at: now,
                        updated_at: now,
                    });
                }
            }
        });

        runMigrationTx();

        if (changed) {
            const tempPath = `${LEGACY_JSON_PATH}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tempPath, JSON.stringify(legacyData, null, 2), 'utf-8');
            fs.renameSync(tempPath, LEGACY_JSON_PATH);
            console.log('[database] Encrypted existing plaintext tokens at rest in guild_configs.json.');
        }
        console.log('[database] Successfully synchronized guild configs with SQLite database.');
    } catch (err) {
        console.error('[database] Migration from guild_configs.json failed:', err);
    }
}

migrateFromLegacyJson();

function getGuildConfig(guildId) {
    const row = stmts.getGuild.get(guildId);
    if (!row) return {};

    let sectionBlockMap = {};
    if (row.section_block_map) {
        try {
            sectionBlockMap = JSON.parse(row.section_block_map);
        } catch {
            sectionBlockMap = {};
        }
    }

    return {
        groqApiKey: decrypt(row.groq_api_key) || undefined,
        geminiApiKey: decrypt(row.gemini_api_key) || undefined,
        nvidiaApiKey: decrypt(row.nvidia_api_key) || undefined,
        summaryProvider: row.summary_provider || 'groq',
        groqModel: row.groq_model || undefined,
        geminiModel: row.gemini_model || undefined,
        nvidiaModel: row.nvidia_model || undefined,
        notesChannelId: row.notes_channel_id || null,
        assistantChannelId: row.assistant_channel_id || null,
        digestChannelId: row.digest_channel_id || null,
        lastDigestAt: row.last_digest_at || 0,
        dailyRequestLimit: row.daily_request_limit || 0,
        notionToken: decrypt(row.notion_token) || undefined,
        wikiPageId: row.wiki_page_id || undefined,
        meetingsDbId: row.meetings_db_id || undefined,
        orgInfoPageId: row.org_info_page_id || undefined,
        actionItemsDbId: row.action_items_db_id || undefined,
        membersDbId: row.members_db_id || undefined,
        syncMode: row.sync_mode || 'manual',
        sectionBlockMap,
    };
}

function setGuildKeys(guildId, { groqApiKey, geminiApiKey, nvidiaApiKey, summaryProvider, groqModel, geminiModel, nvidiaModel }) {
    const now = Date.now();
    const existing = stmts.getGuild.get(guildId);

    const encGroq = groqApiKey !== undefined ? (groqApiKey ? encrypt(groqApiKey) : null) : (existing?.groq_api_key || null);
    const encGemini = geminiApiKey !== undefined ? (geminiApiKey ? encrypt(geminiApiKey) : null) : (existing?.gemini_api_key || null);
    const encNvidia = nvidiaApiKey !== undefined ? (nvidiaApiKey ? encrypt(nvidiaApiKey) : null) : (existing?.nvidia_api_key || null);

    stmts.upsertGuildKeys.run({
        guild_id: guildId,
        groq_api_key: encGroq,
        gemini_api_key: encGemini,
        nvidia_api_key: encNvidia,
        summary_provider: summaryProvider !== undefined ? summaryProvider : (existing?.summary_provider || 'groq'),
        groq_model: groqModel !== undefined ? groqModel : (existing?.groq_model || null),
        gemini_model: geminiModel !== undefined ? geminiModel : (existing?.gemini_model || null),
        nvidia_model: nvidiaModel !== undefined ? nvidiaModel : (existing?.nvidia_model || null),
        notes_channel_id: existing?.notes_channel_id || null,
        created_at: existing?.created_at || now,
        updated_at: now,
    });

    syncToJson();
}

function clearGuildKeys(guildId) {
    stmts.clearGuildKeys.run(Date.now(), guildId);
    syncToJson();
}

function setGuildNotionConfig(guildId, {
    notionToken,
    wikiPageId,
    meetingsDbId,
    orgInfoPageId,
    actionItemsDbId,
    membersDbId,
    syncMode,
    sectionBlockMap,
}) {
    const now = Date.now();
    const existing = stmts.getGuild.get(guildId);

    const encToken = notionToken !== undefined ? (notionToken ? encrypt(notionToken) : null) : (existing?.notion_token || null);
    const resolvedWikiId = wikiPageId !== undefined ? wikiPageId : (existing?.wiki_page_id || null);
    const resolvedMeetingsDb = meetingsDbId !== undefined ? meetingsDbId : (existing?.meetings_db_id || null);
    const resolvedOrgInfo = orgInfoPageId !== undefined ? orgInfoPageId : (existing?.org_info_page_id || null);
    const resolvedActionItems = actionItemsDbId !== undefined ? actionItemsDbId : (existing?.action_items_db_id || null);
    const resolvedMembersDb = membersDbId !== undefined ? membersDbId : (existing?.members_db_id || null);
    const resolvedSyncMode = syncMode !== undefined ? syncMode : (existing?.sync_mode || 'manual');
    const resolvedBlockMap = sectionBlockMap !== undefined
        ? (typeof sectionBlockMap === 'object' ? JSON.stringify(sectionBlockMap) : String(sectionBlockMap))
        : (existing?.section_block_map || null);

    stmts.upsertNotionConfig.run({
        guild_id: guildId,
        notion_token: encToken,
        wiki_page_id: resolvedWikiId,
        meetings_db_id: resolvedMeetingsDb,
        org_info_page_id: resolvedOrgInfo,
        action_items_db_id: resolvedActionItems,
        members_db_id: resolvedMembersDb,
        sync_mode: resolvedSyncMode,
        section_block_map: resolvedBlockMap,
        created_at: existing?.created_at || now,
        updated_at: now,
    });

    syncToJson();
}

function updateGuildConfig(guildId, patch = {}) {
    const existing = stmts.getGuild.get(guildId);
    const now = Date.now();

    const hasKeyPatch = ['groqApiKey', 'geminiApiKey', 'nvidiaApiKey', 'summaryProvider', 'groqModel', 'geminiModel', 'nvidiaModel'].some((k) => k in patch);
    const hasNotionPatch = ['notionToken', 'wikiPageId', 'meetingsDbId', 'orgInfoPageId', 'actionItemsDbId', 'membersDbId', 'syncMode', 'sectionBlockMap'].some((k) => k in patch);
    const hasChannelPatch = 'notesChannelId' in patch;
    const hasAssistantChannelPatch = 'assistantChannelId' in patch;
    const hasDigestChannelPatch = 'digestChannelId' in patch;
    const hasQuotaPatch = 'dailyRequestLimit' in patch;

    if (hasKeyPatch) {
        const encGroq = patch.groqApiKey !== undefined ? (patch.groqApiKey ? encrypt(patch.groqApiKey) : null) : (existing?.groq_api_key || null);
        const encGemini = patch.geminiApiKey !== undefined ? (patch.geminiApiKey ? encrypt(patch.geminiApiKey) : null) : (existing?.gemini_api_key || null);
        const encNvidia = patch.nvidiaApiKey !== undefined ? (patch.nvidiaApiKey ? encrypt(patch.nvidiaApiKey) : null) : (existing?.nvidia_api_key || null);

        stmts.upsertGuildKeys.run({
            guild_id: guildId,
            groq_api_key: encGroq,
            gemini_api_key: encGemini,
            nvidia_api_key: encNvidia,
            summary_provider: patch.summaryProvider !== undefined ? patch.summaryProvider : (existing?.summary_provider || 'groq'),
            groq_model: patch.groqModel !== undefined ? patch.groqModel : (existing?.groq_model || null),
            gemini_model: patch.geminiModel !== undefined ? patch.geminiModel : (existing?.gemini_model || null),
            nvidia_model: patch.nvidiaModel !== undefined ? patch.nvidiaModel : (existing?.nvidia_model || null),
            notes_channel_id: patch.notesChannelId !== undefined ? patch.notesChannelId : (existing?.notes_channel_id || null),
            created_at: existing?.created_at || now,
            updated_at: now,
        });
    }

    if (hasNotionPatch) {
        const encToken = patch.notionToken !== undefined ? (patch.notionToken ? encrypt(patch.notionToken) : null) : (existing?.notion_token || null);
        const resolvedWikiId = patch.wikiPageId !== undefined ? patch.wikiPageId : (existing?.wiki_page_id || null);
        const resolvedMeetingsDb = patch.meetingsDbId !== undefined ? patch.meetingsDbId : (existing?.meetings_db_id || null);
        const resolvedOrgInfo = patch.orgInfoPageId !== undefined ? patch.orgInfoPageId : (existing?.org_info_page_id || null);
        const resolvedActionItems = patch.actionItemsDbId !== undefined ? patch.actionItemsDbId : (existing?.action_items_db_id || null);
        const resolvedMembersDb = patch.membersDbId !== undefined ? patch.membersDbId : (existing?.members_db_id || null);
        const resolvedSyncMode = patch.syncMode !== undefined ? patch.syncMode : (existing?.sync_mode || 'manual');
        const resolvedBlockMap = patch.sectionBlockMap !== undefined
            ? (typeof patch.sectionBlockMap === 'object' ? JSON.stringify(patch.sectionBlockMap) : String(patch.sectionBlockMap))
            : (existing?.section_block_map || null);

        stmts.upsertNotionConfig.run({
            guild_id: guildId,
            notion_token: encToken,
            wiki_page_id: resolvedWikiId,
            meetings_db_id: resolvedMeetingsDb,
            org_info_page_id: resolvedOrgInfo,
            action_items_db_id: resolvedActionItems,
            members_db_id: resolvedMembersDb,
            sync_mode: resolvedSyncMode,
            section_block_map: resolvedBlockMap,
            created_at: existing?.created_at || now,
            updated_at: now,
        });
    }

    if (hasChannelPatch && !hasKeyPatch) {
        stmts.setChannelId.run(guildId, patch.notesChannelId || null, existing?.created_at || now, now);
    }

    if (hasAssistantChannelPatch) {
        stmts.setAssistantChannelId.run(guildId, patch.assistantChannelId || null, existing?.created_at || now, now);
    }

    if (hasDigestChannelPatch) {
        stmts.setDigestChannelId.run(guildId, patch.digestChannelId || null, existing?.created_at || now, now);
    }

    if (hasQuotaPatch) {
        stmts.setQuota.run(guildId, Math.max(0, parseInt(patch.dailyRequestLimit, 10) || 0), existing?.created_at || now, now);
    }

    syncToJson();
    return getGuildConfig(guildId);
}

function clearGuildNotionConfig(guildId) {
    stmts.clearNotionConfig.run(Date.now(), guildId);
    syncToJson();
}

function getNotesChannelId(guildId) {
    const row = stmts.getGuild.get(guildId);
    return row?.notes_channel_id || null;
}

function setNotesChannelId(guildId, channelId) {
    const now = Date.now();
    stmts.setChannelId.run(guildId, channelId, now, now);
    syncToJson();
}

function getAssistantChannelId(guildId) {
    const row = stmts.getGuild.get(guildId);
    return row?.assistant_channel_id || null;
}

function setAssistantChannelId(guildId, channelId) {
    const now = Date.now();
    stmts.setAssistantChannelId.run(guildId, channelId || null, now, now);
    syncToJson();
}

function getDigestChannelId(guildId) {
    const row = stmts.getGuild.get(guildId);
    return row?.digest_channel_id || null;
}

function setDigestChannelId(guildId, channelId) {
    const now = Date.now();
    stmts.setDigestChannelId.run(guildId, channelId || null, now, now);
    syncToJson();
}

function updateLastDigestAt(guildId, timestamp = Date.now()) {
    stmts.setLastDigestAt.run(timestamp, Date.now(), guildId);
}

function getGuildsWithDigestChannel() {
    try {
        return stmts.getGuildsWithDigest.all();
    } catch {
        return [];
    }
}

function recordSession({
    guildId,
    channelId = null,
    channelName = null,
    startedAt,
    endedAt,
    durationSeconds = 0,
    participantCount = 0,
    participants = '',
    summaryProvider = null,
    summaryModel = null,
    transcriptEntriesCount = 0,
    status,
    errorMessage = null,
    summaryText = null,
    rawTranscript = null,
}) {
    try {
        const info = stmts.insertSession.run({
            guild_id: guildId,
            channel_id: channelId,
            channel_name: channelName,
            started_at: typeof startedAt === 'object' ? startedAt.toISOString() : String(startedAt),
            ended_at: typeof endedAt === 'object' ? endedAt.toISOString() : String(endedAt),
            duration_seconds: Math.round(durationSeconds),
            participant_count: participantCount,
            participants: typeof participants === 'object' ? JSON.stringify(participants) : String(participants),
            summary_provider: summaryProvider,
            summary_model: summaryModel,
            transcript_entries_count: transcriptEntriesCount,
            status,
            error_message: errorMessage,
            summary_text: summaryText,
            raw_transcript: rawTranscript,
            created_at: Date.now(),
        });
        return info?.lastInsertRowid || null;
    } catch (err) {
        console.error('[database] Failed to record meeting session:', err);
        return null;
    }
}

function getSessionById(sessionId) {
    try {
        return stmts.getSessionById.get(sessionId) || null;
    } catch (err) {
        console.error('[database] Failed to get session by id:', err);
        return null;
    }
}

function getLatestCompletedSession(guildId) {
    return stmts.getLatestCompletedSession.get(guildId) || null;
}

function getGuildStats(guildId) {
    return stmts.getGuildStats.get(guildId) || {
        total_meetings: 0,
        completed_meetings: 0,
        failed_meetings: 0,
        total_duration_seconds: 0,
    };
}

function getRecentSessions(guildId, limit = 5) {
    return stmts.getRecentSessions.all(guildId, limit);
}

function logApiRequest({ guildId, service, model = null, status, tokensUsed = 0, errorMessage = null }) {
    try {
        stmts.insertApiRequest.run({
            guild_id: guildId,
            service,
            model,
            status,
            tokens_used: tokensUsed,
            error_message: errorMessage,
            created_at: Date.now(),
        });
    } catch (err) {
        console.error('[database] Failed to log API request:', err);
    }
}

function getGuildRequestStats(guildId) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneMinAgo = now - 60 * 1000;

    const dailyStats = stmts.getDailyRequestStats.get(guildId, oneDayAgo) || {
        total_requests_24h: 0,
        total_tokens_24h: 0,
        groq_requests_24h: 0,
        groq_tokens_24h: 0,
        stt_requests_24h: 0,
        summary_requests_24h: 0,
        rate_limit_hits_24h: 0,
    };

    const minuteStats = stmts.getMinuteRequestStats.get(guildId, oneMinAgo) || {
        total_requests_1m: 0,
        total_tokens_1m: 0,
        groq_requests_1m: 0,
        groq_tokens_1m: 0,
    };

    const lifetimeStats = stmts.getLifetimeRequestStats.get(guildId) || {
        total_lifetime_requests: 0,
        total_lifetime_tokens: 0,
    };

    const config = getGuildConfig(guildId);
    const limit = config.dailyRequestLimit || 0;
    const remaining = limit > 0 ? Math.max(0, limit - dailyStats.total_requests_24h) : null;

    return {
        daily: dailyStats,
        minute: minuteStats,
        lifetime: lifetimeStats,
        limits: GROQ_LIMITS,
        guildQuota: {
            limit,
            remaining,
        },
    };
}

function checkGroqDailyLimit(guildId = null) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let targetGuildId = guildId;
    if (guildId) {
        const config = getGuildConfig(guildId);
        if (!config.groqApiKey) {
            targetGuildId = null;
        }
    }
    const row = targetGuildId
        ? stmts.getGuildGroqUsageSince.get(targetGuildId, oneDayAgo)
        : stmts.getGroqUsageSince.get(oneDayAgo);

    const totalRequests = row?.total_requests || 0;
    const totalTokens = row?.total_tokens || 0;

    if (totalRequests >= GROQ_LIMITS.requestsPerDay) {
        return {
            allowed: false,
            reason: `Groq daily request limit reached (${totalRequests}/${GROQ_LIMITS.requestsPerDay} RPD). Limit resets in rolling 24h.`,
            usedRequests: totalRequests,
            usedTokens: totalTokens,
        };
    }

    if (totalTokens >= GROQ_LIMITS.tokensPerDay) {
        return {
            allowed: false,
            reason: `Groq daily token limit reached (${totalTokens}/${GROQ_LIMITS.tokensPerDay} TPD). Limit resets in rolling 24h.`,
            usedRequests: totalRequests,
            usedTokens: totalTokens,
        };
    }

    return {
        allowed: true,
        usedRequests: totalRequests,
        usedTokens: totalTokens,
        remainingRequests: GROQ_LIMITS.requestsPerDay - totalRequests,
        remainingTokens: GROQ_LIMITS.tokensPerDay - totalTokens,
    };
}

function checkRequestQuota(guildId) {
    const config = getGuildConfig(guildId);
    const limit = config.dailyRequestLimit || 0;
    if (limit <= 0) return { allowed: true, remaining: null, limit: 0, used: 0 };

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const countRow = stmts.countRequestsSince.get(guildId, oneDayAgo);
    const used = countRow ? countRow.total : 0;
    const remaining = Math.max(0, limit - used);

    return {
        allowed: used < limit,
        remaining,
        limit,
        used,
    };
}

function setGuildQuota(guildId, limit) {
    const now = Date.now();
    stmts.setQuota.run(guildId, Math.max(0, parseInt(limit, 10) || 0), now, now);
    syncToJson();
}

function sanitizeAuditDetails(details) {
    if (!details) return null;

    const redactRegex = /(ntn_[A-Za-z0-9]+|secret_[A-Za-z0-9]+|gsk_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|enc:v\d+:[0-9a-fA-F:]+)/gi;
    const redactString = (str) => {
        const redacted = str.replace(redactRegex, '[REDACTED_SECRET]');
        return redacted.length > 200 ? redacted.slice(0, 197) + '...' : redacted;
    };

    if (typeof details === 'string') {
        return redactString(details);
    }

    if (typeof details === 'object') {
        const sensitiveKeyNames = new Set([
            'token', 'notiontoken', 'apikey', 'groqapikey', 'geminiapikey',
            'password', 'secret', 'authorization', 'config_encryption_key',
            'configencryptionkey', 'encryptionkey', 'key', 'auth',
        ]);
        const sanitizeObj = (obj) => {
            if (Array.isArray(obj)) {
                return obj.map((item) => (typeof item === 'object' && item !== null ? sanitizeObj(item) : (typeof item === 'string' ? redactString(item) : item)));
            }
            const result = {};
            for (const [k, v] of Object.entries(obj)) {
                if (sensitiveKeyNames.has(k.toLowerCase())) {
                    result[k] = '[REDACTED_SECRET]';
                } else if (typeof v === 'string') {
                    result[k] = redactString(v);
                } else if (typeof v === 'object' && v !== null) {
                    result[k] = sanitizeObj(v);
                } else {
                    result[k] = v;
                }
            }
            return result;
        };
        const str = JSON.stringify(sanitizeObj(details));
        return str.length > 300 ? str.slice(0, 297) + '...' : str;
    }

    return String(details).slice(0, 200);
}

function logAudit({ guildId, userId, userTag, action, targetMemberId = null, details = null }) {
    if (!guildId || !userId || !action) return;
    try {
        stmts.insertAuditLog.run({
            guild_id: String(guildId),
            user_id: String(userId),
            user_tag: userTag ? String(userTag) : null,
            action: String(action),
            target_member_id: targetMemberId ? String(targetMemberId) : null,
            details: sanitizeAuditDetails(details),
            created_at: Date.now(),
        });
    } catch (err) {
        console.error('[database] Failed to insert audit log:', err);
    }
}

function getRecentAuditLogs(guildId, limit = 20) {
    try {
        return stmts.getAuditLogs.all(guildId, limit);
    } catch (err) {
        console.error('[database] Failed to query audit logs:', err);
        return [];
    }
}

function upsertNotionItem(item) {
    try {
        stmts.upsertNotionItem.run({
            id: item.id,
            guild_id: item.guildId,
            parent_id: item.parentId || null,
            database_id: item.databaseId || null,
            type: item.type || 'page',
            title: item.title || '',
            status: item.status || null,
            assignee: item.assignee || null,
            due_date: item.dueDate || null,
            properties_json: item.propertiesJson ? (typeof item.propertiesJson === 'string' ? item.propertiesJson : JSON.stringify(item.propertiesJson)) : null,
            content_markdown: item.contentMarkdown || '',
            url: item.url || null,
            updated_at: item.updatedAt || Date.now()
        });
        return true;
    } catch (err) {
        console.error('[database] Failed to upsert Notion item:', err);
        return false;
    }
}

function deleteNotionItem(id) {
    try {
        stmts.deleteNotionItem.run(id);
        return true;
    } catch (err) {
        console.error('[database] Failed to delete Notion item:', err);
        return false;
    }
}

function getNotionItem(id) {
    try {
        return stmts.getNotionItem.get(id);
    } catch (err) {
        console.error('[database] Failed to get Notion item:', err);
        return null;
    }
}

function getNotionItemsByGuild(guildId) {
    try {
        return stmts.getNotionItemsByGuild.all(guildId);
    } catch (err) {
        console.error('[database] Failed to get Notion items by guild:', err);
        return [];
    }
}

function sanitizeFts5Query(rawQuery, joinMode = 'AND') {
    if (!rawQuery || typeof rawQuery !== 'string') return '';
    // Extract alphanumeric/unicode word tokens and quote each one so FTS5 operators (&, -, *, :, etc.) never trigger syntax errors.
    const tokens = rawQuery
        .replace(/[^\p{L}\p{N}_]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return '';
    const quoted = tokens.map((t) => `"${t}"`);
    return joinMode === 'OR' ? quoted.join(' OR ') : quoted.join(' ');
}

function searchNotionItems(guildId, query) {
    const safeAndQuery = sanitizeFts5Query(query, 'AND');
    if (!safeAndQuery) return [];
    try {
        let results = stmts.searchNotionItems.all(guildId, safeAndQuery);
        if (results.length > 0) return results;

        // Recall fallback 1: FTS5 OR matching for multi-word natural queries
        const safeOrQuery = sanitizeFts5Query(query, 'OR');
        if (safeOrQuery && safeOrQuery !== safeAndQuery) {
            results = stmts.searchNotionItems.all(guildId, safeOrQuery);
            if (results.length > 0) return results;
        }

        // Recall fallback 2: LIKE search across title, markdown, assignee, status, properties_json
        const tokens = String(query)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_]+/gu, ' ')
            .trim()
            .split(/\s+/)
            .filter((t) => t.length >= 2);
        if (tokens.length > 0) {
            const pattern = `%${tokens[0]}%`;
            results = stmts.likeSearchNotionItems.all(guildId, pattern, pattern, pattern, pattern, pattern);
        }
        return results;
    } catch (err) {
        console.error('[database] Failed to search Notion items:', err);
        return [];
    }
}

function pruneNotionItemsNotIn(guildId, keepIds) {
    if (!guildId || !(keepIds instanceof Set)) return 0;
    try {
        const existing = stmts.getNotionItemsByGuild.all(guildId);
        let removed = 0;
        const delTx = db.transaction((items) => {
            for (const item of items) {
                if (!keepIds.has(item.id)) {
                    stmts.deleteNotionItem.run(item.id);
                    removed++;
                }
            }
        });
        delTx(existing);
        return removed;
    } catch (err) {
        console.error('[database] Failed to prune stale Notion items:', err);
        return 0;
    }
}

function upsertGuildWiki(guildId, rootPageId, tocMarkdown, structureJson, lastScannedAt) {
    try {
        stmts.upsertGuildWiki.run({
            guild_id: guildId,
            wiki_root_page_id: rootPageId,
            wiki_toc_markdown: tocMarkdown || null,
            structure_json: structureJson ? (typeof structureJson === 'string' ? structureJson : JSON.stringify(structureJson)) : null,
            last_scanned_at: lastScannedAt || Date.now()
        });
        return true;
    } catch (err) {
        console.error('[database] Failed to upsert Guild Wiki:', err);
        return false;
    }
}

function getGuildWiki(guildId) {
    try {
        return stmts.getGuildWiki.get(guildId);
    } catch (err) {
        console.error('[database] Failed to get Guild Wiki:', err);
        return null;
    }
}

function upsertUserMapping(guildId, discordUserId, discordDisplayName, notionUserName, notionUserId) {
    try {
        stmts.upsertUserMapping.run({
            guild_id: guildId,
            discord_user_id: discordUserId,
            discord_display_name: discordDisplayName || null,
            notion_user_name: notionUserName || null,
            notion_user_id: notionUserId || null
        });
        return true;
    } catch (err) {
        console.error('[database] Failed to upsert User Mapping:', err);
        return false;
    }
}

function getUserMapping(guildId, discordUserId) {
    try {
        return stmts.getUserMapping.get(guildId, discordUserId);
    } catch (err) {
        console.error('[database] Failed to get User Mapping:', err);
        return null;
    }
}

function getUserMappingByNotionName(guildId, notionUserName) {
    try {
        return stmts.getUserMappingByNotionName.get(guildId, notionUserName);
    } catch (err) {
        console.error('[database] Failed to get User Mapping by Notion name:', err);
        return null;
    }
}

function getUserMappingsByGuild(guildId) {
    try {
        return stmts.getUserMappingsByGuild.all(guildId);
    } catch (err) {
        console.error('[database] Failed to get User Mappings by guild:', err);
        return [];
    }
}

function deleteUserMapping(guildId, discordUserId) {
    try {
        stmts.deleteUserMapping.run(guildId, discordUserId);
        return true;
    } catch (err) {
        console.error('[database] Failed to delete User Mapping:', err);
        return false;
    }
}

const DEFAULT_CONVERSATION_TTL_MS = 30 * 60 * 1000;

function appendConversationTurn(guildId, channelId, { userId = null, role, authorName = null, content, createdAt = Date.now() }) {
    if (!guildId || !channelId || !role || !content) return false;
    try {
        stmts.insertConversationMsg.run({
            guild_id: String(guildId),
            channel_id: String(channelId),
            user_id: userId ? String(userId) : null,
            role: String(role),
            author_name: authorName ? String(authorName).slice(0, 64) : null,
            content: String(content).slice(0, 4000),
            created_at: createdAt,
        });
        return true;
    } catch (err) {
        console.error('[database] Failed to append conversation turn:', err);
        return false;
    }
}

function getConversationHistory(guildId, channelId, { limit = 8, ttlMs = DEFAULT_CONVERSATION_TTL_MS, maxTokens = 2500 } = {}) {
    if (!guildId || !channelId) return [];
    try {
        const cutoff = Date.now() - ttlMs;
        const rows = stmts.getRecentConversationMsgs.all(String(guildId), String(channelId), cutoff, limit);
        const result = [];
        let approxTokens = 0;
        // Walk backwards from most recent to enforce token budget, then reverse back to chronological
        for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            const est = Math.ceil((r.content || '').length / 4);
            if (result.length > 0 && approxTokens + est > maxTokens) break;
            approxTokens += est;
            result.unshift({
                role: r.role === 'assistant' ? 'assistant' : 'user',
                content: r.content,
                name: r.author_name || undefined,
                userId: r.user_id || undefined,
                createdAt: r.created_at,
            });
        }
        return result;
    } catch (err) {
        console.error('[database] Failed to get conversation history:', err);
        return [];
    }
}

function clearConversationHistory(guildId, channelId) {
    if (!guildId || !channelId) return false;
    try {
        stmts.clearConversationMsgs.run(String(guildId), String(channelId));
        return true;
    } catch (err) {
        console.error('[database] Failed to clear conversation history:', err);
        return false;
    }
}

function pruneOldConversationHistory(ttlMs = 24 * 60 * 60 * 1000) {
    try {
        stmts.pruneConversationMsgs.run(Date.now() - ttlMs);
    } catch {
        // Non-fatal
    }
}

module.exports = {
    db,
    GROQ_LIMITS,
    getGuildConfig,
    setGuildKeys,
    clearGuildKeys,
    setGuildNotionConfig,
    clearGuildNotionConfig,
    updateGuildConfig,
    getNotesChannelId,
    setNotesChannelId,
    getAssistantChannelId,
    setAssistantChannelId,
    getDigestChannelId,
    setDigestChannelId,
    updateLastDigestAt,
    getGuildsWithDigestChannel,
    recordSession,
    getSessionById,
    getLatestCompletedSession,
    getGuildStats,
    getRecentSessions,
    logApiRequest,
    getGuildRequestStats,
    checkGroqDailyLimit,
    checkRequestQuota,
    setGuildQuota,
    logAudit,
    getRecentAuditLogs,
    sanitizeAuditDetails,
    upsertNotionItem,
    deleteNotionItem,
    getNotionItem,
    getNotionItemsByGuild,
    searchNotionItems,
    pruneNotionItemsNotIn,
    upsertGuildWiki,
    getGuildWiki,
    upsertUserMapping,
    getUserMapping,
    getUserMappingByNotionName,
    getUserMappingsByGuild,
    deleteUserMapping,
    appendConversationTurn,
    getConversationHistory,
    clearConversationHistory,
    pruneOldConversationHistory,
};
