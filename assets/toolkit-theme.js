/* Light and dark themes for every toolkit page.

   The pages are designed dark, with their colours written straight into their
   stylesheets. Rather than keep a second hand-written palette for each of them,
   light mode is derived from the page's own stylesheets: every colour a rule
   declares is mirrored, in the same order, into one extra sheet placed after
   all of them, with its lightness turned over in OKLab (dark surfaces become
   light ones, light text becomes dark) and bright accents darkened enough to
   read on white. Hue is kept, so a green button stays green.

   What is never touched: images, canvases and video (the data), and colours set
   on an element's own style attribute -- that is where channel swatches, LUT
   colours and source stripes live, and they must stay true.

   The choice is one localStorage key shared by every page of the site, so it
   follows you between tools and changes open tabs as soon as it is made. */
(function () {
    'use strict';
    const KEY = 'toolkit.theme';
    const SHEET_ID = 'toolkit-theme-light';
    const root = document.documentElement;
    const listeners = new Set();

    const read = () => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; } };

    /* ---- colour arithmetic (sRGB <-> OKLab) -------------------------------- */
    const toLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const fromLin = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    function toLab(r, g, b) {
        r = toLin(r); g = toLin(g); b = toLin(b);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    }
    function fromLab(L, A, B) {
        const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
        const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
        const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
        return [fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
    }
    /* Back to sRGB at lightness L and hue h, giving up chroma until it fits. */
    function inGamut(L, C, h) {
        let lo = 0, hi = C, rgb = fromLab(L, C * Math.cos(h), C * Math.sin(h));
        const fits = c => c.every(v => v >= -0.0005 && v <= 1.0005);
        if (fits(rgb))
            return rgb;
        for (let i = 0; i < 18; i++) {
            const mid = (lo + hi) / 2, t = fromLab(L, mid * Math.cos(h), mid * Math.sin(h));
            if (fits(t)) { lo = mid; rgb = t; }
            else
                hi = mid;
        }
        return fromLab(L, lo * Math.cos(h), lo * Math.sin(h));
    }
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    /* The light-theme twin of one colour. `shadow` colours are shadows: a dark
       one stays dark and only softens, since a shadow turned white is a glow. */
    function lightTwin(rgba, shadow) {
        const [r, g, b, a] = rgba;
        if (r === 0 && g === 0 && b === 0)
            return shadow ? [0, 0, 0, a * 0.45] : rgba; // pure black is an image well or a deliberate scrim
        const [L, A, B] = toLab(r, g, b), C = Math.hypot(A, B), h = Math.atan2(B, A);
        if (shadow && L < 0.5 && C < 0.06)
            return [r, g, b, a * 0.45];
        let L2, C2 = C;
        if (C < 0.04) {
            // Greys -- surfaces, borders and text: lightness turned over.
            L2 = clamp(1.12 - L, 0.1, 0.995);
            C2 = L2 > 0.9 ? Math.min(C, 0.02) : C * 0.85;
        }
        else if (L < 0.55) {
            // Dark tinted surfaces become pale tints, a little paler than a
            // straight turn so text in an accent colour still reads on them.
            L2 = clamp(1.1 - 0.75 * L, 0.6, 0.97);
            C2 = C * 0.8;
        }
        else {
            // Bright accents: darkened to read on a light page, hue kept.
            L2 = Math.min(L, 0.38 + 0.12 * (L - 0.55) / 0.45);
        }
        const [r2, g2, b2] = inGamut(L2, C2, h);
        return [clamp(r2, 0, 1), clamp(g2, 0, 1), clamp(b2, 0, 1), a];
    }

    /* ---- colours inside CSS values ------------------------------------------ */
    const NAMED = { white: [1, 1, 1], black: [0, 0, 0], silver: [.753, .753, .753], gray: [.502, .502, .502], grey: [.502, .502, .502],
        red: [1, 0, 0], green: [0, .502, 0], blue: [0, 0, 1], yellow: [1, 1, 0], orange: [1, .647, 0], purple: [.502, 0, .502],
        magenta: [1, 0, 1], fuchsia: [1, 0, 1], cyan: [0, 1, 1], aqua: [0, 1, 1], lime: [0, 1, 0], navy: [0, 0, .502],
        teal: [0, .502, .502], maroon: [.502, 0, 0], olive: [.502, .502, 0], gold: [1, .843, 0], pink: [1, .753, .796] };
    const TOKEN = new RegExp('#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])|rgba?\\([^()]*\\)|(?<![\\w-])(?:' + Object.keys(NAMED).join('|') + ')(?![\\w-])', 'gi');
    function parseColour(t) {
        if (t[0] === '#') {
            let h = t.slice(1);
            if (h.length === 3 || h.length === 4)
                h = h.split('').map(c => c + c).join('');
            if (h.length !== 6 && h.length !== 8)
                return null;
            const n = i => parseInt(h.slice(i, i + 2), 16) / 255;
            return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
        }
        const named = NAMED[t.toLowerCase()];
        if (named)
            return [...named, 1];
        const parts = t.slice(t.indexOf('(') + 1, -1).trim().split(/[\s,/]+/).filter(Boolean);
        if (parts.length < 3 || parts.some(p => !/^-?[\d.]+%?$/.test(p)))
            return null;
        const ch = p => clamp(p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255, 0, 1);
        const al = p => p === undefined ? 1 : clamp(p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p), 0, 1);
        return [ch(parts[0]), ch(parts[1]), ch(parts[2]), al(parts[3])];
    }
    const fmt = ([r, g, b, a]) => {
        const c = v => Math.round(v * 255);
        return a >= 0.999 ? `rgb(${c(r)}, ${c(g)}, ${c(b)})` : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${+a.toFixed(3)})`;
    };
    const valueCache = new Map();
    function mapValue(v, shadow) {
        const key = (shadow ? 's' : 'c') + v;
        let out = valueCache.get(key);
        if (out === undefined) {
            out = v.replace(TOKEN, t => { const c = parseColour(t); return c ? fmt(lightTwin(c, shadow)) : t; });
            valueCache.set(key, out);
        }
        return out;
    }

    /* ---- mirroring the stylesheets ------------------------------------------ */
    const COLOUR_PROPS = new Set(['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color',
        'border-bottom-color', 'border-left-color', 'border-block-start-color', 'border-block-end-color',
        'border-inline-start-color', 'border-inline-end-color', 'outline-color', 'column-rule-color', 'caret-color',
        'accent-color', 'text-decoration-color', 'text-emphasis-color', 'fill', 'stroke', 'stop-color', 'flood-color',
        'lighting-color', 'scrollbar-color', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-tap-highlight-color',
        'box-shadow', 'text-shadow', 'color-scheme']);
    /* A shorthand written with var() has no longhand values to read, so it is
       mirrored whole. */
    const SHORTHANDS = ['background', 'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
        'border-block', 'border-inline', 'outline', 'text-decoration', 'column-rule'];
    /* A relative url() in a stylesheet is read against that sheet; once copied
       into this page's own style block it would be read against the page (the
       stars of assets/site-theme.css asked for /icons/stars.svg), so it is
       written out in full. */
    let sheetBase = document.baseURI;
    const absoluteUrls = v => v.includes('url(') ? v.replace(/url\((['"]?)(?!data:|https?:|blob:|#)([^'")]+)\1\)/g, (m, q, u) => { try { return `url("${new URL(u, sheetBase).href}")`; } catch (_) { return m; } }) : v;
    function declarations(style) {
        let out = '';
        for (let i = 0; i < style.length; i++) {
            const name = style[i];
            if (!name.startsWith('--') && !COLOUR_PROPS.has(name))
                continue;
            const v = style.getPropertyValue(name);
            if (!v)
                continue;
            const mapped = name === 'color-scheme' ? (/\bnormal\b/.test(v) ? v : 'light') : absoluteUrls(mapValue(v, name === 'box-shadow' || name === 'text-shadow'));
            out += `${name}:${mapped}${style.getPropertyPriority(name) ? '!important' : ''};`;
        }
        for (const sh of SHORTHANDS) {
            const v = style.getPropertyValue(sh);
            if (v && v.includes('var('))
                out += `${sh}:${absoluteUrls(mapValue(v, false))}${style.getPropertyPriority(sh) ? '!important' : ''};`;
        }
        return out;
    }
    function mirror(rules) {
        let out = '';
        for (const r of rules) {
            if (r.type === 1) { // style rule
                const d = declarations(r.style), nested = r.cssRules && r.cssRules.length ? mirror(r.cssRules) : '';
                if (d || nested)
                    out += `${r.selectorText}{${d}${nested}}`;
            }
            else if (r.type === 4) { // @media
                const t = mirror(r.cssRules);
                if (t)
                    out += `@media ${r.media.mediaText}{${t}}`;
            }
            else if (r.type === 12) { // @supports
                const t = mirror(r.cssRules);
                if (t)
                    out += `@supports ${r.conditionText}{${t}}`;
            }
            else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) {
                const t = mirror(r.cssRules);
                if (t)
                    out += `@layer ${r.name}{${t}}`;
            }
        }
        return out;
    }

    /* Things the mirroring cannot know: colours an element carries inline that
       were made to read on dark. A channel's name is printed in a lightened
       "ink" of its colour; on a light page it is darkened from the colour
       itself, and a white channel's dot needs an edge to be seen at all. */
    const EXTRAS = '.tk-merge-part{color:color-mix(in oklab,var(--tk-part-color,#5b6570) 52%,#000);text-shadow:none}'
        + '.tk-merge-dot{box-shadow:0 0 0 1px rgba(0,0,0,.3)}';

    let sheetEl = null, observer = null, building = false;
    const isOurs = n => n && n.id === SHEET_ID;
    function build() {
        if (building)
            return;
        building = true;
        try {
            let css = ':root{color-scheme:light}';
            for (const sheet of document.styleSheets) {
                if (isOurs(sheet.ownerNode))
                    continue;
                let rules;
                try { rules = sheet.cssRules; } catch (_) { continue; } // another origin's sheet (fonts)
                if (!rules)
                    continue;
                sheetBase = sheet.href || document.baseURI;
                const body = mirror(rules), media = sheet.media && sheet.media.mediaText;
                css += media && media !== 'all' ? `@media ${media}{${body}}` : body;
            }
            css += EXTRAS;
            if (!sheetEl) {
                sheetEl = document.createElement('style');
                sheetEl.id = SHEET_ID;
            }
            if (sheetEl.textContent !== css)
                sheetEl.textContent = css;
            // It has to come after every sheet it mirrors to win at equal specificity.
            let last = null;
            for (const sheet of document.styleSheets)
                if (sheet.ownerNode && !isOurs(sheet.ownerNode))
                    last = sheet.ownerNode;
            if (!sheetEl.isConnected || (last && !(last.compareDocumentPosition(sheetEl) & Node.DOCUMENT_POSITION_FOLLOWING)))
                (last ? last.after(sheetEl) : (document.head || root).appendChild(sheetEl));
        }
        finally {
            building = false;
        }
    }
    function watch() {
        if (observer)
            return;
        const relevant = n => n.nodeType === 1 && !isOurs(n) && (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /stylesheet/i.test(n.rel)));
        observer = new MutationObserver(list => {
            let again = false;
            for (const m of list) {
                if (relevant(m.target) || (m.target.parentNode && relevant(m.target.parentNode)))
                    again = true;
                for (const n of m.addedNodes) {
                    if (relevant(n))
                        again = true;
                    if (n.tagName === 'LINK')
                        n.addEventListener('load', () => current === 'light' && build(), { once: true });
                }
                for (const n of m.removedNodes)
                    if (relevant(n))
                        again = true;
            }
            if (again && current === 'light')
                build();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    let current = null;
    /* A page that is a night scene by design (the Arsenal) says so with
       <html data-theme-fixed="dark"> and stays dark whatever the choice. */
    const fixed = root.getAttribute?.('data-theme-fixed');
    function apply(theme) {
        theme = fixed === 'dark' || fixed === 'light' ? fixed : theme === 'light' ? 'light' : 'dark';
        root.dataset.theme = theme;
        if (theme === 'light') {
            build();
            sheetEl.media = 'all';
            watch();
        }
        else if (sheetEl)
            sheetEl.media = 'not all';
        if (theme === current)
            return;
        const was = current;
        current = theme;
        if (was !== null) {
            listeners.forEach(fn => { try { fn(theme); } catch (_) { } });
            window.dispatchEvent(new CustomEvent('toolkit-theme', { detail: { theme } }));
        }
    }

    apply(read());
    // Sheets further down the page, and links still loading, join when they arrive.
    document.addEventListener('DOMContentLoaded', () => { if (current === 'light') build(); });
    window.addEventListener('load', () => { if (current === 'light') build(); });
    window.addEventListener('storage', e => { if (e.key === KEY) apply(read()); });

    window.ToolkitTheme = Object.freeze({
        get: () => current,
        set(theme) {
            try { localStorage.setItem(KEY, theme === 'light' ? 'light' : 'dark'); } catch (_) { }
            apply(theme);
        },
        toggle() { this.set(current === 'light' ? 'dark' : 'light'); },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        // For tests: the light twin of a CSS colour value.
        _lightValue: v => mapValue(String(v), false)
    });
})();
