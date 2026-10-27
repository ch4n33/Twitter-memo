importScripts('shared.js');

const MESSAGE_ACTIONS = new Set(['getMemo', 'setMemo', 'listMemo']);

async function handleMessage(request) {
    if (request.action === 'getMemo') {
        if (!TwitterMemo.isValidMemoId(request.id)) return { ok: false, error: 'Invalid profile ID.' };
        const result = await chrome.storage.local.get([request.id]);
        return { ok: true, res: result[request.id] };
    }

    if (request.action === 'setMemo') {
        if (!TwitterMemo.isValidMemoId(request.id) || typeof request.memo !== 'string') {
            return { ok: false, error: 'Invalid memo request.' };
        }
        if (request.memo.length === 0) {
            await chrome.storage.local.remove(request.id);
            return { ok: true, res: 'memo is deleted' };
        }
        await chrome.storage.local.set({ [request.id]: request.memo });
        return { ok: true, res: 'memo is set' };
    }

    const items = await chrome.storage.local.get(null);
    return { ok: true, res: items };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !MESSAGE_ACTIONS.has(request.action)) return false;
    handleMessage(request).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error && error.message ? error.message : 'Storage request failed.' });
    });
    return true;
});
