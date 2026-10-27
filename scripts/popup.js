function isValidMemoId(id) {
    return typeof id === 'string' && /^[1-9]\d*$/.test(id);
}

function queryActiveTab() {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || 'Could not find the active tab.'));
                    return;
                }
                if (!tabs || !tabs.length || typeof tabs[0].id !== 'number') {
                    reject(new Error('No active tab found.'));
                    return;
                }
                resolve(tabs[0]);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.sendMessage(tabId, message, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || 'Could not read the current profile.'));
                    return;
                }
                resolve(response);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || 'Extension message failed.'));
                    return;
                }
                resolve(response);
            });
        } catch (error) {
            reject(error);
        }
    });
}

const target = document.getElementById('memoInput');
const memoButton = document.getElementById('memoButton');
const memoTable = document.getElementById('memoTable');
let profileId = null;
let boundTabId = null;
let isSaving = false;

memoButton.disabled = true;

function addMemoRow(key, value) {
    const row = memoTable.insertRow(-1);
    const idCell = row.insertCell(0);
    const memoCell = row.insertCell(1);
    const profileCell = row.insertCell(2);

    idCell.textContent = key;
    idCell.title = key;
    idCell.classList.add('key-cell');

    memoCell.textContent = value;
    memoCell.title = key;
    memoCell.classList.add('value-cell');

    profileCell.textContent = 'profile';
    profileCell.addEventListener('click', () => {
        window.open('https://twitter.com/intent/user?user_id=' + encodeURIComponent(key));
    });
    profileCell.classList.add('profile-cell');
}

async function loadMemoList() {
    try {
        const response = await sendRuntimeMessage({ action: 'listMemo' });
        if (!response || response.ok === false || !response.res || typeof response.res !== 'object') {
            return;
        }
        for (const [key, value] of Object.entries(response.res)) {
            if (isValidMemoId(key) && typeof value === 'string') {
                addMemoRow(key, value);
            }
        }
    } catch (error) {
        // The memo list is informational and does not affect the selected profile.
    }
}

async function loadCurrentProfile() {
    try {
        const tab = await queryActiveTab();
        boundTabId = tab.id;
        const response = await sendTabMessage(tab.id, { action: 'tmemo_requestData' });
        if (!response || response.ok === false || !isValidMemoId(response.id)) {
            target.placeholder = 'not on profile page';
            return;
        }

        profileId = response.id;
        memoButton.disabled = false;
        try {
            const memoResponse = await sendRuntimeMessage({ action: 'getMemo', id: profileId });
            if (!memoResponse || memoResponse.ok === false) {
                target.placeholder = 'could not load memo';
                return;
            }
            target.placeholder = typeof memoResponse.res === 'string' && memoResponse.res ? memoResponse.res : 'no memo';
        } catch (error) {
            target.placeholder = 'could not load memo';
        }
    } catch (error) {
        target.placeholder = 'not on profile page';
    }
}

async function saveMemo() {
    if (!profileId || !isValidMemoId(profileId) || isSaving) {
        return;
    }

    isSaving = true;
    memoButton.disabled = true;
    try {
        const activeTab = await queryActiveTab();
        if (activeTab.id !== boundTabId) {
            profileId = null;
            target.placeholder = 'tab changed; reopen popup';
            throw new Error('The active tab changed. Reopen the popup to select its profile.');
        }

        const currentProfile = await sendTabMessage(activeTab.id, { action: 'tmemo_requestData' });
        if (!currentProfile || currentProfile.ok === false || currentProfile.id !== profileId) {
            profileId = null;
            target.placeholder = 'profile changed; reopen popup';
            throw new Error('The profile changed. Reopen the popup to select its profile.');
        }

        const response = await sendRuntimeMessage({
            action: 'setMemo',
            id: profileId,
            memo: target.value,
        });
        if (!response || response.ok !== true) {
            throw new Error(response && response.error ? response.error : 'Storage did not confirm the save.');
        }

        target.value = '';
        alert('The memo is saved. Please refresh to see the change.');
        location.replace(location.href);
    } catch (error) {
        alert('The memo could not be saved: ' + error.message);
    } finally {
        isSaving = false;
        memoButton.disabled = !profileId;
    }
}

memoButton.addEventListener('click', saveMemo);
target.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        saveMemo();
    }
});

loadCurrentProfile();
loadMemoList();
