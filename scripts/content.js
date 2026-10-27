const { getTimelineMemoMap, getValidatedProfile, getVisibleUserNameElement, normalizeHandle } = globalThis.TwitterMemo;

let activeProfile = null;
let activeMemo = '';
let memoLoaded = false;
let memoRequestGeneration = -1;
let memoReadToken = 0;
let profileGeneration = 0;
let lastObservedHref = window.location.href;
let memoElement = null;
let refreshScheduled = false;
let timelineMemoByHandle = new Map();
let timelineIndexGeneration = 0;
let timelineReloadScheduled = false;
const timelineMemoElements = new WeakMap();

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const TWEET_AUTHOR_SELECTOR = '[data-testid="User-Name"]';
const TIMELINE_NOTE_ATTRIBUTE = 'data-twitter-memo-timeline-note';

function isWithinTimelineMemoElement(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (element) {
        if (element.getAttribute && element.getAttribute(TIMELINE_NOTE_ATTRIBUTE) === 'true') return true;
        element = element.parentElement;
    }
    return false;
}

function removeTimelineMemo(article) {
    const element = timelineMemoElements.get(article);
    if (element && element.parentNode) element.parentNode.removeChild(element);
    timelineMemoElements.delete(article);
}

function isExcludedTweetAuthorHeader(header, article) {
    let element = header;
    while (element && element !== article) {
        if (element.tagName === 'BLOCKQUOTE') return true;
        if (element.getAttribute && element.getAttribute('role') === 'link') return true;
        const testId = (element.getAttribute && element.getAttribute('data-testid') || '').toLowerCase();
        if (testId === 'socialcontext' || testId.includes('quote')) return true;
        element = element.parentElement;
    }
    return false;
}

function getPrimaryTweetAuthor(article) {
    for (const header of article.querySelectorAll(TWEET_AUTHOR_SELECTOR)) {
        if (header.closest(TWEET_SELECTOR) !== article || isExcludedTweetAuthorHeader(header, article)) continue;
        for (const anchor of header.querySelectorAll('a[href]')) {
            const label = typeof anchor.textContent === 'string' ? anchor.textContent.trim() : '';
            if (!label.startsWith('@')) continue;
            const displayedHandle = normalizeHandle(label);
            const linkedHandle = globalThis.TwitterMemo.getProfileHandle(anchor.href);
            if (displayedHandle && linkedHandle && displayedHandle.toLowerCase() === linkedHandle.toLowerCase()) {
                return { header, handle: displayedHandle.toLowerCase() };
            }
        }
    }
    return null;
}

function renderTimelineTweet(article) {
    if (!article || !article.isConnected) return;
    const author = getPrimaryTweetAuthor(article);
    const memo = author && timelineMemoByHandle.get(author.handle);
    if (!memo || !memo.memo) {
        removeTimelineMemo(article);
        return;
    }

    let element = timelineMemoElements.get(article);
    if (!element) {
        element = document.createElement('div');
        element.setAttribute(TIMELINE_NOTE_ATTRIBUTE, 'true');
        element.className = 'twitter-memo-timeline-note';
        timelineMemoElements.set(article, element);
    }
    element.setAttribute('data-profile-id', memo.id);
    element.setAttribute('data-profile-handle', memo.handle);
    const noteText = `메모: ${memo.memo}`;
    if (element.textContent !== noteText) element.textContent = noteText;

    const parent = author.header.parentNode;
    if (!parent) {
        removeTimelineMemo(article);
        return;
    }
    if (element.parentNode !== parent || element.previousSibling !== author.header) {
        if (element.parentNode) element.parentNode.removeChild(element);
        parent.insertBefore(element, author.header.nextSibling);
    }
}

function refreshVisibleTimelineTweets() {
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) renderTimelineTweet(article);
}

function loadTimelineMemoIndex() {
    const requestGeneration = ++timelineIndexGeneration;
    chrome.runtime.sendMessage({ action: 'listMemo' }).then((response) => {
        if (requestGeneration !== timelineIndexGeneration || !response || response.ok !== true) return;
        timelineMemoByHandle = getTimelineMemoMap(response.res);
        refreshVisibleTimelineTweets();
    }).catch(() => {
        // Keep the last successful index during transient storage failures.
    });
}

function requestTimelineMemoIndexReload() {
    if (timelineReloadScheduled) return;
    timelineReloadScheduled = true;
    Promise.resolve().then(() => {
        timelineReloadScheduled = false;
        loadTimelineMemoIndex();
    });
}

function rememberCurrentProfileMemo(profile, memo) {
    if (!profile || typeof memo !== 'string' || memo.length === 0) return;
    chrome.runtime.sendMessage({ action: 'rememberMemoProfile', id: profile.id, handle: profile.handle }).catch(() => {});
}

function getTweetArticle(node) {
    let element = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!element || !element.closest) return null;
    return element.closest(TWEET_SELECTOR);
}

function collectTimelineArticles(mutations) {
    const articles = new Set();
    const addFromNode = (node) => {
        if (!node || isWithinTimelineMemoElement(node) || isWithinMemoElement(node)) return;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) return;
        if (element.matches && element.matches(TWEET_SELECTOR)) articles.add(element);
        const closest = getTweetArticle(element);
        if (closest) articles.add(closest);
        if (element.querySelectorAll) {
            for (const article of element.querySelectorAll(TWEET_SELECTOR)) articles.add(article);
        }
    };
    for (const mutation of mutations) {
        if (isWithinTimelineMemoElement(mutation.target) || isWithinMemoElement(mutation.target)) continue;
        addFromNode(mutation.target);
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) addFromNode(node);
    }
    return articles;
}

function currentProfile() {
    const href = readLocationHref();
    return href ? getValidatedProfile(href, document) : null;
}

function readLocationHref() {
    try {
        return window.location.href;
    } catch (error) {
        return null;
    }
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
        rememberCurrentProfileMemo(profile, activeMemo);
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
    const href = readLocationHref();
    if (href === null) return false;
    if (href !== lastObservedHref) {
        lastObservedHref = href;
        profileGeneration += 1;
    }
    return true;
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
    if (areaName !== 'local') return;
    if (activeProfile && Object.prototype.hasOwnProperty.call(changes, activeProfile.id)) {
        const change = changes[activeProfile.id];
        memoReadToken += 1;
        activeMemo = change && typeof change.newValue === 'string' ? change.newValue : '';
        memoLoaded = true;
        renderMemo(activeProfile, activeMemo);
    }
    const hasMemoChange = Object.keys(changes).some((key) => TwitterMemo.isValidMemoId(key));
    if (hasMemoChange || Object.prototype.hasOwnProperty.call(changes, TwitterMemo.PROFILE_INDEX_STORAGE_KEY)) {
        requestTimelineMemoIndexReload();
    }
});

wrapHistoryMethod('pushState');
wrapHistoryMethod('replaceState');
window.addEventListener('popstate', onPotentialNavigation);
window.addEventListener('hashchange', onPotentialNavigation);

const identityObserver = new MutationObserver((mutations) => {
    const href = readLocationHref();
    if (href === null) return;
    const hrefChanged = href !== lastObservedHref;
    if (hrefChanged) noteHrefChange();
    if (hrefChanged || mutations.some(shouldRefreshForMutation)) scheduleRefresh();
});
if (document.documentElement) {
    identityObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

const timelineObserver = new MutationObserver((mutations) => {
    const href = readLocationHref();
    if (href === null) return;
    const hrefChanged = href !== lastObservedHref;
    if (hrefChanged) {
        noteHrefChange();
        scheduleRefresh();
    }
    for (const article of collectTimelineArticles(mutations)) renderTimelineTweet(article);
});
if (document.documentElement) {
    timelineObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['href'],
        childList: true,
        characterData: true,
        subtree: true,
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'tmemo_requestData') return false;
    const profile = syncProfile();
    sendResponse(profile ? { ok: true, id: profile.id, handle: profile.handle } : { ok: false, id: 'not found' });
    return false;
});

syncProfile();
loadTimelineMemoIndex();
