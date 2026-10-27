const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'scripts/content.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'scripts/popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'scripts/background.js'), 'utf8');

function matchesSelector(element, selector) {
    const selectors = selector.split(',').map((part) => part.trim());
    return selectors.some((part) => {
        if (part === '*') return true;
        if (/^[a-z][a-z0-9-]*$/i.test(part)) return element.tagName.toLowerCase() === part.toLowerCase();
        const testId = part.match(/^\[data-testid="([^"]+)"\]$/);
        if (testId) {
            return element.getAttribute('data-testid') === testId[1];
        }
        const attribute = part.match(/^\[([a-z-]+)="([^"]+)"\]$/i);
        if (attribute) {
            return element.getAttribute(attribute[1]) === attribute[2];
        }
        if (part === 'script[type="application/ld+json"]') {
            return element.tagName === 'SCRIPT' && element.getAttribute('type') === 'application/ld+json';
        }
        return false;
    });
}

class FakeElement {
    constructor(tagName, document) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.ownerDocument = document;
        this.parentNode = null;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this._textContent = '';
        this.className = '';
        this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
        this.title = '';
        this.value = '';
        this.placeholder = '';
        this.disabled = false;
        this.insertedRows = [];
        this.innerHTMLAssigned = undefined;
    }

    get parentElement() {
        return this.parentNode;
    }

    get isConnected() {
        let node = this;
        while (node.parentNode) {
            node = node.parentNode;
        }
        return node === this.ownerDocument.documentElement;
    }

    get nextSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.children;
        return siblings[siblings.indexOf(this) + 1] || null;
    }

    get previousSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.children;
        return siblings[siblings.indexOf(this) - 1] || null;
    }

    get textContent() {
        if (!this.children.length) return this._textContent;
        return this._textContent + this.children.map((child) => child.textContent).join('');
    }

    set textContent(value) {
        this._textContent = String(value);
        for (const child of this.children) child.parentNode = null;
        this.children = [];
    }

    set innerHTML(value) {
        this.innerHTMLAssigned = String(value);
        this.textContent = String(value);
    }

    get innerHTML() {
        return this.innerHTMLAssigned;
    }

    getClientRects() {
        return this.hidden ? [] : [{}];
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    matches(selector) {
        return matchesSelector(this, selector);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const found = [];
        const visit = (node) => {
            for (const child of node.children) {
                if (matchesSelector(child, selector)) found.push(child);
                visit(child);
            }
        };
        visit(this);
        return found;
    }

    appendChild(node) {
        return this.insertBefore(node, null);
    }

    insertBefore(node, beforeNode) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const index = beforeNode ? this.children.indexOf(beforeNode) : -1;
        if (index === -1) this.children.push(node);
        else this.children.splice(index, 0, node);
        node.parentNode = this;
        return node;
    }

    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index === -1) throw new Error('Node is not a child.');
        this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    async dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) {
            await listener({ preventDefault() {}, ...event });
        }
    }

    insertRow() {
        const row = new FakeElement('tr', this.ownerDocument);
        row.insertCell = () => {
            const cell = new FakeElement('td', this.ownerDocument);
            row.appendChild(cell);
            return cell;
        };
        this.insertedRows.push(row);
        this.appendChild(row);
        return row;
    }
}

class FakeDocument {
    constructor() {
        this.documentElement = new FakeElement('html', this);
        this.head = new FakeElement('head', this);
        this.body = new FakeElement('body', this);
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.elementsById = new Map();
    }

    createElement(tagName) {
        return new FakeElement(tagName, this);
    }

    registerId(id, element) {
        this.elementsById.set(id, element);
    }

    getElementById(id) {
        return this.elementsById.get(id) || null;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const found = [];
        if (matchesSelector(this.documentElement, selector)) found.push(this.documentElement);
        return found.concat(this.documentElement.querySelectorAll(selector));
    }
}

function createContentHarness(href) {
    const document = new FakeDocument();
    const windowListeners = new Map();
    const observers = [];
    const readRequests = [];
    const messageListeners = [];
    const window = {
        location: { href },
        history: {
            pushState(state, title, pathOrUrl) {
                this.lastState = { state, title };
                window.location.href = new URL(pathOrUrl, window.location.href).href;
            },
            replaceState(state, title, pathOrUrl) {
                this.lastState = { state, title };
                window.location.href = new URL(pathOrUrl, window.location.href).href;
            },
        },
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
    };
    const chrome = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                if (message.action === 'getMemo') {
                    readRequests.push({ id: message.id, callback });
                    return;
                }
                callback({ ok: true });
            },
            onMessage: {
                addListener(listener) { messageListeners.push(listener); },
            },
        },
    };
    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe(target, options) { this.target = target; this.options = options; }
        notify(mutations) { this.callback(mutations); }
    }
    const context = vm.createContext({
        Array,
        JSON,
        Number,
        Object,
        Promise,
        Set,
        URL,
        chrome,
        document,
        window,
        MutationObserver: FakeMutationObserver,
    });
    vm.runInContext(contentSource, context, { filename: 'content.js' });
    return { context, document, window, observers, readRequests, messageListeners };
}

function addProfile(harness, handle, id) {
    const { document } = harness;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        script.parentNode.removeChild(script);
    }
    let userName = document.querySelector('[data-testid="UserName"]');
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) {
        const column = document.createElement('main');
        column.setAttribute('data-testid', 'primaryColumn');
        document.body.appendChild(column);
    }
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (userName && userName.parentNode) userName.parentNode.removeChild(userName);
    userName = document.createElement('div');
    userName.setAttribute('data-testid', 'UserName');
    const displayName = document.createElement('span');
    displayName.textContent = 'X';
    const visibleHandle = document.createElement('span');
    visibleHandle.textContent = `@${handle}`;
    userName.appendChild(displayName);
    userName.appendChild(visibleHandle);
    column.appendChild(userName);

    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
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
    return { userName, script };
}

function notifyIdentityMutation(harness, addedNodes = [], removedNodes = []) {
    harness.observers[0].notify([{
        target: harness.document.body,
        addedNodes,
        removedNodes,
    }]);
}

function respondToRead(request, memo) {
    request.callback({ ok: true, res: memo });
}

function getDisplayedMemo(document) {
    return document.querySelector('[data-twitter-memo-display="true"]');
}

function makeHelperContext(document = new FakeDocument(), window = { location: { href: 'https://x.com/Alpha' } }) {
    const context = vm.createContext({ Array, JSON, Number, Object, Set, URL, document, window });
    const helperSource = contentSource.split('let activeProfile = null;')[0];
    vm.runInContext(helperSource, context, { filename: 'content-helpers.js' });
    return context;
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('accepts supported X and legacy Twitter profile routes only', () => {
    const context = makeHelperContext();
    const route = (url) => vm.runInContext(`getProfileHandle(${JSON.stringify(url)})`, context);

    assert.equal(route('https://x.com/Alpha'), 'Alpha');
    assert.equal(route('https://x.com/Alpha/media?lang=en'), 'Alpha');
    assert.equal(route('https://twitter.com/Alpha/with_replies'), 'Alpha');
    assert.equal(route('https://twitter.com/intent/user?screen_name=Alpha'), 'Alpha');
    assert.equal(route('https://x.com/home'), null);
    assert.equal(route('https://x.com/search?q=Alpha'), null);
    assert.equal(route('https://x.com/communities'), null);
    assert.equal(route('https://x.com/Alpha/status/123'), null);
    assert.equal(route('https://example.com/Alpha'), null);
});

test('matches the visible handle when X concatenates it directly after the display name', () => {
    const context = makeHelperContext();
    const userName = new FakeElement('div', new FakeDocument());
    const displayName = userName.ownerDocument.createElement('span');
    displayName.textContent = 'X';
    const visibleHandle = userName.ownerDocument.createElement('span');
    visibleHandle.textContent = '@X';
    userName.appendChild(displayName);
    userName.appendChild(visibleHandle);
    assert.equal(userName.textContent, 'X@X');
    context.userNameFixture = userName;
    assert.equal(vm.runInContext('visibleHeaderMatches(userNameFixture, "X")', context), true);

    userName.removeChild(visibleHandle);
    userName.textContent = 'X@Xx';
    assert.equal(vm.runInContext('visibleHeaderMatches(userNameFixture, "X")', context), false);
});

test('fails closed when the display name matches the route but the visible handle does not', async () => {
    const harness = createContentHarness('https://x.com/Expected');
    const primaryColumn = harness.document.createElement('main');
    primaryColumn.setAttribute('data-testid', 'primaryColumn');
    const userName = harness.document.createElement('div');
    userName.setAttribute('data-testid', 'UserName');
    const displayName = harness.document.createElement('span');
    displayName.textContent = '@Expected';
    const actualHandle = harness.document.createElement('span');
    actualHandle.textContent = '@Different';
    userName.appendChild(displayName);
    userName.appendChild(actualHandle);
    primaryColumn.appendChild(userName);
    harness.document.body.appendChild(primaryColumn);
    const script = harness.document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify({ mainEntity: { additionalName: 'Expected', identifier: '123', url: 'https://x.com/Expected' } });
    harness.document.head.appendChild(script);
    notifyIdentityMutation(harness, [userName, script]);
    await flushPromises();

    assert.equal(vm.runInContext('getValidatedProfile()', harness.context), null);
    assert.equal(harness.readRequests.length, 0);
    let response;
    harness.messageListeners[0]({ action: 'tmemo_requestData' }, {}, (value) => { response = value; });
    assert.deepEqual({ ok: response.ok, id: response.id }, { ok: false, id: 'not found' });
});

test('reads current mainEntity, legacy author, arrays and @graph while rejecting mismatches and unsafe IDs', () => {
    const document = new FakeDocument();
    const context = makeHelperContext(document);
    const setJsonLd = (value) => {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            script.parentNode.removeChild(script);
        }
        const script = document.createElement('script');
        script.setAttribute('type', 'application/ld+json');
        script.textContent = JSON.stringify(value);
        document.head.appendChild(script);
    };
    const getId = () => vm.runInContext('getJsonLdProfileId("Alpha")', context);
    const setRawJsonLd = (raw) => {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            script.parentNode.removeChild(script);
        }
        const script = document.createElement('script');
        script.setAttribute('type', 'application/ld+json');
        script.textContent = raw;
        document.head.appendChild(script);
    };

    setJsonLd({ '@type': 'ProfilePage', mainEntity: { additionalName: 'Alpha', identifier: '783214', url: 'https://x.com/Alpha' } });
    assert.equal(getId(), '783214');
    setJsonLd({ '@type': 'ProfilePage', author: { additionalName: 'Alpha', identifier: '555', url: 'https://twitter.com/Alpha' } });
    assert.equal(getId(), '555');
    setJsonLd([{ '@graph': [{ mainEntity: { additionalName: 'Alpha', identifier: 777, url: 'https://x.com/Alpha' } }] }]);
    assert.equal(getId(), '777');
    setJsonLd({ mainEntity: { additionalName: 'Different', identifier: '123', url: 'https://x.com/Different' } });
    assert.equal(getId(), null);
    setJsonLd({ mainEntity: { additionalName: 'Alpha', identifier: '123', url: 'https://x.com/Different' } });
    assert.equal(getId(), null);
    setJsonLd({ mainEntity: { additionalName: 'Alpha', identifier: '9007199254740992', url: 'https://x.com/Alpha' } });
    assert.equal(getId(), '9007199254740992');
    setJsonLd({ mainEntity: { additionalName: 'Alpha', identifier: 9007199254740992, url: 'https://x.com/Alpha' } });
    assert.equal(getId(), null);
    setRawJsonLd('{ malformed json');
    assert.equal(getId(), null);
});

test('waits for matching visible identity, displays memo as text, and follows SPA profile changes', async () => {
    const harness = createContentHarness('https://x.com/Alpha');
    assert.equal(harness.readRequests.length, 0);
    const alpha = addProfile(harness, 'Alpha', '101');
    assert.equal(vm.runInContext('getValidatedProfile()?.id || null', harness.context), '101');
    harness.context.testNode = alpha.userName;
    assert.equal(vm.runInContext('isIdentityRelatedNode(testNode)', harness.context), true);
    notifyIdentityMutation(harness, [alpha.userName, alpha.script]);
    await flushPromises();

    assert.equal(harness.readRequests.length, 1);
    assert.equal(harness.readRequests[0].id, '101');
    const requestData = harness.messageListeners[0];
    let response;
    requestData({ action: 'tmemo_requestData' }, {}, (value) => { response = value; });
    assert.deepEqual({ ok: response.ok, id: response.id }, { ok: true, id: '101' });

    harness.window.history.pushState({}, '', '/Beta');
    const beta = addProfile(harness, 'Beta', '202');
    notifyIdentityMutation(harness, [beta.userName, beta.script], [alpha.userName, alpha.script]);
    await flushPromises();
    assert.equal(harness.readRequests.length, 2);
    assert.equal(harness.readRequests[1].id, '202');

    respondToRead(harness.readRequests[0], '<img src=x onerror=alert(1)>');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document).textContent, '@Beta');
    respondToRead(harness.readRequests[1], '<img src=x onerror=alert(1)>');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document).textContent, "@Beta : '<img src=x onerror=alert(1)>'");
    assert.equal(getDisplayedMemo(harness.document).innerHTML, undefined);

    harness.window.history.pushState({}, '', '/home');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document), null);
    requestData({ action: 'tmemo_requestData' }, {}, (value) => { response = value; });
    assert.deepEqual({ ok: response.ok, id: response.id }, { ok: false, id: 'not found' });
});

test('generation tokens reject stale A-to-B-to-A memo reads', async () => {
    const harness = createContentHarness('https://x.com/Alpha');
    const alpha = addProfile(harness, 'Alpha', '101');
    notifyIdentityMutation(harness, [alpha.userName, alpha.script]);
    await flushPromises();
    const firstAlphaRead = harness.readRequests[0];

    harness.window.location.href = 'https://x.com/Beta';
    const beta = addProfile(harness, 'Beta', '202');
    notifyIdentityMutation(harness, [beta.userName, beta.script], [alpha.userName, alpha.script]);
    await flushPromises();
    assert.equal(harness.readRequests.length, 2);
    assert.equal(harness.readRequests[1].id, '202');

    harness.window.location.href = 'https://x.com/Alpha';
    const finalAlpha = addProfile(harness, 'Alpha', '101');
    notifyIdentityMutation(harness, [finalAlpha.userName, finalAlpha.script], [beta.userName, beta.script]);
    await flushPromises();

    assert.equal(harness.readRequests.length, 3);
    assert.equal(harness.readRequests[2].id, '101');
    respondToRead(firstAlphaRead, 'stale memo');
    respondToRead(harness.readRequests[1], 'stale Beta memo');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document).textContent, '@Alpha');
    respondToRead(harness.readRequests[2], 'current memo');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document).textContent, "@Alpha : 'current memo'");
});

test('detects page-world route changes on unrelated DOM mutations', async () => {
    const harness = createContentHarness('https://x.com/Alpha');
    const alpha = addProfile(harness, 'Alpha', '101');
    notifyIdentityMutation(harness, [alpha.userName, alpha.script]);
    await flushPromises();
    assert.equal(harness.readRequests[0].id, '101');

    // Model page-world history changing the URL while the isolated content world cannot wrap it.
    harness.window.location.href = 'https://x.com/Beta';
    const beta = addProfile(harness, 'Beta', '202');
    const unrelatedNode = harness.document.createElement('div');
    notifyIdentityMutation(harness, [unrelatedNode]);
    await flushPromises();

    assert.equal(harness.readRequests.length, 2);
    assert.equal(harness.readRequests[1].id, '202');
    respondToRead(harness.readRequests[0], 'stale Alpha memo');
    respondToRead(harness.readRequests[1], 'Beta memo');
    await flushPromises();
    assert.equal(getDisplayedMemo(harness.document).textContent, "@Beta : 'Beta memo'");
});

test('numeric ID validation preserves positive digit strings and rejects unsafe number values', () => {
    const context = makeHelperContext();
    const normalize = (value) => vm.runInContext(`normalizeNumericId(${JSON.stringify(value)})`, context);

    assert.equal(normalize('783214'), '783214');
    assert.equal(normalize(783214), '783214');
    assert.equal(normalize('9007199254740992'), '9007199254740992');
    assert.equal(normalize('0'), null);
    assert.equal(normalize(9007199254740992), null);
    assert.equal(normalize(1.5), null);
});

test('background reads and writes the existing numeric-key string memo contract and reports storage errors', async () => {
    const data = { '9007199254740992': 'Existing memo', 'invalid-key': 'other data' };
    const runtime = {
        lastError: null,
        onInstalled: { addListener() {} },
        onMessage: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
    };
    const chrome = {
        runtime,
        action: { setBadgeText() {} },
        storage: {
            local: {
                get(keys, callback) {
                    const result = keys === null
                        ? { ...data }
                        : Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
                    callback(result);
                },
                set(items, callback) {
                    if (chrome.nextStorageError) {
                        runtime.lastError = { message: chrome.nextStorageError };
                        callback();
                        runtime.lastError = null;
                        return;
                    }
                    Object.assign(data, items);
                    callback();
                },
            },
        },
        nextStorageError: null,
    };
    vm.runInNewContext(backgroundSource, { chrome });
    const listener = runtime.onMessage.listeners[0];
    const send = (request) => new Promise((resolve) => listener(request, {}, resolve));

    let response = await send({ action: 'getMemo', id: '9007199254740992' });
    assert.equal(response.ok, true);
    assert.equal(response.res, 'Existing memo');
    response = await send({ action: 'setMemo', id: '9007199254740992', memo: 'Updated memo' });
    assert.equal(response.ok, true);
    assert.equal(response.res, 'memo is set');
    assert.equal(data['9007199254740992'], 'Updated memo');
    response = await send({ action: 'getMemo', id: '0' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Invalid profile ID.');

    chrome.nextStorageError = 'Quota exceeded';
    response = await send({ action: 'setMemo', id: '9007199254740992', memo: 'not saved' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Quota exceeded');
    assert.equal(data['9007199254740992'], 'Updated memo');
});

function createPopupHarness() {
    const document = new FakeDocument();
    const input = document.createElement('input');
    const button = document.createElement('button');
    const table = document.createElement('table');
    document.registerId('memoInput', input);
    document.registerId('memoButton', button);
    document.registerId('memoTable', table);
    const alerts = [];
    const sentRuntimeMessages = [];
    const state = { currentTabId: 7, currentProfileId: '9007199254740992', setResponse: { ok: false, error: 'Quota exceeded' }, tabMessageCalls: 0, replaced: null };
    const chrome = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                sentRuntimeMessages.push(message);
                if (message.action === 'listMemo') {
                    callback({ ok: true, res: { '9007199254740992': '<img src=x onerror=alert(1)>', 'bad-key': 'ignore' } });
                } else if (message.action === 'getMemo') {
                    callback({ ok: true, res: 'Existing memo' });
                } else if (message.action === 'setMemo') {
                    callback(state.setResponse);
                }
            },
        },
        tabs: {
            query(query, callback) { callback([{ id: state.currentTabId, url: 'https://x.com/Alpha' }]); },
            sendMessage(tabId, message, callback) {
                state.tabMessageCalls += 1;
                callback({ ok: true, id: state.currentProfileId, handle: 'Alpha' });
            },
        },
    };
    const location = {
        href: 'chrome-extension://test/popup.html',
        replace(url) { state.replaced = url; },
    };
    const window = { open() {} };
    vm.runInNewContext(popupSource, { chrome, document, location, window, alert: (message) => alerts.push(message), encodeURIComponent });
    return { alerts, button, chrome, document, input, location, sentRuntimeMessages, state, table };
}

test('popup saves only after storage confirms the same current numeric profile ID', async () => {
    const harness = createPopupHarness();
    await flushPromises();
    assert.equal(harness.button.disabled, false);
    assert.equal(harness.input.placeholder, 'Existing memo');

    const listedMemo = harness.table.insertedRows[0].children[1];
    assert.equal(listedMemo.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(listedMemo.innerHTML, undefined);
    assert.equal(harness.table.insertedRows.length, 1);

    harness.input.value = 'new memo';
    await harness.button.dispatch('click');
    assert.equal(harness.state.replaced, null);
    assert.equal(harness.input.value, 'new memo');
    assert.match(harness.alerts.at(-1), /could not be saved/i);
    assert.ok(harness.sentRuntimeMessages.some((message) => message.action === 'setMemo' && message.id === '9007199254740992'));

    harness.state.setResponse = { ok: true, res: 'memo is set' };
    await harness.button.dispatch('click');
    assert.equal(harness.state.replaced, harness.location.href);
    assert.equal(harness.input.value, '');
    assert.match(harness.alerts.at(-1), /memo is saved/i);
    assert.ok(harness.sentRuntimeMessages.filter((message) => message.action === 'setMemo').every((message) => message.id === '9007199254740992'));
});

test('popup refuses to save when the tab changes profile after opening', async () => {
    const harness = createPopupHarness();
    await flushPromises();
    harness.input.value = 'memo for old profile';
    harness.state.currentProfileId = '900';
    await harness.button.dispatch('click');

    assert.equal(harness.sentRuntimeMessages.some((message) => message.action === 'setMemo'), false);
    assert.equal(harness.state.replaced, null);
    assert.equal(harness.input.value, 'memo for old profile');
    assert.equal(harness.button.disabled, true);
    assert.match(harness.alerts.at(-1), /profile changed/i);
});
