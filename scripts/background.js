chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
        text: "OFF",
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action == "getMemo") {
        var id = request.id;
        chrome.storage.local.get(
            [id], 
            (result) => {
                sendResponse({res : result[id]});
        });   
        return true;         
    }
});
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action == "setMemo") {
        var id = request.id;
        var memo = request.memo;
        var a = {};
        a[id] = memo;
        chrome.storage.local.set(a, ()=>{
        });
        sendResponse({ res: 'memo is set' });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action == "listMemo") {
        chrome.storage.local.get(null, (items) => {
            sendResponse({res : items});
        });
        return true;         
    }
});