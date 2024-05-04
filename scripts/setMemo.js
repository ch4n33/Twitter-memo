function setMemo(id, memo) {
    chrome.storage.local.set({id:memo}, function() {
        console.log(id + "'s Memo is set to " + memo);
    });
}