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

var tid = getTabID().then(tabId => {
    return tabId;
}).catch(error => {
    console.error(error);
});


var id = 0;

async function setMemo(id, memo) {
    await chrome.runtime.sendMessage({action: 'setMemo', id: id, memo: memo}, function(response) {
        console.log(response.res);
    });
}

var target = document.getElementById('memoInput')

chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    var tabId = tabs[0].id;
    chrome.tabs.sendMessage(tabId, {action: 'tmemo_requestData'}, async function(response) {
        if (response.id === 'not found') {
            console.log('id not found');
        }
        id = response.id;
        await chrome.runtime.sendMessage({action: 'getMemo', id: id}, function(response) {
            console.log(response.res, id);
            memo = response.res;
            target.placeholder = memo || "no memo";
        });
    });
});


document.getElementById('memoButton').addEventListener('click', ()=>{
    setMemo(id, target.value);
    target.value = '';
    alert('The memo is saved. Please refresh to see the change.');
    location.replace(location.href);
    
});

document.getElementById('memoInput').addEventListener('keypress', (e)=>{
    if (e.key === 'Enter') {
        setMemo(id, target.value);
        target.value = '';
        alert('The memo is saved. Please refresh to see the change.');
        location.replace(location.href);
    }
});