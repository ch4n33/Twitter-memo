const TwitterMemo = globalThis.TwitterMemo;
const memoForm = document.getElementById('memoForm');
const memoInput = document.getElementById('memoInput');
const memoButton = document.getElementById('memoButton');
const currentHandle = document.getElementById('currentHandle');
const status = document.getElementById('memoStatus');
const memoRows = document.getElementById('memoRows');

let profile = null;
let canSave = false;
let isSaving = false;
let memoListGeneration = 0;

function setStatus(message) {
    status.textContent = message;
}

async function queryActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('현재 탭을 확인할 수 없습니다.');
    return tab;
}

async function requestProfile(tabId) {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'tmemo_requestData' });
    const handle = response && TwitterMemo.normalizeHandle(response.handle);
    if (!response || response.ok !== true || !TwitterMemo.isValidMemoId(response.id) || !handle) {
        throw new Error('X 또는 Twitter 프로필에서 팝업을 열어 주세요.');
    }
    return { id: response.id, handle };
}

function createMemoRow(id, memo) {
    const row = document.createElement('tr');
    row.dataset.memoId = id;

    const idCell = document.createElement('td');
    idCell.className = 'key-cell';
    idCell.textContent = id;
    idCell.title = id;

    const memoCell = document.createElement('td');
    memoCell.className = 'value-cell';
    memoCell.textContent = memo;
    memoCell.title = memo;

    const profileCell = document.createElement('td');
    profileCell.className = 'profile-cell';
    const profileLink = document.createElement('a');
    profileLink.href = `https://x.com/i/user/${id}`;
    profileLink.target = '_blank';
    profileLink.rel = 'noopener noreferrer';
    profileLink.textContent = '프로필 열기';
    profileCell.appendChild(profileLink);

    row.append(idCell, memoCell, profileCell);
    return row;
}

function renderMemoList(items) {
    memoRows.replaceChildren();
    for (const [id, memo] of Object.entries(items || {})) {
        if (TwitterMemo.isValidMemoId(id) && typeof memo === 'string' && memo.length > 0) {
            memoRows.appendChild(createMemoRow(id, memo));
        }
    }
}

function updateMemoRow(id, memo) {
    const existing = Array.from(memoRows.rows).find((row) => row.dataset.memoId === id);
    if (memo.length === 0) {
        if (existing) existing.remove();
        return;
    }
    if (existing) {
        const memoCell = existing.cells[1];
        memoCell.textContent = memo;
        memoCell.title = memo;
    } else {
        memoRows.prepend(createMemoRow(id, memo));
    }
}

async function loadMemoList() {
    const requestGeneration = ++memoListGeneration;
    try {
        const response = await chrome.runtime.sendMessage({ action: 'listMemo' });
        if (requestGeneration !== memoListGeneration) return;
        if (response && response.ok === true) renderMemoList(response.res);
    } catch (error) {
        // The list is informational; the current memo remains available independently.
    }
}

async function loadCurrentProfile() {
    memoInput.disabled = true;
    memoButton.disabled = true;
    setStatus('현재 프로필을 불러오는 중입니다…');
    try {
        const tab = await queryActiveTab();
        const current = await requestProfile(tab.id);
        profile = { ...current, tabId: tab.id };
        currentHandle.textContent = `@${current.handle}`;

        let response;
        try {
            response = await chrome.runtime.sendMessage({ action: 'getMemo', id: current.id });
        } catch (error) {
            throw new Error('저장된 메모를 불러오지 못했습니다.');
        }
        if (!response || response.ok !== true) {
            throw new Error('저장된 메모를 불러오지 못했습니다.');
        }
        if (memoInput.value === '') memoInput.value = typeof response.res === 'string' ? response.res : '';
        canSave = true;
        memoInput.disabled = false;
        memoButton.disabled = false;
        setStatus(memoInput.value ? '메모를 불러왔습니다. 내용을 수정하거나 비우면 삭제됩니다.' : '저장된 메모가 없습니다.');
    } catch (error) {
        canSave = false;
        memoInput.disabled = true;
        memoButton.disabled = true;
        const message = error.message === '저장된 메모를 불러오지 못했습니다.'
            ? '저장된 메모를 불러오지 못했습니다. 저장은 비활성화됩니다.'
            : error.message || '현재 프로필을 확인할 수 없습니다.';
        setStatus(message);
    }
}

async function saveMemo(event) {
    event.preventDefault();
    if (!canSave || !profile || isSaving) return;

    isSaving = true;
    memoInput.disabled = true;
    memoButton.disabled = true;
    setStatus('메모를 저장하는 중입니다…');
    try {
        let tab;
        try {
            tab = await queryActiveTab();
        } catch (error) {
            canSave = false;
            throw error;
        }
        if (tab.id !== profile.tabId) {
            canSave = false;
            throw new Error('현재 탭이 바뀌었습니다. 팝업을 다시 열어 주세요.');
        }

        let current;
        try {
            current = await requestProfile(tab.id);
        } catch (error) {
            canSave = false;
            throw error;
        }
        if (current.id !== profile.id) {
            canSave = false;
            throw new Error('프로필이 바뀌었습니다. 팝업을 다시 열어 주세요.');
        }
        profile = { ...current, tabId: tab.id };
        currentHandle.textContent = `@${current.handle}`;

        const memo = memoInput.value;
        const response = await chrome.runtime.sendMessage({ action: 'setMemo', id: profile.id, memo });
        if (!response || response.ok !== true) {
            throw new Error(response && response.error ? response.error : '저장을 확인하지 못했습니다.');
        }

        memoListGeneration += 1;
        updateMemoRow(profile.id, memo);
        loadMemoList();
        setStatus(memo.length === 0 ? '메모를 삭제했습니다.' : '메모를 저장했습니다.');
    } catch (error) {
        setStatus(`${error.message || '메모를 저장하지 못했습니다.'} 입력 내용은 유지했습니다.`);
    } finally {
        isSaving = false;
        memoInput.disabled = !canSave;
        memoButton.disabled = !canSave;
    }
}

memoForm.addEventListener('submit', saveMemo);

loadCurrentProfile();
loadMemoList();
