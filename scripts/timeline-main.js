(() => {
    const ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
    const BRIDGE_CHANNEL = 'x-memo.timeline-id.v1';
    const MAX_FIBER_ANCESTORS = 64;
    const MAX_ID_DIGITS = 256;
    const ID_PATTERN = new RegExp(`^[1-9][0-9]{0,${MAX_ID_DIGITS - 1}}$`);
    const visibleArticles = new WeakSet();
    const observedArticles = new WeakSet();
    const lastPublishedPairByArticle = new WeakMap();

    function isPositiveIdString(value) {
        return typeof value === 'string' && ID_PATTERN.test(value);
    }

    function isExcludedFromPrimary(element, article, ignoreCandidateRoleLink = false) {
        let current = element;
        while (current && current !== article) {
            if (current.tagName === 'BLOCKQUOTE') return true;
            if (current.getAttribute && current.getAttribute('role') === 'link' &&
                !(ignoreCandidateRoleLink && current === element)) return true;
            const testId = (current.getAttribute && current.getAttribute('data-testid') || '').toLowerCase();
            if (testId === 'socialcontext' || testId.includes('quote')) return true;
            current = current.parentElement;
        }
        return false;
    }

    function getPrimaryStatusPostId(article) {
        const ids = new Set();
        for (const anchor of article.querySelectorAll('a[href]')) {
            if (anchor.closest(ARTICLE_SELECTOR) !== article || isExcludedFromPrimary(anchor, article, true)) continue;
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
            if (isPositiveIdString(parts[2])) ids.add(parts[2]);
        }
        return ids.size === 1 ? ids.values().next().value : null;
    }

    function getArticleReactFiber(article) {
        for (const key of Object.getOwnPropertyNames(article)) {
            if (!key.startsWith('__reactFiber$')) continue;
            const descriptor = Object.getOwnPropertyDescriptor(article, key);
            if (descriptor && descriptor.value && typeof descriptor.value === 'object') return descriptor.value;
        }
        return null;
    }

    function getUserIdForPost(article, postId) {
        let fiber;
        try {
            fiber = getArticleReactFiber(article);
            if (!fiber) return null;

            const visited = new Set();
            let foundMatchingTweet = false;
            let invalidMatch = false;
            let matchingUserId = null;
            for (let depth = 0; fiber && depth < MAX_FIBER_ANCESTORS; depth += 1) {
                if (typeof fiber !== 'object' || visited.has(fiber)) break;
                visited.add(fiber);

                const props = fiber.memoizedProps;
                const tweet = props && typeof props === 'object' ? props.tweet : null;
                if (tweet && typeof tweet === 'object' && tweet.id_str === postId) {
                    foundMatchingTweet = true;
                    const user = tweet.user;
                    const userId = user && typeof user === 'object' ? user.id_str : null;
                    if (!isPositiveIdString(userId)) {
                        invalidMatch = true;
                    } else if (matchingUserId !== null && matchingUserId !== userId) {
                        invalidMatch = true;
                    } else {
                        matchingUserId = userId;
                    }
                }
                fiber = fiber.return;
            }
            return foundMatchingTweet && !invalidMatch ? matchingUserId : null;
        } catch (error) {
            return null;
        }
    }

    function publishArticlePair(article) {
        if (!article.isConnected || !visibleArticles.has(article)) return;
        const postId = getPrimaryStatusPostId(article);
        if (!postId) {
            lastPublishedPairByArticle.delete(article);
            return;
        }

        const userId = getUserIdForPost(article, postId);
        const previous = lastPublishedPairByArticle.get(article);
        if (previous && previous.postId === postId && previous.userId === userId) return;
        lastPublishedPairByArticle.set(article, { postId, userId });

        window.postMessage({
            channel: BRIDGE_CHANNEL,
            type: 'visible-tweet-ids',
            postId,
            userId,
        }, window.location.origin);
    }

    function collectArticles(node, articles) {
        if (!node || node.nodeType !== 1) return;
        if (node.matches && node.matches(ARTICLE_SELECTOR)) articles.add(node);
        const parentArticle = node.closest && node.closest(ARTICLE_SELECTOR);
        if (parentArticle) articles.add(parentArticle);
        if (node.querySelectorAll) {
            for (const article of node.querySelectorAll(ARTICLE_SELECTOR)) articles.add(article);
        }
    }

    function collectContainedArticles(node, articles) {
        if (!node || node.nodeType !== 1) return;
        if (node.matches && node.matches(ARTICLE_SELECTOR)) articles.add(node);
        if (node.querySelectorAll) {
            for (const article of node.querySelectorAll(ARTICLE_SELECTOR)) articles.add(article);
        }
    }

    const visibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio > 0) {
                visibleArticles.add(entry.target);
                publishArticlePair(entry.target);
            } else {
                visibleArticles.delete(entry.target);
            }
        }
    }, { threshold: 0 });

    const domObserver = new MutationObserver((mutations) => {
        const articles = new Set();
        const removedArticles = new Set();
        for (const mutation of mutations) {
            collectArticles(mutation.target, articles);
            for (const node of mutation.addedNodes) collectArticles(node, articles);
            for (const node of mutation.removedNodes) collectContainedArticles(node, removedArticles);
        }
        for (const article of articles) {
            if (!observedArticles.has(article)) {
                observedArticles.add(article);
                visibilityObserver.observe(article);
            }
            publishArticlePair(article);
        }
        for (const article of removedArticles) {
            if (article.isConnected) continue;
            visibilityObserver.unobserve(article);
            visibleArticles.delete(article);
            observedArticles.delete(article);
            lastPublishedPairByArticle.delete(article);
        }
    });

    if (document.documentElement) {
        domObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['href'],
            childList: true,
            characterData: true,
            subtree: true,
        });
    }

    for (const article of document.querySelectorAll(ARTICLE_SELECTOR)) {
        observedArticles.add(article);
        visibilityObserver.observe(article);
    }
})();
