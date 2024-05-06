chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
        text: "OFF",
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action == "getMemo") {
        var id = request.id;
        console.log(id, Date.now());
        chrome.storage.local.get(
            [id], 
            (result) => {
                console.log('background.js: getMemo:', result[id], Date.now());
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
            console.log('background.js: set memo:', memo, ', ',typeof(memo));
        });
        sendResponse({ res: 'memo is set' });
    }
});
