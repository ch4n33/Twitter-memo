const PROFILE_HANDLE_PATTERN = /^[a-zA-Z0-9_]{1,15}$/;
const PROFILE_SUBROUTES = new Set(['with_replies', 'highlights', 'articles', 'media', 'likes']);
const RESERVED_PROFILE_PATHS = new Set([
    'about', 'account', 'bookmarks', 'communities', 'compose', 'download', 'events', 'explore',
    'followers', 'following', 'hashtag', 'home', 'i', 'intent', 'jobs', 'lists', 'login',
    'logout', 'messages', 'moments', 'notifications', 'oauth', 'premium', 'privacy', 'search',
    'settings', 'share', 'signup', 'spaces', 'topics', 'tos', 'verified_followers', 'widgets',
]);

function getProfileHandle(urlValue) {
    let url;
    try {
        url = new URL(urlValue);
    } catch (error) {
        return null;
    }

    if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.hostname.toLowerCase())) {
        return null;
    }

    let pathParts;
    try {
        pathParts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch (error) {
        return null;
    }

    if (pathParts.length === 2 && pathParts[0].toLowerCase() === 'intent' && pathParts[1].toLowerCase() === 'user') {
        const screenName = url.searchParams.get('screen_name');
        return screenName && PROFILE_HANDLE_PATTERN.test(screenName) ? screenName : null;
    }

    if (pathParts.length < 1 || pathParts.length > 2) {
        return null;
    }

    const handle = pathParts[0];
    if (!PROFILE_HANDLE_PATTERN.test(handle) || RESERVED_PROFILE_PATHS.has(handle.toLowerCase())) {
        return null;
    }
    if (pathParts.length === 2 && !PROFILE_SUBROUTES.has(pathParts[1].toLowerCase())) {
        return null;
    }

    return handle;
}

function normalizeHandle(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const handle = value.startsWith('@') ? value.slice(1) : value;
    return PROFILE_HANDLE_PATTERN.test(handle) ? handle : null;
}

function normalizeNumericId(value) {
    let id;
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) {
            return null;
        }
        id = String(value);
    } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
        id = value;
    } else {
        return null;
    }
    return id;
}

function collectProfileEntities(value, results = []) {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectProfileEntities(item, results);
        }
        return results;
    }
    if (!value || typeof value !== 'object') {
        return results;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'identifier') &&
        Object.prototype.hasOwnProperty.call(value, 'additionalName')) {
        results.push(value);
    }
    if (value.mainEntity) {
        collectProfileEntities(value.mainEntity, results);
    }
    if (value.author) {
        collectProfileEntities(value.author, results);
    }
    if (value['@graph']) {
        collectProfileEntities(value['@graph'], results);
    }
    return results;
}

function getJsonLdProfileId(handle) {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const matchingIds = new Set();

    for (const script of scripts) {
        let parsed;
        try {
            parsed = JSON.parse(script.textContent || '');
        } catch (error) {
            continue;
        }

        for (const entity of collectProfileEntities(parsed)) {
            const entityHandle = normalizeHandle(entity.additionalName);
            if (!entityHandle || entityHandle.toLowerCase() !== handle.toLowerCase()) {
                continue;
            }
            if (entity.url !== undefined &&
                (typeof entity.url !== 'string' || getProfileHandle(entity.url)?.toLowerCase() !== handle.toLowerCase())) {
                continue;
            }
            const id = normalizeNumericId(entity.identifier);
            if (id) {
                matchingIds.add(id);
            }
        }
    }

    return matchingIds.size === 1 ? Array.from(matchingIds)[0] : null;
}

function getVisibleUserNameElement() {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) {
        return null;
    }
    const userName = primaryColumn.querySelector('[data-testid="UserName"]');
    if (!userName || !userName.isConnected) {
        return null;
    }
    if (typeof userName.getClientRects === 'function' && userName.getClientRects().length === 0) {
        return null;
    }
    return userName;
}

function visibleHeaderMatches(userName, handle) {
    const text = userName && typeof userName.textContent === 'string' ? userName.textContent : '';
    const expectedHandle = `@${handle}`.toLowerCase();
    if (userName && typeof userName.querySelectorAll === 'function') {
        const descendants = Array.from(userName.querySelectorAll('*'));
        const visibleHandleTexts = descendants
            .map((descendant) => typeof descendant.textContent === 'string' ? descendant.textContent.trim() : '')
            .filter((value) => /^@[a-zA-Z0-9_]{1,15}$/.test(value));
        if (visibleHandleTexts.length) {
            return visibleHandleTexts[visibleHandleTexts.length - 1].toLowerCase() === expectedHandle;
        }
        if (descendants.length === 0) {
            return text.trim().toLowerCase() === expectedHandle;
        }
        return false;
    }
    return text.trim().toLowerCase() === expectedHandle;
}

function getValidatedProfile() {
    const handle = getProfileHandle(window.location.href);
    if (!handle) {
        return null;
    }

    const userName = getVisibleUserNameElement();
    if (!userName || !visibleHeaderMatches(userName, handle)) {
        return null;
    }

    const id = getJsonLdProfileId(handle);
    return id ? { handle, id } : null;
}

function sameProfile(left, right) {
    return Boolean(left && right && left.id === right.id && left.handle.toLowerCase() === right.handle.toLowerCase());
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

let activeProfile = null;
let activeMemo = '';
let memoLoaded = false;
let memoRequestGeneration = -1;
let profileGeneration = 0;
let lastObservedHref = window.location.href;
let memoElement = null;
let refreshScheduled = false;

function isWithinMemoElement(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (element) {
        if (element.getAttribute && element.getAttribute('data-twitter-memo-display') === 'true') {
            return true;
        }
        element = element.parentElement;
    }
    return false;
}

function removeMemoElement() {
    if (memoElement && memoElement.parentNode) {
        memoElement.parentNode.removeChild(memoElement);
    }
    memoElement = null;
}

function ensureMemoElement(userName) {
    if (!memoElement) {
        memoElement = document.createElement('div');
        memoElement.setAttribute('data-twitter-memo-display', 'true');
        memoElement.className = 'twitter-memo-display';
    }

    const parent = userName.parentNode;
    if (!parent) {
        return null;
    }
    if (memoElement.parentNode !== parent || memoElement.previousSibling !== userName) {
        if (memoElement.parentNode) {
            memoElement.parentNode.removeChild(memoElement);
        }
        parent.insertBefore(memoElement, userName.nextSibling || null);
    }
    return memoElement;
}

function renderMemo(profile, memo) {
    const current = getValidatedProfile();
    if (!sameProfile(current, profile)) {
        syncProfile();
        return;
    }

    const userName = getVisibleUserNameElement();
    const element = userName && ensureMemoElement(userName);
    if (!element) {
        return;
    }
    element.textContent = memo ? `@${profile.handle} : '${memo}'` : `@${profile.handle}`;
}

function loadMemo(profile, requestGeneration) {
    memoRequestGeneration = requestGeneration;
    sendRuntimeMessage({ action: 'getMemo', id: profile.id }).then((response) => {
        if (requestGeneration !== profileGeneration || !sameProfile(activeProfile, profile)) {
            return;
        }
        if (!sameProfile(getValidatedProfile(), profile)) {
            syncProfile();
            return;
        }
        activeMemo = response && response.ok !== false && typeof response.res === 'string' ? response.res : '';
        memoLoaded = true;
        memoRequestGeneration = -1;
        renderMemo(profile, activeMemo);
    }).catch(() => {
        if (requestGeneration !== profileGeneration || !sameProfile(activeProfile, profile)) {
            return;
        }
        if (!sameProfile(getValidatedProfile(), profile)) {
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
    const profile = getValidatedProfile();
    if (!profile) {
        if (activeProfile || memoElement) {
            profileGeneration += 1;
        }
        activeProfile = null;
        activeMemo = '';
        memoLoaded = false;
        memoRequestGeneration = -1;
        removeMemoElement();
        return null;
    }

    if (!sameProfile(activeProfile, profile)) {
        profileGeneration += 1;
        activeProfile = profile;
        activeMemo = '';
        memoLoaded = false;
        memoRequestGeneration = -1;
    } else {
        activeProfile = profile;
    }

    const userName = getVisibleUserNameElement();
    const element = userName && ensureMemoElement(userName);
    if (element) {
        element.textContent = activeMemo ? `@${profile.handle} : '${activeMemo}'` : `@${profile.handle}`;
    }

    if (!memoLoaded && memoRequestGeneration !== profileGeneration) {
        loadMemo(profile, profileGeneration);
    }
    return profile;
}

function scheduleRefresh() {
    if (refreshScheduled) {
        return;
    }
    refreshScheduled = true;
    Promise.resolve().then(() => {
        refreshScheduled = false;
        syncProfile();
    });
}

function isIdentityRelatedNode(node) {
    if (!node || node.nodeType !== 1) {
        return false;
    }
    if (node.matches && node.matches('script[type="application/ld+json"], [data-testid="UserName"]')) {
        return true;
    }
    return Boolean(node.querySelector && node.querySelector('script[type="application/ld+json"], [data-testid="UserName"]'));
}

function isInIdentityArea(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (element) {
        if (element.matches && element.matches('script[type="application/ld+json"], [data-testid="UserName"]')) {
            return true;
        }
        element = element.parentElement;
    }
    return false;
}

function shouldRefreshForMutation(mutation) {
    if (isWithinMemoElement(mutation.target)) {
        return false;
    }
    if (isInIdentityArea(mutation.target)) {
        return true;
    }
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.some(isIdentityRelatedNode);
}

function onPotentialNavigation() {
    noteHrefChange();
    scheduleRefresh();
}

function wrapHistoryMethod(methodName) {
    const history = window.history;
    const original = history && history[methodName];
    if (typeof original !== 'function') {
        return;
    }
    try {
        history[methodName] = function() {
            const result = original.apply(this, arguments);
            onPotentialNavigation();
            return result;
        };
    } catch (error) {
        // DOM and popstate observation still cover navigation if the method cannot be wrapped.
    }
}

wrapHistoryMethod('pushState');
wrapHistoryMethod('replaceState');
window.addEventListener('popstate', onPotentialNavigation);
window.addEventListener('hashchange', onPotentialNavigation);

const identityObserver = new MutationObserver((mutations) => {
    const hrefChanged = window.location.href !== lastObservedHref;
    if (hrefChanged) {
        noteHrefChange();
    }
    if (hrefChanged || mutations.some(shouldRefreshForMutation)) {
        scheduleRefresh();
    }
});
if (document.documentElement) {
    identityObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'tmemo_requestData') {
        return false;
    }
    const profile = syncProfile();
    if (!profile) {
        sendResponse({ ok: false, id: 'not found' });
        return false;
    }
    sendResponse({ ok: true, id: profile.id, handle: profile.handle });
    return false;
});

syncProfile();
