
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
console.log("content.js")
chrome.scripting.executeScript(
    {
        target: {
            tabId: await getTabID(),
            allFrames: true
        },
        files: ["memo.js"]
    }
)
.then(function(){
    console.log("Injected")
});