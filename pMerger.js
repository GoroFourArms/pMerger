// ==UserScript==
// @name         pMerger
// @namespace    https://tampermonkey.net/
// @version      1.1.13
// @description  Merge artificial webnovel paragraph breaks for smoother TTS.
// @author       You
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @downloadURL  https://raw.githubusercontent.com/GoroFourArms/pMerger/refs/heads/main/pMerger.js
// @updateURL    https://raw.githubusercontent.com/GoroFourArms/pMerger/refs/heads/main/pMerger.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // STORAGE
    // ============================================================

    const STORAGE_KEY = 'ttsCleanerConfig';
	const originalChapterHTML = new WeakMap();
	const modifiedContainers = new Set();
  const MAX_MERGED_SENTENCES = 5;
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
GM_registerMenuCommand(
    'pMerger: Apply',
    applyCurrentPage
);

GM_registerMenuCommand(
    'pMerger: Undo',
    undoCurrentPage
);
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
    function countSentences(text) {
    if (!text) {
        return 0;
    }

    const matches =
        text.match(/[.!?]+(?=\s|$)/g);

    return matches ? matches.length : 0;
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
function removeJunk(container, site) {
    if (!site.junkSelector) {
        return;
    }

    const junk = safeQueryAll(
        container,
        site.junkSelector
    );

    for (const element of junk) {
        if (element.isConnected) {
            element.remove();
        }
    }
}
function getNavigationReplacement(element) {
    if (!element) {
        return null;
    }

    const text = textOf(element);

    if (/^(?:next|next\s+chapter)$/i.test(text)) {
        return '~~>';
    }

    if (/^(?:previous|previous\s+chapter)$/i.test(text)) {
        return '<~~';
    }

if (
    /^(?:toc|contents|table\s+of\s+contents|index)$/i.test(text)
) {
    return '~~|~~';
}

    return null;
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

    // Dialogue beginning with quotation marks.
    if (/^["“‘「『]/.test(text)) {
        return true;
    }

    // Dialogue beginning with an em/en dash.
    if (/^[—–]\s*\S/.test(text)) {
        return true;
    }

    return false;
}

    // ============================================================
    // PARAGRAPH MERGING
    // ============================================================

function areAdjacent(first, second) {
    if (!first || !second) {
        return false;
    }

    return first.nextElementSibling === second;
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
function saveOriginalChapter(container) {
    if (!originalChapterHTML.has(container)) {
        originalChapterHTML.set(
            container,
            container.innerHTML
        );

        modifiedContainers.add(container);
    }
}

function applyCurrentPage() {
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
        saveOriginalChapter(container);
        cleanChapter(container, site);
    }
}

function undoCurrentPage() {
    for (const container of modifiedContainers) {
        const original =
            originalChapterHTML.get(container);

        if (
            original !== undefined &&
            container.isConnected
        ) {
            container.innerHTML = original;
        }

        originalChapterHTML.delete(container);
    }

    modifiedContainers.clear();
}
function flattenParagraphWrappers(container, site) {
    const paragraphs = safeQueryAll(
        container,
        site.paragraphSelector
    );

    if (paragraphs.length < 2) {
        return;
    }

    const wrappers = [];

    for (const paragraph of paragraphs) {
        const wrapper = paragraph.parentElement;

        if (
            !wrapper ||
            wrapper.parentElement !== container
        ) {
            continue;
        }

        if (!wrappers.includes(wrapper)) {
            wrappers.push(wrapper);
        }
    }

    if (wrappers.length < 2) {
        return;
    }

    for (let i = 0; i < wrappers.length; i++) {
        const first = wrappers[i];

        if (!first.isConnected) {
            continue;
        }

        let next = first.nextElementSibling;

        while (
            next &&
            next.tagName === first.tagName &&
            next.className === first.className
        ) {
            const nextParagraphs =
                safeQueryAll(
                    next,
                    site.paragraphSelector
                );

            for (const paragraph of nextParagraphs) {
                first.appendChild(paragraph);
            }

            const wrapperToRemove = next;
            next = next.nextElementSibling;

            wrapperToRemove.remove();
        }
    }
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

    saveOriginalChapter(container);

    processingContainers.add(container);

    try {
        // --------------------------------------------------------
        // Remove junk before merging
        // --------------------------------------------------------

        removeJunk(
            container,
            site
        );

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
        // Flatten paragraph wrappers
        // --------------------------------------------------------

        flattenParagraphWrappers(
            container,
            site
        );

        let paragraphs = safeQueryAll(
            container,
            site.paragraphSelector
        );

        // --------------------------------------------------------
        // Convert scene breaks to <hr>
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

        let previousWasDialogue =
            looksLikeDialogue(current);

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
                    previousWasDialogue =
                        looksLikeDialogue(next);
                }

                continue;
            }

            if (!areAdjacent(current, next)) {
                current = next;
                previousWasDialogue =
                    looksLikeDialogue(next);

                continue;
            }

            const nextIsDialogue =
                looksLikeDialogue(next);

            // Keep a break only when two dialogue
            // paragraphs are directly back-to-back.
            if (
                previousWasDialogue &&
                nextIsDialogue
            ) {
                current = next;
                previousWasDialogue = nextIsDialogue;
                continue;
            }

            const combinedText =
                (current.textContent || '') +
                ' ' +
                (next.textContent || '');

            // Maximum 5 sentences per <p>.
            if (
                countSentences(combinedText) >
                MAX_MERGED_SENTENCES
            ) {
                current = next;
                previousWasDialogue = nextIsDialogue;
                continue;
            }

            appendWithSpace(
                current,
                next
            );

            previousWasDialogue = nextIsDialogue;
        }
    } finally {
        processingContainers.delete(container);
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
                 * Ignore mutations made inside paragraphs.
                 * This prevents the cleaner from reacting to
                 * its own text merging.
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

                /*
                 * Ignore mutations caused by the cleaner's
                 * own removal/replacement of elements when
                 * there are no newly added nodes.
                 */
                if (
                    mutation.addedNodes.length === 0
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

    // Validate all selectors.
    try {
        document.querySelectorAll(
            values.chapterContainer
        );

        document.querySelectorAll(
            values.paragraphSelector
        );

        if (values.junkSelector) {
            document.querySelectorAll(
                values.junkSelector
            );
        }
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
