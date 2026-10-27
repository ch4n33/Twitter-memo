(() => {
  let checkedAt = null;
  try {
    checkedAt = new Date().toISOString();
  } catch (error) {
    checkedAt = null;
  }

  let pathname = null;
  const report = {
    checkedAt,
    pathname,
    status: 'browser_unavailable',
    summary: 'A page document and location are required to run this probe.',
    reference: { status: 'unavailable' },
    samples: [],
  };

  const finish = () => JSON.stringify(report);
  const isObject = (value) => value !== null && typeof value === 'object';
  const ownData = (object, key) => {
    if (!isObject(object)) return { found: false, value: undefined };
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(object, key);
    } catch (error) {
      return { found: false, value: undefined };
    }
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false, value: undefined };
  };
  const isPositiveDigits = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value);
  const allowedHost = (hostname) => ['x.com', 'twitter.com'].includes(String(hostname || '').toLowerCase());
  const handlePattern = /^[a-zA-Z0-9_]{1,15}$/;
  const reservedPaths = new Set([
    'about', 'account', 'bookmarks', 'communities', 'compose', 'download', 'events', 'explore',
    'followers', 'following', 'hashtag', 'home', 'i', 'intent', 'jobs', 'lists', 'login',
    'logout', 'messages', 'moments', 'notifications', 'oauth', 'premium', 'privacy', 'search',
    'settings', 'share', 'signup', 'spaces', 'topics', 'tos', 'verified_followers', 'widgets',
  ]);
  const profileSubroutes = new Set(['with_replies', 'reposts', 'highlights', 'articles', 'media', 'likes']);

  const getProfileHandle = (urlValue) => {
    let url;
    try {
      url = new URL(urlValue);
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'https:' || !allowedHost(url.hostname)) return null;

    let parts;
    try {
      parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch (error) {
      return null;
    }
    if (parts.length < 1 || parts.length > 2) return null;
    const handle = parts[0];
    if (!handlePattern.test(handle) || reservedPaths.has(handle.toLowerCase())) return null;
    if (parts.length === 2 && !profileSubroutes.has(parts[1].toLowerCase())) return null;
    return handle;
  };

  const normalizedEntityHandle = (entity, baseUrl) => {
    if (!isObject(entity)) return null;
    const name = ownData(entity, 'additionalName');
    const entityUrl = ownData(entity, 'url');
    let nameHandle = null;
    if (name.found && typeof name.value === 'string') {
      const candidate = name.value.startsWith('@') ? name.value.slice(1) : name.value;
      if (handlePattern.test(candidate)) nameHandle = candidate;
    }
    let urlHandle = null;
    if (entityUrl.found) {
      if (typeof entityUrl.value !== 'string') return null;
      try {
        urlHandle = getProfileHandle(new URL(entityUrl.value, baseUrl).href);
      } catch (error) {
        return null;
      }
      if (!urlHandle) return null;
    }
    if (nameHandle && urlHandle && nameHandle.toLowerCase() !== urlHandle.toLowerCase()) return null;
    return nameHandle || urlHandle;
  };

  const hasType = (value, wanted) => {
    const type = ownData(value, '@type');
    const types = Array.isArray(type.value) ? type.value : [type.value];
    return type.found && types.some((entry) => typeof entry === 'string' && entry.toLowerCase() === wanted.toLowerCase());
  };

  const collectProfilePages = (value, pages, seen, depth, budget) => {
    if (budget.count >= 128 || depth > 8 || !isObject(value) || seen.has(value)) return;
    seen.add(value);
    budget.count += 1;
    if (Array.isArray(value)) {
      for (const entry of value) collectProfilePages(entry, pages, seen, depth + 1, budget);
      return;
    }
    if (hasType(value, 'ProfilePage')) pages.push(value);
    for (const key of ['@graph']) {
      const nested = ownData(value, key);
      if (nested.found) collectProfilePages(nested.value, pages, seen, depth + 1, budget);
    }
  };

  const collectEntities = (value, entities, seen, depth, budget) => {
    if (budget.count >= 128 || depth > 8 || !isObject(value) || seen.has(value)) return;
    seen.add(value);
    budget.count += 1;
    if (Array.isArray(value)) {
      for (const entry of value) collectEntities(entry, entities, seen, depth + 1, budget);
      return;
    }
    entities.push(value);
    for (const key of ['mainEntity', 'author', '@graph']) {
      const nested = ownData(value, key);
      if (nested.found) collectEntities(nested.value, entities, seen, depth + 1, budget);
    }
  };

  const normalizeReferenceId = (value) => {
    if (typeof value === 'string') return isPositiveDigits(value) ? { id: value } : { invalid: true };
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return { unsafe: true };
      if (value <= 0) return { invalid: true };
      return { id: String(value) };
    }
    return { invalid: true };
  };

  const getProfileReference = (document, handle, baseUrl) => {
    const ids = new Set();
    let sawUnsafe = false;
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of Array.from(scripts).slice(0, 16)) {
      const text = script.textContent || '';
      if (text.length > 65536) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        continue;
      }
      const pages = [];
      collectProfilePages(parsed, pages, new Set(), 0, { count: 0 });
      for (const page of pages) {
        const mainEntity = ownData(page, 'mainEntity');
        const mainEntities = [];
        if (mainEntity.found) collectEntities(mainEntity.value, mainEntities, new Set(), 0, { count: 0 });
        const matchingMain = mainEntities.filter((entity) => {
          const entityHandle = normalizedEntityHandle(entity, baseUrl);
          return entityHandle && entityHandle.toLowerCase() === handle.toLowerCase();
        });

        let entities = matchingMain;
        if (!entities.length) {
          const legacyAuthor = ownData(page, 'author');
          const authors = [];
          if (legacyAuthor.found) collectEntities(legacyAuthor.value, authors, new Set(), 0, { count: 0 });
          entities = authors.filter((entity) => {
            const entityHandle = normalizedEntityHandle(entity, baseUrl);
            return entityHandle && entityHandle.toLowerCase() === handle.toLowerCase();
          });
        }

        for (const entity of entities) {
          const identifier = ownData(entity, 'identifier');
          if (!identifier.found) continue;
          const normalized = normalizeReferenceId(identifier.value);
          if (normalized.id) ids.add(normalized.id);
          if (normalized.unsafe) sawUnsafe = true;
        }
      }
    }
    if (ids.size > 1) return { status: 'conflict' };
    if (sawUnsafe) return { status: ids.size ? 'conflict' : 'unsafe_numeric_id' };
    if (ids.size === 1) return { status: 'available', userId: ids.values().next().value };
    return { status: 'unavailable' };
  };

  const matchingProfileAnchor = (header, handle, baseUrl) => {
    for (const anchor of header.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (typeof href !== 'string') continue;
      let candidateUrl;
      try {
        candidateUrl = new URL(href, baseUrl);
      } catch (error) {
        continue;
      }
      const candidate = getProfileHandle(candidateUrl.href);
      if (candidate && candidate.toLowerCase() === handle.toLowerCase()) return true;
    }
    return false;
  };

  const getDomPostId = (header, handle, baseUrl) => {
    const ids = new Set();
    let sawTimestampLink = false;
    for (const anchor of header.querySelectorAll('a[href]')) {
      if (!anchor.querySelector('time')) continue;
      sawTimestampLink = true;
      const href = anchor.getAttribute('href');
      if (typeof href !== 'string') continue;
      let url;
      try {
        url = new URL(href, baseUrl);
      } catch (error) {
        continue;
      }
      if (url.protocol !== 'https:' || !allowedHost(url.hostname) || url.search || url.hash) continue;
      let parts;
      try {
        parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      } catch (error) {
        continue;
      }
      if (parts.length !== 3 || parts[0].toLowerCase() !== handle.toLowerCase() || parts[1].toLowerCase() !== 'status') continue;
      if (!/^\d+$/.test(parts[2])) continue;
      ids.add(parts[2]);
    }
    if (ids.size > 1) return { status: 'dom_post_id_conflict' };
    if (!ids.size) return { status: sawTimestampLink ? 'dom_post_id_missing' : 'dom_tweet_link_missing' };
    const id = ids.values().next().value;
    return isPositiveDigits(id) ? { status: 'ok', postId: id } : { status: 'dom_post_id_invalid' };
  };

  const getModelIdentity = (article, postId) => {
    let fiberKeys = [];
    try {
      fiberKeys = Object.getOwnPropertyNames(article).filter((key) => key.startsWith('__reactFiber$'));
    } catch (error) {
      fiberKeys = [];
    }
    if (!fiberKeys.length) {
      return { status: 'react_fiber_missing', path: '__reactFiber$* missing' };
    }
    if (fiberKeys.length !== 1) {
      return { status: 'react_fiber_ambiguous', path: '__reactFiber$* has multiple candidates' };
    }

    const fiberDescriptor = ownData(article, fiberKeys[0]);
    if (!fiberDescriptor.found || !isObject(fiberDescriptor.value)) {
      return { status: 'react_fiber_unavailable', path: '__reactFiber$* is not a data property' };
    }

    const visited = new Set();
    const matching = [];
    let sawTweet = false;
    let sawMissingModelId = false;
    let sawInvalidModelId = false;
    let sawDifferentModelId = false;
    let node = fiberDescriptor.value;
    let depth = 0;
    let lastDepth = -1;
    let cycle = false;
    let bounded = false;

    while (isObject(node) && depth < 64) {
      if (visited.has(node)) {
        cycle = true;
        break;
      }
      visited.add(node);
      lastDepth = depth;

      const memoizedProps = ownData(node, 'memoizedProps');
      const tweetProperty = memoizedProps.found ? ownData(memoizedProps.value, 'tweet') : { found: false };
      if (tweetProperty.found && isObject(tweetProperty.value)) {
        sawTweet = true;
        const idProperty = ownData(tweetProperty.value, 'id_str');
        if (!idProperty.found || idProperty.value === null || idProperty.value === undefined) {
          sawMissingModelId = true;
        } else if (typeof idProperty.value !== 'string' || !isPositiveDigits(idProperty.value)) {
          sawInvalidModelId = true;
        } else if (idProperty.value === postId) {
          const userProperty = ownData(tweetProperty.value, 'user');
          const userIdProperty = userProperty.found ? ownData(userProperty.value, 'id_str') : { found: false };
          if (!userProperty.found || !isObject(userProperty.value) || !userIdProperty.found ||
              userIdProperty.value === null || userIdProperty.value === undefined) {
            matching.push({ status: 'user_id_missing', userId: null, depth });
          } else if (typeof userIdProperty.value === 'number' && !Number.isSafeInteger(userIdProperty.value)) {
            matching.push({ status: 'unsafe_numeric_id', userId: null, depth });
          } else if (typeof userIdProperty.value !== 'string') {
            matching.push({ status: 'user_id_not_string', userId: null, depth });
          } else if (!isPositiveDigits(userIdProperty.value)) {
            matching.push({ status: 'user_id_invalid', userId: null, depth });
          } else {
            matching.push({ status: 'ok', userId: userIdProperty.value, depth });
          }
        } else {
          sawDifferentModelId = true;
        }
      }

      const returnProperty = ownData(node, 'return');
      if (!returnProperty.found || !isObject(returnProperty.value)) break;
      if (depth === 63) {
        bounded = true;
        break;
      }
      node = returnProperty.value;
      depth += 1;
    }

    if (matching.length) {
      const path = `__reactFiber$* -> return×${matching[0].depth} -> memoizedProps.tweet (observed depth ${matching[0].depth})`;
      const bad = matching.find((entry) => entry.status !== 'ok');
      if (bad) return { status: bad.status, path };
      const ids = new Set(matching.map((entry) => entry.userId));
      if (ids.size > 1) return { status: 'identity_conflict', path };
      return { status: 'ok', userId: ids.values().next().value, path };
    }
    if (bounded) {
      return { status: 'fiber_bound_reached', path: `__reactFiber$* -> return×${lastDepth} -> 64-fiber bound reached` };
    }
    if (cycle) {
      return { status: 'fiber_cycle', path: `__reactFiber$* -> return×${lastDepth} -> cycle detected` };
    }
    if (!sawTweet) {
      return { status: 'tweet_model_missing', path: `__reactFiber$* -> return×${Math.max(0, lastDepth)} -> memoizedProps.tweet absent (observed depth ${Math.max(0, lastDepth)})` };
    }
    if (sawMissingModelId) {
      return { status: 'tweet_model_id_missing', path: `__reactFiber$* -> return×${Math.max(0, lastDepth)} -> tweet.id_str absent (observed depth ${Math.max(0, lastDepth)})` };
    }
    if (sawInvalidModelId) {
      return { status: 'tweet_model_id_invalid', path: `__reactFiber$* -> return×${Math.max(0, lastDepth)} -> tweet.id_str invalid (observed depth ${Math.max(0, lastDepth)})` };
    }
    if (sawDifferentModelId) {
      return { status: 'tweet_id_mismatch', path: `__reactFiber$* -> return×${Math.max(0, lastDepth)} -> no tweet.id_str matched DOM post ID (observed depth ${Math.max(0, lastDepth)})` };
    }
    return { status: 'tweet_model_missing', path: '__reactFiber$* -> memoizedProps.tweet unavailable' };
  };

  try {
    if (typeof window === 'undefined' || !window.location || !window.document) return finish();
    pathname = typeof window.location.pathname === 'string' ? window.location.pathname : null;
    report.pathname = pathname;
    const currentUrl = new URL(window.location.href);
    const handle = getProfileHandle(currentUrl.href);
    if (!handle) {
      report.status = 'wrong_scope';
      report.summary = 'Only public X profile paths on x.com or twitter.com are in scope.';
      return finish();
    }

    const reference = getProfileReference(window.document, handle, currentUrl.href);
    if (reference.status === 'available') {
      report.reference = { status: 'available', userId: reference.userId };
    } else {
      report.reference = { status: reference.status };
    }

    const articles = Array.from(window.document.querySelectorAll('article[data-testid="tweet"]')).slice(0, 32);
    for (const article of articles) {
      if (report.samples.length >= 3) break;
      const headers = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
        .filter((header) => header.closest('article[data-testid="tweet"]') === article);
      const header = headers.find((candidate) => !candidate.closest('blockquote, [role="link"], [data-testid="socialContext"], [data-testid*="quote" i]'));
      if (!header || !matchingProfileAnchor(header, handle, currentUrl.href)) continue;

      const post = getDomPostId(header, handle, currentUrl.href);
      if (post.status !== 'ok') {
        report.samples.push({ postId: null, userId: null, status: post.status, path: 'DOM User-Name timestamp link' });
        continue;
      }

      const model = getModelIdentity(article, post.postId);
      let status = model.status;
      let userId = model.userId || null;
      if (status === 'ok' && report.reference.status === 'available' && report.reference.userId !== userId) {
        status = 'reference_conflict';
        userId = null;
      } else if (status === 'ok' && report.reference.status === 'conflict') {
        status = 'reference_conflict';
        userId = null;
      }
      report.samples.push({ postId: post.postId, userId, status, path: model.path });
    }

    if (report.reference.status !== 'available') {
      const sampledUserIds = new Set(
        report.samples.filter((sample) => sample.status === 'ok').map((sample) => sample.userId),
      );
      if (sampledUserIds.size > 1) {
        for (const sample of report.samples) {
          if (sample.status === 'ok') {
            sample.status = 'identity_conflict';
            sample.userId = null;
          }
        }
      }
    }

    const loginPrompt = window.document.querySelector('[data-testid="LoginForm_Login_Button"]');
    if (!report.samples.length) {
      report.status = loginPrompt ? 'login_required' : 'no_posts';
      report.summary = loginPrompt
        ? 'X is asking for login; no identity conclusion was possible.'
        : 'No matching public profile posts are available to inspect; page load or visibility may be incomplete.';
      return finish();
    }

    const successful = report.samples.filter((sample) => sample.status === 'ok').length;
    if (successful === report.samples.length) {
      report.status = 'ok';
      report.summary = `Matched DOM and React IDs in ${successful} visible authored post${successful === 1 ? '' : 's'}.`;
    } else if (successful > 0) {
      report.status = 'partial';
      report.summary = `Matched DOM and React IDs in ${successful} of ${report.samples.length} sampled posts; other samples need inspection.`;
    } else {
      report.status = 'probe_incomplete';
      report.summary = `No sampled post produced a verified author ID; inspect the per-post status and path.`;
    }
    if (report.reference.status !== 'available') {
      const referenceSummary = report.reference.status === 'unsafe_numeric_id'
        ? 'is unsafe'
        : report.reference.status === 'conflict' ? 'is conflicting' : 'is unavailable';
      report.summary += ` Profile JSON-LD reference ${referenceSummary}.`;
    }
    return finish();
  } catch (error) {
    report.status = 'probe_error';
    report.summary = 'The read-only probe could not complete; this is not evidence of an X schema change.';
    report.samples = [];
    return finish();
  }
})()
