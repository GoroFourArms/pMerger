// ==UserScript==
// @name         pMerger
// @namespace    https://tampermonkey.net/
// @version      1.1.14
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

    const MAX_MERGED_SENTENCES = 5;

    const originalChapterHTML =
        new WeakMap();

    const modifiedContainers =
        new Set();

    const processingContainers =
        new WeakSet();

    const pendingChapterTimers =
        new WeakMap();

    const DEFAULT_CONFIG = {
        globalEnabled: false,
        sites: {}
    };

    let config =
        GM_getValue(
            STORAGE_KEY,
            DEFAULT_CONFIG
        );

    function loadConfig() {
        if (
            !config ||
            typeof config !== 'object'
        ) {
            config = {};
        }

        if (
            typeof config.globalEnabled !==
            'boolean'
        ) {
            config.globalEnabled = false;
        }

        if (
            !config.sites ||
            typeof config.sites !== 'object'
        ) {
            config.sites = {};
        }
    }

    function saveConfig() {
        GM_setValue(
            STORAGE_KEY,
            config
        );
    }

    loadConfig();


    // ============================================================
    // RUNTIME STATE
    // ============================================================

    let observer = null;
    let urlWatcher = null;
    let lastUrl = location.href;

    let applyMenuId = null;
    let undoMenuId = null;
    let toggleMenuId = null;
    let settingsMenuId = null;


    // ============================================================
    // DOMAIN
    // ============================================================

    function getDomain() {
        return location.hostname
            .toLowerCase()
            .replace(/^www\./, '');
    }

    function getCurrentSite() {
        return (
            config.sites[
                getDomain()
            ] || null
        );
    }


    // ============================================================
    // MENU COMMANDS
    // ============================================================

    function registerMenuCommands() {
        for (const id of [
            applyMenuId,
            undoMenuId,
            toggleMenuId,
            settingsMenuId
        ]) {
            if (
                id !== null &&
                typeof GM_unregisterMenuCommand ===
                    'function'
            ) {
                try {
                    GM_unregisterMenuCommand(id);
                } catch {
                    // Ignore unsupported/invalid IDs.
                }
            }
        }

        applyMenuId =
            GM_registerMenuCommand(
                'pMerger: Apply',
                applyCurrentPage
            );

        undoMenuId =
            GM_registerMenuCommand(
                'pMerger: Undo',
                undoCurrentPage
            );

        toggleMenuId =
            GM_registerMenuCommand(
                `pMerger: ${
                    config.globalEnabled
                        ? 'ON'
                        : 'OFF'
                }`,
                toggleCleaner
            );

        settingsMenuId =
            GM_registerMenuCommand(
                'pMerger — Settings',
                openSettings
            );
    }

    function toggleCleaner() {
        config.globalEnabled =
            !config.globalEnabled;

        saveConfig();

        registerMenuCommands();

        if (config.globalEnabled) {
            startCleaner();
        } else {
            stopCleaner();
        }
    }


    // ============================================================
    // URL PATTERNS
    // ============================================================

    function wildcardToRegex(pattern) {
        const escaped =
            pattern
                .replace(
                    /[.+?^${}()|[\]\\]/g,
                    '\\$&'
                )
                .replace(
                    /\*/g,
                    '.*'
                );

        return new RegExp(
            '^' +
                escaped +
                '$',
            'i'
        );
    }

    function matchesUrlPattern(pattern) {
        if (!pattern) {
            return false;
        }

        pattern =
            pattern.trim();

        if (!pattern) {
            return false;
        }

        try {
            const target =
                pattern.startsWith('/')
                    ? location.pathname +
                      location.search +
                      location.hash
                    : location.href;

            return wildcardToRegex(
                pattern
            ).test(target);
        } catch {
            return false;
        }
    }

    function isChapterPage() {
        if (!config.globalEnabled) {
            return false;
        }

        const site =
            getCurrentSite();

        if (
            !site ||
            site.enabled === false
        ) {
            return false;
        }

        if (
            !site.chapterContainer
        ) {
            return false;
        }

        if (
            !site.paragraphSelector
        ) {
            return false;
        }

        if (
            !Array.isArray(
                site.chapterUrlPatterns
            ) ||
            site.chapterUrlPatterns.length === 0
        ) {
            return false;
        }

        return site.chapterUrlPatterns.some(
            matchesUrlPattern
        );
    }


    // ============================================================
    // SELECTOR HELPERS
    // ============================================================

    function safeQueryAll(
        root,
        selector
    ) {
        if (
            !root ||
            !selector
        ) {
            return [];
        }

        try {
            return Array.from(
                root.querySelectorAll(
                    selector
                )
            );
        } catch (error) {
            console.warn(
                '[pMerger] Invalid selector:',
                selector,
                error
            );

            return [];
        }
    }

    function elementMatches(
        element,
        selector
    ) {
        if (
            !element ||
            element.nodeType !==
                Node.ELEMENT_NODE ||
            !selector
        ) {
            return false;
        }

        try {
            return element.matches(
                selector
            );
        } catch {
            return false;
        }
    }

    function findChapterContainers(
        root,
        selector
    ) {
        const results = [];

        if (
            root &&
            root.nodeType ===
                Node.ELEMENT_NODE &&
            elementMatches(
                root,
                selector
            )
        ) {
            results.push(root);
        }

        results.push(
            ...safeQueryAll(
                root,
                selector
            )
        );

        return [
            ...new Set(results)
        ];
    }

    function closestChapter(
        element,
        selector
    ) {
        if (
            !element ||
            element.nodeType !==
                Node.ELEMENT_NODE ||
            !selector
        ) {
            return null;
        }

        try {
            return element.closest(
                selector
            );
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
            text.match(
                /[.!?]+(?=\s|$)/g
            );

        return matches
            ? matches.length
            : 0;
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


    // ============================================================
    // JUNK
    // ============================================================

    function removeJunk(
        container,
        site
    ) {
        if (
            !site ||
            !site.junkSelector
        ) {
            return;
        }

        const junk =
            safeQueryAll(
                container,
                site.junkSelector
            );

        for (const element of junk) {
            if (element.isConnected) {
                element.remove();
            }
        }
    }


    // ============================================================
    // NAVIGATION
    // ============================================================

    function getNavigationReplacement(
        element
    ) {
        if (!element) {
            return null;
        }

        const text =
            textOf(element);

        if (
            /^(?:next|next\s+chapter)$/i.test(
                text
            )
        ) {
            return '~~>';
        }

        if (
            /^(?:previous|previous\s+chapter)$/i.test(
                text
            )
        ) {
            return '<~~';
        }

        if (
            /^(?:toc|contents|table\s+of\s+contents|index)$/i.test(
                text
            )
        ) {
            return '~~|~~';
        }

        return null;
    }

    function cleanNavigationElement(
        element
    ) {
        const replacement =
            getNavigationReplacement(
                element
            );

        if (
            replacement === null
        ) {
            return false;
        }

        element.textContent =
            replacement;

        return true;
    }


    // ============================================================
    // DIALOGUE
    // ============================================================

    function looksLikeDialogue(
        element
    ) {
        const text =
            textOf(element);

        if (!text) {
            return false;
        }

        /*
         * Dialogue beginning with quotation marks.
         */
        if (
            /^["“‘「『]/.test(text)
        ) {
            return true;
        }

        /*
         * Dialogue beginning with an
         * em dash or en dash.
         */
        if (
            /^[—–]\s*\S/.test(text)
        ) {
            return true;
        }

        return false;
    }


    // ============================================================
    // PARAGRAPH HELPERS
    // ============================================================

    function areAdjacent(
        first,
        second
    ) {
        if (
            !first ||
            !second
        ) {
            return false;
        }

        return (
            first.nextElementSibling ===
            second
        );
    }

    function appendWithSpace(
        first,
        second
    ) {
        const firstText =
            first.textContent || '';

        const secondText =
            second.textContent || '';

        if (
            firstText &&
            secondText &&
            !/\s$/.test(firstText) &&
            !/^\s/.test(secondText)
        ) {
            first.appendChild(
                document.createTextNode(
                    ' '
                )
            );
        }

        while (
            second.firstChild
        ) {
            first.appendChild(
                second.firstChild
            );
        }

        second.remove();
    }


    // ============================================================
    // ORIGINAL CONTENT
    // ============================================================

    function saveOriginalChapter(
        container
    ) {
        if (
            originalChapterHTML.has(
                container
            )
        ) {
            return;
        }

        originalChapterHTML.set(
            container,
            container.innerHTML
        );

        modifiedContainers.add(
            container
        );
    }
        // ============================================================
    // PARAGRAPH WRAPPERS
    // ============================================================

    function flattenParagraphWrappers(
        container,
        site
    ) {
        if (
            !site ||
            !site.paragraphSelector
        ) {
            return;
        }

        const paragraphs =
            safeQueryAll(
                container,
                site.paragraphSelector
            );

        for (const paragraph of paragraphs) {
            if (!paragraph.parentElement) {
                continue;
            }

            /*
             * If the paragraph is already a direct child
             * of the chapter container, nothing needs changing.
             */
            if (
                paragraph.parentElement ===
                container
            ) {
                continue;
            }

            /*
             * Only flatten simple wrappers that contain
             * this paragraph and nothing else meaningful.
             */
            const wrapper =
                paragraph.parentElement;

            if (
                wrapper.children.length === 1 &&
                wrapper.parentElement ===
                    container
            ) {
                container.appendChild(
                    paragraph
                );

                wrapper.remove();
            }
        }
    }


    // ============================================================
    // NAVIGATION CLEANING
    // ============================================================

    function cleanNavigation(
        container
    ) {
        const elements =
            safeQueryAll(
                container,
                'a, button, [role="button"]'
            );

        for (const element of elements) {
            cleanNavigationElement(
                element
            );
        }
    }


    // ============================================================
    // SCENE BREAKS
    // ============================================================

    function convertSceneBreaks(
        container,
        site
    ) {
        if (
            !site ||
            !site.paragraphSelector
        ) {
            return;
        }

        const paragraphs =
            safeQueryAll(
                container,
                site.paragraphSelector
            );

        for (const paragraph of paragraphs) {
            const text =
                textOf(paragraph);

            if (
                !looksLikeSceneBreak(
                    text
                )
            ) {
                continue;
            }

            const hr =
                document.createElement(
                    'hr'
                );

            paragraph.replaceWith(
                hr
            );
        }
    }


    // ============================================================
    // MERGING
    // ============================================================

    function mergeParagraphs(
        container,
        site
    ) {
        if (
            !site ||
            !site.paragraphSelector
        ) {
            return;
        }

        /*
         * Only work with paragraphs that are direct
         * children of this chapter container.
         */
        let paragraphs =
            Array.from(
                container.children
            ).filter(
                element =>
                    elementMatches(
                        element,
                        site.paragraphSelector
                    )
            );

        let sentenceCount = 0;
        let previousWasDialogue = false;

        for (
            let i = 0;
            i < paragraphs.length;
            i++
        ) {
            const current =
                paragraphs[i];

            if (
                !current.isConnected
            ) {
                continue;
            }

            const currentText =
                textOf(current);

            if (!currentText) {
                continue;
            }

            /*
             * Scene breaks and other non-paragraph
             * elements reset the merge chain.
             */
            if (
                looksLikeSceneBreak(
                    currentText
                )
            ) {
                sentenceCount = 0;
                previousWasDialogue = false;
                continue;
            }

            const currentIsDialogue =
                looksLikeDialogue(
                    current
                );

            /*
             * Find the previous connected paragraph.
             */
            let previous = null;

            for (
                let j = i - 1;
                j >= 0;
                j--
            ) {
                if (
                    paragraphs[j].isConnected
                ) {
                    previous =
                        paragraphs[j];
                    break;
                }
            }

            if (!previous) {
                sentenceCount =
                    countSentences(
                        currentText
                    );

                previousWasDialogue =
                    currentIsDialogue;

                continue;
            }

            const previousText =
                textOf(previous);

            /*
             * If something other than a paragraph
             * sits between them, do not merge.
             */
            if (
                !areAdjacent(
                    previous,
                    current
                )
            ) {
                sentenceCount =
                    countSentences(
                        currentText
                    );

                previousWasDialogue =
                    currentIsDialogue;

                continue;
            }

            /*
             * Two dialogue paragraphs directly
             * beside each other create a break.
             */
            if (
                previousWasDialogue &&
                currentIsDialogue
            ) {
                sentenceCount =
                    countSentences(
                        currentText
                    );

                previousWasDialogue =
                    currentIsDialogue;

                continue;
            }

            const currentSentences =
                countSentences(
                    currentText
                );

            /*
             * Never create a merged paragraph with
             * more than the configured sentence limit.
             */
            if (
                sentenceCount > 0 &&
                sentenceCount +
                    currentSentences >
                    MAX_MERGED_SENTENCES
            ) {
                sentenceCount =
                    currentSentences;

                previousWasDialogue =
                    currentIsDialogue;

                continue;
            }

            /*
             * Merge current into previous.
             */
            appendWithSpace(
                previous,
                current
            );

            sentenceCount +=
                currentSentences;

            /*
             * Remove the consumed paragraph
             * from our working list.
             */
            paragraphs.splice(
                i,
                1
            );

            i--;

            previousWasDialogue =
                currentIsDialogue;
        }
    }


    // ============================================================
    // CLEAN ONE CHAPTER
    // ============================================================

    function cleanChapter(
        container,
        site
    ) {
        if (
            !container ||
            !site
        ) {
            return;
        }

        if (
            processingContainers.has(
                container
            )
        ) {
            return;
        }

        processingContainers.add(
            container
        );

        try {
            saveOriginalChapter(
                container
            );

            /*
             * Remove manually configured junk first.
             */
            removeJunk(
                container,
                site
            );

            /*
             * Convert navigation links/buttons
             * into harmless text markers.
             */
            cleanNavigation(
                container
            );

            /*
             * Convert scene-break paragraphs
             * before flattening/merging.
             */
            convertSceneBreaks(
                container,
                site
            );

            /*
             * Turn structures such as:
             *
             * div.paragraph > p.line
             *
             * into:
             *
             * chapter > p.line
             *
             * so paragraphs can actually become
             * adjacent siblings.
             */
            flattenParagraphWrappers(
                container,
                site
            );

            /*
             * Merge artificial paragraph breaks.
             */
            mergeParagraphs(
                container,
                site
            );
        } finally {
            processingContainers.delete(
                container
            );
        }
    }


    // ============================================================
    // CLEAN ALL CHAPTERS ON PAGE
    // ============================================================

    function cleanCurrentPage() {
        if (!isChapterPage()) {
            return 0;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return 0;
        }

        const containers =
            findChapterContainers(
                document,
                site.chapterContainer
            );

        for (const container of containers) {
            cleanChapter(
                container,
                site
            );
        }

        return containers.length;
    }
        // ============================================================
    // TIMER HELPERS
    // ============================================================

    function cancelContainerTimer(
        container
    ) {
        const timer =
            pendingChapterTimers.get(
                container
            );

        if (
            timer !== undefined
        ) {
            clearTimeout(timer);

            pendingChapterTimers.delete(
                container
            );
        }
    }

    function scheduleContainer(
        container,
        site,
        delay = 100
    ) {
        if (
            !container ||
            !site
        ) {
            return;
        }

        cancelContainerTimer(
            container
        );

        const timer =
            setTimeout(() => {
                pendingChapterTimers.delete(
                    container
                );

                if (
                    !config.globalEnabled ||
                    !container.isConnected
                ) {
                    return;
                }

                const currentSite =
                    getCurrentSite();

                if (
                    !currentSite ||
                    currentSite !== site
                ) {
                    return;
                }

                cleanChapter(
                    container,
                    site
                );
            }, delay);

        pendingChapterTimers.set(
            container,
            timer
        );
    }


    // ============================================================
    // APPLY
    // ============================================================

    function applyCurrentPage() {
        const site =
            getCurrentSite();

        if (!site) {
            return;
        }

        if (
            site.enabled === false
        ) {
            return;
        }

        if (
            !site.chapterContainer ||
            !site.paragraphSelector
        ) {
            return;
        }

        if (
            !Array.isArray(
                site.chapterUrlPatterns
            ) ||
            site.chapterUrlPatterns.length === 0
        ) {
            return;
        }

        /*
         * Manual Apply must work even when the
         * master switch is currently OFF.
         */
        const matches =
            site.chapterUrlPatterns.some(
                matchesUrlPattern
            );

        if (!matches) {
            return;
        }

        const containers =
            findChapterContainers(
                document,
                site.chapterContainer
            );

        for (const container of containers) {
            cleanChapter(
                container,
                site
            );
        }
    }


    // ============================================================
    // UNDO
    // ============================================================

    function undoCurrentPage() {
        /*
         * Stop the observer first so restoring the original
         * HTML does not immediately trigger another cleanup.
         */
        stopObserver();

        /*
         * Cancel timers belonging to containers we know
         * were modified.
         */
        for (
            const container of modifiedContainers
        ) {
            cancelContainerTimer(
                container
            );
        }

        /*
         * Restore each saved chapter.
         */
        for (
            const container of modifiedContainers
        ) {
            const originalHTML =
                originalChapterHTML.get(
                    container
                );

            if (
                originalHTML === undefined
            ) {
                continue;
            }

            if (
                container.isConnected
            ) {
                container.innerHTML =
                    originalHTML;
            }
        }

        /*
         * Clear all saved snapshots for the page.
         */
        for (
            const container of modifiedContainers
        ) {
            originalChapterHTML.delete(
                container
            );
        }

        modifiedContainers.clear();

        /*
         * Restart automatic processing if enabled.
         */
        if (config.globalEnabled) {
            startObserver();
        }
    }


    // ============================================================
    // MUTATION HANDLING
    // ============================================================

    function handleAddedNode(
        node,
        site
    ) {
        if (
            !node ||
            node.nodeType !==
                Node.ELEMENT_NODE
        ) {
            return;
        }

        /*
         * If the added node itself is a chapter,
         * process it.
         */
        const ownChapter =
            elementMatches(
                node,
                site.chapterContainer
            )
                ? node
                : null;

        if (ownChapter) {
            scheduleContainer(
                ownChapter,
                site
            );
        }

        /*
         * Also look for chapters inside the
         * newly added node.
         */
        const chapters =
            findChapterContainers(
                node,
                site.chapterContainer
            );

        for (const chapter of chapters) {
            scheduleContainer(
                chapter,
                site
            );
        }

        /*
         * If content was inserted inside an existing
         * chapter, process that chapter instead.
         */
        const parentChapter =
            closestChapter(
                node,
                site.chapterContainer
            );

        if (parentChapter) {
            scheduleContainer(
                parentChapter,
                site
            );
        }
    }


    function handleMutations(
        mutations
    ) {
        if (!config.globalEnabled) {
            return;
        }

        if (!isChapterPage()) {
            return;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return;
        }

        for (const mutation of mutations) {
            if (
                mutation.type !==
                'childList'
            ) {
                continue;
            }

            /*
             * Ignore mutations caused only by
             * text/attribute changes.
             */
            if (
                mutation.addedNodes.length === 0
            ) {
                continue;
            }

            for (
                const node of mutation.addedNodes
            ) {
                handleAddedNode(
                    node,
                    site
                );
            }
        }
    }


    // ============================================================
    // MUTATION OBSERVER
    // ============================================================

    function startObserver() {
        stopObserver();

        if (!config.globalEnabled) {
            return;
        }

        if (!isChapterPage()) {
            return;
        }

        observer =
            new MutationObserver(
                handleMutations
            );

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );
    }


    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }


    // ============================================================
    // START / STOP
    // ============================================================

    function startCleaner() {
        stopObserver();

        if (!isChapterPage()) {
            return;
        }

        cleanCurrentPage();

        startObserver();

        startUrlWatcher();
    }


    function stopCleaner() {
        stopObserver();

        stopUrlWatcher();
    }
        // ============================================================
    // URL WATCHER
    // ============================================================

    function startUrlWatcher() {
        stopUrlWatcher();

        lastUrl = location.href;

        urlWatcher = setInterval(() => {
            if (location.href === lastUrl) {
                return;
            }

            lastUrl = location.href;

            /*
             * The site may have changed chapters without
             * performing a full page reload.
             */
            if (config.globalEnabled) {
                stopObserver();

                setTimeout(() => {
                    if (
                        config.globalEnabled &&
                        isChapterPage()
                    ) {
                        cleanCurrentPage();
                        startObserver();
                    }
                }, 150);
            }
        }, 500);
    }


    function stopUrlWatcher() {
        if (urlWatcher !== null) {
            clearInterval(
                urlWatcher
            );

            urlWatcher = null;
        }
    }


    // ============================================================
    // SETTINGS HELPERS
    // ============================================================

    function getFormSettings(
        form
    ) {
        const site =
            getCurrentSite() || {};

        return {
            enabled:
                form.enabled.checked,

            chapterUrlPatterns:
                form.chapterUrlPatterns.value
                    .split('\n')
                    .map(
                        value =>
                            value.trim()
                    )
                    .filter(Boolean),

            chapterContainer:
                form.chapterContainer.value
                    .trim(),

            paragraphSelector:
                form.paragraphSelector.value
                    .trim(),

            junkSelector:
                form.junkSelector.value
                    .trim()
        };
    }


    function createSettingsField(
        labelText,
        value,
        type = 'text'
    ) {
        const wrapper =
            document.createElement(
                'label'
            );

        wrapper.style.display =
            'block';

        wrapper.style.marginBottom =
            '12px';

        const label =
            document.createElement(
                'div'
            );

        label.textContent =
            labelText;

        label.style.fontWeight =
            'bold';

        label.style.marginBottom =
            '4px';

        const input =
            document.createElement(
                type === 'textarea'
                    ? 'textarea'
                    : 'input'
            );

        if (type !== 'textarea') {
            input.type = type;
        }

        input.value =
            value || '';

        input.style.width =
            '100%';

        input.style.boxSizing =
            'border-box';

        input.style.padding =
            '6px';

        if (
            type === 'textarea'
        ) {
            input.rows = 5;
        }

        wrapper.appendChild(
            label
        );

        wrapper.appendChild(
            input
        );

        return {
            wrapper,
            input
        };
    }


    // ============================================================
    // SETTINGS
    // ============================================================

    function openSettings() {
        const domain =
            getDomain();

        const existing =
            document.getElementById(
                'pmerger-settings'
            );

        if (existing) {
            existing.remove();
        }

        const site =
            getCurrentSite() || {
                enabled: true,
                chapterUrlPatterns: [],
                chapterContainer: '',
                paragraphSelector: '',
                junkSelector: ''
            };

        const overlay =
            document.createElement(
                'div'
            );

        overlay.id =
            'pmerger-settings';

        Object.assign(
            overlay.style,
            {
                position: 'fixed',
                inset: '0',
                zIndex: '2147483647',
                background: 'rgba(0,0,0,.65)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px',
                boxSizing: 'border-box'
            }
        );

        const panel =
            document.createElement(
                'div'
            );

        Object.assign(
            panel.style,
            {
                background: '#fff',
                color: '#111',
                width: 'min(700px, 100%)',
                maxHeight: '90vh',
                overflowY: 'auto',
                padding: '20px',
                borderRadius: '8px',
                boxSizing: 'border-box',
                fontFamily: 'Arial, sans-serif'
            }
        );

        const title =
            document.createElement(
                'h2'
            );

        title.textContent =
            `pMerger — ${domain}`;

        title.style.marginTop =
            '0';

        panel.appendChild(
            title
        );


        // --------------------------------------------------------
        // Enabled
        // --------------------------------------------------------

        const enabledLabel =
            document.createElement(
                'label'
            );

        enabledLabel.style.display =
            'block';

        enabledLabel.style.marginBottom =
            '14px';

        const enabled =
            document.createElement(
                'input'
            );

        enabled.type =
            'checkbox';

        enabled.checked =
            site.enabled !== false;

        enabledLabel.appendChild(
            enabled
        );

        enabledLabel.appendChild(
            document.createTextNode(
                ' Enable this site'
            )
        );

        panel.appendChild(
            enabledLabel
        );


        // --------------------------------------------------------
        // URL patterns
        // --------------------------------------------------------

        const urlField =
            createSettingsField(
                'Chapter URL patterns (one per line)',
                Array.isArray(
                    site.chapterUrlPatterns
                )
                    ? site.chapterUrlPatterns.join(
                        '\n'
                    )
                    : '',
                'textarea'
            );

        panel.appendChild(
            urlField.wrapper
        );


        // --------------------------------------------------------
        // Chapter container
        // --------------------------------------------------------

        const containerField =
            createSettingsField(
                'Chapter container selector',
                site.chapterContainer
            );

        panel.appendChild(
            containerField.wrapper
        );


        // --------------------------------------------------------
        // Paragraph selector
        // --------------------------------------------------------

        const paragraphField =
            createSettingsField(
                'Paragraph selector',
                site.paragraphSelector
            );

        panel.appendChild(
            paragraphField.wrapper
        );


        // --------------------------------------------------------
        // Junk selector
        // --------------------------------------------------------

        const junkField =
            createSettingsField(
                'Junk selector (optional)',
                site.junkSelector
            );

        panel.appendChild(
            junkField.wrapper
        );


        // --------------------------------------------------------
        // Information
        // --------------------------------------------------------

        const info =
            document.createElement(
                'div'
            );

        info.textContent =
            'Scene breaks are converted to <hr>. ' +
            'Navigation links are replaced with silent markers. ' +
            'Two dialogue paragraphs directly beside each other ' +
            'remain separated. Merged paragraphs are limited to 5 sentences.';

        Object.assign(
            info.style,
            {
                fontSize: '13px',
                lineHeight: '1.4',
                marginBottom: '16px',
                padding: '10px',
                background: '#eee'
            }
        );

        panel.appendChild(
            info
        );


        // --------------------------------------------------------
        // Buttons
        // --------------------------------------------------------

        const buttons =
            document.createElement(
                'div'
            );

        Object.assign(
            buttons.style,
            {
                display: 'flex',
                gap: '8px',
                justifyContent: 'flex-end'
            }
        );

        const cancel =
            document.createElement(
                'button'
            );

        cancel.textContent =
            'Cancel';

        const save =
            document.createElement(
                'button'
            );

        save.textContent =
            'Save';

        buttons.appendChild(
            cancel
        );

        buttons.appendChild(
            save
        );

        panel.appendChild(
            buttons
        );


        // --------------------------------------------------------
        // Close
        // --------------------------------------------------------

        cancel.addEventListener(
            'click',
            () => {
                overlay.remove();
            }
        );


        // --------------------------------------------------------
        // Save
        // --------------------------------------------------------

        save.addEventListener(
            'click',
            () => {
                const form = {
                    enabled,
                    chapterUrlPatterns:
                        urlField.input,
                    chapterContainer:
                        containerField.input,
                    paragraphSelector:
                        paragraphField.input,
                    junkSelector:
                        junkField.input
                };

                const newSite =
                    getFormSettings(
                        form
                    );

                config.sites[domain] =
                    newSite;

                saveConfig();

                overlay.remove();

                registerMenuCommands();

                /*
                 * Re-evaluate the current page
                 * immediately after saving.
                 */
                stopCleaner();

                if (
                    config.globalEnabled
                ) {
                    startCleaner();
                }
            }
        );


        // --------------------------------------------------------
        // Mount
        // --------------------------------------------------------

        overlay.appendChild(
            panel
        );

        document.body.appendChild(
            overlay
        );
    }
        // ============================================================
    // DEFAULT SITE CONFIGS
    // ============================================================

    function addDefaultSite(
        domain,
        settings
    ) {
        if (
            config.sites[domain] &&
            typeof config.sites[domain] ===
                'object'
        ) {
            return;
        }

        config.sites[domain] =
            settings;
    }


    function loadDefaultSites() {
        addDefaultSite(
            'wtr-lab.com',
            {
                enabled: true,

                chapterUrlPatterns: [
                    '/en/novel/*/tts*'
                ],

                chapterContainer:
                    'div.chapter-container',

                paragraphSelector:
                    'div.wtr-line',

                junkSelector: ''
            }
        );

        addDefaultSite(
            'karistudio.com',
            {
                enabled: true,

                chapterUrlPatterns: [
                    '/chapter-*'
                ],

                chapterContainer:
                    'article.small.single',

                paragraphSelector:
                    'p',

                junkSelector: ''
            }
        );

        addDefaultSite(
            'dreamytranslations.com',
            {
                enabled: true,

                chapterUrlPatterns: [
                    '/novel/*/chapter/*'
                ],

                chapterContainer:
                    'article.chapter-content',

                paragraphSelector:
                    'p.line',

                junkSelector: ''
            }
        );

        saveConfig();
    }


    // ============================================================
    // STARTUP
    // ============================================================

    function initialize() {
        loadConfig();

        loadDefaultSites();

        registerMenuCommands();

        /*
         * The master switch defaults to OFF.
         * Nothing is automatically modified until
         * the user turns pMerger ON.
         */
        if (
            config.globalEnabled
        ) {
            startCleaner();
        }
    }


    // ============================================================
    // INITIALIZE
    // ============================================================

    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            initialize,
            {
                once: true
            }
        );
    } else {
        initialize();
    }

})();
