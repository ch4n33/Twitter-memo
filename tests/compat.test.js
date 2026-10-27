const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const sharedSource = fs.readFileSync(path.join(root, 'scripts/shared.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'scripts/content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'scripts/background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'scripts/popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');

function createDom(url = 'https://x.com/X', html = '<!doctype html><html><head></head><body></body></html>') {
    return new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
}

function installProfile(window, handle, id, { spans } = {}) {
    const document = window.document;
    let primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) {
        primaryColumn = document.createElement('main');
        primaryColumn.setAttribute('data-testid', 'primaryColumn');
        document.body.appendChild(primaryColumn);
    }

    primaryColumn.querySelector('[data-testid="UserName"]')?.remove();
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => script.remove());

    const userName = document.createElement('div');
    userName.setAttribute('data-testid', 'UserName');
    for (const text of spans || ['X', '', '', '', '', `@${handle}`]) {
        const span = document.createElement('span');
        span.textContent = text;
        userName.appendChild(span);
    }
    userName.getClientRects = () => [{}];
    primaryColumn.appendChild(userName);

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
        '@type': 'ProfilePage',
        mainEntity: {
            '@type': 'Person',
            additionalName: handle,
            identifier: id,
            url: `https://x.com/${handle}`,
        },
    });
    document.head.appendChild(script);
    return { primaryColumn, userName, script };
}

function setJsonLd(window, value) {
    const document = window.document;
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => script.remove());
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = typeof value === 'string' ? value : JSON.stringify(value);
    document.head.appendChild(script);
}

function createContentHarness(url, profileFixture, timelineItems = {}, prepareDom = null) {
    const dom = createDom(url);
    const { window } = dom;
    if (profileFixture) installProfile(window, profileFixture.handle, profileFixture.id, profileFixture.options);
    if (prepareDom) prepareDom(window.document);
    const reads = [];
    const listRequests = [];
    const rememberedProfiles = [];
    const runtimeListeners = [];
    const storageListeners = [];
    const state = { timelineItems: { ...timelineItems } };
    const chrome = {
        runtime: {
            sendMessage(message) {
                if (message.action === 'getMemo') {
                    return new Promise((resolve, reject) => reads.push({ id: message.id, resolve, reject }));
                }
                if (message.action === 'listMemo') {
                    listRequests.push(message);
                    return Promise.resolve({ ok: true, res: { ...state.timelineItems } });
                }
                if (message.action === 'rememberMemoProfile') {
                    rememberedProfiles.push(message);
                    return Promise.resolve({ ok: true, res: true });
                }
                return Promise.resolve({ ok: true });
            },
            onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        },
        storage: { onChanged: { addListener(listener) { storageListeners.push(listener); } } },
    };
    window.chrome = chrome;
    const pageWorldPushState = window.history.pushState.bind(window.history);
    window.eval(sharedSource);
    window.eval(contentSource);

    return {
        dom,
        window,
        reads,
        listRequests,
        rememberedProfiles,
        state,
        runtimeListeners,
        storageListeners,
        pageWorldPushState,
        addNoise() {
            const node = window.document.createElement('div');
            node.textContent = 'unrelated page update';
            window.document.body.appendChild(node);
        },
        sendProfileRequest() {
            let response;
            runtimeListeners[0]({ action: 'tmemo_requestData' }, {}, (value) => { response = value; });
            return response;
        },
        updateTimelineItems(items, changes) {
            state.timelineItems = { ...items };
            storageListeners[0](changes, 'local');
        },
    };
}

function createPopupHarness(options = {}) {
    const dom = createDom('https://extension.test/popup.html', popupHtml);
    const { window } = dom;
    const state = {
        profile: { id: '9007199254740992', handle: 'Alpha' },
        tabId: 7,
        getMemo: () => Promise.resolve({ ok: true, res: 'Existing memo' }),
        listMemo: () => Promise.resolve({ ok: true, res: {} }),
        setMemo: () => Promise.resolve({ ok: true, res: 'memo is set' }),
        runtimeMessages: [],
        setRequests: [],
        tabMessages: [],
        queryCalls: [],
        ...options,
    };
    const chrome = {
        runtime: {
            sendMessage(message) {
                state.runtimeMessages.push(message);
                if (message.action === 'getMemo') return state.getMemo(message);
                if (message.action === 'listMemo') return state.listMemo(message);
                if (message.action === 'setMemo') {
                    state.setRequests.push(message);
                    return state.setMemo(message);
                }
                return Promise.resolve(undefined);
            },
        },
        tabs: {
            query(query) {
                state.queryCalls.push(query);
                return Promise.resolve([{ id: state.tabId }]);
            },
            sendMessage(tabId, message) {
                state.tabMessages.push({ tabId, message });
                if (!state.profile) return Promise.resolve({ ok: false, id: 'not found' });
                return Promise.resolve({ ok: true, ...state.profile });
            },
        },
    };
    window.chrome = chrome;
    window.eval(sharedSource);
    window.eval(popupSource);
    return { dom, window, state };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

async function waitFor(condition, message = 'Condition did not become true.') {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (condition()) return;
        await settle();
    }
    assert.fail(message);
}

function getMemoMarker(document) {
    return document.querySelector('[data-twitter-memo-display="true"]');
}

function appendTweet(document, handle, { quoteHandle = null, socialContextHandle = null, mentionHandle = null } = {}) {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');

    if (socialContextHandle) {
        const socialContext = document.createElement('div');
        socialContext.setAttribute('data-testid', 'socialContext');
        socialContext.appendChild(createTweetAuthorHeader(document, socialContextHandle).element);
        article.appendChild(socialContext);
    }

    const header = createTweetAuthorHeader(document, handle);
    article.appendChild(header.element);

    if (mentionHandle) {
        const text = document.createElement('div');
        const mention = document.createElement('a');
        mention.href = `/${mentionHandle}`;
        mention.textContent = `@${mentionHandle}`;
        text.appendChild(mention);
        article.appendChild(text);
    }

    if (quoteHandle) {
        const quote = document.createElement('div');
        quote.setAttribute('data-testid', 'QuoteTweet');
        quote.appendChild(createTweetAuthorHeader(document, quoteHandle).element);
        article.appendChild(quote);
    }

    document.body.appendChild(article);
    return { article, ...header };
}

function appendRoleLinkQuoteOnlyTweet(document, handle) {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    const quoteCard = document.createElement('div');
    quoteCard.setAttribute('role', 'link');
    const author = createTweetAuthorHeader(document, handle);
    quoteCard.appendChild(author.element);
    article.appendChild(quoteCard);
    document.body.appendChild(article);
    return { article, ...author };
}

function createTweetAuthorHeader(document, handle) {
    const element = document.createElement('div');
    element.setAttribute('data-testid', 'User-Name');
    const displayName = document.createElement('a');
    displayName.href = `/${handle}`;
    displayName.textContent = handle;
    const authorLink = document.createElement('a');
    authorLink.href = `/${handle}`;
    authorLink.textContent = `@${handle}`;
    element.append(displayName, authorLink);
    return { element, displayName, authorLink };
}

function submitPopup(window) {
    window.document.getElementById('memoForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('shared profile validation supports X, legacy Twitter, reposts, and only profile routes', () => {
    const dom = createDom();
    dom.window.eval(sharedSource);
    const { TwitterMemo } = dom.window;

    assert.equal(TwitterMemo.getProfileHandle('https://x.com/X'), 'X');
    assert.equal(TwitterMemo.getProfileHandle('https://x.com/Another/reposts'), 'Another');
    assert.equal(TwitterMemo.getProfileHandle('https://x.com/Another/articles'), 'Another');
    assert.equal(TwitterMemo.getProfileHandle('https://twitter.com/Alpha/with_replies'), 'Alpha');
    assert.equal(TwitterMemo.getProfileHandle('https://twitter.com/intent/user?screen_name=Alpha'), 'Alpha');
    assert.equal(TwitterMemo.getProfileHandle('https://x.com/home'), null);
    assert.equal(TwitterMemo.getProfileHandle('https://x.com/communities'), null);
    assert.equal(TwitterMemo.getProfileHandle('https://x.com/Alpha/status/123'), null);
    assert.equal(TwitterMemo.getProfileHandle('https://example.com/Alpha'), null);
    dom.window.close();
});

test('shared identity parsing covers mainEntity, legacy author, arrays, @graph, and fails closed', () => {
    const dom = createDom();
    const { window } = dom;
    window.eval(sharedSource);
    const idFor = () => window.TwitterMemo.getJsonLdProfileId('Alpha', window.document);

    setJsonLd(window, { '@type': 'ProfilePage', mainEntity: { additionalName: 'Alpha', identifier: '783214', url: 'https://x.com/Alpha' } });
    assert.equal(idFor(), '783214');
    setJsonLd(window, { '@type': 'ProfilePage', author: { additionalName: 'Alpha', identifier: '555', url: 'https://twitter.com/Alpha' } });
    assert.equal(idFor(), '555');
    setJsonLd(window, [{ '@graph': [{ mainEntity: { additionalName: 'Alpha', identifier: 777, url: 'https://x.com/Alpha' } }] }]);
    assert.equal(idFor(), '777');
    setJsonLd(window, { mainEntity: { additionalName: 'Different', identifier: '123', url: 'https://x.com/Different' } });
    assert.equal(idFor(), null);
    setJsonLd(window, { mainEntity: { additionalName: 'Alpha', identifier: '123', url: 'https://x.com/Different' } });
    assert.equal(idFor(), null);
    setJsonLd(window, { mainEntity: { additionalName: 'Alpha', identifier: '9007199254740992', url: 'https://x.com/Alpha' } });
    assert.equal(idFor(), '9007199254740992');
    setJsonLd(window, { mainEntity: { additionalName: 'Alpha', identifier: 9007199254740992, url: 'https://x.com/Alpha' } });
    assert.equal(idFor(), null);
    setJsonLd(window, '{ malformed json');
    assert.equal(idFor(), null);
    assert.equal(window.TwitterMemo.isValidMemoId('9007199254740992'), true);
    assert.equal(window.TwitterMemo.isValidMemoId('0'), false);
    dom.window.close();
});

test('shared timeline index normalizes handles and suppresses ambiguous claims', () => {
    const dom = createDom();
    const { window } = dom;
    window.eval(sharedSource);
    const { TwitterMemo } = window;
    const key = TwitterMemo.PROFILE_INDEX_STORAGE_KEY;

    const renamed = TwitterMemo.addVerifiedMemoProfile({ '101': 'OldName', '202': 'KeepName' }, '101', '@NewName');
    assert.deepEqual({ ...renamed }, { '101': 'newname', '202': 'keepname' });
    const reassigned = TwitterMemo.addVerifiedMemoProfile({ '101': 'NewName', '202': 'KeepName' }, '202', 'NewName');
    assert.deepEqual({ ...reassigned }, { '202': 'newname' });

    const unambiguous = TwitterMemo.getTimelineMemoMap({
        '9007199254740992': 'Large ID memo',
        '555': 'Keep this memo',
        [key]: { '9007199254740992': 'LargeName', '555': 'OtherName' },
    });
    assert.equal(unambiguous.get('largename').id, '9007199254740992');
    assert.equal(unambiguous.get('largename').memo, 'Large ID memo');
    assert.equal(unambiguous.get('othername').memo, 'Keep this memo');

    const ambiguous = TwitterMemo.getTimelineMemoMap({
        '101': 'first claim',
        '202': '',
        [key]: { '101': 'SharedName', '202': 'sharedname' },
    });
    assert.equal(ambiguous.has('sharedname'), false);
    dom.window.close();
});

test('visible header checks the final handle span and does not trust a matching display name', () => {
    const dom = createDom('https://x.com/X');
    const { window } = dom;
    window.eval(sharedSource);
    const correct = installProfile(window, 'X', '783214');
    assert.equal(correct.userName.textContent, 'X@X');
    const displayOuter = window.document.createElement('span');
    const displayInner = window.document.createElement('span');
    displayInner.textContent = 'X';
    displayOuter.appendChild(displayInner);
    const spans = [displayOuter, ...Array.from({ length: 3 }, () => window.document.createElement('span'))];
    const handleSpan = window.document.createElement('span');
    handleSpan.textContent = '@X';
    correct.userName.replaceChildren(...spans, handleSpan);
    assert.equal(correct.userName.textContent, 'X@X');
    assert.deepEqual(Array.from(correct.userName.querySelectorAll('span'), (span) => span.textContent), ['X', 'X', '', '', '', '@X']);
    assert.deepEqual(
        Object.values(window.TwitterMemo.getValidatedProfile(window.location.href, window.document)),
        ['X', '783214'],
    );

    const mismatched = installProfile(window, 'Expected', '123', { spans: ['@Expected', '@Different'] });
    const result = window.TwitterMemo.getValidatedProfile('https://x.com/Expected', window.document);
    assert.equal(result, null);
    assert.equal(mismatched.userName.textContent, '@Expected@Different');
    dom.window.close();
});

test('content waits for header and JSON-LD, then keeps the X username untouched', async () => {
    const harness = createContentHarness('https://x.com/home');
    assert.equal(harness.reads.length, 0);
    harness.pageWorldPushState({}, '', '/X');
    const profile = installProfile(harness.window, 'X', '783214');
    harness.addNoise();
    await waitFor(() => harness.reads.length === 1);
    assert.equal(harness.reads[0].id, '783214');
    const response = harness.sendProfileRequest();
    assert.deepEqual(
        { ok: response.ok, id: response.id },
        { ok: true, id: '783214' },
    );

    harness.reads[0].resolve({ ok: true });
    await settle();
    assert.equal(getMemoMarker(harness.window.document), null);
    assert.equal(profile.userName.textContent, 'X@X');
    assert.equal(harness.window.document.querySelectorAll('[data-twitter-memo-display="true"]').length, 0);
    await settle();
});

test('content follows page-world A→B→A DOM navigation and rejects stale memo reads', async () => {
    const harness = createContentHarness('https://x.com/Alpha', { handle: 'Alpha', id: '101' });
    await waitFor(() => harness.reads.length === 1);
    const firstAlphaRead = harness.reads[0];

    harness.pageWorldPushState({}, '', '/Beta');
    installProfile(harness.window, 'Beta', '202');
    harness.addNoise();
    await waitFor(() => harness.reads.length === 2);
    assert.equal(harness.reads[1].id, '202');

    harness.pageWorldPushState({}, '', '/Alpha');
    installProfile(harness.window, 'Alpha', '101');
    harness.addNoise();
    await waitFor(() => harness.reads.length === 3);
    assert.equal(harness.reads[2].id, '101');

    firstAlphaRead.resolve({ ok: true, res: 'stale Alpha memo' });
    harness.reads[1].resolve({ ok: true, res: 'stale Beta memo' });
    await settle();
    assert.equal(getMemoMarker(harness.window.document), null);

    harness.reads[2].resolve({ ok: true, res: '<img src=x onerror=alert(1)>' });
    await waitFor(() => getMemoMarker(harness.window.document) !== null);
    assert.equal(getMemoMarker(harness.window.document).textContent, "@Alpha : '<img src=x onerror=alert(1)>'");
    assert.equal(getMemoMarker(harness.window.document).querySelector('img'), null);
    await waitFor(() => harness.rememberedProfiles.length === 1);
    assert.deepEqual({ ...harness.rememberedProfiles[0] }, { action: 'rememberMemoProfile', id: '101', handle: 'Alpha' });

    harness.pageWorldPushState({}, '', '/home');
    harness.addNoise();
    await waitFor(() => getMemoMarker(harness.window.document) === null);
    const response = harness.sendProfileRequest();
    assert.deepEqual(
        { ok: response.ok, id: response.id },
        { ok: false, id: 'not found' },
    );
    await settle();
});

test('timeline memos use the primary author, handle inserted and reused tweets, and refresh from storage', async () => {
    const key = '__twitterMemoProfileIndexV1';
    let initialTweet;
    let unrelatedTweet;
    let quoteOnlyTweet;
    const harness = createContentHarness(
        'https://x.com/home',
        null,
        { '101': '<img src=x>', '202': 'Beta note', [key]: { '101': 'Alpha', '202': 'Beta' } },
        (document) => {
            initialTweet = appendTweet(document, 'Alpha', { socialContextHandle: 'Beta', quoteHandle: 'Beta' });
            unrelatedTweet = appendTweet(document, 'Gamma', { quoteHandle: 'Alpha', mentionHandle: 'Alpha' });
            quoteOnlyTweet = appendRoleLinkQuoteOnlyTweet(document, 'Alpha');
        },
    );

    await waitFor(() => initialTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]') !== null);
    const alphaNote = initialTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]');
    assert.equal(alphaNote.textContent, '메모: <img src=x>');
    assert.equal(alphaNote.querySelector('img'), null);
    assert.equal(alphaNote.dataset.profileId, '101');
    assert.equal(unrelatedTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]'), null);
    assert.equal(quoteOnlyTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]'), null);

    const inserted = appendTweet(harness.window.document, 'Beta');
    await waitFor(() => inserted.article.querySelector('[data-twitter-memo-timeline-note="true"]') !== null);
    assert.equal(inserted.article.querySelector('[data-twitter-memo-timeline-note="true"]').textContent, '메모: Beta note');
    assert.equal(harness.listRequests.length, 1);

    inserted.authorLink.href = '/Alpha';
    inserted.authorLink.textContent = '@Alpha';
    await waitFor(() => inserted.article.querySelector('[data-twitter-memo-timeline-note="true"]')?.dataset.profileId === '101');
    assert.equal(inserted.article.querySelectorAll('[data-twitter-memo-timeline-note="true"]').length, 1);
    assert.equal(inserted.article.querySelector('[data-twitter-memo-timeline-note="true"]').textContent, '메모: <img src=x>');

    inserted.authorLink.href = '/Gamma';
    inserted.authorLink.textContent = '@Gamma';
    await waitFor(() => inserted.article.querySelector('[data-twitter-memo-timeline-note="true"]') === null);

    const oldIndex = { '101': 'Alpha', '202': 'Beta' };
    const updatedIndex = { ...oldIndex };
    harness.updateTimelineItems(
        { '101': 'Updated alpha note', '202': 'Beta note', [key]: updatedIndex },
        { '101': { oldValue: '<img src=x>', newValue: 'Updated alpha note' }, [key]: { oldValue: oldIndex, newValue: updatedIndex } },
    );
    await waitFor(() => initialTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]')?.textContent === '메모: Updated alpha note');

    const betaOnlyIndex = { '202': 'Beta' };
    harness.updateTimelineItems(
        { '202': 'Beta note', [key]: betaOnlyIndex },
        { '101': { oldValue: 'Updated alpha note' }, [key]: { oldValue: updatedIndex, newValue: betaOnlyIndex } },
    );
    await waitFor(() => initialTweet.article.querySelector('[data-twitter-memo-timeline-note="true"]') === null);
    assert.equal(harness.listRequests.length, 3);
    harness.dom.window.close();
});

test('storage changes update the active memo and invalidate an older initial read', async () => {
    const harness = createContentHarness('https://x.com/Alpha', { handle: 'Alpha', id: '101' });
    await waitFor(() => harness.reads.length === 1);
    harness.storageListeners[0]({ '101': { newValue: 'updated outside the page' } }, 'local');
    await waitFor(() => getMemoMarker(harness.window.document) !== null);
    assert.equal(getMemoMarker(harness.window.document).textContent, "@Alpha : 'updated outside the page'");

    harness.reads[0].resolve({ ok: true, res: 'older initial value' });
    await settle();
    assert.equal(getMemoMarker(harness.window.document).textContent, "@Alpha : 'updated outside the page'");
    harness.storageListeners[0]({ '101': { oldValue: 'updated outside the page' } }, 'local');
    await waitFor(() => getMemoMarker(harness.window.document) === null);
    assert.equal(harness.window.document.querySelector('[data-testid="UserName"]').textContent, 'X@Alpha');
    await settle();
});

function createBackgroundHarness(initialData = {}) {
    const data = { ...initialData };
    const runtimeListeners = [];
    const state = { data, failNext: null, removedKeys: [] };
    const chrome = {
        runtime: { onMessage: { addListener(listener) { runtimeListeners.push(listener); } } },
        storage: {
            local: {
                async get(keys) {
                    if (state.failNext) {
                        const error = state.failNext;
                        state.failNext = null;
                        throw error;
                    }
                    if (keys === null) return { ...data };
                    return Object.fromEntries(keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
                },
                async set(items) {
                    if (state.failNext) {
                        const error = state.failNext;
                        state.failNext = null;
                        throw error;
                    }
                    Object.assign(data, items);
                },
                async remove(key) {
                    if (state.failNext) {
                        const error = state.failNext;
                        state.failNext = null;
                        throw error;
                    }
                    state.removedKeys.push(key);
                    delete data[key];
                },
            },
        },
    };
    const context = vm.createContext({ chrome });
    context.importScripts = (name) => {
        assert.equal(name, 'shared.js');
        vm.runInContext(sharedSource, context, { filename: 'shared.js' });
    };
    vm.runInContext(backgroundSource, context, { filename: 'background.js' });
    const listener = runtimeListeners[0];
    function send(request) {
        return new Promise((resolve) => {
            const keepChannelOpen = listener(request, {}, resolve);
            if (keepChannelOpen !== true) resolve({ ignored: true });
        });
    }
    return { state, listener, send };
}

test('background preserves numeric-string storage and deletes only the selected key', async () => {
    const harness = createBackgroundHarness({ '9007199254740992': 'Old memo', '555': 'Keep this memo' });
    let response = await harness.send({ action: 'getMemo', id: '9007199254740992' });
    assert.equal(response.ok, true);
    assert.equal(response.res, 'Old memo');
    response = await harness.send({ action: 'setMemo', id: '9007199254740992', memo: 'Updated memo' });
    assert.equal(response.ok, true);
    assert.equal(harness.state.data['9007199254740992'], 'Updated memo');
    response = await harness.send({ action: 'setMemo', id: '9007199254740992', memo: '' });
    assert.equal(response.ok, true);
    assert.equal(response.res, 'memo is deleted');
    assert.deepEqual(harness.state.removedKeys, ['9007199254740992']);
    assert.equal(Object.hasOwn(harness.state.data, '9007199254740992'), false);
    assert.equal(harness.state.data['555'], 'Keep this memo');
    response = await harness.send({ action: 'listMemo' });
    assert.equal(response.res['555'], 'Keep this memo');
    assert.equal((await harness.send({ action: 'unknown' })).ignored, true);
});

test('background serializes verified profile indexing, rename, reassignment, and deletion', async () => {
    const key = '__twitterMemoProfileIndexV1';
    const harness = createBackgroundHarness({ '9007199254740992': 'Legacy memo', '555': 'Other memo' });

    const initial = await Promise.all([
        harness.send({ action: 'rememberMemoProfile', id: '9007199254740992', handle: 'Alpha' }),
        harness.send({ action: 'rememberMemoProfile', id: '555', handle: 'Beta' }),
    ]);
    assert.equal(initial.every((response) => response.ok), true);
    assert.deepEqual({ ...harness.state.data[key] }, { '9007199254740992': 'alpha', '555': 'beta' });

    let response = await harness.send({ action: 'rememberMemoProfile', id: '777', handle: 'NoMemo' });
    assert.equal(response.ok, true);
    assert.deepEqual({ ...harness.state.data[key] }, { '9007199254740992': 'alpha', '555': 'beta' });

    await harness.send({ action: 'setMemo', id: '9007199254740992', handle: 'RenamedAlpha', memo: 'Updated memo' });
    assert.deepEqual({ ...harness.state.data[key] }, { '9007199254740992': 'renamedalpha', '555': 'beta' });

    await harness.send({ action: 'setMemo', id: '555', handle: 'RenamedAlpha', memo: 'Other memo updated' });
    assert.deepEqual({ ...harness.state.data[key] }, { '555': 'renamedalpha' });
    assert.equal(harness.state.data['9007199254740992'], 'Updated memo');

    const deleteCurrentMemo = harness.send({ action: 'setMemo', id: '555', handle: 'RenamedAlpha', memo: '' });
    const delayedObservation = harness.send({ action: 'rememberMemoProfile', id: '555', handle: 'RenamedAlpha' });
    response = await deleteCurrentMemo;
    assert.equal(response.ok, true);
    assert.equal((await delayedObservation).res, false);
    assert.deepEqual({ ...harness.state.data[key] }, {});
    assert.equal(Object.hasOwn(harness.state.data, '555'), false);
    assert.equal(harness.state.data['9007199254740992'], 'Updated memo');
});

test('background reports rejected storage promises instead of reporting success', async () => {
    const harness = createBackgroundHarness({ '101': 'memo' });
    harness.state.failNext = new Error('Storage unavailable');
    const response = await harness.send({ action: 'setMemo', id: '101', memo: 'draft' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Storage unavailable');
    assert.equal(harness.state.data['101'], 'memo');
});

test('popup loads a labelled memo, uses safe profile links, and preserves drafts on save errors', async () => {
    const harness = createPopupHarness({
        getMemo: () => Promise.resolve({ ok: true, res: 'Existing memo' }),
        listMemo: () => Promise.resolve({ ok: true, res: { '9007199254740992': '<img src=x>', 'bad-key': 'ignored' } }),
        setMemo: () => Promise.resolve({ ok: false, error: 'Quota exceeded' }),
    });
    const { window, state } = harness;
    await waitFor(() => !window.document.getElementById('memoInput').disabled);
    const input = window.document.getElementById('memoInput');
    const button = window.document.getElementById('memoButton');
    const status = window.document.getElementById('memoStatus');
    const memoCell = window.document.querySelector('#memoRows tr td:nth-child(2)');
    const link = window.document.querySelector('#memoRows a');

    assert.equal(window.document.querySelector('label[for="memoInput"]').textContent, '메모');
    assert.equal(window.document.getElementById('currentHandle').textContent, '@Alpha');
    assert.equal(input.value, 'Existing memo');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(memoCell.textContent, '<img src=x>');
    assert.equal(memoCell.querySelector('img'), null);
    assert.equal(link.href, 'https://x.com/i/user/9007199254740992');
    assert.equal(link.target, '_blank');
    assert.equal(state.queryCalls.length >= 1, true);

    input.value = 'draft that failed';
    submitPopup(window);
    await waitFor(() => state.setRequests.length === 1);
    await settle();
    assert.equal(state.setRequests[0].id, '9007199254740992');
    assert.equal(state.setRequests[0].handle, 'Alpha');
    assert.equal(input.value, 'draft that failed');
    assert.equal(input.disabled, false);
    assert.match(status.textContent, /Quota exceeded/);
    assert.equal(window.document.querySelectorAll('dialog').length, 0);
    window.close();
});

test('popup disables writes after an initial memo read failure and keeps the draft', async () => {
    const initialRead = deferred();
    const harness = createPopupHarness({ getMemo: () => initialRead.promise, listMemo: () => Promise.resolve({ ok: true, res: {} }) });
    const { window } = harness;
    const input = window.document.getElementById('memoInput');
    const button = window.document.getElementById('memoButton');
    assert.equal(input.disabled, true);
    assert.equal(button.disabled, true);
    input.value = 'draft before read failure';
    initialRead.reject(new Error('storage read failed'));
    await waitFor(() => window.document.getElementById('memoStatus').textContent.includes('불러오지 못했습니다'));

    assert.equal(input.value, 'draft before read failure');
    assert.equal(input.disabled, true);
    assert.equal(button.disabled, true);
    submitPopup(window);
    await settle();
    assert.equal(harness.state.setRequests.length, 0);
    window.close();
});

test('popup loads asynchronously, blocks double submits, and re-enables controls after save', async () => {
    const initialRead = deferred();
    const saveResult = deferred();
    const harness = createPopupHarness({
        getMemo: () => initialRead.promise,
        listMemo: () => Promise.resolve({ ok: true, res: {} }),
        setMemo: () => saveResult.promise,
    });
    const { window, state } = harness;
    const input = window.document.getElementById('memoInput');
    const button = window.document.getElementById('memoButton');
    assert.equal(input.disabled, true);
    assert.equal(button.disabled, true);
    assert.match(window.document.getElementById('memoStatus').textContent, /불러오는 중/);

    initialRead.resolve({ ok: true, res: 'Stored memo' });
    await waitFor(() => !input.disabled);
    assert.equal(input.value, 'Stored memo');
    input.value = 'new memo';
    submitPopup(window);
    submitPopup(window);
    await waitFor(() => state.setRequests.length === 1);
    assert.equal(input.disabled, true);
    assert.equal(button.disabled, true);
    saveResult.resolve({ ok: true, res: 'memo is set' });
    await waitFor(() => window.document.getElementById('memoStatus').textContent === '메모를 저장했습니다.');

    assert.equal(state.setRequests.length, 1);
    assert.equal(input.value, 'new memo');
    assert.equal(input.disabled, false);
    assert.equal(button.disabled, false);
    window.close();
});

test('popup deletes a blank memo for only the current profile and ignores an older list response', async () => {
    const oldList = deferred();
    let listCall = 0;
    const harness = createPopupHarness({
        getMemo: () => Promise.resolve({ ok: true, res: 'Delete this memo' }),
        listMemo: () => {
            listCall += 1;
            return listCall === 1
                ? oldList.promise
                : Promise.resolve({ ok: true, res: { '555': 'Keep this memo' } });
        },
    });
    const { window, state } = harness;
    await waitFor(() => !window.document.getElementById('memoInput').disabled);
    const input = window.document.getElementById('memoInput');
    input.value = '';
    submitPopup(window);
    await waitFor(() => state.setRequests.length === 1);
    await waitFor(() => window.document.getElementById('memoStatus').textContent === '메모를 삭제했습니다.');
    assert.equal(state.setRequests[0].id, '9007199254740992');
    assert.equal(state.setRequests[0].memo, '');
    await waitFor(() => window.document.querySelector('#memoRows tr[data-memo-id="555"]') !== null);

    oldList.resolve({ ok: true, res: { '9007199254740992': 'stale memo', '555': 'Keep this memo' } });
    await settle();
    assert.equal(window.document.querySelector('#memoRows tr[data-memo-id="9007199254740992"]'), null);
    assert.equal(window.document.querySelector('#memoRows tr[data-memo-id="555"] td:nth-child(2)').textContent, 'Keep this memo');
    window.close();
});

test('popup revalidates the active profile before writing', async () => {
    const harness = createPopupHarness();
    const { window, state } = harness;
    await waitFor(() => !window.document.getElementById('memoInput').disabled);
    const input = window.document.getElementById('memoInput');
    input.value = 'do not send to another profile';
    state.profile = { id: '202', handle: 'Beta' };
    submitPopup(window);
    await waitFor(() => window.document.getElementById('memoStatus').textContent.includes('프로필이 바뀌었습니다'));

    assert.equal(state.setRequests.length, 0);
    assert.equal(input.value, 'do not send to another profile');
    assert.equal(input.disabled, true);
    assert.equal(window.document.getElementById('memoButton').disabled, true);
    window.close();
});
