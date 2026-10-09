const { withRetry } = require('./notion');

/**
 * Extracts plain text from a Notion block depending on its type.
 */
function getBlockText(block) {
    if (!block || !block.type) return '';
    const typeData = block[block.type];
    if (!typeData) return '';
    if (Array.isArray(typeData.rich_text)) {
        return typeData.rich_text.map((t) => t.plain_text || t.text?.content || '').join('');
    }
    if (Array.isArray(typeData.title)) {
        return typeData.title.map((t) => t.plain_text || t.text?.content || '').join('');
    }
    return '';
}

/**
 * Finds the Sprint Focus & Notice Board callout block on a Central Wiki page.
 */
async function findNoticeBoardBlock(client, wikiPageId) {
    if (!client || !wikiPageId) return null;
    const cleanId = wikiPageId.replace(/-/g, '');

    const res = await withRetry(() => client.blocks.children.list({
        block_id: cleanId,
        page_size: 40,
    }));

    for (const b of (res.results || [])) {
        if (b.type === 'callout') {
            const text = getBlockText(b);
            if (/notice board|sprint focus/i.test(text)) {
                return { id: b.id, block: b, text };
            }
        }
    }
    return null;
}

/**
 * Parses raw plain text of a notice board callout into structured parts.
 */
function parseNoticeBoardText(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const items = [];
    let title = 'Omnori Sprint Focus & Notice Board';
    let northStar = 'Validate & scale users/clients → reinvest cashflow into proprietary tech.';
    let corePolicy = 'Never dilute more than 5%.';

    for (const line of lines) {
        if (/sprint focus|notice board/i.test(line) && !line.startsWith('•') && !line.startsWith('-')) {
            title = line.replace(/^[⚡📢]\s*/, '').trim();
            continue;
        }
        if (/north star:/i.test(line)) {
            const m = line.match(/north star:\s*(.*)/i);
            if (m && m[1]) northStar = m[1].replace(/💡.*$/, '').trim();
            continue;
        }
        if (/core policy:/i.test(line)) {
            const m = line.match(/core policy:\s*(.*)/i);
            if (m && m[1]) corePolicy = m[1].trim();
            continue;
        }
        if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
            const cleaned = line.replace(/^[•\-*]\s*/, '').trim();
            if (cleaned) items.push(cleaned);
        } else if (line.length > 0 && !line.includes('North Star') && !line.includes('Core Policy')) {
            items.push(line);
        }
    }

    return { title, items, northStar, corePolicy };
}

/**
 * Builds Notion rich_text array from notice board parts.
 */
function buildNoticeBoardRichText({
    title = 'Omnori Sprint Focus & Notice Board',
    items = [],
    northStar = 'Validate & scale users/clients → reinvest cashflow into proprietary tech.',
    corePolicy = 'Never dilute more than 5%.',
}) {
    const richText = [];

    // Header title
    richText.push({
        type: 'text',
        text: { content: `${title}\n` },
        annotations: { bold: true },
    });

    // Notice items
    for (const item of items) {
        const clean = item.trim();
        if (!clean) continue;
        const line = clean.startsWith('•') ? `${clean}\n` : `• ${clean}\n`;
        richText.push({
            type: 'text',
            text: { content: line },
        });
    }

    // Footer spacing & North Star
    richText.push({
        type: 'text',
        text: { content: '\n🎯 ' },
    });
    richText.push({
        type: 'text',
        text: { content: 'North Star: ' },
        annotations: { bold: true },
    });
    richText.push({
        type: 'text',
        text: { content: `${northStar}\n💡 ` },
    });
    richText.push({
        type: 'text',
        text: { content: 'Core Policy: ' },
        annotations: { bold: true },
    });
    richText.push({
        type: 'text',
        text: { content: corePolicy },
    });

    return richText;
}

/**
 * Reads the current notice board from Notion.
 */
async function readNoticeBoard(client, wikiPageId) {
    const found = await findNoticeBoardBlock(client, wikiPageId);
    if (!found) {
        return {
            exists: false,
            message: 'No Sprint Focus & Notice Board callout found on the Central Wiki.',
        };
    }

    const parsed = parseNoticeBoardText(found.text);
    return {
        exists: true,
        blockId: found.id,
        rawText: found.text,
        title: parsed.title,
        items: parsed.items,
        northStar: parsed.northStar,
        corePolicy: parsed.corePolicy,
    };
}

/**
 * Updates the Notice Board callout block on Notion.
 * Actions:
 *  - 'add' / 'append': Appends or updates notice items while preserving structure
 *  - 'set' / 'replace': Overwrites notice items with new content
 *  - 'clear': Clears non-core notice items
 */
async function updateNoticeBoardCallout(client, wikiPageId, options = {}) {
    const {
        action = 'add',
        text = '',
        items = [],
        category = '',
        northStar,
        corePolicy,
    } = options;

    let targetBlock = await findNoticeBoardBlock(client, wikiPageId);

    // If block doesn't exist, create it at the top of the wiki page
    if (!targetBlock) {
        const initialRichText = buildNoticeBoardRichText({
            title: 'Omnori Sprint Focus & Notice Board',
            items: items.length > 0 ? items : (text ? [text] : []),
            northStar: northStar || 'Validate & scale users/clients → reinvest cashflow into proprietary tech.',
            corePolicy: corePolicy || 'Never dilute more than 5%.',
        });

        const created = await withRetry(() => client.blocks.children.append({
            block_id: wikiPageId.replace(/-/g, ''),
            children: [{
                object: 'block',
                type: 'callout',
                callout: {
                    icon: { type: 'emoji', emoji: '⚡' },
                    color: 'yellow_background',
                    rich_text: initialRichText,
                },
            }],
        }));

        const newBlock = created.results?.[0];
        return {
            success: true,
            created: true,
            blockId: newBlock?.id,
            action,
            items: items.length > 0 ? items : (text ? [text] : []),
        };
    }

    const current = parseNoticeBoardText(targetBlock.text);
    let updatedItems = [...current.items];

    if (action === 'clear') {
        updatedItems = [];
    } else if (action === 'set' || action === 'replace') {
        if (items && items.length > 0) {
            updatedItems = items;
        } else if (text) {
            updatedItems = text.split('\n').map((l) => l.trim()).filter(Boolean);
        } else {
            updatedItems = [];
        }
    } else {
        // action === 'add' or 'append'
        const candidateItems = items.length > 0 ? items : (text ? [text] : []);
        for (const cand of candidateItems) {
            const cleanCand = cand.trim().replace(/^[•\-*]\s*/, '');
            if (!cleanCand) continue;

            const formattedCand = category
                ? `${category}: ${cleanCand}`
                : cleanCand;

            // Check if item already exists or updates an existing prefix
            const prefix = formattedCand.split(':')[0].trim().toLowerCase();
            const existingIndex = updatedItems.findIndex((it) => {
                const itPrefix = it.split(':')[0].trim().toLowerCase();
                return itPrefix === prefix && prefix.length > 3;
            });

            if (existingIndex >= 0) {
                updatedItems[existingIndex] = formattedCand;
            } else {
                updatedItems.push(formattedCand);
            }
        }
    }

    const finalRichText = buildNoticeBoardRichText({
        title: current.title,
        items: updatedItems,
        northStar: northStar || current.northStar,
        corePolicy: corePolicy || current.corePolicy,
    });

    await withRetry(() => client.blocks.update({
        block_id: targetBlock.id,
        callout: {
            rich_text: finalRichText,
        },
    }));

    return {
        success: true,
        blockId: targetBlock.id,
        action,
        items: updatedItems,
        title: current.title,
    };
}

/**
 * Synchronizes meeting updates that impact the Sprint Focus & Notice Board.
 */
async function syncNoticeBoardFromMeetingUpdates({ client, wikiPageId, updates = [] }) {
    if (!client || !wikiPageId || !updates || updates.length === 0) {
        return { applied: 0, items: [] };
    }

    const noticeUpdates = updates.filter((u) => {
        const sec = (u.section || '').toLowerCase();
        const content = (u.content || '').toLowerCase();
        return sec.includes('sprint focus') ||
               sec.includes('notice') ||
               content.includes('notice board') ||
               content.includes('announcement') ||
               content.includes('launch') ||
               content.includes('deadline');
    });

    if (noticeUpdates.length === 0) {
        return { applied: 0, items: [] };
    }

    const itemsToAdd = noticeUpdates.map((u) => {
        let content = u.content.replace(/^[•\-*]\s*/, '').trim();
        return content;
    });

    const res = await updateNoticeBoardCallout(client, wikiPageId, {
        action: 'add',
        items: itemsToAdd,
    });

    return {
        applied: itemsToAdd.length,
        items: itemsToAdd,
        blockId: res.blockId,
    };
}

module.exports = {
    findNoticeBoardBlock,
    parseNoticeBoardText,
    buildNoticeBoardRichText,
    readNoticeBoard,
    updateNoticeBoardCallout,
    syncNoticeBoardFromMeetingUpdates,
};
