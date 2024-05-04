console.log('This is a popup!');

function getTabID() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs.length) {
                resolve(tabs[0].id);
            } else {
                reject(Error("No active tab found"));
            }
        });
    });
}

async function onWindowLoad() {
    var tid = getTabID().then(tabId => {
        return tabId;
    }).catch(error => {
        console.error(error);
    });
    console.log(tid, "tab id", typeof(tid));
    chrome.scripting.executeScript({
        target : {tabId: await tid, allFrames: true}, 
        files: ["scripts/memo.js"]
        }).then(
        injectionResults =>{
			console.log("Injection Success on popup.js")
        }
    );
}
window.onload = onWindowLoad;

var id = 0;
var old_memo = "";
chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        console.log(request.id, request.memo);
        id = request.id;
        old_memo = request.memo;
        sendResponse({received: true});
    }
);
document.getElementById('memoInput').value = old_memo