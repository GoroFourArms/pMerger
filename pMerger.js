// ==UserScript==
// @name         pMerger
// @namespace    https://tampermonkey.net/
// @version      1.1.4
// @description  Merge artificial webnovel paragraph breaks for smoother TTS.
// @author       You
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // STORAGE
    // ============================================================

    const STORAGE_KEY = 'ttsCleanerConfig';

    const DEFAULT_CONFIG = {
        globalEnabled: false,
        sites: {}
    };

    let config = GM_getValue(STORAGE_KEY, DEFAULT_CONFIG);

    function loadConfig() {
        if (!config || typeof config !== 'object') {
            config = {};
        }

        if (typeof config.globalEnabled !== 'boolean') {
            config.globalEnabled = false;
        }

        if (!config.sites || typeof config.sites !== 'object') {
            config.sites = {};
        }
    }

    function saveConfig() {
        GM_setValue(STORAGE_KEY, config);
    }

    loadConfig();


    // ============================================================
    // DOMAIN
    // ============================================================

    function getDomain() {
        return location.hostname
            .toLowerCase()
            .replace(/^www\./, '');
    }

    function getCurrentSite() {
        return config.sites[getDomain()] || null;
    }


    // ============================================================
    // MENU COMMANDS
    // ============================================================

    let toggleMenuId = null;
    let settingsMenuId = null;

    function registerMenuCommands() {
        // Remove old toggle command if Tampermonkey supplied an ID.
        if (
            toggleMenuId !== null &&
            typeof GM_unregisterMenuCommand === 'function'
        ) {
            try {
                GM_unregisterMenuCommand(toggleMenuId);
            } catch {
                // Ignore unsupported/invalid IDs.
            }
        }

        if (
            settingsMenuId !== null &&
            typeof GM_unregisterMenuCommand === 'function'
        ) {
            try {
                GM_unregisterMenuCommand(settingsMenuId);
            } catch {
                // Ignore unsupported/invalid IDs.
            }
        }

        toggleMenuId = GM_registerMenuCommand(
            `TTS Cleaner: ${config.globalEnabled ? 'ON' : 'OFF'}`,
            toggleCleaner
        );

        settingsMenuId = GM_registerMenuCommand(
            'TTS Cleaner — Settings',
            openSettings
        );
    }

    function toggleCleaner() {
        config.globalEnabled = !config.globalEnabled;
        saveConfig();

        registerMenuCommands();

        if (config.globalEnabled) {
            startCleaner();
        } else {
            stopCleaner();
        }
    }

    // Register immediately.
    registerMenuCommands();


    // ============================================================
    // URL PATTERNS
    // ============================================================

    function wildcardToRegex(pattern) {
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');

        return new RegExp('^' + escaped + '$', 'i');
    }

    function matchesUrlPattern(pattern) {
        if (!pattern) {
            return false;
        }

        pattern = pattern.trim();

        if (!pattern) {
            return false;
        }

        try {
            const target = pattern.startsWith('/')
                ? location.pathname + location.search + location.hash
                : location.href;

            return wildcardToRegex(pattern).test(target);
        } catch {
            return false;
        }
    }

    function isChapterPage() {
        if (!config.globalEnabled) {
            return false;
        }

        const site = getCurrentSite();

        if (!site || site.enabled === false) {
            return false;
        }

        if (!site.chapterContainer) {
            return false;
        }

        if (!site.paragraphSelector) {
            return false;
        }

        if (
            !Array.isArray(site.chapterUrlPatterns) ||
            site.chapterUrlPatterns.length === 0
        ) {
            return false;
        }

        return site.chapterUrlPatterns.some(matchesUrlPattern);
    }


    // ============================================================
    // SELECTOR HELPERS
    // ============================================================

    function safeQueryAll(root, selector) {
        try {
            return Array.from(root.querySelectorAll(selector));
        } catch (error) {
            console.warn(
                '[pMerger] Invalid selector:',
                selector,
                error
            );

            return [];
        }
    }

    function elementMatches(element, selector) {
        if (
            !element ||
            element.nodeType !== Node.ELEMENT_NODE
        ) {
            return false;
        }

        try {
            return element.matches(selector);
        } catch {
            return false;
        }
    }

    function findChapterContainers(root, selector) {
        const results = [];

        if (
            root &&
            root.nodeType === Node.ELEMENT_NODE &&
            elementMatches(root, selector)
        ) {
            results.push(root);
        }

        results.push(...safeQueryAll(root, selector));

        return [...new Set(results)];
    }

    function closestChapter(element, selector) {
        if (
            !element ||
            element.nodeType !== Node.ELEMENT_NODE
        ) {
            return null;
        }

        try {
            return element.closest(selector);
        } catch {
            return null;
        }
    }


    // ============================================================
    // TEXT / BREAK DETECTION
    // ============================================================

    function textOf(element) {
        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }
    
function looksLikeSceneBreak(text) {
    return (
        /^~{2,}$/.test(text) ||
        /^-{3,}$/.test(text) ||
        /^_{3,}$/.test(text) ||
        /^\*{2,}$/.test(text) ||
        /^•{2,}$/.test(text) ||
        /^·{2,}$/.test(text)
    );
}
    function cleanNavigationElement(element) {
    const replacement =
        getNavigationReplacement(element);

    if (replacement === null) {
        return false;
    }

    element.textContent = replacement;

    return true;
}
    function looksLikeDialogue(element) {
        const text = textOf(element);

        if (!text) {
            return false;
        }

        return (
            /^["“‘「『]/.test(text) ||
            /^[—–]\s*\S/.test(text)
        );
    }

function shouldPreserveBreak(first, second, site) {
    if (
        site.preserveDialogue === false
    ) {
        return false;
    }

    /*
     * Preserve a paragraph if the NEW paragraph
     * appears to begin dialogue.
     */
    if (looksLikeDialogue(second)) {
        return true;
    }

    return false;
}


    // ============================================================
    // PARAGRAPH MERGING
    // ============================================================

    function areAdjacent(first, second) {
        let node = first.nextSibling;

        while (node) {
            if (node === second) {
                return true;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent.trim() !== '') {
                    return false;
                }
            } else {
                return false;
            }

            node = node.nextSibling;
        }

        return false;
    }

    function appendWithSpace(first, second) {
        const firstText = first.textContent || '';
        const secondText = second.textContent || '';

        if (
            firstText &&
            secondText &&
            !/\s$/.test(firstText) &&
            !/^\s/.test(secondText)
        ) {
            first.appendChild(
                document.createTextNode(' ')
            );
        }

        while (second.firstChild) {
            first.appendChild(second.firstChild);
        }

        second.remove();
    }

function cleanChapter(container, site) {
    if (
        !container ||
        !container.isConnected
    ) {
        return;
    }

    if (processingContainers.has(container)) {
        return;
    }

    processingContainers.add(container);

    try {
        // --------------------------------------------------------
        // Navigation text
        // --------------------------------------------------------

        const possibleNavigation =
            safeQueryAll(
                container,
                'a, button, [role="button"]'
            );

        for (const element of possibleNavigation) {
            cleanNavigationElement(element);
        }


        // --------------------------------------------------------
        // Find paragraphs
        // --------------------------------------------------------

        let paragraphs = safeQueryAll(
            container,
            site.paragraphSelector
        );


        // --------------------------------------------------------
        // Convert scene-break paragraphs to <hr>
        // --------------------------------------------------------

        for (const paragraph of paragraphs) {
            if (
                paragraph.isConnected &&
                looksLikeSceneBreak(
                    textOf(paragraph)
                )
            ) {
                const hr =
                    document.createElement('hr');

                paragraph.replaceWith(hr);
            }
        }


        // Get paragraphs again because some were replaced.
        paragraphs = safeQueryAll(
            container,
            site.paragraphSelector
        );

        if (paragraphs.length < 2) {
            return;
        }


        // --------------------------------------------------------
        // Merge artificial paragraph breaks
        // --------------------------------------------------------

        let current = paragraphs[0];

        for (
            let i = 1;
            i < paragraphs.length;
            i++
        ) {
            const next = paragraphs[i];

            if (
                !current.isConnected ||
                !next.isConnected
            ) {
                if (next.isConnected) {
                    current = next;
                }

                continue;
            }

            /*
             * Never merge across another element.
             *
             * This keeps <hr>, headings, images, ads,
             * navigation, etc. as separate content.
             */
            if (!areAdjacent(current, next)) {
                current = next;
                continue;
            }

            if (
                shouldPreserveBreak(
                    current,
                    next,
                    site
                )
            ) {
                current = next;
                continue;
            }

            appendWithSpace(
                current,
                next
            );
        }

    } finally {
        processingContainers.delete(container);
    }
}

    // ============================================================
    // CONTAINER PROCESSING
    // ============================================================

    const processingContainers = new WeakSet();

    /*
     * Used only for debouncing changes inside existing chapters.
     */
    const pendingChapterTimers = new WeakMap();

    function processContainer(container) {
        if (!config.globalEnabled) {
            return;
        }

        if (!isChapterPage()) {
            return;
        }

        const site = getCurrentSite();

        if (!site) {
            return;
        }

        cleanChapter(container, site);
    }

    function scheduleContainer(container, delay = 75) {
        if (!container || !container.isConnected) {
            return;
        }

        const oldTimer = pendingChapterTimers.get(container);

        if (oldTimer) {
            clearTimeout(oldTimer);
        }

        const timer = setTimeout(() => {
            pendingChapterTimers.delete(container);

            if (
                config.globalEnabled &&
                container.isConnected &&
                isChapterPage()
            ) {
                processContainer(container);
            }
        }, delay);

        pendingChapterTimers.set(
            container,
            timer
        );
    }

    function scanPage() {
        if (!config.globalEnabled) {
            return;
        }

        if (!isChapterPage()) {
            return;
        }

        const site = getCurrentSite();

        if (!site) {
            return;
        }

        const containers = findChapterContainers(
            document,
            site.chapterContainer
        );

        for (const container of containers) {
            processContainer(container);
        }
    }


    // ============================================================
    // PAGETUAL / MUTATION OBSERVER
    // ============================================================

    let observer = null;

    function handleAddedNode(node) {
        if (
            !node ||
            node.nodeType !== Node.ELEMENT_NODE
        ) {
            return;
        }

        if (!config.globalEnabled) {
            return;
        }

        if (!isChapterPage()) {
            return;
        }

        const site = getCurrentSite();

        if (!site) {
            return;
        }

        /*
         * Case 1:
         * Pagetual appended an entirely new chapter container.
         */
        const newContainers = findChapterContainers(
            node,
            site.chapterContainer
        );

        for (const container of newContainers) {
            /*
             * Wait briefly so Pagetual can finish inserting
             * the chapter contents before we merge anything.
             */
            scheduleContainer(container, 75);
        }

        /*
         * Case 2:
         * New paragraphs/content were added inside an
         * already-existing chapter.
         */
        let parentChapter = null;

        if (
            elementMatches(
                node,
                site.chapterContainer
            )
        ) {
            parentChapter = node;
        } else {
            parentChapter = closestChapter(
                node,
                site.chapterContainer
            );
        }

        if (parentChapter) {
            scheduleContainer(
                parentChapter,
                100
            );
        }
    }

    function startObserver() {
        if (observer) {
            return;
        }

        if (!document.documentElement) {
            return;
        }

        observer = new MutationObserver(
            mutations => {
                if (!config.globalEnabled) {
                    return;
                }

                if (!isChapterPage()) {
                    return;
                }

                const site = getCurrentSite();

                if (!site) {
                    return;
                }

                for (const mutation of mutations) {

                    /*
                     * If the mutation target is itself a paragraph,
                     * it is probably the cleaner moving text/nodes
                     * inside an existing paragraph.
                     *
                     * Ignore it to prevent observer feedback loops.
                     */
                    if (
                        mutation.target &&
                        mutation.target.nodeType ===
                            Node.ELEMENT_NODE &&
                        elementMatches(
                            mutation.target,
                            site.paragraphSelector
                        )
                    ) {
                        continue;
                    }

                    for (
                        const node of mutation.addedNodes
                    ) {
                        handleAddedNode(node);
                    }
                }
            }
        );

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );
    }

    function stopObserver() {
        if (!observer) {
            return;
        }

        observer.disconnect();
        observer = null;
    }


    // ============================================================
    // SPA URL WATCHER
    // ============================================================

    let urlWatcher = null;
    let lastUrl = location.href;

    function startUrlWatcher() {
        if (urlWatcher) {
            return;
        }

        urlWatcher = setInterval(() => {
            if (location.href === lastUrl) {
                return;
            }

            lastUrl = location.href;

            if (!config.globalEnabled) {
                return;
            }

            /*
             * Give the SPA a moment to replace the chapter.
             */
            setTimeout(() => {
                scanPage();
            }, 150);

        }, 750);
    }

    function stopUrlWatcher() {
        if (!urlWatcher) {
            return;
        }

        clearInterval(urlWatcher);
        urlWatcher = null;
    }


    // ============================================================
    // START / STOP
    // ============================================================

    function startCleaner() {
        if (!config.globalEnabled) {
            return;
        }

        startObserver();
        startUrlWatcher();

        setTimeout(() => {
            scanPage();
        }, 100);
    }

    function stopCleaner() {
        stopObserver();
        stopUrlWatcher();

        /*
         * Cancel pending chapter timers.
         *
         * WeakMap itself cannot be iterated, so timers will simply
         * check config.globalEnabled before doing anything.
         */
    }


    // ============================================================
    // SETTINGS UI
    // ============================================================

    let settingsWindow = null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function injectStyles() {
        if (
            document.getElementById(
                'tts-cleaner-styles'
            )
        ) {
            return;
        }

        if (!document.documentElement) {
            return;
        }

        const style =
            document.createElement('style');

        style.id = 'tts-cleaner-styles';

        style.textContent = `
            .tts-cleaner-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                background: rgba(0,0,0,.55);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                box-sizing: border-box;
                font-family: system-ui, sans-serif;
            }

            .tts-cleaner-window {
                width: min(620px, 100%);
                max-height: 90vh;
                overflow-y: auto;
                background: white;
                color: #222;
                border-radius: 10px;
                box-shadow: 0 20px 60px rgba(0,0,0,.4);
            }

            .tts-cleaner-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 16px 18px;
                border-bottom: 1px solid #ddd;
            }

            .tts-cleaner-title {
                font-size: 19px;
                font-weight: 700;
            }

            .tts-cleaner-domain {
                color: #777;
                font-size: 13px;
                margin-top: 3px;
            }

            .tts-cleaner-close {
                border: 0;
                background: none;
                font-size: 28px;
                cursor: pointer;
                line-height: 1;
            }

            .tts-cleaner-body {
                padding: 18px;
            }

            .tts-cleaner-body label {
                display: block;
                margin-top: 16px;
                font-weight: 600;
            }

            .tts-cleaner-body input,
            .tts-cleaner-body textarea {
                box-sizing: border-box;
                width: 100%;
                margin-top: 6px;
                padding: 9px;
                border: 1px solid #bbb;
                border-radius: 6px;
                font: inherit;
            }

            .tts-cleaner-body textarea {
                resize: vertical;
            }

            .tts-check {
                display: flex !important;
                align-items: center;
                gap: 8px;
            }

            .tts-check input {
                width: auto;
                margin: 0;
            }

            .tts-help {
                margin-top: 6px;
                color: #777;
                font-size: 12px;
                font-weight: normal;
            }

            .tts-message {
                padding: 10px;
                background: #f3f3f3;
                border-radius: 6px;
                margin-bottom: 12px;
            }

            .tts-buttons {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 20px;
            }

            .tts-buttons button {
                padding: 8px 13px;
                border: 1px solid #aaa;
                border-radius: 6px;
                cursor: pointer;
                background: #f4f4f4;
            }

            .tts-buttons .primary {
                background: #222;
                color: white;
                border-color: #222;
            }

            .tts-result {
                margin-top: 12px;
                color: #176b2c;
                min-height: 18px;
            }

            .tts-error {
                color: #a00;
            }
        `;

        document.documentElement.appendChild(style);
    }


    // ============================================================
    // OPEN SETTINGS
    // ============================================================

    function openSettings() {
        if (!document.documentElement) {
            return;
        }

        injectStyles();

        if (settingsWindow) {
            settingsWindow.remove();
            settingsWindow = null;
        }

        const domain = getDomain();
        const site = getCurrentSite();

        settingsWindow =
            document.createElement('div');

        settingsWindow.className =
            'tts-cleaner-overlay';

        settingsWindow.innerHTML = `
            <div class="tts-cleaner-window">

                <div class="tts-cleaner-header">
                    <div>
                        <div class="tts-cleaner-title">
                            TTS Cleaner
                        </div>

                        <div class="tts-cleaner-domain">
                            ${escapeHtml(domain)}
                        </div>
                    </div>

                    <button
                        class="tts-cleaner-close"
                        data-action="close">
                        ×
                    </button>
                </div>

                <div class="tts-cleaner-body">

                    ${
                        site
                            ? `
                                <div class="tts-message">
                                    This site has saved settings.
                                </div>
                            `
                            : `
                                <div class="tts-message">
                                    No settings for this site yet.
                                </div>
                            `
                    }

                    <label class="tts-check">
                        <input
                            id="tts-site-enabled"
                            type="checkbox"
                            ${
                                site?.enabled !== false
                                    ? 'checked'
                                    : ''
                            }
                        >
                        Enable cleaner for this site
                    </label>

                    <label>
                        Chapter URL pattern(s)

                        <textarea
                            id="tts-url-patterns"
                            rows="3"
                            placeholder="/chapter/*"
                        >${escapeHtml(
                            site?.chapterUrlPatterns
                                ?.join('\n') || ''
                        )}</textarea>

                        <div class="tts-help">
                            One pattern per line.
                            Use * as a wildcard.
                            Example: /chapter/*
                        </div>
                    </label>

                    <label>
                        Chapter container selector

                        <input
                            id="tts-chapter-selector"
                            value="${escapeHtml(
                                site?.chapterContainer || ''
                            )}"
                            placeholder="article.chapter"
                        >
                    </label>

                    <label>
                        Paragraph selector

                        <input
                            id="tts-paragraph-selector"
                            value="${escapeHtml(
                                site?.paragraphSelector || ''
                            )}"
                            placeholder="p"
                        >
                    </label>

                    <label class="tts-check">
                        <input
                            id="tts-preserve-dialogue"
                            type="checkbox"
                            ${
                                site?.preserveDialogue === true
                                    ? 'checked'
                                    : ''
                            }
                        >
                        Preserve dialogue paragraph breaks
                    </label>

                    <div
                        id="tts-result"
                        class="tts-result">
                    </div>

                    <div class="tts-buttons">

                        <button
                            class="primary"
                            data-action="test">
                            Test
                        </button>

                        <button
                            class="primary"
                            data-action="save">
                            ${site ? 'Save' : 'Add site'}
                        </button>

                        ${
                            site
                                ? `
                                    <button
                                        data-action="delete">
                                        Delete
                                    </button>
                                `
                                : ''
                        }

                        <button data-action="close">
                            Close
                        </button>

                    </div>

                </div>
            </div>
        `;

        document.documentElement.appendChild(
            settingsWindow
        );

        settingsWindow.addEventListener(
            'click',
            event => {
                const actionElement =
                    event.target.closest(
                        '[data-action]'
                    );

                if (!actionElement) {
                    return;
                }

                const action =
                    actionElement.dataset.action;

                if (action === 'close') {
                    closeSettings();
                }

                if (action === 'test') {
                    testSettings();
                }

                if (action === 'save') {
                    saveSettings();
                }

                if (action === 'delete') {
                    deleteSettings();
                }
            }
        );

        settingsWindow.addEventListener(
            'click',
            event => {
                if (
                    event.target === settingsWindow
                ) {
                    closeSettings();
                }
            }
        );
    }


    // ============================================================
    // SETTINGS FORM
    // ============================================================

    function getFormSettings() {
        const patterns =
            document
                .getElementById(
                    'tts-url-patterns'
                )
                ?.value
                .split('\n')
                .map(x => x.trim())
                .filter(Boolean) || [];

        return {
            enabled:
                document
                    .getElementById(
                        'tts-site-enabled'
                    )
                    ?.checked ?? true,

            chapterUrlPatterns:
                patterns,

            chapterContainer:
                document
                    .getElementById(
                        'tts-chapter-selector'
                    )
                    ?.value
                    .trim() || '',

            paragraphSelector:
                document
                    .getElementById(
                        'tts-paragraph-selector'
                    )
                    ?.value
                    .trim() || '',

          preserveDialogue:
    document
        .getElementById(
            'tts-preserve-dialogue'
        )
        ?.checked ?? false
        };
    }

    function showResult(
        message,
        error = false
    ) {
        const result =
            document.getElementById(
                'tts-result'
            );

        if (!result) {
            return;
        }

        result.textContent = message;

        result.classList.toggle(
            'tts-error',
            error
        );
    }


    // ============================================================
    // TEST SETTINGS
    // ============================================================

    function testSettings() {
        const values =
            getFormSettings();

        if (
            !values.chapterContainer
        ) {
            showResult(
                'Enter a chapter container selector.',
                true
            );
            return;
        }

        if (
            !values.paragraphSelector
        ) {
            showResult(
                'Enter a paragraph selector.',
                true
            );
            return;
        }

        let containers;

        try {
            containers =
                document.querySelectorAll(
                    values.chapterContainer
                );
        } catch {
            showResult(
                'Invalid chapter container selector.',
                true
            );
            return;
        }

        let paragraphCount = 0;

        try {
            for (
                const container of containers
            ) {
                paragraphCount +=
                    container.querySelectorAll(
                        values.paragraphSelector
                    ).length;
            }
        } catch {
            showResult(
                'Invalid paragraph selector.',
                true
            );
            return;
        }

        showResult(
            `Found ${containers.length} chapter ` +
            `container(s) and ${paragraphCount} ` +
            `paragraph(s).`
        );
    }


    // ============================================================
    // SAVE SETTINGS
    // ============================================================

    function saveSettings() {
        const values =
            getFormSettings();

        const domain =
            getDomain();

        if (
            !values.chapterUrlPatterns.length
        ) {
            showResult(
                'Enter at least one chapter URL pattern.',
                true
            );
            return;
        }

        if (
            !values.chapterContainer
        ) {
            showResult(
                'Enter a chapter container selector.',
                true
            );
            return;
        }

        if (
            !values.paragraphSelector
        ) {
            showResult(
                'Enter a paragraph selector.',
                true
            );
            return;
        }

        // Validate both selectors.
        try {
            document.querySelectorAll(
                values.chapterContainer
            );

            document.querySelectorAll(
                values.paragraphSelector
            );
        } catch {
            showResult(
                'One of the selectors is invalid.',
                true
            );
            return;
        }

        config.sites[domain] =
            values;

        saveConfig();

        showResult(
            'Settings saved.'
        );

        if (config.globalEnabled) {
            setTimeout(
                scanPage,
                100
            );
        }
    }


    // ============================================================
    // DELETE SETTINGS
    // ============================================================

    function deleteSettings() {
        const domain =
            getDomain();

        if (!config.sites[domain]) {
            closeSettings();
            return;
        }

        if (
            !confirm(
                `Delete TTS Cleaner settings for ${domain}?`
            )
        ) {
            return;
        }

        delete config.sites[domain];

        saveConfig();

        closeSettings();

        /*
         * Stop the observer if the current page no longer
         * has a configured site.
         */
        if (
            config.globalEnabled
        ) {
            if (!getCurrentSite()) {
                stopCleaner();
            }
        }
    }


    // ============================================================
    // CLOSE SETTINGS
    // ============================================================

    function closeSettings() {
        if (!settingsWindow) {
            return;
        }

        settingsWindow.remove();
        settingsWindow = null;
    }


    // ============================================================
    // INITIALIZATION
    // ============================================================

    function initialize() {
        if (config.globalEnabled) {
            startCleaner();
        }
    }

    if (
        document.readyState === 'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            initialize,
            { once: true }
        );
    } else {
        initialize();
    }

})();
