globalThis.TwitterMemo = (() => {
    const HANDLE_PATTERN = /^[a-zA-Z0-9_]{1,15}$/;
    const SUBROUTES = new Set(['with_replies', 'reposts', 'highlights', 'articles', 'media', 'likes']);
    const RESERVED_PATHS = new Set([
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
            return screenName && HANDLE_PATTERN.test(screenName) ? screenName : null;
        }

        if (pathParts.length < 1 || pathParts.length > 2) {
            return null;
        }

        const handle = pathParts[0];
        if (!HANDLE_PATTERN.test(handle) || RESERVED_PATHS.has(handle.toLowerCase())) {
            return null;
        }
        if (pathParts.length === 2 && !SUBROUTES.has(pathParts[1].toLowerCase())) {
            return null;
        }
        return handle;
    }

    function normalizeHandle(value) {
        if (typeof value !== 'string') {
            return null;
        }
        const handle = value.startsWith('@') ? value.slice(1) : value;
        return HANDLE_PATTERN.test(handle) ? handle : null;
    }

    function normalizeNumericId(value) {
        if (typeof value === 'number') {
            return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        }
        return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
    }

    function isValidMemoId(id) {
        return typeof id === 'string' && /^[1-9]\d*$/.test(id);
    }

    function collectProfileEntities(value, results = []) {
        if (Array.isArray(value)) {
            for (const item of value) collectProfileEntities(item, results);
            return results;
        }
        if (!value || typeof value !== 'object') {
            return results;
        }

        if (Object.hasOwn(value, 'identifier') && Object.hasOwn(value, 'additionalName')) {
            results.push(value);
        }
        for (const key of ['mainEntity', 'author', '@graph']) {
            if (value[key]) collectProfileEntities(value[key], results);
        }
        return results;
    }

    function getJsonLdProfileId(handle, document = globalThis.document) {
        const matchingIds = new Set();
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            let parsed;
            try {
                parsed = JSON.parse(script.textContent || '');
            } catch (error) {
                continue;
            }

            for (const entity of collectProfileEntities(parsed)) {
                const entityHandle = normalizeHandle(entity.additionalName);
                if (!entityHandle || entityHandle.toLowerCase() !== handle.toLowerCase()) continue;
                if (entity.url !== undefined &&
                    (typeof entity.url !== 'string' || getProfileHandle(entity.url)?.toLowerCase() !== handle.toLowerCase())) {
                    continue;
                }
                const id = normalizeNumericId(entity.identifier);
                if (id) matchingIds.add(id);
            }
        }
        return matchingIds.size === 1 ? matchingIds.values().next().value : null;
    }

    function getVisibleUserNameElement(document = globalThis.document) {
        const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
        const userName = primaryColumn && primaryColumn.querySelector('[data-testid="UserName"]');
        if (!userName || !userName.isConnected) return null;
        if (typeof userName.getClientRects === 'function' && userName.getClientRects().length === 0) return null;
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
            if (descendants.length === 0) return text.trim().toLowerCase() === expectedHandle;
            return false;
        }
        return text.trim().toLowerCase() === expectedHandle;
    }

    function getValidatedProfile(urlValue = globalThis.location && globalThis.location.href, document = globalThis.document) {
        const handle = getProfileHandle(urlValue);
        if (!handle) return null;
        const userName = getVisibleUserNameElement(document);
        if (!userName || !visibleHeaderMatches(userName, handle)) return null;
        const id = getJsonLdProfileId(handle, document);
        return id ? { handle, id } : null;
    }

    return Object.freeze({
        getJsonLdProfileId,
        getProfileHandle,
        getValidatedProfile,
        getVisibleUserNameElement,
        isValidMemoId,
        normalizeHandle,
        normalizeNumericId,
        visibleHeaderMatches,
    });
})();
