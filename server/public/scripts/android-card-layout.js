/* Layout compatibility for embedded character interfaces in the Android host. */
const HOST_STYLE_ID = 'st-android-card-layout';
const FRAME_SELECTOR = 'iframe[id^="TH-message--"]';

const hostStyles = `
@media (max-width: 1000px) {
    #chat .mes:has(${FRAME_SELECTOR}) { padding-inline: 8px; }
    #chat .mes:has(${FRAME_SELECTOR}) .mesAvatarWrapper { display: none; }
    #chat .mes:has(${FRAME_SELECTOR}) .mes_block {
        width: 100%; min-width: 0; margin-inline: 0; padding-inline: 0;
    }
    #chat .mes:has(${FRAME_SELECTOR}) .mes_text { min-width: 0; padding-inline: 0; }
    #chat ${FRAME_SELECTOR} { display: block; width: 100%; max-width: 100%; }
}
`;

// Match the mode selector's structure so unrelated embedded pages keep their styles.
const frameStyles = `
@media (max-width: 699px) {
    body:has(#mode-selection .mode-card[data-mode]) .content-wrapper { padding-inline: 12px; }
    #mode-selection:has(.mode-card[data-mode]) .mode-heading .gtitle {
        font-size: clamp(22px, 7vw, 30px); line-height: 1.5; overflow-wrap: anywhere;
    }
    #mode-selection .mode-selection-container:has(> .mode-card[data-mode]) {
        gap: 16px; align-items: stretch;
    }
    #mode-selection .mode-card[data-mode] {
        width: 100%; max-width: 420px; height: auto; min-height: 176px;
        margin-inline: auto; touch-action: manipulation;
    }
    #mode-selection .mode-card[data-mode] > .inner {
        display: grid; grid-template-columns: minmax(64px, 84px) minmax(0, 1fr);
        grid-template-rows: auto auto; gap: 8px 14px; align-content: center;
        min-height: 176px; height: auto; padding: 18px; text-align: left;
    }
    #mode-selection .mode-card[data-mode] > .inner > .num {
        grid-column: 1; grid-row: 1; justify-self: center; font-size: 14px;
    }
    #mode-selection .mode-card[data-mode] > .inner > .art {
        grid-column: 1; grid-row: 2; justify-self: center; width: 80px; height: 80px;
    }
    #mode-selection .mode-card[data-mode] > .inner > :last-child:not(.art):not(.num) {
        grid-column: 2; grid-row: 1 / span 2; min-width: 0;
    }
    #mode-selection .mode-card[data-mode] .mode-name {
        margin: 0; font-size: 20px; line-height: 1.5; letter-spacing: .1em;
        white-space: normal; overflow-wrap: anywhere;
    }
    #mode-selection .mode-card[data-mode] .mode-description {
        max-width: none; margin-top: 8px; font-size: 13px; line-height: 1.75;
        white-space: normal; overflow-wrap: anywhere;
    }
    #mode-selection:has(.mode-card[data-mode]) .button-container {
        width: 100%; max-width: 420px;
    }
}
@media (hover: none) and (max-width: 699px) {
    #mode-selection .mode-card[data-mode]:hover { transform: none; }
}
@media (max-width: 1024px) {
    :is(#left-drawer, #right-drawer).drawer-panel .drawer-close {
        min-width: 44px; min-height: 44px; flex-shrink: 0; touch-action: manipulation;
    }
}
`;

// These card drawers can open through inline handlers even when their separate
// close-event manager never starts. Closing is idempotent alongside that manager.
function installDrawerDismiss(embedded) {
    const selector = ':is(#left-drawer, #right-drawer).drawer-panel';
    const close = panels => {
        if (!panels.length) return;
        panels.forEach(panel => panel.classList.remove('open'));
        if (!embedded.querySelector(`${selector}.open`)) {
            embedded.querySelector('.drawer-overlay')?.classList.remove('active');
        }
    };
    embedded.addEventListener('click', event => {
        const target = event.target;
        if (target?.nodeType !== 1) return;
        const button = target.closest('.drawer-close');
        const panel = button?.closest(selector);
        if (panel) {
            event.preventDefault();
            close([panel]);
        } else if (target.matches('.drawer-overlay')) {
            close(embedded.querySelectorAll(selector));
        }
    }, true);
    embedded.addEventListener('keydown', event => {
        if (event.key === 'Escape') close(embedded.querySelectorAll(selector));
    });
}

/** Install once per host page; iframe navigation receives a fresh compatibility style. */
export function installAndroidCardLayout(document = window.document) {
    if (document.getElementById(HOST_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HOST_STYLE_ID;
    style.textContent = hostStyles;
    document.head.append(style);

    const attached = new WeakSet();
    function adapt(frame) {
        try {
            const embedded = frame.contentDocument;
            if (!embedded?.head || embedded.getElementById(HOST_STYLE_ID)) return;
            const style = embedded.createElement('style');
            style.id = HOST_STYLE_ID;
            style.textContent = frameStyles;
            embedded.head.append(style);
            installDrawerDismiss(embedded);
        } catch {
            // Cross-origin frames are intentionally inaccessible to the host.
        }
    }
    function attach(frame) {
        if (!attached.has(frame)) {
            attached.add(frame);
            frame.addEventListener('load', () => adapt(frame));
        }
        adapt(frame);
    }
    document.querySelectorAll(FRAME_SELECTOR).forEach(attach);
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches(FRAME_SELECTOR)) attach(node);
                node.querySelectorAll(FRAME_SELECTOR).forEach(attach);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}
