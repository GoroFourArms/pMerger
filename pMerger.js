// ==UserScript==
// @name         pMerger
// @namespace    https://tampermonkey.net/
// @version      2.0.0
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
    // CORE SETTINGS
    // ============================================================

    const STORAGE_KEY =
        'pMergerConfig';

    const MAX_MERGED_SENTENCES =
        5;


    // ============================================================
    // CONFIGURATION
    // ============================================================

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

    /*
     * Original HTML for Undo.
     *
     * Each chapter container gets its own snapshot.
     */
    const originalChapterHTML =
        new WeakMap();


    /*
     * Chapters currently modified by pMerger.
     */
    const modifiedContainers =
        new Set();


    /*
     * Prevent the same chapter from being
     * processed recursively.
     */
    const processingContainers =
        new WeakSet();


    /*
     * Delayed processing timers.
     */
    const pendingChapterTimers =
        new WeakMap();


    /*
     * MutationObserver.
     */
    let observer = null;


    /*
     * SPA URL watcher.
     */
    let urlWatcher = null;

    let lastUrl =
        location.href;


    /*
     * Used to invalidate delayed work when
     * the page state changes.
     */
    let processingGeneration = 0;


    // ============================================================
    // MENU COMMAND STATE
    // ============================================================

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
            .replace(
                /^www\./,
                ''
            );
    }


    function getCurrentSite() {
        return (
            config.sites[
                getDomain()
            ] || null
        );
    }


    // ============================================================
    // URL PATTERNS
    // ============================================================

    function wildcardToRegex(
        pattern
    ) {
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


    function matchesUrlPattern(
        pattern
    ) {
        if (!pattern) {
            return false;
        }

        pattern =
            pattern.trim();

        if (!pattern) {
            return false;
        }

        try {
            /*
             * Patterns beginning with /
             * match the current path.
             */
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


    // ============================================================
    // CHAPTER PAGE CHECK
    // ============================================================

    function isChapterPage(
        requireEnabled = true
    ) {
        if (
            requireEnabled &&
            !config.globalEnabled
        ) {
            return false;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return false;
        }

        if (
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
            !Array.isArray(
                site.chapterUrlPatterns
            )
        ) {
            return false;
        }

        if (
            site.chapterUrlPatterns.length === 0
        ) {
            return false;
        }

        return site.chapterUrlPatterns.some(
            matchesUrlPattern
        );
    }


    // ============================================================
    // SAFE DOM HELPERS
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
            results.push(
                root
            );
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
    // TEXT HELPERS
    // ============================================================

    function textOf(
        element
    ) {
        if (!element) {
            return '';
        }

        return (
            element.textContent || ''
        )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();
    }


function countSentences(
    text
) {
    if (!text) {
        return 0;
    }

    const normalized =
        text
            .replace(
                /\s+/g,
                ' '
            )
            .trim();

    if (!normalized) {
        return 0;
    }

    /*
     * Count sentence-ending punctuation even when
     * followed by closing quotation marks.
     *
     * Examples:
     *
     * Hello.
     * "Hello."
     * "Hello," said Olivia.
     * "Are you okay?" he asked.
     */
    const matches =
        normalized.match(
            /[.!?]+(?=(?:["'”’»」』)]*)?(?:\s|$))/g
        );

    return matches
        ? matches.length
        : 0;
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
                    GM_unregisterMenuCommand(
                        id
                    );
                } catch {
                    // Ignore invalid IDs.
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

        processingGeneration++;

        saveConfig();

        registerMenuCommands();

        if (
            config.globalEnabled
        ) {
            startCleaner();

        } else {
            stopCleaner();
        }
    }


    // ============================================================
    // DEFAULT SITE CONFIGURATION
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

                junkSelector: ''
            }
        );

        saveConfig();
    }


    // ============================================================
    // PLACEHOLDERS
    // ============================================================
    /*
     * These functions are defined in later parts.
     *
     * Function declarations are hoisted, so the menu can
     * safely reference them before their implementations
     * appear later in the completed script.
     */

    function applyCurrentPage() {
        // Part 7
    }


    function undoCurrentPage() {
        // Part 7
    }


    function openSettings() {
        // Part 7
    }


    function startCleaner() {
        // Part 6
    }


    function stopCleaner() {
        // Part 6
    }

    // ============================================================
    // DOM ANALYSIS
    // ============================================================

    /*
     * pMerger does not assume that <p> is a paragraph.
     *
     * Instead, it examines the chapter and creates logical
     * blocks from the DOM.
     */


    const BLOCK_TYPES = {
        TEXT: 'text',
        SCENE_BREAK: 'scene_break',
        NAVIGATION: 'navigation',
        JUNK: 'junk',
        UNKNOWN: 'unknown'
    };


    // ============================================================
    // ELEMENT / TEXT HELPERS
    // ============================================================

    function isElement(
        node
    ) {
        return (
            node &&
            node.nodeType ===
                Node.ELEMENT_NODE
        );
    }


    function isTextNode(
        node
    ) {
        return (
            node &&
            node.nodeType ===
                Node.TEXT_NODE
        );
    }


    function hasMeaningfulText(
        element
    ) {
        return (
            textOf(element)
                .length > 0
        );
    }


    function isWhitespaceOnly(
        node
    ) {
        if (!isTextNode(node)) {
            return false;
        }

        return !node.nodeValue
            .trim();
    }


    // ============================================================
    // INLINE ELEMENTS
    // ============================================================

    function isInlineElement(
        element
    ) {
        if (!isElement(element)) {
            return false;
        }

        const tag =
            element.tagName
                .toLowerCase();

        return [
            'span',
            'a',
            'b',
            'strong',
            'i',
            'em',
            'u',
            's',
            'small',
            'mark',
            'sub',
            'sup',
            'code',
            'abbr',
            'cite',
            'q',
            'label'
        ].includes(tag);
    }


    // ============================================================
    // BLOCK ELEMENTS
    // ============================================================

    function isBlockElement(
        element
    ) {
        if (!isElement(element)) {
            return false;
        }

        const tag =
            element.tagName
                .toLowerCase();

        return [
            'address',
            'article',
            'aside',
            'blockquote',
            'div',
            'dl',
            'dt',
            'dd',
            'fieldset',
            'figcaption',
            'figure',
            'footer',
            'form',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'header',
            'hr',
            'li',
            'main',
            'nav',
            'ol',
            'p',
            'pre',
            'section',
            'table',
            'ul'
        ].includes(tag);
    }


    // ============================================================
    // SPECIAL ELEMENTS
    // ============================================================
function isHardBoundary(
    element
) {
    if (!isElement(element)) {
        return false;
    }

    const tag =
        element.tagName
            .toLowerCase();

    return [
        'hr',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',

        'img',
        'picture',
        'video',
        'audio',

        'table',
        'ul',
        'ol',

        'figure',
        'blockquote',

        'pre',

        'nav',
        'header',
        'footer',
        'aside'
    ].includes(tag);
}


    // ============================================================
    // SCENE BREAK DETECTION
    // ============================================================

    function looksLikeSceneBreak(
        text
    ) {
        const value =
            (text || '')
                .replace(
                    /\s+/g,
                    ''
                );

        return (
            /^~{2,}$/.test(value) ||
            /^-{3,}$/.test(value) ||
            /^_{3,}$/.test(value) ||
            /^\*{2,}$/.test(value) ||
            /^•{2,}$/.test(value) ||
            /^·{2,}$/.test(value)
        );
    }


    function isSceneBreakElement(
        element
    ) {
        if (!isElement(element)) {
            return false;
        }

        const tag =
            element.tagName
                .toLowerCase();

        if (tag === 'hr') {
            return true;
        }

        return looksLikeSceneBreak(
            textOf(element)
        );
    }


    // ============================================================
    // NAVIGATION DETECTION
    // ============================================================

function getNavigationReplacement(element) {
    if (!isElement(element)) {
        return null;
    }

    if (
        element.getAttribute(
            'data-pmerger-navigation'
        ) === 'true'
    ) {
        return element.textContent.trim();
    }

    const tag =
        element.tagName.toLowerCase();

    if (
        tag !== 'a' &&
        tag !== 'button' &&
        element.getAttribute('role') !== 'button'
    ) {
        return null;
    }

    const text =
        textOf(element)
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

    if (
        text === 'next' ||
        text === 'next chapter'
    ) {
        return '~~>';
    }

    if (
        text === 'previous' ||
        text === 'previous chapter'
    ) {
        return '<~~';
    }

    if (
        text === 'toc' ||
        text === 'contents' ||
        text === 'table of contents' ||
        text === 'index'
    ) {
        return '~~|~~';
    }

    return null;
}


    function isNavigationElement(
        element
    ) {
        return (
            getNavigationReplacement(
                element
            ) !== null
        );
    }


    // ============================================================
    // DIALOGUE DETECTION
    // ============================================================

    function looksLikeDialogue(
        text
    ) {
        const value =
            (text || '')
                .trim();

        if (!value) {
            return false;
        }

        /*
         * Quoted dialogue.
         *
         * This intentionally does not require
         * the paragraph to END with a quote.
         *
         * Therefore:
         *
         * "Hello," said Olivia.
         *
         * is still dialogue.
         */
        if (
            /^["“‘「『]/.test(
                value
            )
        ) {
            return true;
        }

        /*
         * Dash-style dialogue.
         */
        if (
            /^[—–]\s*\S/.test(
                value
            )
        ) {
            return true;
        }

        return false;
    }


    // ============================================================
    // ORDERING METADATA
    // ============================================================

    const ORDER_ATTRIBUTES = [
        'data',
        'data-order',
        'data-index',
        'data-number',
        'data-sequence',
        'data-seq'
    ];


    function getOrderValue(
        element
    ) {
        if (!isElement(element)) {
            return null;
        }

        for (
            const attribute
            of ORDER_ATTRIBUTES
        ) {
            const value =
                element.getAttribute(
                    attribute
                );

            if (
                value === null
            ) {
                continue;
            }

            const number =
                Number(
                    value
                        .trim()
                );

            if (
                Number.isFinite(
                    number
                )
            ) {
                return {
                    attribute,
                    value,
                    number
                };
            }
        }

        return null;
    }


    // ============================================================
    // CONTENT ELEMENT DETECTION
    // ============================================================

    function hasDirectText(
        element
    ) {
        if (!isElement(element)) {
            return false;
        }

        for (
            const node
            of element.childNodes
        ) {
            if (
                isTextNode(node) &&
                node.nodeValue.trim()
            ) {
                return true;
            }
        }

        return false;
    }


    function getElementDepth(
        element,
        chapter
    ) {
        let depth = 0;
        let current = element;

        while (
            current &&
            current !== chapter
        ) {
            depth++;
            current =
                current.parentElement;
        }

        return depth;
    }


    // ============================================================
    // TEXT BLOCK CANDIDATES
    // ============================================================

function isTextBlockCandidate(
    element,
    chapter
) {
    if (
        !isElement(element) ||
        !element.isConnected ||
        element === chapter
    ) {
        return false;
    }

    if (
        !hasMeaningfulText(element)
    ) {
        return false;
    }

    /*
     * Never treat special elements as normal text.
     */
    if (
        isNavigationElement(element) ||
        isSceneBreakElement(element) ||
        isHardBoundary(element)
    ) {
        return false;
    }

    /*
     * Inline elements are content inside a
     * logical text block.
     */
    if (
        isInlineElement(element)
    ) {
        return false;
    }

    /*
     * If this element contains another meaningful
     * block-level element, it is usually a wrapper,
     * not the actual paragraph.
     */
    const childBlocks =
        Array.from(
            element.children
        ).filter(
            child =>
                isBlockElement(child) &&
                hasMeaningfulText(child)
        );

    if (
        childBlocks.length > 0
    ) {
        /*
         * A block can still be the text block if
         * all of its children are inline/content
         * structures rather than separate paragraphs.
         */
        const meaningfulChildren =
            Array.from(
                element.children
            ).filter(
                child =>
                    hasMeaningfulText(child)
            );

        if (
            meaningfulChildren.some(
                child =>
                    isBlockElement(child) &&
                    !isInlineElement(child)
            )
        ) {
            return false;
        }
    }

    /*
     * Direct text is the strongest indication
     * that this is the actual text container.
     */
    if (
        hasDirectText(element)
    ) {
        return true;
    }

    /*
     * A block containing only inline elements
     * is also a valid text block.
     */
    const children =
        Array.from(
            element.children
        );

    if (
        children.length > 0 &&
        children.every(
            child =>
                isInlineElement(child)
        )
    ) {
        return true;
    }

    return false;
}


    // ============================================================
    // FIND TEXT BLOCKS
    // ============================================================

function findTextBlocks(
    chapter
) {
    const allElements =
        safeQueryAll(
            chapter,
            '*'
        );

    const candidates = [];

    for (
        const element
        of allElements
    ) {
        if (
            isTextBlockCandidate(
                element,
                chapter
            )
        ) {
            candidates.push(
                element
            );
        }
    }

    /*
     * If a candidate contains another candidate,
     * the outer candidate is normally just a wrapper.
     *
     * Keep the deepest meaningful candidate.
     */
    return candidates.filter(
        candidate => {
            return !candidates.some(
                other =>
                    other !== candidate &&
                    candidate.contains(
                        other
                    )
            );
        }
    );
}


    // ============================================================
    // ANALYZED BLOCK
    // ============================================================

    function createAnalyzedBlock(
        element,
        type
    ) {
        const order =
            getOrderValue(
                element
            );

        return {
            element,

            type,

            text:
                textOf(
                    element
                ),

            sentenceCount:
                countSentences(
                    textOf(
                        element
                    )
                ),

            dialogue:
                looksLikeDialogue(
                    textOf(
                        element
                    )
                ),

            orderAttribute:
                order
                    ? order.attribute
                    : null,

            orderValue:
                order
                    ? order.number
                    : null
        };
    }


    // ============================================================
    // ANALYZE CHAPTER
    // ============================================================

function analyzeChapter(
    chapter,
    site
) {
    const blocks = [];

    const allElements =
        safeQueryAll(
            chapter,
            '*'
        );


    // ============================================================
    // SPECIAL ELEMENTS
    // ============================================================

    /*
     * Scene breaks:
     *
     * If a scene-break element is inside another
     * scene-break element, only keep the deepest one.
     *
     * This prevents:
     *
     * <div>
     *     <p>---</p>
     * </div>
     *
     * from becoming two scene breaks.
     */
    const sceneElements =
        allElements.filter(
            element =>
                isSceneBreakElement(
                    element
                )
        );

    const sceneBreaks =
        sceneElements.filter(
            element => {
                return !sceneElements.some(
                    other =>
                        other !== element &&
                        element.contains(
                            other
                        )
                );
            }
        );

    for (
        const element
        of sceneBreaks
    ) {
        blocks.push(
            createAnalyzedBlock(
                element,
                BLOCK_TYPES.SCENE_BREAK
            )
        );
    }


    // ============================================================
    // NAVIGATION
    // ============================================================

    /*
     * Navigation elements are also deduplicated.
     *
     * If a navigation element is nested inside
     * another detected navigation element, only
     * the deepest interactive element is used.
     */
    const navigationElements =
        allElements.filter(
            element =>
                isNavigationElement(
                    element
                )
        );

    const navigationBlocks =
        navigationElements.filter(
            element => {
                return !navigationElements.some(
                    other =>
                        other !== element &&
                        element.contains(
                            other
                        )
                );
            }
        );

    for (
        const element
        of navigationBlocks
    ) {
        blocks.push(
            createAnalyzedBlock(
                element,
                BLOCK_TYPES.NAVIGATION
            )
        );
    }


    // ============================================================
    // TEXT BLOCKS
    // ============================================================

    const textBlocks =
        findTextBlocks(
            chapter
        );

    for (
        const element
        of textBlocks
    ) {
        /*
         * Do not allow a normal text block to contain
         * a separately recognized special element.
         */
        const containsSpecial =
            sceneBreaks.some(
                special =>
                    element.contains(
                        special
                    )
            ) ||
            navigationBlocks.some(
                special =>
                    element.contains(
                        special
                    )
            );

        if (
            containsSpecial
        ) {
            continue;
        }

        blocks.push(
            createAnalyzedBlock(
                element,
                BLOCK_TYPES.TEXT
            )
        );
    }


    // ============================================================
    // DOM ORDER
    // ============================================================

    blocks.sort(
        (a, b) => {
            if (
                a.element ===
                b.element
            ) {
                return 0;
            }

            const position =
                a.element.compareDocumentPosition(
                    b.element
                );

            if (
                position &
                Node.DOCUMENT_POSITION_FOLLOWING
            ) {
                return -1;
            }

            return 1;
        }
    );


    return {
        chapter,
        site,
        blocks
    };
}
      // ============================================================
    // JUNK DETECTION
    // ============================================================

    function isConfiguredJunk(
        element,
        site
    ) {
        if (
            !element ||
            !site ||
            !site.junkSelector
        ) {
            return false;
        }

        return elementMatches(
            element,
            site.junkSelector
        );
    }


    function removeConfiguredJunk(
        chapter,
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
                chapter,
                site.junkSelector
            );

        for (
            const element
            of junk
        ) {
            if (
                element.isConnected &&
                element !== chapter
            ) {
                element.remove();
            }
        }
    }


    // ============================================================
    // BOUNDARIES
    // ============================================================

    function isStructuralBoundary(
        block
    ) {
        if (!block) {
            return true;
        }

        if (
            block.type ===
            BLOCK_TYPES.SCENE_BREAK
        ) {
            return true;
        }

        if (
            block.type ===
            BLOCK_TYPES.NAVIGATION
        ) {
            return true;
        }

        if (
            block.type !==
            BLOCK_TYPES.TEXT
        ) {
            return true;
        }

        if (
            isHardBoundary(
                block.element
            )
        ) {
            return true;
        }

        return false;
    }


    // ============================================================
    // ADJACENCY
    // ============================================================

function areAdjacentTextBlocks(first, second) {
    if (
        !first ||
        !second ||
        !first.element ||
        !second.element
    ) {
        return false;
    }

    const firstElement =
        first.element;

    const secondElement =
        second.element;

    if (
        firstElement === secondElement ||
        firstElement.contains(secondElement) ||
        secondElement.contains(firstElement)
    ) {
        return false;
    }

    const range =
        document.createRange();

    try {
        range.setStartAfter(
            firstElement
        );

        range.setEndBefore(
            secondElement
        );
    } catch {
        return false;
    }

    const fragment =
        range.cloneContents();

    const elements =
        fragment.querySelectorAll('*');

    for (
        const element
        of elements
    ) {
        if (
            isSceneBreakElement(element) ||
            isNavigationElement(element) ||
            isHardBoundary(element)
        ) {
            return false;
        }

        if (
            hasMeaningfulText(element) &&
            !isInlineElement(element)
        ) {
            return false;
        }
    }

    const text =
        fragment.textContent
            .replace(/\s+/g, '');

    return text.length === 0;
}

    function getNextMeaningfulNode(
        element
    ) {
        if (!element) {
            return null;
        }

        /*
         * First try the first meaningful descendant
         * of the next sibling.
         */
        let sibling =
            element.nextSibling;

        while (sibling) {
            if (
                isTextNode(sibling) &&
                isWhitespaceOnly(sibling)
            ) {
                sibling =
                    sibling.nextSibling;

                continue;
            }

            if (
                isElement(sibling)
            ) {
                return (
                    getFirstMeaningfulElement(
                        sibling
                    ) ||
                    sibling
                );
            }

            return sibling;
        }

        /*
         * No sibling. Walk upward until a parent
         * has a next sibling.
         */
        let parent =
            element.parentElement;

        while (parent) {
            sibling =
                parent.nextSibling;

            while (sibling) {
                if (
                    isTextNode(
                        sibling
                    ) &&
                    isWhitespaceOnly(
                        sibling
                    )
                ) {
                    sibling =
                        sibling.nextSibling;

                    continue;
                }

                if (
                    isElement(
                        sibling
                    )
                ) {
                    return (
                        getFirstMeaningfulElement(
                            sibling
                        ) ||
                        sibling
                    );
                }

                return sibling;
            }

            parent =
                parent.parentElement;
        }

        return null;
    }


    function getFirstMeaningfulElement(
        element
    ) {
        if (!isElement(element)) {
            return null;
        }

        if (
            textOf(element)
        ) {
            /*
             * If this element directly contains
             * readable text, it is meaningful.
             */
            if (
                hasDirectText(
                    element
                )
            ) {
                return element;
            }
        }

        for (
            const child
            of element.children
        ) {
            const result =
                getFirstMeaningfulElement(
                    child
                );

            if (result) {
                return result;
            }
        }

        return null;
    }


    // ============================================================
    // MERGE ELIGIBILITY
    // ============================================================

    function canMergeBlocks(
        previous,
        current,
        sentenceCount
    ) {
        if (
            !previous ||
            !current
        ) {
            return false;
        }

        if (
            previous.type !==
            BLOCK_TYPES.TEXT ||
            current.type !==
            BLOCK_TYPES.TEXT
        ) {
            return false;
        }

        /*
         * Never merge across a structural boundary.
         */
        if (
            isStructuralBoundary(
                previous
            ) ||
            isStructuralBoundary(
                current
            )
        ) {
            return false;
        }

        /*
         * The blocks must actually be separate
         * pieces of the document.
         */
        if (
            !areAdjacentTextBlocks(
                previous,
                current
            )
        ) {
            return false;
        }

        /*
         * Two dialogue paragraphs directly beside
         * each other must remain separate.
         */
        if (
            previous.dialogue &&
            current.dialogue
        ) {
            return false;
        }

        const newSentenceCount =
            sentenceCount +
            current.sentenceCount;

        /*
         * Zero-sentence blocks should not accidentally
         * bypass the sentence limit.
         */
        if (
            current.sentenceCount > 0 &&
            newSentenceCount >
                MAX_MERGED_SENTENCES
        ) {
            return false;
        }

        return true;
    }


    // ============================================================
    // BUILD MERGE GROUPS
    // ============================================================

    function buildMergeGroups(
        analysis
    ) {
        const groups = [];

        let currentGroup = null;

        let sentenceCount = 0;

        for (
            const block
            of analysis.blocks
        ) {
            /*
             * Anything that is not a text block
             * ends the current merge group.
             */
            if (
                block.type !==
                BLOCK_TYPES.TEXT
            ) {
                currentGroup = null;
                sentenceCount = 0;

                continue;
            }


            /*
             * First text block in a group.
             */
            if (!currentGroup) {
                currentGroup = [
                    block
                ];

                groups.push(
                    currentGroup
                );

                sentenceCount =
                    block.sentenceCount;

                continue;
            }


            const previous =
                currentGroup[
                    currentGroup.length - 1
                ];


            /*
             * Decide whether this block can join
             * the current group.
             */
            if (
                canMergeBlocks(
                    previous,
                    block,
                    sentenceCount
                )
            ) {
                currentGroup.push(
                    block
                );

                sentenceCount +=
                    block.sentenceCount;

                continue;
            }


            /*
             * Start a new group.
             */
            currentGroup = [
                block
            ];

            groups.push(
                currentGroup
            );

            sentenceCount =
                block.sentenceCount;
        }

        return groups;
    }


    // ============================================================
    // MERGE PLAN
    // ============================================================

    function createMergePlan(
        analysis
    ) {
        const groups =
            buildMergeGroups(
                analysis
            );

        const operations = [];

        for (
            const group
            of groups
        ) {
            if (
                group.length < 2
            ) {
                continue;
            }

            operations.push({
                target:
                    group[0],

                sources:
                    group.slice(1),

                blocks:
                    group
            });
        }

        return {
            analysis,
            groups,
            operations
        };
    }
      // ============================================================
    // DOM MERGING
    // ============================================================

    function appendBlockContents(
        target,
        source
    ) {
        if (
            !target ||
            !source ||
            !target.element ||
            !source.element
        ) {
            return;
        }

        const targetElement =
            target.element;

        const sourceElement =
            source.element;

        /*
         * Move all original nodes instead of rebuilding
         * the text. This preserves inline formatting.
         */
        while (
            sourceElement.firstChild
        ) {
            targetElement.appendChild(
                sourceElement.firstChild
            );
        }
    }


    function addMergeSeparator(
        target
    ) {
        if (!target) {
            return;
        }

        /*
         * Add a normal text-space between the two
         * original blocks.
         *
         * We do not use <br>, because the purpose of
         * pMerger is to remove artificial paragraph
         * breaks for TTS.
         */
        target.appendChild(
            document.createTextNode(
                ' '
            )
        );
    }


function mergeOperation(
    operation
) {
    if (
        !operation ||
        !operation.target ||
        !Array.isArray(
            operation.sources
        )
    ) {
        return false;
    }

    const target =
        operation.target.element;

    if (
        !target ||
        !target.isConnected
    ) {
        return false;
    }

    let changed = false;

    for (
        const sourceBlock
        of operation.sources
    ) {
        const source =
            sourceBlock.element;

        if (
            !source ||
            !source.isConnected
        ) {
            continue;
        }

        if (
            source === target ||
            target.contains(source)
        ) {
            continue;
        }

        addMergeSeparator(
            target
        );

        appendBlockContents(
            operation.target,
            sourceBlock
        );

        source.setAttribute(
            'data-pmerger-empty',
            'true'
        );

        changed = true;
    }

    return changed;
}


    // ============================================================
    // APPLY MERGE PLAN
    // ============================================================

    function applyMergePlan(
        plan
    ) {
        if (
            !plan ||
            !Array.isArray(
                plan.operations
            )
        ) {
            return false;
        }

        let changed = false;

        /*
         * The plan was created from the original DOM,
         * so execute operations in document order.
         */
        for (
            const operation
            of plan.operations
        ) {
            if (
                mergeOperation(
                    operation
                )
            ) {
                changed = true;
            }
        }

        return changed;
    }


    // ============================================================
    // NAVIGATION REPLACEMENT
    // ============================================================

function replaceNavigationElement(element) {
    const replacement =
        getNavigationReplacement(element);

    if (!replacement) {
        return false;
    }

    if (
        element.getAttribute(
            'data-pmerger-navigation'
        ) === 'true'
    ) {
        return false;
    }

    element.textContent =
        replacement;

    element.setAttribute(
        'data-pmerger-navigation',
        'true'
    );

    return true;
}


    function applyNavigationReplacements(
        analysis
    ) {
        if (
            !analysis ||
            !Array.isArray(
                analysis.blocks
            )
        ) {
            return false;
        }

        let changed = false;

        for (
            const block
            of analysis.blocks
        ) {
            if (
                block.type !==
                BLOCK_TYPES.NAVIGATION
            ) {
                continue;
            }

            const replacement =
                getNavigationReplacement(
                    block.element
                );

            if (!replacement) {
                continue;
            }

            if (
                replaceNavigationElement(
                    block.element,
                    replacement
                )
            ) {
                changed = true;
            }
        }

        return changed;
    }


    // ============================================================
    // SCENE BREAK NORMALIZATION
    // ============================================================

    function normalizeSceneBreak(
        element
    ) {
        if (
            !element ||
            !element.isConnected
        ) {
            return false;
        }

        /*
         * Existing <hr> is already correct.
         */
        if (
            element.tagName
                .toLowerCase() ===
            'hr'
        ) {
            return false;
        }

        const hr =
            document.createElement(
                'hr'
            );

        /*
         * Preserve the class attribute when possible.
         * This helps the site's CSS continue to style
         * the separator.
         */
        if (
            element.className
        ) {
            hr.className =
                element.className;
        }

        element.replaceWith(
            hr
        );

        return true;
    }


    function normalizeSceneBreaks(
        analysis
    ) {
        if (
            !analysis ||
            !Array.isArray(
                analysis.blocks
            )
        ) {
            return false;
        }

        let changed = false;

        for (
            const block
            of analysis.blocks
        ) {
            if (
                block.type !==
                BLOCK_TYPES.SCENE_BREAK
            ) {
                continue;
            }

            if (
                normalizeSceneBreak(
                    block.element
                )
            ) {
                changed = true;
            }
        }

        return changed;
    }


    // ============================================================
    // COMPLETE CHAPTER TRANSFORMATION
    // ============================================================

function processChapter(
    chapter,
    site
) {
    if (
        !chapter ||
        !site
    ) {
        return false;
    }

    if (
        processingContainers.has(
            chapter
        )
    ) {
        return false;
    }

    processingContainers.add(
        chapter
    );

    try {
        /*
         * Remove configured junk first.
         */
        removeConfiguredJunk(
            chapter,
            site
        );

        /*
         * First analysis.
         */
        let analysis =
            analyzeChapter(
                chapter,
                site
            );

        /*
         * Handle navigation and scene breaks first.
         */
        const navigationChanged =
            applyNavigationReplacements(
                analysis
            );

        const sceneChanged =
            normalizeSceneBreaks(
                analysis
            );

        /*
         * The DOM changed, so rebuild the analysis.
         *
         * This prevents the merge engine from using
         * stale references to navigation/scene elements.
         */
        if (
            navigationChanged ||
            sceneChanged
        ) {
            analysis =
                analyzeChapter(
                    chapter,
                    site
                );
        }

        /*
         * Now build the merge plan from the
         * final pre-merge DOM.
         */
        const plan =
            createMergePlan(
                analysis
            );

        const mergeChanged =
            applyMergePlan(
                plan
            );

        return (
            navigationChanged ||
            sceneChanged ||
            mergeChanged
        );

    } finally {
        processingContainers.delete(
            chapter
        );
    }
}
      // ============================================================
    // POST-MERGE ORDER METADATA
    // ============================================================

    function collectOrderedElements(
        chapter
    ) {
        const elements =
            safeQueryAll(
                chapter,
                '*'
            );

        const ordered = [];

        for (
            const element
            of elements
        ) {
            const order =
                getOrderValue(
                    element
                );

            if (!order) {
                continue;
            }

            ordered.push({
                element,
                attribute:
                    order.attribute,
                value:
                    order.value,
                number:
                    order.number
            });
        }

        return ordered;
    }


    function groupOrderMetadata(
        ordered
    ) {
        const groups =
            new Map();

        for (
            const item
            of ordered
        ) {
            if (
                !groups.has(
                    item.attribute
                )
            ) {
                groups.set(
                    item.attribute,
                    []
                );
            }

            groups.get(
                item.attribute
            ).push(
                item
            );
        }

        return groups;
    }


    function isLikelySequence(
        items
    ) {
        if (
            !Array.isArray(items) ||
            items.length < 2
        ) {
            return false;
        }

        /*
         * We only treat an attribute as ordering
         * metadata when its numeric values are
         * sufficiently varied.
         *
         * Example:
         *
         * 1, 6, 13, 18
         *
         * looks like ordering metadata.
         *
         * A repeated value such as:
         *
         * 1, 1, 1, 1
         *
         * does not.
         */
        const uniqueValues =
            new Set(
                items.map(
                    item =>
                        item.number
                )
            );

        if (
            uniqueValues.size < 2
        ) {
            return false;
        }

        /*
         * Require the values to be in DOM order
         * already. We never use the numbers to sort.
         */
        for (
            let i = 1;
            i < items.length;
            i++
        ) {
            if (
                items[i].number <=
                items[i - 1].number
            ) {
                return false;
            }
        }

        return true;
    }


    function formatOrderNumber(
        originalValue,
        number
    ) {
        const value =
            String(
                originalValue ?? ''
            );

        /*
         * Preserve zero-padding.
         *
         * 01, 02, 03
         */
        const match =
            value.match(
                /^0+/
            );

        if (
            match &&
            match[0].length > 0
        ) {
            return String(
                number
            ).padStart(
                match[0].length + 1,
                '0'
            );
        }

        return String(
            number
        );
    }

function reindexOrderMetadata(chapter) {
    if (!chapter) {
        return false;
    }

    const blocks =
        findTextBlocks(chapter);

    const groups =
        new Map();

    for (
        const element
        of blocks
    ) {
        const order =
            getOrderValue(element);

        if (!order) {
            continue;
        }

        if (
            !groups.has(
                order.attribute
            )
        ) {
            groups.set(
                order.attribute,
                []
            );
        }

        groups
            .get(order.attribute)
            .push({
                element,
                value: order.value,
                number: order.number
            });
    }

    let changed = false;

    for (
        const [
            attribute,
            items
        ] of groups
    ) {
        if (
            !isLikelySequence(items)
        ) {
            continue;
        }

        for (
            let index = 0;
            index < items.length;
            index++
        ) {
            const item =
                items[index];

            const newValue =
                formatOrderNumber(
                    item.value,
                    index + 1
                );

            if (
                item.value !==
                newValue
            ) {
                item.element.setAttribute(
                    attribute,
                    newValue
                );

                changed = true;
            }
        }
    }

    return changed;
}
    // ============================================================
    // EMPTY ELEMENT CLEANUP
    // ============================================================

    function isEmptyAfterCleanup(
        element
    ) {
        if (!isElement(element)) {
            return false;
        }

        /*
         * Never remove structural elements that
         * have semantic meaning.
         */
        const tag =
            element.tagName
                .toLowerCase();

        if (
            [
                'hr',
                'img',
                'br',
                'input',
                'textarea',
                'select',
                'button',
                'a'
            ].includes(tag)
        ) {
            return false;
        }

        return (
            !textOf(element) &&
            element.children.length === 0
        );
    }

function removeEmptyElements(chapter) {
    if (!chapter) {
        return false;
    }

    let changed = false;

    const marked =
        safeQueryAll(
            chapter,
            '[data-pmerger-empty="true"]'
        ).reverse();

    for (
        const element
        of marked
    ) {
        if (
            !element.isConnected ||
            element === chapter
        ) {
            continue;
        }

        element.remove();
        changed = true;
    }

    return changed;
}


function cleanupTextNodes(
    chapter
) {
    if (!chapter) {
        return false;
    }

    let changed = false;

    const walker =
        document.createTreeWalker(
            chapter,
            NodeFilter.SHOW_TEXT
        );

    const nodes = [];

    let node;

    while (
        (node =
            walker.nextNode())
    ) {
        nodes.push(
            node
        );
    }

    for (
        const textNode
        of nodes
    ) {
        if (
            !textNode.isConnected
        ) {
            continue;
        }

        /*
         * Preserve formatting-sensitive text.
         */
        const parent =
            textNode.parentElement;

        if (
            parent &&
            parent.closest(
                'pre, code'
            )
        ) {
            continue;
        }

        const cleaned =
            textNode.nodeValue
                .replace(
                    /[ \t\r\n]+/g,
                    ' '
                );

        if (
            cleaned !==
            textNode.nodeValue
        ) {
            textNode.nodeValue =
                cleaned;

            changed = true;
        }
    }

    return changed;
}

    // ============================================================
    // FINAL CHAPTER CLEANUP
    // ============================================================

    function finalizeChapter(
        chapter
    ) {
        if (!chapter) {
            return false;
        }

        let changed = false;

        if (
            cleanupTextNodes(
                chapter
            )
        ) {
            changed = true;
        }

        if (
            removeEmptyElements(
                chapter
            )
        ) {
            changed = true;
        }

        if (
            reindexOrderMetadata(
                chapter
            )
        ) {
            changed = true;
        }

        return changed;
    }
      // ============================================================
    // CHAPTER PROCESSING
    // ============================================================

    function processAllChapters(
        root = document
    ) {
        if (
            !config.globalEnabled ||
            !isChapterPage()
        ) {
            return;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return;
        }

        const chapters =
            findChapterContainers(
                root,
                site.chapterContainer
            );

        for (
            const chapter
            of chapters
        ) {
            if (
                !chapter.isConnected
            ) {
                continue;
            }

            /*
             * Save the original HTML only once.
             *
             * This gives Undo a clean copy of the
             * chapter before pMerger modifies it.
             */
            if (
                !originalChapterHTML.has(
                    chapter
                )
            ) {
                originalChapterHTML.set(
                    chapter,
                    chapter.innerHTML
                );
            }

            const changed =
                processChapter(
                    chapter,
                    site
                );

            /*
             * Final cleanup must happen after
             * merging.
             */
            if (changed) {
                finalizeChapter(
                    chapter
                );

                modifiedContainers.add(
                    chapter
                );
            }
        }
    }


    // ============================================================
    // DELAYED CHAPTER PROCESSING
    // ============================================================

    function scheduleChapterProcessing(
        chapter,
        delay = 150
    ) {
        if (
            !chapter ||
            !chapter.isConnected
        ) {
            return;
        }

        const generation =
            processingGeneration;

        const existingTimer =
            pendingChapterTimers.get(
                chapter
            );

        if (
            existingTimer
        ) {
            clearTimeout(
                existingTimer
            );
        }

        const timer =
            setTimeout(
                () => {
                    pendingChapterTimers.delete(
                        chapter
                    );

                    /*
                     * Undo, navigation, or disabling
                     * pMerger may have invalidated
                     * this timer.
                     */
                    if (
                        generation !==
                        processingGeneration
                    ) {
                        return;
                    }

                    if (
                        !config.globalEnabled ||
                        !isChapterPage()
                    ) {
                        return;
                    }

                    if (
                        !chapter.isConnected
                    ) {
                        return;
                    }

                    processAllChapters(
                        chapter
                    );
                },
                delay
            );

        pendingChapterTimers.set(
            chapter,
            timer
        );
    }


    // ============================================================
    // MUTATION OBSERVER
    // ============================================================

    function handleAddedNode(
        node
    ) {
        if (
            !node ||
            node.nodeType !==
                Node.ELEMENT_NODE
        ) {
            return;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return;
        }

        /*
         * The added node itself may be a chapter.
         */
        const directChapters =
            findChapterContainers(
                node,
                site.chapterContainer
            );

        for (
            const chapter
            of directChapters
        ) {
            scheduleChapterProcessing(
                chapter
            );
        }


        /*
         * Or content may have been inserted
         * inside an existing chapter.
         */
        const chapter =
            closestChapter(
                node,
                site.chapterContainer
            );

        if (chapter) {
            scheduleChapterProcessing(
                chapter
            );
        }
    }


    function handleMutations(
        mutations
    ) {
        if (
            !config.globalEnabled ||
            !isChapterPage()
        ) {
            return;
        }

        for (
            const mutation
            of mutations
        ) {
            if (
                mutation.type !==
                'childList'
            ) {
                continue;
            }

            /*
             * Added content.
             */
            for (
                const node
                of mutation.addedNodes
            ) {
                handleAddedNode(
                    node
                );
            }


            /*
             * Removed content can also indicate
             * that a framework is rebuilding the
             * chapter.
             */
            if (
                mutation.removedNodes.length
            ) {
                const target =
                    mutation.target;

                if (
                    target &&
                    target.nodeType ===
                        Node.ELEMENT_NODE
                ) {
                    const site =
                        getCurrentSite();

                    if (site) {
                        const chapter =
                            closestChapter(
                                target,
                                site.chapterContainer
                            );

                        if (chapter) {
                            scheduleChapterProcessing(
                                chapter
                            );
                        }
                    }
                }
            }
        }
    }


    // ============================================================
    // URL WATCHER
    // ============================================================

    function checkForUrlChange() {
        const currentUrl =
            location.href;

        if (
            currentUrl ===
            lastUrl
        ) {
            return;
        }

        lastUrl =
            currentUrl;

        /*
         * Invalidate any delayed processing from
         * the previous page.
         */
        processingGeneration++;

        if (
            !config.globalEnabled
        ) {
            return;
        }

        /*
         * Give SPA navigation a moment to render
         * the new chapter.
         */
        setTimeout(
            () => {
                if (
                    !config.globalEnabled
                ) {
                    return;
                }

                processAllChapters();
            },
            100
        );
    }


    // ============================================================
    // START CLEANER
    // ============================================================

    function startCleaner() {
        stopCleaner();

        if (
            !config.globalEnabled
        ) {
            return;
        }

        lastUrl =
            location.href;


        /*
         * Process anything already on the page.
         */
        processAllChapters();


        /*
         * Watch dynamically loaded chapter content.
         */
        observer =
            new MutationObserver(
                handleMutations
            );

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );


        /*
         * Detect SPA URL changes.
         */
        urlWatcher =
            setInterval(
                checkForUrlChange,
                500
            );
    }


    // ============================================================
    // STOP CLEANER
    // ============================================================

    function stopCleaner() {
        /*
         * Invalidate delayed callbacks.
         */
        processingGeneration++;


        /*
         * Stop DOM observation.
         */
        if (observer) {
            observer.disconnect();
            observer = null;
        }


        /*
         * Stop URL watching.
         */
        if (urlWatcher) {
            clearInterval(
                urlWatcher
            );

            urlWatcher = null;
        }


        /*
         * Cancel pending chapter timers.
         *
         * WeakMap cannot be iterated, so the generation
         * counter above is what invalidates timers that
         * are already waiting to run.
         */
    }
      // ============================================================
    // APPLY CURRENT PAGE
    // ============================================================

    function applyCurrentPage() {
        if (
            !isChapterPage(false)
        ) {
            return;
        }

        const site =
            getCurrentSite();

        if (!site) {
            return;
        }

        /*
         * Manual Apply is allowed even when the
         * global switch is OFF.
         */
        const chapters =
            findChapterContainers(
                document,
                site.chapterContainer
            );

        for (
            const chapter
            of chapters
        ) {
            if (
                !chapter.isConnected
            ) {
                continue;
            }

            if (
                !originalChapterHTML.has(
                    chapter
                )
            ) {
                originalChapterHTML.set(
                    chapter,
                    chapter.innerHTML
                );
            }

            const changed =
                processChapter(
                    chapter,
                    site
                );

            if (changed) {
                finalizeChapter(
                    chapter
                );

                modifiedContainers.add(
                    chapter
                );
            }
        }
    }


    // ============================================================
    // UNDO CURRENT PAGE
    // ============================================================

    function undoCurrentPage() {
        /*
         * Stop observers first.
         *
         * Otherwise restoring the original HTML would
         * itself trigger the MutationObserver.
         */
        const wasEnabled =
            config.globalEnabled;

        stopCleaner();

        const chapters =
            Array.from(
                modifiedContainers
            );

        for (
            const chapter
            of chapters
        ) {
            if (
                !chapter ||
                !chapter.isConnected
            ) {
                continue;
            }

            const originalHTML =
                originalChapterHTML.get(
                    chapter
                );

            if (
                typeof originalHTML !==
                'string'
            ) {
                continue;
            }

            chapter.innerHTML =
                originalHTML;
        }

        modifiedContainers.clear();


        /*
         * The old snapshots are no longer valid.
         *
         * A fresh Apply should create a fresh snapshot.
         */
        for (
            const chapter
            of chapters
        ) {
            originalChapterHTML.delete(
                chapter
            );
        }


        /*
         * Resume automatic processing if it
         * was enabled before Undo.
         */
        if (wasEnabled) {
            startCleaner();
        }
    }


    // ============================================================
    // SETTINGS
    // ============================================================

    function openSettings() {
        const site =
            getCurrentSite();

        if (!site) {
            alert(
                '[pMerger] No site configuration exists for this domain.'
            );

            return;
        }

        const currentPatterns =
            Array.isArray(
                site.chapterUrlPatterns
            )
                ? site.chapterUrlPatterns.join(
                    '\n'
                )
                : '';

        const chapterPatterns =
            prompt(
                'Chapter URL patterns, one per line:',
                currentPatterns
            );

        if (
            chapterPatterns === null
        ) {
            return;
        }

        const chapterContainer =
            prompt(
                'Chapter container CSS selector:',
                site.chapterContainer || ''
            );

        if (
            chapterContainer === null
        ) {
            return;
        }

        const junkSelector =
            prompt(
                'Optional junk CSS selector:',
                site.junkSelector || ''
            );

        if (
            junkSelector === null
        ) {
            return;
        }

        const patterns =
            chapterPatterns
                .split('\n')
                .map(
                    value =>
                        value.trim()
                )
                .filter(
                    Boolean
                );

        if (
            patterns.length === 0
        ) {
            alert(
                '[pMerger] At least one chapter URL pattern is required.'
            );

            return;
        }

        if (
            !chapterContainer.trim()
        ) {
            alert(
                '[pMerger] A chapter container selector is required.'
            );

            return;
        }


        /*
         * Save only the settings that belong
         * to this site.
         */
        site.chapterUrlPatterns =
            patterns;

        site.chapterContainer =
            chapterContainer.trim();

        site.junkSelector =
            junkSelector.trim();

        site.enabled = true;

        config.sites[
            getDomain()
        ] = site;

        processingGeneration++;

        saveConfig();

        /*
         * Re-register the menu so the current
         * configuration is immediately reflected.
         */
        registerMenuCommands();


        /*
         * Re-process the current page if the
         * global switch is enabled.
         */
        if (
            config.globalEnabled
        ) {
            startCleaner();
        }
    }
  // ============================================================
// STARTUP
// ============================================================

function initialize() {
    loadConfig();

    loadDefaultSites();

    registerMenuCommands();

    if (
        config.globalEnabled
    ) {
        startCleaner();
    }
}


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
