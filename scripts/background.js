importScripts('shared.js');

const MESSAGE_ACTIONS = new Set(['getMemo', 'setMemo', 'listMemo', 'rememberMemoProfile']);
let storageMutationQueue = Promise.resolve();

function serializeStorageMutation(operation) {
    const result = storageMutationQueue.then(operation, operation);
    storageMutationQueue = result.catch(() => {});
    return result;
}

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
        const handle = request.handle === undefined ? null : TwitterMemo.normalizeHandle(request.handle);
        if (request.handle !== undefined && !handle) return { ok: false, error: 'Invalid profile handle.' };
        return serializeStorageMutation(async () => {
            const items = await chrome.storage.local.get([request.id, TwitterMemo.PROFILE_INDEX_STORAGE_KEY]);
            const index = items[TwitterMemo.PROFILE_INDEX_STORAGE_KEY];
            if (request.memo.length === 0) {
                await chrome.storage.local.set({
                    [TwitterMemo.PROFILE_INDEX_STORAGE_KEY]: TwitterMemo.removeMemoProfile(index, request.id),
                });
                await chrome.storage.local.remove(request.id);
                return { ok: true, res: 'memo is deleted' };
            }

            const values = { [request.id]: request.memo };
            if (handle) {
                values[TwitterMemo.PROFILE_INDEX_STORAGE_KEY] = TwitterMemo.addVerifiedMemoProfile(index, request.id, handle);
            }
            await chrome.storage.local.set(values);
            return { ok: true, res: 'memo is set' };
        });
    }

    if (request.action === 'rememberMemoProfile') {
        if (!TwitterMemo.isValidMemoId(request.id) || !TwitterMemo.normalizeHandle(request.handle)) {
            return { ok: false, error: 'Invalid profile association.' };
        }
        const handle = TwitterMemo.normalizeHandle(request.handle);
        return serializeStorageMutation(async () => {
            const items = await chrome.storage.local.get([request.id, TwitterMemo.PROFILE_INDEX_STORAGE_KEY]);
            const memo = items[request.id];
            if (typeof memo !== 'string' || memo.length === 0) return { ok: true, res: false };

            const nextIndex = TwitterMemo.addVerifiedMemoProfile(items[TwitterMemo.PROFILE_INDEX_STORAGE_KEY], request.id, handle);
            const currentIndex = TwitterMemo.normalizeProfileIndex(items[TwitterMemo.PROFILE_INDEX_STORAGE_KEY]);
            if (currentIndex[request.id] === nextIndex[request.id] &&
                Object.keys(currentIndex).length === Object.keys(nextIndex).length) {
                return { ok: true, res: true };
            }
            await chrome.storage.local.set({ [TwitterMemo.PROFILE_INDEX_STORAGE_KEY]: nextIndex });
            return { ok: true, res: true };
        });
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
