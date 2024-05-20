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

var id = 0;

async function setMemo(id, memo) {
    await chrome.runtime.sendMessage({action: 'setMemo', id: id, memo: memo}, function(response) {
        console.log(response.res);
    });
}

var target = document.getElementById('memoInput');
const regex_twitter_handle = /^https:\/\/(twitter\.com|x\.com)\/(?!home$)((intent\/user\?screen_name=[a-zA-Z0-9_]{1,15}$)|(([a-zA-Z0-9_]{1,15})(\/(with_replies|highlights|articles|media|likes))(\?.*)?$))/;

chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    var tabId = tabs[0].id;
    var url = tabs[0].url;
    if (!regex_twitter_handle.test(url)) {
        target.placeholder = "not on profile page";
        return;
    }
    chrome.tabs.sendMessage(tabId, {action: 'tmemo_requestData'}, function(response) {
        if (!response) {
            target.placeholder = "not on profile page";
            return;
        }
        if (response.id === 'not found') {
            console.log('id not found');
        }
        id = response.id;
        
        chrome.runtime.sendMessage({action: 'getMemo', id: id}, function(response) {
            console.log(response.res, id);
            memo = response.res;
            target.placeholder = memo || "no memo";
        });
    });
});

chrome.runtime.sendMessage({action: 'listMemo', id: id}, function(response) {
    console.log(response.res);
    //TODO: display all memos in shape of tables
    const table = document.getElementById('memoTable');
    const addMemoRow = (key, value) => {
        var row = table.insertRow(-1);
        var idCell = row.insertCell(0);
        var memoCell = row.insertCell(1);
        var profileCell = row.insertCell(2);
        idCell.innerHTML = key;
        idCell.title = key; // 마우스 오버레이로 전체 키 보여주기
        idCell.classList.add('key-cell');

        memoCell.innerHTML = value;
        memoCell.title = key; // 마우스 오버레이로 전체 키 보여주기
        memoCell.classList.add('value-cell');

        profileCell.innerHTML = 'profile';
        profileCell.onclick = function() {
            const currentUrl = window.location.href;
            let domain = 'twitter.com';
            if (currentUrl.includes('x.com')) {
                domain = 'x.com';
            }
            window.open(`https://${domain}/intent/user?user_id=${key}`);
        };
        profileCell.classList.add('profile-cell');
    };
    for (const key in response.res) {
        if (response.res.hasOwnProperty(key)) {
            addMemoRow(key, response.res[key]);
        }
    } 
});

document.getElementById('memoButton').addEventListener('click', () => {
    setMemo(id, target.value);
    target.value = '';
    alert('The memo is saved. Please refresh to see the change.');
    location.replace(location.href);
});

document.getElementById('memoInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        setMemo(id, target.value);
        target.value = '';
        alert('The memo is saved. Please refresh to see the change.');
        location.replace(location.href);
    }
});
