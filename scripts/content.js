const { getValidatedProfile, getVisibleUserNameElement, isValidMemoId } = globalThis.TwitterMemo;

let activeProfile = null;
let activeMemo = '';
let memoLoaded = false;
let memoRequestGeneration = -1;
let memoReadToken = 0;
let profileGeneration = 0;
let lastObservedHref = window.location.href;
let memoElement = null;
let refreshScheduled = false;
const timelineMemosById = new Map();
const timelineUserByPostId = new Map();
let pendingTimelineMemoReads = 0;
const timelineMemoElements = new WeakMap();

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const TWEET_AUTHOR_SELECTOR = '[data-testid="User-Name"]';
const TIMELINE_NOTE_ATTRIBUTE = 'data-twitter-memo-timeline-note';
const BRIDGE_CHANNEL = 'x-memo.timeline-id.v1';
const MAX_BRIDGE_ID_DIGITS = 256;
const MAX_CACHED_POST_IDS = 300;
const MAX_CACHED_USER_MEMOS = 300;
const MAX_PENDING_MEMO_READS = 16;
const MAX_BRIDGE_MESSAGE_LENGTH = 700;
const EMPTY_BRIDGE_MESSAGE_LENGTH = '{"channel":"","type":"","postId":"","userId":""}'.length;

function isBridgeId(value) {
    return isValidMemoId(value) && value.length <= MAX_BRIDGE_ID_DIGITS;
}

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

function isExcludedFromPrimary(element, article, ignoreCandidateRoleLink = false) {
    const candidate = element;
    while (element && element !== article) {
        if (element.tagName === 'BLOCKQUOTE') return true;
        if (element.getAttribute && element.getAttribute('role') === 'link' &&
            !(ignoreCandidateRoleLink && element === candidate)) return true;
        const testId = (element.getAttribute && element.getAttribute('data-testid') || '').toLowerCase();
        if (testId === 'socialcontext' || testId.includes('quote')) return true;
        element = element.parentElement;
    }
    return false;
}

function getPrimaryTweetPostId(article) {
    const postIds = new Set();
    for (const anchor of article.querySelectorAll('a[href]')) {
        if (anchor.closest(TWEET_SELECTOR) !== article || isExcludedFromPrimary(anchor, article, true)) continue;
        if (!anchor.querySelector('time')) continue;
        let url;
        try {
            url = new URL(anchor.href, window.location.href);
        } catch (error) {
            continue;
        }
        if (url.origin !== window.location.origin) continue;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 3 || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0]) || parts[1].toLowerCase() !== 'status') continue;
        if (isBridgeId(parts[2])) postIds.add(parts[2]);
    }
    return postIds.size === 1 ? postIds.values().next().value : null;
}

function getPrimaryTweetAuthorHeader(article) {
    for (const header of article.querySelectorAll(TWEET_AUTHOR_SELECTOR)) {
        if (header.closest(TWEET_SELECTOR) === article && !isExcludedFromPrimary(header, article)) return header;
    }
    return null;
}

function renderTimelineTweet(article) {
    if (!article || !article.isConnected) return;
    const postId = getPrimaryTweetPostId(article);
    const userId = postId && timelineUserByPostId.get(postId);
    if (!userId) {
        removeTimelineMemo(article);
        return;
    }
    const entry = touchTimelineMemoEntry(userId);
    if (!entry) requestTimelineMemo(userId);
    const authorHeader = getPrimaryTweetAuthorHeader(article);
    if (!entry || entry.status !== 'loaded' || !entry.memo || !authorHeader) {
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
    const noteText = `메모: ${entry.memo}`;
    if (element.textContent !== noteText) element.textContent = noteText;

    const parent = authorHeader.parentNode;
    if (!parent) {
        removeTimelineMemo(article);
        return;
    }
    if (element.parentNode !== parent || element.previousSibling !== authorHeader) {
        if (element.parentNode) element.parentNode.removeChild(element);
        parent.insertBefore(element, authorHeader.nextSibling);
    }
}

function refreshVisibleTimelineTweets() {
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) renderTimelineTweet(article);
}

function touchTimelineMemoEntry(userId) {
    const entry = timelineMemosById.get(userId);
    if (!entry) return null;
    timelineMemosById.delete(userId);
    timelineMemosById.set(userId, entry);
    return entry;
}

function storeTimelineMemoEntry(userId, entry) {
    timelineMemosById.delete(userId);
    timelineMemosById.set(userId, entry);
    while (timelineMemosById.size > MAX_CACHED_USER_MEMOS) {
        timelineMemosById.delete(timelineMemosById.keys().next().value);
    }
}

function renderTimelineTweetsForUserId(userId) {
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
        const postId = getPrimaryTweetPostId(article);
        if (postId && timelineUserByPostId.get(postId) === userId) renderTimelineTweet(article);
    }
}

function startPendingTimelineMemoReads() {
    if (pendingTimelineMemoReads >= MAX_PENDING_MEMO_READS) return;
    for (const [userId, entry] of timelineMemosById) {
        if (entry.status !== 'waiting') continue;
        timelineMemosById.delete(userId);
        requestTimelineMemo(userId);
        if (pendingTimelineMemoReads >= MAX_PENDING_MEMO_READS) return;
    }
}

function requestTimelineMemo(userId) {
    const existing = touchTimelineMemoEntry(userId);
    if (existing) return;
    if (pendingTimelineMemoReads >= MAX_PENDING_MEMO_READS) {
        storeTimelineMemoEntry(userId, { status: 'waiting', memo: '' });
        return;
    }

    const entry = { status: 'loading', memo: '' };
    storeTimelineMemoEntry(userId, entry);
    pendingTimelineMemoReads += 1;
    Promise.resolve().then(() => chrome.runtime.sendMessage({ action: 'getMemo', id: userId })).then((response) => {
        if (timelineMemosById.get(userId) !== entry) return;
        storeTimelineMemoEntry(userId, {
            status: 'loaded',
            memo: response && response.ok === true && typeof response.res === 'string' ? response.res : '',
        });
        renderTimelineTweetsForUserId(userId);
    }).catch(() => {
        if (timelineMemosById.get(userId) === entry) {
            storeTimelineMemoEntry(userId, { status: 'loaded', memo: '' });
            renderTimelineTweetsForUserId(userId);
        }
    }).finally(() => {
        pendingTimelineMemoReads -= 1;
        startPendingTimelineMemoReads();
    });
}

function setTimelineMemoFromStorage(userId, memo) {
    storeTimelineMemoEntry(userId, { status: 'loaded', memo: typeof memo === 'string' ? memo : '' });
    renderTimelineTweetsForUserId(userId);
}

function validateTimelineBridgeEvent(event) {
    if (!event || event.source !== window || typeof event.origin !== 'string') return null;
    let pageOrigin;
    try {
        const url = new URL(window.location.href);
        if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.hostname.toLowerCase())) return null;
        pageOrigin = url.origin;
    } catch (error) {
        return null;
    }
    if (event.origin !== pageOrigin) return null;

    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    let keys;
    let fields;
    try {
        keys = Reflect.ownKeys(data).sort();
        if (keys.length !== 4 || keys.some((key) => typeof key !== 'string') || keys.join(',') !== 'channel,postId,type,userId') return null;
        fields = Object.fromEntries(keys.map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(data, key);
            return [key, descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined];
        }));
    } catch (error) {
        return null;
    }
    if (fields.channel !== BRIDGE_CHANNEL || fields.type !== 'visible-tweet-ids' || !isBridgeId(fields.postId)) return null;
    if (fields.userId !== null && !isBridgeId(fields.userId)) return null;
    const messageSize = EMPTY_BRIDGE_MESSAGE_LENGTH + fields.channel.length + fields.type.length + fields.postId.length +
        (fields.userId === null ? 2 : fields.userId.length);
    if (messageSize > MAX_BRIDGE_MESSAGE_LENGTH) return null;
    return { postId: fields.postId, userId: fields.userId };
}

function hasCurrentPost(articleId) {
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
        if (getPrimaryTweetPostId(article) === articleId) return true;
    }
    return false;
}

function updateTimelineUserForPost(postId, userId) {
    if (userId === null) {
        timelineUserByPostId.delete(postId);
        return;
    }
    timelineUserByPostId.delete(postId);
    timelineUserByPostId.set(postId, userId);
    while (timelineUserByPostId.size > MAX_CACHED_POST_IDS) {
        timelineUserByPostId.delete(timelineUserByPostId.keys().next().value);
    }
}

function onTimelineBridgeMessage(event) {
    const pair = validateTimelineBridgeEvent(event);
    if (!pair) return;
    if (pair.userId !== null && !hasCurrentPost(pair.postId)) return;
    updateTimelineUserForPost(pair.postId, pair.userId);
    if (pair.userId !== null) requestTimelineMemo(pair.userId);
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
        if (getPrimaryTweetPostId(article) === pair.postId) renderTimelineTweet(article);
    }
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
    for (const id of Object.keys(changes)) {
        if (!isBridgeId(id)) continue;
        let isUsedByTimeline = timelineMemosById.has(id);
        if (!isUsedByTimeline) {
            for (const userId of timelineUserByPostId.values()) {
                if (userId === id) {
                    isUsedByTimeline = true;
                    break;
                }
            }
        }
        if (isUsedByTimeline) {
            const change = changes[id];
            setTimelineMemoFromStorage(id, change && change.newValue);
        }
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

window.addEventListener('message', onTimelineBridgeMessage);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'tmemo_requestData') return false;
    const profile = syncProfile();
    sendResponse(profile ? { ok: true, id: profile.id, handle: profile.handle } : { ok: false, id: 'not found' });
    return false;
});

syncProfile();
