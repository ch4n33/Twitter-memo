const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const probeSource = fs.readFileSync(path.join(root, 'tools/probe-x-user-id.js'), 'utf8');

function createDom(url = 'https://x.com/Target') {
  return new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    runScripts: 'outside-only',
  });
}

function addProfileJsonLd(window, handle, identifier, { type = 'ProfilePage', url = `https://x.com/${handle}`, legacy = false } = {}) {
  const script = window.document.createElement('script');
  script.type = 'application/ld+json';
  const person = { '@type': 'Person', additionalName: handle, identifier, url };
  script.textContent = JSON.stringify({ '@type': type, ...(legacy ? { author: person } : { mainEntity: person }) });
  window.document.head.appendChild(script);
  return script;
}

function addPost(window, {
  handle = 'Target',
  postId = '1234567890123456789',
  userId = '9876543210987654321',
  fiberSuffix = 'random_a1',
  fiberDepth = 13,
  modelPostId = postId,
  model = null,
  modelAt = [fiberDepth],
  cycleTo = null,
  fiberNodes = null,
  headerLocation = null,
  timestamp = true,
} = {}) {
  const document = window.document;
  const article = document.createElement('article');
  article.setAttribute('data-testid', 'tweet');
  const header = document.createElement('div');
  header.setAttribute('data-testid', 'User-Name');
  const profileAnchor = document.createElement('a');
  profileAnchor.href = `/${handle}`;
  profileAnchor.setAttribute('role', 'link');
  profileAnchor.textContent = 'profile link';
  header.appendChild(profileAnchor);
  if (timestamp) {
    const timeAnchor = document.createElement('a');
    timeAnchor.href = `/${handle}/status/${postId}`;
    timeAnchor.setAttribute('role', 'link');
    const time = document.createElement('time');
    time.textContent = 'timestamp';
    timeAnchor.appendChild(time);
    header.appendChild(timeAnchor);
  }

  if (headerLocation === 'socialContext' || headerLocation === 'quote' || headerLocation === 'roleLink') {
    const wrapper = document.createElement('div');
    if (headerLocation === 'socialContext') wrapper.setAttribute('data-testid', 'socialContext');
    if (headerLocation === 'quote') wrapper.setAttribute('data-testid', 'QuoteTweet');
    if (headerLocation === 'roleLink') wrapper.setAttribute('role', 'link');
    wrapper.appendChild(header);
    article.appendChild(wrapper);
  } else if (headerLocation !== 'missing') {
    article.appendChild(header);
  }
  document.body.appendChild(article);

  const tweets = fiberNodes || [{
    id_str: modelPostId,
    user: { id_str: userId },
    ...(model || {}),
  }];
  const deepestModelDepth = Math.max(...modelAt, 0);
  const nodes = Array.from({ length: Math.max(fiberDepth, deepestModelDepth) + 1 }, () => ({}));
  for (let index = 0; index < nodes.length - 1; index += 1) nodes[index].return = nodes[index + 1];
  if (cycleTo !== null && nodes.length) nodes[nodes.length - 1].return = nodes[cycleTo];
  for (let index = 0; index < modelAt.length; index += 1) {
    nodes[modelAt[index]].memoizedProps = { tweet: tweets[index] };
  }
  Object.defineProperty(article, `__reactFiber$${fiberSuffix}`, {
    configurable: true,
    value: nodes[0],
  });
  return { article, header, nodes };
}

function runProbe(window) {
  const result = window.eval(probeSource);
  assert.equal(typeof result, 'string', 'The console expression returns a JSON string.');
  return JSON.parse(result);
}

test('matches current profile posts by exact DOM status ID and returns large IDs as strings', () => {
  const dom = createDom('https://x.com/Target/media');
  const { window } = dom;
  const postId = '2123456789012345678';
  const userId = '9007199254740997';
  addPost(window, { handle: 'Target', postId, userId, fiberSuffix: 'new_runtime_suffix', fiberDepth: 17 });

  const report = runProbe(window);
  assert.equal(report.status, 'ok');
  assert.equal(report.pathname, '/Target/media');
  assert.equal(report.samples.length, 1);
  assert.deepEqual(report.samples[0], {
    postId,
    userId,
    status: 'ok',
    path: '__reactFiber$* -> return×17 -> memoizedProps.tweet (observed depth 17)',
  });
  assert.equal(report.reference.status, 'unavailable');
  assert.match(report.summary, /reference is unavailable/);
  assert.equal(JSON.stringify(report).includes('new_runtime_suffix'), false);
  dom.window.close();
});

test('samples at most three primary authored posts and excludes wrong authors and quote-like cards', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { handle: 'SomeoneElse', postId: '101', userId: '201' });
  addPost(window, { headerLocation: 'socialContext', postId: '102', userId: '202' });
  addPost(window, { headerLocation: 'quote', postId: '103', userId: '203' });
  addPost(window, { headerLocation: 'roleLink', postId: '104', userId: '204' });
  addPost(window, { postId: '105', userId: '205', fiberSuffix: 'suffix_two' });
  addPost(window, { postId: '106', userId: '206', fiberSuffix: 'suffix_three' });
  addPost(window, { postId: '107', userId: '207', fiberSuffix: 'suffix_four' });
  addPost(window, { postId: '108', userId: '208', fiberSuffix: 'suffix_five' });

  const report = runProbe(window);
  assert.equal(report.samples.length, 3);
  assert.deepEqual(report.samples.map(({ postId }) => postId), ['105', '106', '107']);
  dom.window.close();
});

test('requires the React tweet ID to match the exact DOM post ID', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { postId: '301', modelPostId: '302', userId: '401', fiberDepth: 3 });

  const report = runProbe(window);
  assert.equal(report.status, 'probe_incomplete');
  assert.equal(report.samples[0].postId, '301');
  assert.equal(report.samples[0].userId, null);
  assert.equal(report.samples[0].status, 'tweet_id_mismatch');
  assert.match(report.samples[0].path, /observed depth 3/);
  dom.window.close();
});

test('reports missing DOM timestamp links and missing model fields without claiming schema drift', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { postId: '501', timestamp: false });
  addPost(window, { postId: '502', model: { id_str: undefined }, fiberDepth: 2 });

  const report = runProbe(window);
  assert.equal(report.status, 'probe_incomplete');
  assert.deepEqual(report.samples.map(({ status, userId }) => ({ status, userId })), [
    { status: 'dom_tweet_link_missing', userId: null },
    { status: 'tweet_model_id_missing', userId: null },
  ]);
  assert.doesNotMatch(report.summary, /schema changed/i);
  dom.window.close();
});

test('distinguishes absent tweet model and missing user ID fields', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { postId: '601', fiberNodes: [], modelAt: [] });
  addPost(window, { postId: '602', model: { user: { id_str: undefined } }, fiberDepth: 0 });

  const report = runProbe(window);
  assert.deepEqual(report.samples.map(({ status }) => status), ['tweet_model_missing', 'user_id_missing']);
  dom.window.close();
});

test('reports when an article has no dynamic React fiber property', () => {
  const dom = createDom();
  const { window } = dom;
  const fixture = addPost(window, { postId: '650', userId: '651', fiberDepth: 0 });
  delete fixture.article.__reactFiber$random_a1;

  const report = runProbe(window);
  assert.equal(report.samples[0].status, 'react_fiber_missing');
  assert.equal(report.samples[0].userId, null);
  assert.equal(report.samples[0].path, '__reactFiber$* missing');
  dom.window.close();
});

test('rejects numeric unsafe IDs and conflicting author IDs', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { postId: '701', userId: 9007199254740992, fiberDepth: 1 });
  addPost(window, {
    postId: '702',
    fiberDepth: 0,
    modelAt: [0, 1],
    model: {},
    fiberNodes: [
      { id_str: '702', user: { id_str: '801' } },
      { id_str: '702', user: { id_str: '802' } },
    ],
  });

  const report = runProbe(window);
  assert.deepEqual(report.samples.map(({ status, userId }) => ({ status, userId })), [
    { status: 'unsafe_numeric_id', userId: null },
    { status: 'identity_conflict', userId: null },
  ]);
  dom.window.close();
});

test('compares a same-handle JSON-LD reference and rejects a conflicting reference ID', () => {
  const dom = createDom();
  const { window } = dom;
  addProfileJsonLd(window, 'Target', '9007199254740994');
  addPost(window, { postId: '801', userId: '9007199254740993', fiberDepth: 5 });

  const report = runProbe(window);
  assert.deepEqual(report.reference, { status: 'available', userId: '9007199254740994' });
  assert.equal(report.status, 'probe_incomplete');
  assert.equal(report.samples[0].status, 'reference_conflict');
  assert.equal(report.samples[0].userId, null);
  dom.window.close();
});

test('rejects inconsistent author IDs across sampled posts when no profile reference exists', () => {
  const dom = createDom();
  const { window } = dom;
  addPost(window, { postId: '851', userId: '901', fiberDepth: 2 });
  addPost(window, { postId: '852', userId: '902', fiberDepth: 4, fiberSuffix: 'another_suffix' });

  const report = runProbe(window);
  assert.equal(report.reference.status, 'unavailable');
  assert.deepEqual(report.samples.map(({ status, userId }) => ({ status, userId })), [
    { status: 'identity_conflict', userId: null },
    { status: 'identity_conflict', userId: null },
  ]);
  dom.window.close();
});

test('ignores mismatched profile JSON-LD handles and supports the legacy author field', () => {
  const dom = createDom();
  const { window } = dom;
  addProfileJsonLd(window, 'Different', '901');
  addPost(window, { postId: '902', userId: '903', fiberDepth: 1 });

  const first = runProbe(window);
  assert.deepEqual(first.reference, { status: 'unavailable' });
  assert.equal(first.samples[0].status, 'ok');

  window.document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => script.remove());
  addProfileJsonLd(window, 'Target', '903', { legacy: true });
  const second = runProbe(window);
  assert.deepEqual(second.reference, { status: 'available', userId: '903' });
  assert.equal(second.samples[0].status, 'ok');
  dom.window.close();
});

test('reports fiber cycles and enforces the 64-fiber bound', () => {
  const cyclic = createDom();
  addPost(cyclic.window, { postId: '1001', userId: '1002', fiberDepth: 0, modelAt: [], cycleTo: 0 });
  const cycleReport = runProbe(cyclic.window);
  assert.equal(cycleReport.samples[0].status, 'fiber_cycle');
  cyclic.window.close();

  const atLimit = createDom();
  addPost(atLimit.window, { postId: '1005', userId: '1006', fiberDepth: 63, modelAt: [63] });
  const atLimitReport = runProbe(atLimit.window);
  assert.equal(atLimitReport.samples[0].status, 'ok');
  assert.match(atLimitReport.samples[0].path, /return×63 .*observed depth 63/);
  atLimit.window.close();

  const bounded = createDom();
  addPost(bounded.window, { postId: '1003', userId: '1004', fiberDepth: 64, modelAt: [64] });
  const boundReport = runProbe(bounded.window);
  assert.equal(boundReport.samples[0].status, 'fiber_bound_reached');
  assert.match(boundReport.samples[0].path, /return×63 .*64-fiber bound/);
  bounded.window.close();
});

test('distinguishes wrong scope, login, no posts, and unavailable browser context', () => {
  const wrongScope = createDom('https://x.com/settings');
  assert.equal(runProbe(wrongScope.window).status, 'wrong_scope');
  wrongScope.window.close();

  const login = createDom();
  const loginButton = login.window.document.createElement('button');
  loginButton.setAttribute('data-testid', 'LoginForm_Login_Button');
  login.window.document.body.appendChild(loginButton);
  assert.equal(runProbe(login.window).status, 'login_required');
  login.window.close();

  const empty = createDom();
  assert.equal(runProbe(empty.window).status, 'no_posts');
  empty.window.close();

  const unavailable = vm.runInNewContext(probeSource);
  assert.equal(typeof unavailable, 'string');
  assert.equal(JSON.parse(unavailable).status, 'browser_unavailable');
});
