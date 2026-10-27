function isValidMemoId(id) {
    return typeof id === 'string' && /^[1-9]\d*$/.test(id);
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({ text: 'OFF' });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.action !== 'string') {
        return false;
    }

    if (request.action === 'getMemo') {
        if (!isValidMemoId(request.id)) {
            sendResponse({ ok: false, error: 'Invalid profile ID.' });
            return false;
        }

        try {
            chrome.storage.local.get([request.id], (result) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
                    return;
                }
                sendResponse({ ok: true, res: result[request.id] });
            });
        } catch (error) {
            sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
        }
        return true;
    }

    if (request.action === 'setMemo') {
        if (!isValidMemoId(request.id) || typeof request.memo !== 'string') {
            sendResponse({ ok: false, error: 'Invalid memo request.' });
            return false;
        }

        const item = { [request.id]: request.memo };
        try {
            chrome.storage.local.set(item, () => {
                const error = chrome.runtime.lastError;
                if (error) {
                    sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
                    return;
                }
                sendResponse({ ok: true, res: 'memo is set' });
            });
        } catch (error) {
            sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
        }
        return true;
    }

    if (request.action === 'listMemo') {
        try {
            chrome.storage.local.get(null, (items) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
                    return;
                }
                sendResponse({ ok: true, res: items });
            });
        } catch (error) {
            sendResponse({ ok: false, error: error.message || 'Storage request failed.' });
        }
        return true;
    }

    return false;
});
