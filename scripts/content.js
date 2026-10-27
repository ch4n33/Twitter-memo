const { getValidatedProfile, getVisibleUserNameElement } = globalThis.TwitterMemo;

let activeProfile = null;
let activeMemo = '';
let memoLoaded = false;
let memoRequestGeneration = -1;
let memoReadToken = 0;
let profileGeneration = 0;
let lastObservedHref = window.location.href;
let memoElement = null;
let refreshScheduled = false;

function currentProfile() {
    return getValidatedProfile(window.location.href, document);
}

function sameProfile(left, right) {
    return Boolean(left && right && left.id === right.id && left.handle.toLowerCase() === right.handle.toLowerCase());
}

function isWithinMemoElement(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (element) {
        if (element.getAttribute && element.getAttribute('data-twitter-memo-display') === 'true') return true;
        element = element.parentElement;
    }
    return false;
}

function removeMemoElement() {
    if (memoElement && memoElement.parentNode) memoElement.parentNode.removeChild(memoElement);
    memoElement = null;
}

function ensureMemoElement(userName) {
    if (!memoElement) {
        memoElement = document.createElement('div');
        memoElement.setAttribute('data-twitter-memo-display', 'true');
        memoElement.className = 'twitter-memo-display';
    }
    const parent = userName.parentNode;
    if (!parent) return null;
    if (memoElement.parentNode !== parent || memoElement.previousSibling !== userName) {
        if (memoElement.parentNode) memoElement.parentNode.removeChild(memoElement);
        parent.insertBefore(memoElement, userName.nextSibling);
    }
    return memoElement;
}

function renderMemo(profile, memo) {
    if (!sameProfile(currentProfile(), profile)) {
        syncProfile();
        return;
    }
    if (!memo) {
        removeMemoElement();
        return;
    }
    const userName = getVisibleUserNameElement(document);
    const element = userName && ensureMemoElement(userName);
    if (element) element.textContent = `@${profile.handle} : '${memo}'`;
}

function loadMemo(profile, requestGeneration) {
    memoRequestGeneration = requestGeneration;
    const requestToken = ++memoReadToken;
    chrome.runtime.sendMessage({ action: 'getMemo', id: profile.id }).then((response) => {
        if (requestToken !== memoReadToken || requestGeneration !== profileGeneration || !sameProfile(activeProfile, profile)) return;
        if (!sameProfile(currentProfile(), profile)) {
            syncProfile();
            return;
        }
        activeMemo = response && response.ok !== false && typeof response.res === 'string' ? response.res : '';
        memoLoaded = true;
        memoRequestGeneration = -1;
        renderMemo(profile, activeMemo);
    }).catch(() => {
        if (requestToken !== memoReadToken || requestGeneration !== profileGeneration || !sameProfile(activeProfile, profile)) return;
        if (!sameProfile(currentProfile(), profile)) {
            syncProfile();
            return;
        }
        activeMemo = '';
        memoLoaded = true;
        memoRequestGeneration = -1;
        renderMemo(profile, activeMemo);
    });
}

function noteHrefChange() {
    const href = window.location.href;
    if (href !== lastObservedHref) {
        lastObservedHref = href;
        profileGeneration += 1;
    }
}

function syncProfile() {
    noteHrefChange();
    const profile = currentProfile();
    if (!profile) {
        if (activeProfile || memoElement) profileGeneration += 1;
        memoReadToken += 1;
        activeProfile = null;
        activeMemo = '';
        memoLoaded = false;
        memoRequestGeneration = -1;
        removeMemoElement();
        return null;
    }

    if (!sameProfile(activeProfile, profile)) {
        profileGeneration += 1;
        memoReadToken += 1;
        activeProfile = profile;
        activeMemo = '';
        memoLoaded = false;
        memoRequestGeneration = -1;
    } else {
        activeProfile = profile;
    }

    if (activeMemo) {
        const userName = getVisibleUserNameElement(document);
        const element = userName && ensureMemoElement(userName);
        if (element) element.textContent = `@${profile.handle} : '${activeMemo}'`;
    } else {
        removeMemoElement();
    }

    if (!memoLoaded && memoRequestGeneration !== profileGeneration) loadMemo(profile, profileGeneration);
    return profile;
}

function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    Promise.resolve().then(() => {
        refreshScheduled = false;
        syncProfile();
    });
}

function isIdentityRelatedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches && node.matches('script[type="application/ld+json"], [data-testid="UserName"]')) return true;
    return Boolean(node.querySelector && node.querySelector('script[type="application/ld+json"], [data-testid="UserName"]'));
}

function isInIdentityArea(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (element) {
        if (element.matches && element.matches('script[type="application/ld+json"], [data-testid="UserName"]')) return true;
        element = element.parentElement;
    }
    return false;
}

function shouldRefreshForMutation(mutation) {
    if (isWithinMemoElement(mutation.target)) return false;
    if (isInIdentityArea(mutation.target)) return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(isIdentityRelatedNode);
}

function onPotentialNavigation() {
    noteHrefChange();
    scheduleRefresh();
}

function wrapHistoryMethod(methodName) {
    const history = window.history;
    const original = history && history[methodName];
    if (typeof original !== 'function') return;
    try {
        history[methodName] = function() {
            const result = original.apply(this, arguments);
            onPotentialNavigation();
            return result;
        };
    } catch (error) {
        // Page DOM mutations and popstate still cover navigation if the method cannot be wrapped.
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !activeProfile || !Object.prototype.hasOwnProperty.call(changes, activeProfile.id)) return;
    const change = changes[activeProfile.id];
    memoReadToken += 1;
    activeMemo = change && typeof change.newValue === 'string' ? change.newValue : '';
    memoLoaded = true;
    renderMemo(activeProfile, activeMemo);
});

wrapHistoryMethod('pushState');
wrapHistoryMethod('replaceState');
window.addEventListener('popstate', onPotentialNavigation);
window.addEventListener('hashchange', onPotentialNavigation);

const identityObserver = new MutationObserver((mutations) => {
    const hrefChanged = window.location.href !== lastObservedHref;
    if (hrefChanged) noteHrefChange();
    if (hrefChanged || mutations.some(shouldRefreshForMutation)) scheduleRefresh();
});
if (document.documentElement) {
    identityObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'tmemo_requestData') return false;
    const profile = syncProfile();
    sendResponse(profile ? { ok: true, id: profile.id, handle: profile.handle } : { ok: false, id: 'not found' });
    return false;
});

syncProfile();
