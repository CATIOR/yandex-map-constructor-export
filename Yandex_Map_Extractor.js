// ==UserScript==
// @name         Yandex Map Constructor — Unlimited Hi-Res Export
// @name:en      Yandex Map Constructor — Unlimited Hi-Res Export
// @name:ru      Конструктор карт Яндекса — Экспорт в высоком разрешении
// @namespace    urn:ymc-hires-export
// @version      1.0.0
// @description  Export maps from Yandex Map Constructor in high-resolution PNG at any zoom (direct tile loading, Satellite/Hybrid support, vector Path2D rendering, auto-fit bounds, Canvas memory protection).
// @description:en Export maps from Yandex Map Constructor in high-resolution PNG at any zoom (direct tile loading, Satellite/Hybrid support, vector Path2D rendering, auto-fit bounds, Canvas memory protection).
// @description:ru Экспорт карт из Конструктора Яндекса в PNG высокого разрешения на любом зуме (прямая загрузка тайлов, поддержка Спутника и Гибрида, векторная отрисовка Path2D, авто-подгонка границ, защита от переполнения памяти Canvas).
// @author       Anonymous
// @license      MIT
// @match        https://yandex.ru/map-constructor*
// @match        https://yandex.com/map-constructor*
// @match        https://yandex.by/map-constructor*
// @match        https://yandex.kz/map-constructor*
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const perf = pageWin.performance || window.performance || performance;
    const DEFAULT_WIDTH = 1920;
    const DEFAULT_HEIGHT = 1080;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let abortExportRequested = false;
    let isExportRunning = false;

    function numOr(val, fallback) {
        const n = typeof val === 'number' ? val : parseFloat(val);
        return Number.isFinite(n) ? n : fallback;
    }

    function isDomOrWindow(obj) {
        if (!obj || typeof obj !== 'object') return false;
        if (obj === window || obj === pageWin || obj === document || obj === pageWin.document) return true;
        if (typeof obj.nodeType === 'number') return true;
        return obj.window === obj;
    }

    function isElementVisible(el, rect) {
        if (!el) return false;
        const r = rect || el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && numOr(st.opacity, 1) > 0;
    }

    function getEffectiveOpacity(el, stopEl) {
        let alpha = 1;
        let cur = el;
        while (cur && cur !== stopEl && cur !== document.body && cur.nodeType === 1) {
            alpha *= numOr(window.getComputedStyle(cur).opacity, 1);
            cur = cur.parentElement;
        }
        return Math.max(0, Math.min(1, alpha));
    }

    function getCumulativeSvgTranslate(el, svgRoot) {
        let tx = 0,
            ty = 0,
            cur = el;
        while (cur && cur !== svgRoot && cur.nodeType === 1) {
            const tr = cur.getAttribute && cur.getAttribute('transform');
            if (tr) {
                const regex = /(translate|matrix)\(\s*([^)]+)\)/gi;
                let m;
                while ((m = regex.exec(tr)) !== null) {
                    const kind = m[1].toLowerCase();
                    const nums = (m[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) || []).map(Number);
                    if (kind === 'translate' && nums.length >= 1) {
                        tx += numOr(nums[0], 0);
                        ty += numOr(nums[1], 0);
                    } else if (kind === 'matrix' && nums.length >= 6) {
                        tx += numOr(nums[4], 0);
                        ty += numOr(nums[5], 0);
                    }
                }
            }
            cur = cur.parentElement;
        }
        return { tx, ty };
    }

    function getExplicitPathFill(pathEl, pStyle) {
        const attrFill = pathEl.getAttribute('fill');
        const inlineFill = pathEl.style && pathEl.style.fill;
        const rawFill = attrFill !== null ? attrFill.trim() : inlineFill ? inlineFill.trim() : '';
        if (rawFill === 'none' || rawFill === 'transparent' || rawFill === 'rgba(0, 0, 0, 0)') return null;

        const fillOpacity = numOr(
            pathEl.getAttribute('fill-opacity') !== null ? pathEl.getAttribute('fill-opacity') : pStyle.fillOpacity,
            1
        );
        if (fillOpacity <= 0) return null;

        if (!rawFill) {
            const compFill = (pStyle.fill || '').trim();
            if (
                !compFill ||
                compFill === 'none' ||
                compFill === 'transparent' ||
                compFill === 'rgb(0, 0, 0)' ||
                compFill === '#000000'
            ) {
                return null;
            }
            return { color: compFill, opacity: fillOpacity };
        }
        return { color: rawFill, opacity: fillOpacity };
    }

    const measureCtx = document.createElement('canvas').getContext('2d');
    function measureCaptionWidth(text) {
        if (!text || !String(text).trim()) return 0;
        measureCtx.font = '13px Arial, sans-serif';
        return Math.min(188, Math.ceil(measureCtx.measureText(String(text).trim()).width));
    }

    function resolveObjScale(w, h) {
        const el = document.getElementById('ymc-unl-objscale');
        const raw = el ? el.value : 'auto';
        if (raw === 'auto') {
            const maxDim = Math.max(w || DEFAULT_WIDTH, h || DEFAULT_HEIGHT);
            return maxDim > 3300 ? Math.min(4.0, Math.max(1.0, Math.round((maxDim / 3000) * 10) / 10)) : 1.0;
        }
        return Math.max(0.5, numOr(raw, 1.0));
    }

    // --- Перехват и сохранение живых шаблонов URL тайлов (с актуальным параметром v=...) ---
    const savedTileTemplates = { map: null, sat: null, skl: null, version: null };

    function inspectTileResourceUrl(url) {
        if (!url || typeof url !== 'string') return;
        if (!/\/tiles\?/i.test(url) || !/[?&]x=-?\d+/i.test(url) || !/[?&]y=-?\d+/i.test(url)) return;
        const vMatch = url.match(/[?&]v=([^&]+)/i);
        if (vMatch && vMatch[1]) savedTileTemplates.version = decodeURIComponent(vMatch[1]);

        if (/[?&]l=sat/i.test(url)) {
            savedTileTemplates.sat = url;
        } else if (/[?&]l=skl/i.test(url)) {
            savedTileTemplates.skl = url;
        } else if (/[?&]l=map/i.test(url)) {
            savedTileTemplates.map = url;
        }
    }

    function harvestTileTemplates() {
        try {
            if (perf && typeof perf.getEntriesByType === 'function') {
                const entries = perf.getEntriesByType('resource');
                for (let i = entries.length - 1; i >= 0; i--) {
                    inspectTileResourceUrl(entries[i].name);
                }
            }
            document.querySelectorAll('[class*="-ground-pane"] img').forEach((img) => {
                if (img && img.src) inspectTileResourceUrl(img.src);
            });
        } catch (e) {}
    }

    try {
        const PerfObs = pageWin.PerformanceObserver || window.PerformanceObserver;
        if (typeof PerfObs === 'function') {
            const obs = new PerfObs((list) => {
                for (const entry of list.getEntries()) {
                    inspectTileResourceUrl(entry.name);
                }
            });
            try {
                obs.observe({ type: 'resource', buffered: true });
            } catch (e1) {
                obs.observe({ entryTypes: ['resource'] });
            }
        }
    } catch (e) {}

    function buildYandexTileUrl(tx, ty, z, tileScale, layerKind = 'map', useFallback = false) {
        const s = Math.max(1, Math.min(4, Math.round(tileScale)));
        const hostNum = (Math.abs(tx + ty) % 4) + 1;
        const verParam = savedTileTemplates.version ? `&v=${encodeURIComponent(savedTileTemplates.version)}` : '';

        if (!useFallback) {
            const tpl =
                layerKind === 'sat'
                    ? savedTileTemplates.sat
                    : layerKind === 'skl'
                    ? savedTileTemplates.skl
                    : savedTileTemplates.map;

            if (tpl) {
                try {
                    const u = new URL(tpl, location.origin);
                    u.searchParams.set('x', String(tx));
                    u.searchParams.set('y', String(ty));
                    u.searchParams.set('z', String(z));
                    if (layerKind === 'sat') {
                        u.searchParams.set('l', 'sat');
                    } else if (layerKind === 'skl') {
                        u.searchParams.set('l', 'skl');
                        u.searchParams.set('scale', String(s));
                    } else {
                        u.searchParams.set('l', 'map');
                        u.searchParams.set('scale', String(s));
                    }
                    return u.toString();
                } catch (e) {}
            }
        }

        if (layerKind === 'sat') {
            return `https://sat0${hostNum}.maps.yandex.net/tiles?l=sat${verParam}&x=${tx}&y=${ty}&z=${z}&lang=ru_RU`;
        }
        if (layerKind === 'skl') {
            return `https://core-renderer-tiles.maps.yandex.net/tiles?l=skl${verParam}&x=${tx}&y=${ty}&z=${z}&scale=${s}&lang=ru_RU`;
        }
        return `https://core-renderer-tiles.maps.yandex.net/tiles?l=map${verParam}&x=${tx}&y=${ty}&z=${z}&scale=${s}&lang=ru_RU`;
    }

    function injectUnlockStyles() {
        if (document.getElementById('ymc-unl-styles')) return;
        const style = document.createElement('style');
        style.id = 'ymc-unl-styles';
        style.textContent = `
            .sidebar__export-settings-panel-print-error-zoom,
            .sidebar__export-settings-panel-print-error-map,
            .sidebar__export-settings-panel-print-error-browser,
            .sidebar__export-settings-panel-print-error-notice,
            .popup_id_error-popup {
                display: none !important;
                visibility: hidden !important;
            }
        `;
        document.head.appendChild(style);
    }

    const capturedMaps = new Set();
    const boundEventMaps = new WeakSet();
    let hookedNs = false,
        zoomSyncTimer1 = null,
        zoomSyncTimer2 = null;

    function isYMap(obj) {
        return (
            Boolean(obj) &&
            typeof obj === 'object' &&
            !isDomOrWindow(obj) &&
            typeof obj.setCenter === 'function' &&
            typeof obj.getCenter === 'function' &&
            typeof obj.setZoom === 'function' &&
            Boolean(obj.container) &&
            typeof obj.container.fitToViewport === 'function' &&
            typeof obj.container.getElement === 'function'
        );
    }

    function getYmapsNs() {
        if (pageWin.ymaps && pageWin.ymaps.Map) return pageWin.ymaps;
        const nsKey = Object.keys(pageWin).find(
            (k) => /^ns\d+$/.test(k) && pageWin[k] && typeof pageWin[k].Map === 'function'
        );
        return nsKey ? pageWin[nsKey] : null;
    }

    function syncActiveZoomBadge() {
        const badge = document.getElementById('ymc-unl-zoom-val');
        if (!badge) return;
        const previewHolder = document.querySelector('.map-editor__preview-holder');
        const isPreviewVisible =
            Boolean(previewHolder) &&
            window.getComputedStyle(previewHolder).display !== 'none' &&
            previewHolder.offsetWidth > 0;

        let editorMap = null,
            previewMap = null;
        for (const m of capturedMaps) {
            try {
                const el = m.container.getElement();
                if (!el || !document.body.contains(el)) continue;
                if (el.closest('.map-editor__preview-holder')) previewMap = m;
                else if (el.closest('.map-editor__map-holder')) editorMap = m;
            } catch (e) {}
        }
        const activeMap = isPreviewVisible ? previewMap || editorMap : editorMap || previewMap;
        if (!activeMap) return;
        try {
            const z = activeMap.getZoom();
            if (Number.isFinite(z)) badge.textContent = Math.round(z * 10) / 10;
        } catch (e) {}
    }

    function scheduleZoomBadgeSync() {
        clearTimeout(zoomSyncTimer1);
        clearTimeout(zoomSyncTimer2);
        zoomSyncTimer1 = setTimeout(syncActiveZoomBadge, 80);
        zoomSyncTimer2 = setTimeout(syncActiveZoomBadge, 350);
    }

    function registerMapInstance(mapObj) {
        if (!isYMap(mapObj)) return;
        capturedMaps.add(mapObj);
        if (!boundEventMaps.has(mapObj)) {
            boundEventMaps.add(mapObj);
            try {
                if (mapObj.events && typeof mapObj.events.add === 'function') {
                    mapObj.events.add(['boundschange', 'actionend', 'actiontickcomplete'], scheduleZoomBadgeSync);
                }
            } catch (e) {}
        }
    }

    function installYmapsHooks() {
        if (hookedNs) return;
        const ns = getYmapsNs();
        if (!ns || !ns.Map || !ns.Map.prototype) return;
        hookedNs = true;
        ['getCenter', 'setCenter', 'getZoom', 'setZoom', 'getBounds', 'getType'].forEach((method) => {
            const orig = ns.Map.prototype[method];
            if (typeof orig === 'function') {
                ns.Map.prototype[method] = function (...args) {
                    if (isYMap(this)) {
                        registerMapInstance(this);
                        scheduleZoomBadgeSync();
                    }
                    return orig.apply(this, args);
                };
            }
        });
    }

    const SKIP_KEYS = new Set([
        'domElem',
        '_elemCache',
        '__self',
        'events',
        '_events',
        'ownerDocument',
        'parentNode',
        'previousSibling',
        'nextSibling',
        'firstChild',
        'lastChild',
        'children',
        'childNodes'
    ]);

    function findMapInstances() {
        installYmapsHooks();
        harvestTileTemplates();
        for (const m of Array.from(capturedMaps)) {
            try {
                const el = m.container.getElement();
                if (!el || !document.body.contains(el)) capturedMaps.delete(m);
            } catch (e) {
                capturedMaps.delete(m);
            }
        }

        const seen = new WeakSet();
        function scanObj(root, depth = 0) {
            if (!root || typeof root !== 'object' || depth > 9 || seen.has(root) || isDomOrWindow(root)) return;
            seen.add(root);
            if (isYMap(root)) {
                registerMapInstance(root);
                return;
            }
            if (Array.isArray(root) && root.length > 500) return;
            let keys;
            try {
                keys = Object.keys(root);
            } catch (e) {
                return;
            }
            const limit = Math.min(keys.length, 400);
            for (let i = 0; i < limit; i++) {
                const k = keys[i];
                if (SKIP_KEYS.has(k)) continue;
                try {
                    const val = root[k];
                    if (!val || typeof val !== 'object' || isDomOrWindow(val)) continue;
                    if (isYMap(val)) registerMapInstance(val);
                    else scanObj(val, depth + 1);
                } catch (e) {}
            }
        }

        const jq = pageWin.jQuery;
        if (jq) {
            ['map-editor', 'page', 'sidebar'].forEach((blockName) => {
                try {
                    const el = jq(`.${blockName}`);
                    if (el.length && typeof el.bem === 'function') {
                        const inst = el.bem(blockName);
                        if (inst) scanObj(inst, 0);
                    }
                } catch (e) {}
            });
            if (jq.cache && typeof jq.cache === 'object') {
                for (const k of Object.keys(jq.cache)) scanObj(jq.cache[k], 0);
            }
            const expando = jq.expando;
            document
                .querySelectorAll('.map-editor, .page, .map-editor__preview-holder, .map-editor__map-holder')
                .forEach((el) => {
                    if (expando && el[expando]) scanObj(el[expando], 0);
                    for (const k of Object.keys(el)) {
                        if (k.startsWith('jQuery') || k.startsWith('__bem')) scanObj(el[k], 0);
                    }
                });
        }

        const result = { editorMap: null, previewMap: null, all: [] };
        for (const m of capturedMaps) {
            try {
                const containerEl = m.container.getElement();
                if (!containerEl || !document.body.contains(containerEl)) continue;
                result.all.push(m);
                if (containerEl.closest('.map-editor__preview-holder')) result.previewMap = m;
                else if (containerEl.closest('.map-editor__map-holder')) result.editorMap = m;
            } catch (e) {}
        }
        return result;
    }

    function getActiveTarget() {
        const maps = findMapInstances();
        const previewHolder = document.querySelector('.map-editor__preview-holder');
        const mapHolder = document.querySelector('.map-editor__map-holder');
        const isPreviewVisible =
            Boolean(previewHolder) &&
            window.getComputedStyle(previewHolder).display !== 'none' &&
            previewHolder.offsetWidth > 0;

        syncActiveZoomBadge();
        if (isPreviewVisible) {
            return {
                holder: previewHolder,
                mapInstance: maps.previewMap || maps.editorMap,
                allMaps: maps,
                isPreview: true
            };
        }
        return {
            holder: mapHolder,
            mapInstance: maps.editorMap || maps.previewMap,
            allMaps: maps,
            isPreview: false
        };
    }

    function collectAllGeoPoints(target) {
        const points = [];
        const activeMap = target.mapInstance || target.allMaps.previewMap || target.allMaps.editorMap;
        if (!activeMap) return points;

        function getPropString(obj, keys) {
            if (!obj || !obj.properties || typeof obj.properties.get !== 'function') return '';
            for (const key of keys) {
                try {
                    const v = obj.properties.get(key);
                    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
                } catch (e) {}
            }
            return '';
        }

        function walkCollection(col) {
            if (!col || typeof col.each !== 'function') return;
            col.each((obj) => {
                if (obj.geometry && typeof obj.geometry.getType === 'function') {
                    if (/Point/i.test(obj.geometry.getType()) && typeof obj.geometry.getCoordinates === 'function') {
                        const c = obj.geometry.getCoordinates();
                        if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number') {
                            points.push({
                                coord: c,
                                caption: getPropString(obj, ['iconCaption', 'name']),
                                content: getPropString(obj, ['iconContent'])
                            });
                        }
                    }
                }
                if (typeof obj.each === 'function') walkCollection(obj);
            });
        }

        const candidateMaps = [activeMap, target.allMaps.editorMap, target.allMaps.previewMap].filter(Boolean);
        for (const m of new Set(candidateMaps)) {
            try {
                if (m.geoObjects) walkCollection(m.geoObjects);
            } catch (e) {}
        }
        return points;
    }

    // --- 2. Точный расчёт габаритов объектов с учётом масштаба значков и подписей (objScale) ---
    function calculateGeoPixelBounds(target, objScale = 1.0) {
        const activeMap = target.mapInstance || target.allMaps.previewMap || target.allMaps.editorMap;
        if (!activeMap) return null;
        const proj = activeMap.options.get('projection');
        const zoom = activeMap.getZoom();
        if (!proj || !Number.isFinite(zoom)) return null;

        let minGX = Infinity,
            minGY = Infinity,
            maxGX = -Infinity,
            maxGY = -Infinity,
            found = false;

        function expandPoint(coord, padLeft, padRight, padTop, padBottom) {
            if (!Array.isArray(coord) || coord.length < 2 || typeof coord[0] !== 'number') return;
            const gp = proj.toGlobalPixels(coord, zoom);
            if (!gp || !Number.isFinite(gp[0]) || !Number.isFinite(gp[1])) return;
            found = true;
            minGX = Math.min(minGX, gp[0] - padLeft);
            maxGX = Math.max(maxGX, gp[0] + padRight);
            minGY = Math.min(minGY, gp[1] - padTop);
            maxGY = Math.max(maxGY, gp[1] + padBottom);
        }

        function walkCoords(coords, padL, padR, padT, padB) {
            if (!Array.isArray(coords) || !coords.length) return;
            if (typeof coords[0] === 'number') expandPoint(coords, padL, padR, padT, padB);
            else for (const item of coords) walkCoords(item, padL, padR, padT, padB);
        }

        function getPropString(obj, keys) {
            if (!obj || !obj.properties || typeof obj.properties.get !== 'function') return '';
            for (const key of keys) {
                try {
                    const v = obj.properties.get(key);
                    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
                } catch (e) {}
            }
            return '';
        }

        function getOptNumber(obj, key, fallback) {
            if (!obj || !obj.options || typeof obj.options.get !== 'function') return fallback;
            try {
                return numOr(obj.options.get(key), fallback);
            } catch (e) {
                return fallback;
            }
        }

        function walkCollection(col) {
            if (!col || typeof col.each !== 'function') return;
            col.each((obj) => {
                if (obj.geometry) {
                    const type = typeof obj.geometry.getType === 'function' ? obj.geometry.getType() : '';
                    const isPoint = /Point/i.test(type);
                    let padL = 12 * objScale,
                        padR = 12 * objScale,
                        padT = 12 * objScale,
                        padB = 12 * objScale;
                    if (isPoint) {
                        const captionPx = measureCaptionWidth(getPropString(obj, ['iconCaption', 'name']));
                        const contentPx = measureCaptionWidth(getPropString(obj, ['iconContent']));
                        padL = 26 * objScale;
                        padT = 36 * objScale;
                        padB = 26 * objScale;
                        padR =
                            Math.max(
                                26,
                                captionPx > 0 ? captionPx + 36 : 0,
                                contentPx > 0 ? contentPx / 2 + 24 : 0
                            ) * objScale;
                        if (contentPx > 24 && captionPx === 0) {
                            padL = Math.max(padL, (contentPx / 2 + 24) * objScale);
                        }
                    } else {
                        const halfSw = Math.ceil((getOptNumber(obj, 'strokeWidth', 5) * objScale) / 2) + 6;
                        padL = padR = padT = padB = halfSw;
                    }
                    if (typeof obj.geometry.getCoordinates === 'function') {
                        walkCoords(obj.geometry.getCoordinates(), padL, padR, padT, padB);
                    } else if (typeof obj.geometry.getBounds === 'function') {
                        const b = obj.geometry.getBounds();
                        if (b) {
                            walkCoords(b[0], padL, padR, padT, padB);
                            walkCoords(b[1], padL, padR, padT, padB);
                        }
                    }
                }
                if (typeof obj.each === 'function') walkCollection(obj);
            });
        }

        const candidateMaps = [activeMap, target.allMaps.editorMap, target.allMaps.previewMap].filter(Boolean);
        for (const m of new Set(candidateMaps)) {
            try {
                if (m.geoObjects) walkCollection(m.geoObjects);
            } catch (e) {}
        }

        if (!found) return null;
        return {
            minGX,
            minGY,
            maxGX,
            maxGY,
            width: maxGX - minGX,
            height: maxGY - minGY,
            centerGlobal: [(minGX + maxGX) / 2, (minGY + maxGY) / 2],
            proj,
            zoom
        };
    }

    function calculateDOMPixelBounds(holderEl, objScale = 1.0) {
        const holderRect = holderEl.getBoundingClientRect();
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity,
            found = false;

        function includeRect(rect, pad = 0) {
            if (!rect || (rect.width <= 0 && rect.height <= 0)) return;
            found = true;
            minX = Math.min(minX, rect.left - holderRect.left - pad);
            maxX = Math.max(maxX, rect.right - holderRect.left + pad);
            minY = Math.min(minY, rect.top - holderRect.top - pad);
            maxY = Math.max(maxY, rect.bottom - holderRect.top + pad);
        }

        holderEl.querySelectorAll('[class*="-placemark-overlay"]').forEach((pm) => {
            if (window.getComputedStyle(pm).display === 'none') return;
            const pmRect = pm.getBoundingClientRect();
            const x = pmRect.left - holderRect.left,
                y = pmRect.top - holderRect.top;
            if (Number.isFinite(x) && Number.isFinite(y)) {
                found = true;
                minX = Math.min(minX, x - 24 * objScale);
                maxX = Math.max(maxX, x + 24 * objScale);
                minY = Math.min(minY, y - 24 * objScale);
                maxY = Math.max(maxY, y + 24 * objScale);
            }
            pm.querySelectorAll('[class*="-svg-icon"], [class*="-stretchy-icon"], [class*="_icon-caption"]').forEach(
                (sub) => {
                    const r = sub.getBoundingClientRect();
                    if (isElementVisible(sub, r)) {
                        const relL = (r.left - pmRect.left) * objScale;
                        const relR = (r.right - pmRect.left) * objScale;
                        const relT = (r.top - pmRect.top) * objScale;
                        const relB = (r.bottom - pmRect.top) * objScale;
                        found = true;
                        minX = Math.min(minX, x + relL - 6 * objScale);
                        maxX = Math.max(maxX, x + relR + 6 * objScale);
                        minY = Math.min(minY, y + relT - 6 * objScale);
                        maxY = Math.max(maxY, y + relB + 6 * objScale);
                    }
                }
            );
        });

        holderEl.querySelectorAll('[class*="-areas-pane"] svg').forEach((svg) => {
            if (window.getComputedStyle(svg).display === 'none') return;
            const svgRect = svg.getBoundingClientRect();
            const svgLeft = svgRect.left - holderRect.left,
                svgTop = svgRect.top - holderRect.top;
            const hasViewBox = svg.hasAttribute('viewBox');

            svg.querySelectorAll('path, polygon, polyline, circle, rect').forEach((shape) => {
                if (window.getComputedStyle(shape).display === 'none') return;
                const sw =
                    (numOr(shape.getAttribute('stroke-width') || window.getComputedStyle(shape).strokeWidth, 5) *
                        objScale) /
                    2;
                try {
                    const bbox = shape.getBBox();
                    if (bbox && (bbox.width > 0 || bbox.height > 0 || sw > 0)) {
                        let a = 1,
                            b = 0,
                            c = 0,
                            d = 1,
                            e = 0,
                            f = 0;
                        if (!hasViewBox && typeof shape.getCTM === 'function') {
                            const ctm = shape.getCTM();
                            if (ctm) {
                                a = numOr(ctm.a, 1);
                                b = numOr(ctm.b, 0);
                                c = numOr(ctm.c, 0);
                                d = numOr(ctm.d, 1);
                                e = numOr(ctm.e, 0);
                                f = numOr(ctm.f, 0);
                            }
                        } else {
                            const tr = getCumulativeSvgTranslate(shape, svg);
                            e = tr.tx;
                            f = tr.ty;
                        }
                        const corners = [
                            [bbox.x, bbox.y],
                            [bbox.x + bbox.width, bbox.y],
                            [bbox.x, bbox.y + bbox.height],
                            [bbox.x + bbox.width, bbox.y + bbox.height]
                        ];
                        for (const [cx, cy] of corners) {
                            const txX = svgLeft + (a * cx + c * cy + e);
                            const txY = svgTop + (b * cx + d * cy + f);
                            found = true;
                            minX = Math.min(minX, txX - sw - 2);
                            maxX = Math.max(maxX, txX + sw + 2);
                            minY = Math.min(minY, txY - sw - 2);
                            maxY = Math.max(maxY, txY + sw + 2);
                        }
                        return;
                    }
                } catch (err) {}
                const r = shape.getBoundingClientRect();
                if (r.width > 0 || r.height > 0) includeRect(r, sw + 2);
            });
        });

        if (!found) return null;
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }

    function computeOptimalCenterAndSize(target, basePadding = 90) {
        const initialGeo = calculateGeoPixelBounds(target, 1.0);
        if (initialGeo) {
            let estObjScale = resolveObjScale(
                initialGeo.width + basePadding * 2,
                initialGeo.height + basePadding * 2
            );
            let scaledGeo = estObjScale !== 1.0 ? calculateGeoPixelBounds(target, estObjScale) : initialGeo;
            let pad = Math.ceil(basePadding * estObjScale);
            const refinedScale = resolveObjScale(scaledGeo.width + pad * 2, scaledGeo.height + pad * 2);
            if (refinedScale !== estObjScale) {
                estObjScale = refinedScale;
                scaledGeo = calculateGeoPixelBounds(target, estObjScale);
                pad = Math.ceil(basePadding * estObjScale);
            }
            return {
                width: Math.max(200, Math.ceil(scaledGeo.width + pad * 2)),
                height: Math.max(200, Math.ceil(scaledGeo.height + pad * 2)),
                centerCoords: scaledGeo.proj.fromGlobalPixels(scaledGeo.centerGlobal, scaledGeo.zoom),
                zoom: scaledGeo.zoom,
                objScale: estObjScale,
                source: 'geo'
            };
        }

        const initialDom = calculateDOMPixelBounds(target.holder, 1.0);
        if (!initialDom) return null;
        let estObjScale = resolveObjScale(initialDom.width + basePadding * 2, initialDom.height + basePadding * 2);
        let domBounds = estObjScale !== 1.0 ? calculateDOMPixelBounds(target.holder, estObjScale) : initialDom;
        let pad = Math.ceil(basePadding * estObjScale);
        const refinedScale = resolveObjScale(domBounds.width + pad * 2, domBounds.height + pad * 2);
        if (refinedScale !== estObjScale) {
            estObjScale = refinedScale;
            domBounds = calculateDOMPixelBounds(target.holder, estObjScale);
            pad = Math.ceil(basePadding * estObjScale);
        }

        const currentW = target.holder.offsetWidth || 1500,
            currentH = target.holder.offsetHeight || 1500;
        const dx = (domBounds.minX + domBounds.maxX) / 2 - currentW / 2;
        const dy = (domBounds.minY + domBounds.maxY) / 2 - currentH / 2;

        let centerCoords = null,
            zoom = null;
        if (target.mapInstance && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
            try {
                const proj = target.mapInstance.options.get('projection');
                zoom = target.mapInstance.getZoom();
                const centerGlobal = proj.toGlobalPixels(target.mapInstance.getCenter(), zoom);
                centerCoords = proj.fromGlobalPixels([centerGlobal[0] + dx, centerGlobal[1] + dy], zoom);
            } catch (e) {}
        }
        return {
            width: Math.max(200, Math.ceil(domBounds.width + pad * 2)),
            height: Math.max(200, Math.ceil(domBounds.height + pad * 2)),
            centerCoords,
            zoom,
            objScale: estObjScale,
            source: 'dom'
        };
    }

    async function autoFitAllObjects(basePadding = 90) {
        const target = getActiveTarget();
        if (!target.holder) {
            alert('Контейнер карты не найден!');
            return;
        }
        setStatus('Считаем точные габариты всех объектов с учётом масштаба меток...');
        const fit = computeOptimalCenterAndSize(target, basePadding);
        if (!fit) {
            alert('На карте не найдено видимых меток или линий.');
            return;
        }

        document.getElementById('ymc-unl-w').value = fit.width;
        document.getElementById('ymc-unl-h').value = fit.height;

        if (fit.width > 3500 || fit.height > 3500) {
            if (target.mapInstance && fit.centerCoords) {
                try {
                    const targetZoom = fit.zoom !== null ? fit.zoom : target.mapInstance.getZoom();
                    await Promise.race([
                        Promise.resolve(target.mapInstance.setCenter(fit.centerCoords, targetZoom)),
                        sleep(1500)
                    ]);
                } catch (e) {}
            }
            setStatus(
                `✅ Рассчитан большой размер: ${fit.width} × ${fit.height} px (метки: ${fit.objScale}x). Нажмите «Скачать карту в PNG»!`
            );
            return;
        }

        await applyContainerSize(fit.width, fit.height, fit.centerCoords, fit.zoom, false);

        if (fit.source === 'dom') {
            await sleep(300);
            const secondPass = computeOptimalCenterAndSize(getActiveTarget(), basePadding);
            if (secondPass) {
                document.getElementById('ymc-unl-w').value = secondPass.width;
                document.getElementById('ymc-unl-h').value = secondPass.height;
                if (secondPass.width <= 3500 && secondPass.height <= 3500) {
                    await applyContainerSize(
                        secondPass.width,
                        secondPass.height,
                        secondPass.centerCoords,
                        secondPass.zoom,
                        false
                    );
                }
            }
        }
        setStatus(
            `✅ Авто-размер: ${document.getElementById('ymc-unl-w').value} × ${
                document.getElementById('ymc-unl-h').value
            } px (метки: ${fit.objScale}x)`
        );
    }

    function snapshotContainerState(target) {
        if (!target || !target.holder) return null;
        const saved = [];
        function record(el) {
            if (!el || saved.some((s) => s.el === el)) return;
            saved.push({
                el,
                width: el.style.width,
                height: el.style.height,
                left: el.style.left,
                top: el.style.top,
                display: el.style.display
            });
        }
        record(target.holder);
        target.holder
            .querySelectorAll(
                'ymaps[class*="-map "], ymaps[class$="-map"], .map-editor__preview-map, .print-map, [class*="-ground-pane"]'
            )
            .forEach(record);
        if (target.mapInstance) {
            try {
                let cur = target.mapInstance.container.getElement();
                while (cur && cur !== target.holder && target.holder.contains(cur)) {
                    record(cur);
                    cur = cur.parentElement;
                }
            } catch (e) {}
        }
        let origMapType = null;
        if (target.mapInstance && typeof target.mapInstance.getType === 'function') {
            try {
                origMapType = target.mapInstance.getType();
            } catch (e) {}
        }
        return { saved, mapInstance: target.mapInstance, origMapType };
    }

    async function restoreContainerState(snapshot) {
        if (!snapshot) return;
        for (const item of snapshot.saved) {
            item.el.style.width = item.width;
            item.el.style.height = item.height;
            item.el.style.left = item.left;
            item.el.style.top = item.top;
            item.el.style.display = item.display;
        }
        const m = snapshot.mapInstance || getActiveTarget().mapInstance;
        if (m) {
            try {
                m.container.fitToViewport();
                if (snapshot.origMapType && typeof m.setType === 'function' && m.getType() !== snapshot.origMapType) {
                    m.setType(snapshot.origMapType);
                }
            } catch (e) {}
        }
    }

    async function applyContainerSize(w, h, newCenterCoords = null, zoom = null, suspendGroundTiles = false) {
        injectUnlockStyles();
        harvestTileTemplates();
        const target = getActiveTarget();
        if (!target.holder) return;

        // 1. Сначала вызываем setCenter/setZoom при активном слое карты
        if (target.mapInstance && newCenterCoords) {
            try {
                const targetZoom = zoom !== null ? zoom : target.mapInstance.getZoom();
                await Promise.race([
                    Promise.resolve(target.mapInstance.setCenter(newCenterCoords, targetZoom)),
                    sleep(1500)
                ]);
            } catch (e) {}
        }

        // 2. Перед временным отключением тайлового слоя расширяем допустимый диапазон зума до [0..23],
        // чтобы повторный setCenter после fitToViewport не сбрасывал даже экстремальные зумы z=20..21
        if (suspendGroundTiles && (w > 3500 || h > 3500) && target.mapInstance) {
            try {
                if (target.mapInstance.options && typeof target.mapInstance.options.set === 'function') {
                    target.mapInstance.options.set('maxZoom', 23);
                    target.mapInstance.options.set('minZoom', 0);
                }
                const gp = target.holder.querySelector('[class*="-ground-pane"]');
                if (gp) gp.style.display = 'none';
                if (typeof target.mapInstance.setType === 'function') {
                    target.mapInstance.setType(null);
                }
            } catch (e) {}
        }

        const editorHolder = document.querySelector('.map-editor__map-holder');
        const baseW = editorHolder && editorHolder.offsetWidth > 0 ? editorHolder.offsetWidth : window.innerWidth;
        const baseH = editorHolder && editorHolder.offsetHeight > 0 ? editorHolder.offsetHeight : window.innerHeight;

        target.holder.style.width = `${w}px`;
        target.holder.style.height = `${h}px`;
        if (target.isPreview) {
            target.holder.style.left = `${Math.round((baseW - w) / 2)}px`;
            target.holder.style.top = `${Math.round((baseH - h) / 2)}px`;
        }

        if (target.mapInstance) {
            try {
                let cur = target.mapInstance.container.getElement();
                while (cur && cur !== target.holder && target.holder.contains(cur)) {
                    cur.style.width = `${w}px`;
                    cur.style.height = `${h}px`;
                    cur = cur.parentElement;
                }
            } catch (e) {}
        }

        target.holder
            .querySelectorAll('ymaps[class*="-map "], ymaps[class$="-map"], .map-editor__preview-map, .print-map')
            .forEach((el) => {
                el.style.width = `${w}px`;
                el.style.height = `${h}px`;
            });

        if (target.mapInstance) {
            try {
                target.mapInstance.container.fitToViewport();
                if (newCenterCoords) {
                    await Promise.race([
                        Promise.resolve(target.mapInstance.setCenter(newCenterCoords)),
                        sleep(800)
                    ]);
                }
            } catch (e) {}
        }
        scheduleZoomBadgeSync();
        await sleep(400);
    }

    function loadImage(src, useAnonymous = true) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            if (useAnonymous && !src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(e);
            img.src = src;
        });
    }

    let taintTestCanvas = document.createElement('canvas');
    taintTestCanvas.width = 1;
    taintTestCanvas.height = 1;
    function isImageTaintFree(img) {
        try {
            const tCtx = taintTestCanvas.getContext('2d');
            tCtx.clearRect(0, 0, 1, 1);
            tCtx.drawImage(img, 0, 0, 1, 1);
            tCtx.getImageData(0, 0, 1, 1);
            return true;
        } catch (e) {
            // Пересоздаём тестовый 1x1 холст, чтобы сбросить флаг origin-clean
            taintTestCanvas = document.createElement('canvas');
            taintTestCanvas.width = 1;
            taintTestCanvas.height = 1;
            return false;
        }
    }

    async function loadCorsSafeImage(url, allowFallbackFetch = false) {
        try {
            const img = await loadImage(url, true);
            if (isImageTaintFree(img)) return img;
            allowFallbackFetch = true;
        } catch (e) {}

        if (allowFallbackFetch && /^https?:/i.test(url) && typeof fetch === 'function') {
            try {
                const resp = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
                if (resp.ok) {
                    const blobUrl = URL.createObjectURL(await resp.blob());
                    try {
                        const img = await loadImage(blobUrl, false);
                        if (isImageTaintFree(img)) return img;
                    } finally {
                        URL.revokeObjectURL(blobUrl);
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    function extractBgUrl(el) {
        if (!el) return null;
        const bg = window.getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') return null;
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        return match ? match[1] : null;
    }

    function roundRect(ctx, x, y, w, h, r) {
        const radius = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function drawVectorCircleIcon(ctx, cx, cy, size, hexColor, hasInnerWhiteDot, pixelScale) {
        const scaleRatio = size / 40;
        ctx.save();
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
        ctx.shadowBlur = 2.0 * scaleRatio * pixelScale;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0.8 * scaleRatio * pixelScale;
        ctx.beginPath();
        ctx.arc(cx, cy, 18.2 * scaleRatio, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(cx, cy, 15.6 * scaleRatio, 0, Math.PI * 2);
        ctx.fillStyle = '#' + hexColor;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, (hasInnerWhiteDot ? 11.4 : 4.2) * scaleRatio, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
    }

    function resolveHolderGlobalOrigin(target, holderRect, width, height) {
        const activeMap = target.mapInstance || target.allMaps.previewMap || target.allMaps.editorMap;
        if (!activeMap) return null;
        const proj = activeMap.options.get('projection');
        if (!proj) return null;
        let zoom = Math.round(activeMap.getZoom());

        const geoPts = collectAllGeoPoints(target);
        const domPlacemarks = Array.from(target.holder.querySelectorAll('[class*="-placemark-overlay"]')).filter(
            (pm) => window.getComputedStyle(pm).display !== 'none'
        );

        const matchedAnchors = [];
        for (const pm of domPlacemarks) {
            const capEl = pm.querySelector('[class*="_icon-caption"]');
            const capText = capEl ? capEl.textContent.trim() : '';
            if (!capText) continue;
            const matchingGeo = geoPts.filter((g) => g.caption === capText);
            if (matchingGeo.length === 1) {
                const pmRect = pm.getBoundingClientRect();
                matchedAnchors.push({
                    x: pmRect.left - holderRect.left,
                    y: pmRect.top - holderRect.top,
                    coord: matchingGeo[0].coord
                });
            }
        }

        if (matchedAnchors.length >= 2) {
            const a0 = matchedAnchors[0],
                a1 = matchedAnchors[matchedAnchors.length - 1];
            const domDist = Math.hypot(a1.x - a0.x, a1.y - a0.y);
            if (domDist > 20) {
                let bestZ = zoom,
                    bestErr = Infinity;
                for (let z = 1; z <= 21; z++) {
                    const gp0 = proj.toGlobalPixels(a0.coord, z),
                        gp1 = proj.toGlobalPixels(a1.coord, z);
                    const err = Math.abs(Math.hypot(gp1[0] - gp0[0], gp1[1] - gp0[1]) - domDist);
                    if (err < bestErr) {
                        bestErr = err;
                        bestZ = z;
                    }
                }
                zoom = bestZ;
            }
        }

        if (matchedAnchors.length >= 1) {
            let sumOX = 0,
                sumOY = 0;
            for (const anc of matchedAnchors) {
                const gp = proj.toGlobalPixels(anc.coord, zoom);
                sumOX += gp[0] - anc.x;
                sumOY += gp[1] - anc.y;
            }
            return {
                originGX: sumOX / matchedAnchors.length,
                originGY: sumOY / matchedAnchors.length,
                zoom,
                proj,
                activeMap
            };
        }

        try {
            const centerGP = proj.toGlobalPixels(activeMap.getCenter(), zoom);
            const cRect = activeMap.container.getElement().getBoundingClientRect();
            const mapCenterX = cRect.width > 0 ? cRect.left - holderRect.left + cRect.width / 2 : width / 2;
            const mapCenterY = cRect.height > 0 ? cRect.top - holderRect.top + cRect.height / 2 : height / 2;
            return { originGX: centerGP[0] - mapCenterX, originGY: centerGP[1] - mapCenterY, zoom, proj, activeMap };
        } catch (e) {
            return null;
        }
    }

    async function renderMapTilesDirectly(ctx, target, holderRect, width, height, scale, mapTypeStr) {
        harvestTileTemplates();
        const originInfo = resolveHolderGlobalOrigin(target, holderRect, width, height);
        if (!originInfo) return false;

        const { originGX, originGY, zoom } = originInfo;
        const typeStr = String(mapTypeStr || '');
        const isHybrid = /hybrid/i.test(typeStr);
        const isSat = isHybrid || /sat/i.test(typeStr);

        let zoomShift = 0;
        let tileLogicalSize = 256;
        let minTX = Math.floor(originGX / 256);
        let maxTX = Math.floor((originGX + width - 1) / 256);
        let minTY = Math.floor(originGY / 256);
        let maxTY = Math.floor((originGY + height - 1) / 256);
        let totalTiles = (maxTX - minTX + 1) * (maxTY - minTY + 1);

        if (totalTiles > 2000 && zoom > 2) {
            const fastTilesCount = Math.ceil(totalTiles / 4);
            const keepFullZoom = window.confirm(
                `На текущем зуме (z=${zoom}) область ${width}×${height} px содержит ${totalTiles} тайлов.\n\n` +
                    `• Нажмите «ОК», чтобы скачать все ${totalTiles} детальных тайлов z=${zoom} (может занять 20–40 сек).\n` +
                    `• Нажмите «Отмена», чтобы использовать ускоренный режим (z=${
                        zoom - 1
                    }, scale=4 — всего ${fastTilesCount} тайлов, в 4 раза быстрее).`
            );
            if (!keepFullZoom) {
                zoomShift = 1;
                tileLogicalSize = 512;
                minTX = Math.floor(originGX / tileLogicalSize);
                maxTX = Math.floor((originGX + width - 1) / tileLogicalSize);
                minTY = Math.floor(originGY / tileLogicalSize);
                maxTY = Math.floor((originGY + height - 1) / tileLogicalSize);
            }
        }

        const tileZ = zoom - zoomShift;
        const desiredTileScale =
            zoomShift > 0 ? Math.min(4, Math.max(2, Math.ceil(scale * 2))) : scale >= 1.4 ? 2 : 1;
        const seamOverlap = 0.45 / Math.max(0.25, scale);

        const tasks = [];
        for (let ty = minTY; ty <= maxTY; ty++) {
            for (let tx = minTX; tx <= maxTX; tx++) {
                tasks.push({
                    tx,
                    ty,
                    drawX: tx * tileLogicalSize - originGX,
                    drawY: ty * tileLogicalSize - originGY,
                    drawSize: tileLogicalSize + seamOverlap
                });
            }
        }
        if (!tasks.length) return false;

        async function fetchLayerTile(tx, ty, layerKind) {
            const url1 = buildYandexTileUrl(tx, ty, tileZ, desiredTileScale, layerKind, false);
            let img = await loadCorsSafeImage(url1, false);
            if (img) return img;

            const url2 = buildYandexTileUrl(tx, ty, tileZ, 2, layerKind, true);
            if (url2 !== url1) {
                img = await loadCorsSafeImage(url2, false);
                if (img) return img;
            }

            const url3 = buildYandexTileUrl(tx, ty, tileZ, 1, layerKind, true);
            return await loadCorsSafeImage(url3, layerKind === 'sat');
        }

        async function runTilePass(layerKind, passLabel) {
            let loadedCount = 0,
                successCount = 0,
                consecutiveErrors = 0,
                cursor = 0;
            const CONCURRENCY = tasks.length > 1500 ? 14 : 20;
            const maxConsecutiveErrors = layerKind === 'sat' ? 250 : 80;

            async function worker() {
                while (cursor < tasks.length && !abortExportRequested && consecutiveErrors < maxConsecutiveErrors) {
                    const task = tasks[cursor++];
                    const img = await fetchLayerTile(task.tx, task.ty, layerKind);
                    loadedCount++;
                    if (img) {
                        successCount++;
                        consecutiveErrors = 0;
                        ctx.drawImage(img, task.drawX, task.drawY, task.drawSize, task.drawSize);
                    } else {
                        consecutiveErrors++;
                    }
                    if (loadedCount % 15 === 0 || loadedCount === tasks.length) {
                        setStatus(
                            `2/3: Загрузка тайлов (${passLabel}, z=${tileZ}): ${loadedCount} / ${tasks.length} (${Math.round(
                                (loadedCount / tasks.length) * 100
                            )}%)...`
                        );
                    }
                }
            }

            const workers = [];
            for (let i = 0; i < Math.min(CONCURRENCY, tasks.length); i++) workers.push(worker());
            await Promise.all(workers);
            return successCount;
        }

        if (isSat) {
            const satCount = await runTilePass('sat', 'Спутник');
            if (isHybrid && !abortExportRequested) {
                await runTilePass('skl', 'Гибрид-подписи');
            }
            return satCount > 0;
        } else {
            const mapCount = await runTilePass('map', 'Схема');
            return mapCount > 0;
        }
    }

    async function renderDirectCanvas(target, width, height, scale, objScale, bgMode, origMapType) {
        const holder = target.holder;
        const outCanvas = document.createElement('canvas');
        outCanvas.width = Math.round(width * scale);
        outCanvas.height = Math.round(height * scale);
        const ctx = outCanvas.getContext('2d');
        if (!ctx) throw new Error('Браузер не выделил 2D-контекст для данного разрешения');

        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        ctx.scale(scale, scale);

        if (bgMode !== 'transparent') {
            ctx.fillStyle = '#f5f3f0';
            ctx.fillRect(0, 0, width, height);
        }

        const holderRect = holder.getBoundingClientRect();
        const imageCache = new Map();
        async function getCachedImage(url) {
            if (!url) return null;
            if (imageCache.has(url)) return imageCache.get(url);
            const img = await loadCorsSafeImage(url, true);
            imageCache.set(url, img);
            return img;
        }

        // ШАГ 1: Отрисовка тайлов карты
        if (bgMode === 'map') {
            const tilesRendered = await renderMapTilesDirectly(
                ctx,
                target,
                holderRect,
                width,
                height,
                scale,
                origMapType
            );
            if (!tilesRendered && !abortExportRequested) {
                const groundPane = holder.querySelector('[class*="-ground-pane"]');
                if (groundPane) {
                    groundPane.querySelectorAll('canvas').forEach((c) => {
                        const rect = c.getBoundingClientRect();
                        if (!isElementVisible(c, rect) || c.width === 0 || c.height === 0) return;
                        ctx.save();
                        ctx.globalAlpha = getEffectiveOpacity(c, holder);
                        ctx.drawImage(c, rect.left - holderRect.left, rect.top - holderRect.top, rect.width, rect.height);
                        ctx.restore();
                    });
                }
            }
        }

        if (abortExportRequested) throw new Error('Экспорт остановлен пользователем');

        // ШАГ 2: Нативная векторная отрисовка всех линий (<path> через Path2D) + фоллбэк XMLSerializer для прочих SVG-фигур
        setStatus('3/3: Отрисовка векторных линий и меток...');
        const svgs = Array.from(holder.querySelectorAll('[class*="-areas-pane"] svg'));
        svgs.sort(
            (a, b) =>
                numOr(window.getComputedStyle(a).zIndex || a.style.zIndex, 0) -
                numOr(window.getComputedStyle(b).zIndex || b.style.zIndex, 0)
        );

        for (const svg of svgs) {
            const rect = svg.getBoundingClientRect();
            if (window.getComputedStyle(svg).display === 'none') continue;
            const svgLeft = rect.left - holderRect.left,
                svgTop = rect.top - holderRect.top;
            const paths = Array.from(svg.querySelectorAll('path'));
            const otherShapes = svg.querySelectorAll('polygon, polyline, circle, rect');

            if (paths.length > 0 && typeof Path2D === 'function') {
                for (const pathEl of paths) {
                    const d = pathEl.getAttribute('d');
                    if (!d) continue;
                    const pStyle = window.getComputedStyle(pathEl);
                    if (pStyle.display === 'none' || pStyle.visibility === 'hidden') continue;
                    const alpha = getEffectiveOpacity(pathEl, holder);
                    const p2d = new Path2D(d);

                    ctx.save();
                    ctx.globalAlpha = alpha;
                    ctx.translate(svgLeft, svgTop);

                    let appliedCtm = false;
                    let ctmScale = 1;
                    if (!svg.hasAttribute('viewBox') && typeof pathEl.getCTM === 'function') {
                        try {
                            const ctm = pathEl.getCTM();
                            if (ctm) {
                                ctx.transform(ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f);
                                ctmScale = Math.hypot(ctm.a, ctm.b) || 1;
                                appliedCtm = true;
                            }
                        } catch (e) {}
                    }
                    if (!appliedCtm) {
                        const { tx, ty } = getCumulativeSvgTranslate(pathEl, svg);
                        ctx.translate(tx, ty);
                    }

                    const fillInfo = getExplicitPathFill(pathEl, pStyle);
                    if (fillInfo) {
                        ctx.save();
                        ctx.fillStyle = fillInfo.color;
                        ctx.globalAlpha = alpha * fillInfo.opacity;
                        ctx.fill(p2d, pathEl.getAttribute('fill-rule') || pStyle.fillRule || 'nonzero');
                        ctx.restore();
                    }

                    const stroke = pathEl.getAttribute('stroke') || pStyle.stroke;
                    const strokeW = numOr(pathEl.getAttribute('stroke-width') || pStyle.strokeWidth, 0);
                    if (stroke && stroke !== 'none' && stroke !== 'transparent' && strokeW > 0) {
                        const strokeOpacity = numOr(
                            pathEl.getAttribute('stroke-opacity') !== null
                                ? pathEl.getAttribute('stroke-opacity')
                                : pStyle.strokeOpacity,
                            1
                        );
                        if (strokeOpacity > 0) {
                            ctx.save();
                            ctx.globalAlpha = alpha * strokeOpacity;
                            ctx.strokeStyle = stroke;
                            ctx.lineWidth = (strokeW * objScale) / ctmScale;
                            ctx.lineCap = pathEl.getAttribute('stroke-linecap') || pStyle.strokeLinecap || 'round';
                            ctx.lineJoin = pathEl.getAttribute('stroke-linejoin') || pStyle.strokeLinejoin || 'round';
                            const dash = pathEl.getAttribute('stroke-dasharray') || pStyle.strokeDasharray;
                            if (dash && dash !== 'none') {
                                const dashArr = dash
                                    .split(/[\s,]+/)
                                    .map((v) => (parseFloat(v) * objScale) / ctmScale)
                                    .filter(Number.isFinite);
                                if (dashArr.length) ctx.setLineDash(dashArr);
                            }
                            ctx.stroke(p2d);
                            ctx.restore();
                        }
                    }
                    ctx.restore();
                }
            }

            if (otherShapes.length > 0 && rect.width > 0 && rect.height > 0) {
                const w = rect.width,
                    h = rect.height;
                const clone = svg.cloneNode(true);
                if (paths.length > 0 && typeof Path2D === 'function') {
                    clone.querySelectorAll('path').forEach((p) => p.remove());
                }
                if (objScale !== 1) {
                    clone.querySelectorAll('polygon, polyline, circle, rect').forEach((sh) => {
                        const sw = numOr(sh.getAttribute('stroke-width'), 0);
                        if (sw > 0) sh.setAttribute('stroke-width', String(sw * objScale));
                    });
                }
                clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                clone.setAttribute('width', String(Math.max(1, Math.round(w * scale))));
                clone.setAttribute('height', String(Math.max(1, Math.round(h * scale))));
                if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);

                const svgXml = new XMLSerializer().serializeToString(clone);
                const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgXml);
                try {
                    const img = await loadImage(svgUrl, false);
                    ctx.save();
                    ctx.globalAlpha = getEffectiveOpacity(svg, holder);
                    ctx.drawImage(img, svgLeft, svgTop, w, h);
                    ctx.restore();
                } catch (e) {}
            }
        }

        // ШАГ 3: Двухпроходная отрисовка меток и подписей с учётом objScale
        const placemarks = Array.from(holder.querySelectorAll('[class*="-placemark-overlay"]')).filter(
            (pm) => window.getComputedStyle(pm).display !== 'none' && window.getComputedStyle(pm).visibility !== 'hidden'
        );
        placemarks.sort((a, b) => {
            const zA = numOr(window.getComputedStyle(a).zIndex || a.style.zIndex, 0);
            const zB = numOr(window.getComputedStyle(b).zIndex || b.style.zIndex, 0);
            return zA !== zB ? zA - zB : a.getBoundingClientRect().top - b.getBoundingClientRect().top;
        });

        // Проход 3А: Все плашки подписей
        for (const pm of placemarks) {
            const captionEl = pm.querySelector('[class*="_icon-caption"]');
            if (!captionEl) continue;
            const text = captionEl.textContent.trim();
            if (!text) continue;
            const capRect = captionEl.getBoundingClientRect();
            if (!isElementVisible(captionEl, capRect)) continue;

            const pmRect = pm.getBoundingClientRect();
            const pmX = pmRect.left - holderRect.left,
                pmY = pmRect.top - holderRect.top;
            const capStyle = window.getComputedStyle(captionEl);
            const padLeft = numOr(capStyle.paddingLeft, 24),
                padRight = numOr(capStyle.paddingRight, 8);
            const parsedMaxW = parseFloat(capStyle.maxWidth);
            const hasMaxW = Number.isFinite(parsedMaxW) && parsedMaxW > 0;
            const maxContentW = hasMaxW ? parsedMaxW : Infinity;
            const boxH = capRect.height > 0 ? capRect.height : 27;

            ctx.save();
            ctx.globalAlpha = getEffectiveOpacity(captionEl, holder);
            ctx.translate(pmX, pmY);
            ctx.scale(objScale, objScale);
            ctx.font =
                capStyle.font ||
                `${capStyle.fontWeight || '400'} ${capStyle.fontSize || '13px'} ${
                    capStyle.fontFamily || 'Arial, sans-serif'
                }`;

            const measuredTextW = ctx.measureText(text).width;
            const boxW = Math.max(capRect.width, Math.min(measuredTextW, maxContentW) + padLeft + padRight);
            const relX = capRect.left - pmRect.left,
                relY = capRect.top - pmRect.top;

            roundRect(ctx, relX, relY, boxW, boxH, numOr(capStyle.borderRadius, 5));
            ctx.fillStyle =
                capStyle.backgroundColor && capStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
                    ? capStyle.backgroundColor
                    : 'rgba(255, 255, 255, 0.85)';
            ctx.fill();
            ctx.clip();
            ctx.fillStyle = capStyle.color || '#000000';
            ctx.textBaseline = 'middle';

            let displayText = text;
            if (hasMaxW && measuredTextW > maxContentW) {
                while (displayText.length > 1 && ctx.measureText(displayText + '…').width > maxContentW) {
                    displayText = displayText.slice(0, -1);
                }
                displayText += '…';
            }
            ctx.fillText(displayText, relX + padLeft, relY + boxH / 2 + 0.5);
            ctx.restore();
        }

        // Проход 3Б: Все иконки меток, пиктограммы и внутренние номера
        for (const pm of placemarks) {
            const pmRect = pm.getBoundingClientRect();
            const pmX = pmRect.left - holderRect.left,
                pmY = pmRect.top - holderRect.top;
            const pmAlpha = getEffectiveOpacity(pm, holder);

            ctx.save();
            ctx.translate(pmX, pmY);
            ctx.scale(objScale, objScale);

            const stretchyEl = pm.querySelector('[class*="-stretchy-icon"]');
            if (stretchyEl) {
                const sRect = stretchyEl.getBoundingClientRect();
                if (isElementVisible(stretchyEl, sRect)) {
                    const sLeft = sRect.left - pmRect.left,
                        sTop = sRect.top - pmRect.top;
                    const sStyle = window.getComputedStyle(stretchyEl);
                    let fillBg = sStyle.backgroundColor,
                        radius = numOr(sStyle.borderRadius, 13);
                    if (!fillBg || fillBg === 'rgba(0, 0, 0, 0)' || fillBg === 'transparent') {
                        const coloredChild = Array.from(stretchyEl.querySelectorAll('*')).find((ch) => {
                            const bg = window.getComputedStyle(ch).backgroundColor;
                            return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
                        });
                        if (coloredChild) {
                            const chSt = window.getComputedStyle(coloredChild);
                            fillBg = chSt.backgroundColor;
                            radius = numOr(chSt.borderRadius, radius);
                        }
                    }
                    ctx.save();
                    ctx.globalAlpha = pmAlpha;
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
                    ctx.shadowBlur = 2.0 * scale * objScale;
                    ctx.shadowOffsetY = 0.8 * scale * objScale;
                    roundRect(ctx, sLeft - 2, sTop - 2, sRect.width + 4, sRect.height + 4, radius + 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.restore();

                    ctx.save();
                    ctx.globalAlpha = pmAlpha;
                    roundRect(ctx, sLeft, sTop, sRect.width, sRect.height, radius);
                    ctx.fillStyle = fillBg && fillBg !== 'rgba(0, 0, 0, 0)' ? fillBg : '#1e98ff';
                    ctx.fill();
                    ctx.restore();
                }
            }

            const iconEl = pm.querySelector('[class*="-svg-icon"]');
            if (iconEl) {
                const iconRect = iconEl.getBoundingClientRect();
                if (isElementVisible(iconEl, iconRect)) {
                    const iLeft = iconRect.left - pmRect.left,
                        iTop = iconRect.top - pmRect.top;
                    const iW = iconRect.width,
                        iH = iconRect.height;
                    const hexMatch = iconEl.className.match(/circle(Dot)?Icon___([0-9A-Fa-f]{6})_(\d+)x(\d+)/);
                    ctx.save();
                    ctx.globalAlpha = pmAlpha;
                    if (hexMatch) {
                        drawVectorCircleIcon(
                            ctx,
                            iLeft + iW / 2,
                            iTop + iH / 2,
                            iW,
                            hexMatch[2],
                            !hexMatch[1],
                            scale * objScale
                        );
                    } else {
                        const img = await getCachedImage(extractBgUrl(iconEl));
                        if (img) ctx.drawImage(img, iLeft, iTop, iW, iH);
                    }
                    ctx.restore();
                }
            }

            const pictoEl = pm.querySelector(
                '[class*="-pictogramCircleIconContent"], [class*="-pictogramIconContent"]'
            );
            if (pictoEl) {
                const pRect = pictoEl.getBoundingClientRect();
                if (isElementVisible(pictoEl, pRect)) {
                    const img = await getCachedImage(extractBgUrl(pictoEl));
                    if (img) {
                        const pW = pRect.width || 22,
                            pH = pRect.height || 22;
                        const pLeft = pRect.width > 0 ? pRect.left - pmRect.left : -pW / 2;
                        const pTop = pRect.height > 0 ? pRect.top - pmRect.top : -pH / 2;
                        ctx.save();
                        ctx.globalAlpha = pmAlpha;
                        ctx.drawImage(img, pLeft, pTop, pW, pH);
                        ctx.restore();
                    }
                }
            }

            const contentCandidates = Array.from(
                pm.querySelectorAll(
                    '[class*="-svg-icon-content"], [class*="-stretchy-icon"] ymaps, [class*="-placemark__content"]'
                )
            );
            const contentTextEl = contentCandidates.find((el) => {
                if (el.closest('[class*="_icon-caption"]') || el === pictoEl || (pictoEl && el.contains(pictoEl))) {
                    return false;
                }
                const directText = Array.from(el.childNodes)
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.nodeValue.trim())
                    .join('');
                return directText.length > 0 && isElementVisible(el);
            });

            if (contentTextEl) {
                const cText = contentTextEl.textContent.trim();
                const cRect = contentTextEl.getBoundingClientRect();
                const cStyle = window.getComputedStyle(contentTextEl);
                ctx.save();
                ctx.globalAlpha = pmAlpha;
                ctx.font =
                    cStyle.font ||
                    `${cStyle.fontWeight || 'bold'} ${cStyle.fontSize || '13px'} ${
                        cStyle.fontFamily || 'Arial, sans-serif'
                    }`;
                ctx.fillStyle = cStyle.color || '#000000';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(
                    cText,
                    cRect.left - pmRect.left + cRect.width / 2,
                    cRect.top - pmRect.top + cRect.height / 2 + 0.5
                );
                ctx.restore();
            }
            ctx.restore();
        }

        if (document.getElementById('ymc-unl-logo').checked) {
            const logoImg = holder.querySelector('#stretchLogo');
            if (logoImg && logoImg.src) {
                const img = await getCachedImage(logoImg.src);
                if (img) ctx.drawImage(img, width - 135, height - 71, 105, 46);
            }
        }
        return outCanvas;
    }

    async function exportMap() {
        const exportBtn = document.getElementById('ymc-unl-export');
        if (isExportRunning) {
            abortExportRequested = true;
            setStatus('⏹ Остановка экспорта...');
            return;
        }

        const w = Math.max(100, parseInt(document.getElementById('ymc-unl-w').value, 10) || DEFAULT_WIDTH);
        const h = Math.max(100, parseInt(document.getElementById('ymc-unl-h').value, 10) || DEFAULT_HEIGHT);
        let scale = parseFloat(document.getElementById('ymc-unl-scale').value) || 2;
        const bgMode = document.getElementById('ymc-unl-bg').value;
        const objScale = resolveObjScale(w, h);
        const autoRestore = document.getElementById('ymc-unl-restore').checked;
        const autoCenter = document.getElementById('ymc-unl-autocenter').checked;

        const MAX_SIDE = 32000,
            MAX_AREA = 260000000;
        if (w * scale > MAX_SIDE || h * scale > MAX_SIDE || w * scale * (h * scale) > MAX_AREA) {
            const clampedScale =
                Math.floor(Math.min(MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h))) * 100) / 100;
            if (clampedScale < 0.25) {
                alert(
                    `Запрошенный размер ${w}×${h} превышает аппаратный лимит памяти 2D Canvas браузера. Уменьшите зум на 1-2 шага.`
                );
                return;
            }
            scale = clampedScale;
            setStatus(`⚠️ Множитель снижен до ${scale}x (лимит памяти Canvas браузера)`);
            await sleep(600);
        }

        const initialTarget = getActiveTarget();
        if (!initialTarget.holder) {
            alert('Контейнер карты не найден!');
            return;
        }

        const stateSnapshot = snapshotContainerState(initialTarget);
        const origMapType = stateSnapshot ? stateSnapshot.origMapType : 'yandex#map';

        isExportRunning = true;
        abortExportRequested = false;
        if (exportBtn) {
            exportBtn.textContent = '⏹ Остановить экспорт';
            exportBtn.style.background = '#ff9999';
        }

        try {
            let centerCoords = null,
                targetZoom = null,
                firstFitSource = null;
            if (autoCenter) {
                const fit = computeOptimalCenterAndSize(initialTarget, 90);
                if (fit) {
                    firstFitSource = fit.source;
                    if (fit.centerCoords) {
                        centerCoords = fit.centerCoords;
                        targetZoom = fit.zoom;
                    }
                }
            }

            setStatus('1/3: Выставляем габариты схемы и центрируем объекты...');
            await applyContainerSize(w, h, centerCoords, targetZoom, true);

            if (autoCenter && firstFitSource === 'dom') {
                const secondFit = computeOptimalCenterAndSize(getActiveTarget(), 90);
                if (secondFit && secondFit.centerCoords) {
                    await applyContainerSize(w, h, secondFit.centerCoords, secondFit.zoom, true);
                }
            }
            await sleep(350);

            const target = getActiveTarget();
            if (!target.holder) throw new Error('Не найден контейнер карты');

            const finalCanvas = await renderDirectCanvas(target, w, h, scale, objScale, bgMode, origMapType);
            if (!finalCanvas || finalCanvas.width === 0 || finalCanvas.height === 0) {
                throw new Error('Итоговый Canvas пуст (превышен лимит памяти вкладки)');
            }

            const realW = finalCanvas.width,
                realH = finalCanvas.height;
            setStatus(`Упаковка PNG (${realW} × ${realH} px)...`);
            await new Promise((resolve, reject) => {
                finalCanvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Браузер не смог создать PNG Blob'));
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    a.href = url;
                    a.download = `map_${realW}x${realH}_${ts}.png`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60000);
                    setStatus(`✅ Скачан PNG: ${realW} × ${realH} px (метки: ${objScale}x)`);
                    resolve();
                }, 'image/png');
            });
        } catch (err) {
            console.error(err);
            setStatus('❌ ' + err.message);
        } finally {
            if ((autoRestore || w > 3500 || h > 3500) && stateSnapshot) {
                await restoreContainerState(stateSnapshot);
            }
            isExportRunning = false;
            abortExportRequested = false;
            if (exportBtn) {
                exportBtn.textContent = '💾 Скачать карту в PNG';
                exportBtn.style.background = '#ffdb4d';
            }
        }
    }

    function changeZoom(delta) {
        injectUnlockStyles();
        const target = getActiveTarget();
        const activeMap = target.mapInstance || target.allMaps.all[0];
        if (!activeMap) {
            setStatus('Инстанс ymaps.Map не найден — чуть сдвиньте карту мышью.');
            return;
        }
        const nextZ = Math.max(1, Math.min(21, activeMap.getZoom() + delta));
        try {
            activeMap.setZoom(nextZ);
        } catch (e) {}
        document.getElementById('ymc-unl-zoom-val').textContent = nextZ;
        scheduleZoomBadgeSync();
        setStatus(`Масштаб установлен: ${nextZ}`);
    }

    function setStatus(text) {
        const el = document.getElementById('ymc-unl-status');
        if (el) el.textContent = text;
    }

    function createPanel() {
        if (document.getElementById('ymc-unl-panel')) return;
        injectUnlockStyles();
        installYmapsHooks();
        harvestTileTemplates();

        const panel = document.createElement('div');
        panel.id = 'ymc-unl-panel';
        panel.style.cssText = `
            position: fixed; bottom: 20px; left: 340px; z-index: 99999; width: 335px;
            background: #ffffff; border: 1px solid rgba(0,0,0,0.18); border-radius: 8px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.22); font-family: Arial, Helvetica, sans-serif;
            font-size: 13px; color: #222; padding: 12px 14px; user-select: none;
        `;

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid #eee;padding-bottom:6px;cursor:move;" id="ymc-unl-header">
                <strong style="font-size:14px;">🖨️ Экспорт без лимитов v1.0.0</strong>
                <button id="ymc-unl-min" style="border:none;background:none;cursor:pointer;font-size:16px;line-height:1;">—</button>
            </div>
            <div id="ymc-unl-body">
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                    <span style="width:85px;">Размер (px):</span>
                    <input id="ymc-unl-w" type="number" value="${DEFAULT_WIDTH}" min="100" max="25000" step="100" style="width:72px;padding:4px;border:1px solid #ccc;border-radius:4px;">
                    <span>×</span>
                    <input id="ymc-unl-h" type="number" value="${DEFAULT_HEIGHT}" min="100" max="25000" step="100" style="width:72px;padding:4px;border:1px solid #ccc;border-radius:4px;">
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                    <span style="width:85px;">Множитель:</span>
                    <select id="ymc-unl-scale" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:4px;">
                        <option value="1">1x (96 DPI — быстро)</option>
                        <option value="2" selected>2x (Retina — чётко)</option>
                        <option value="3.125">3.125x (300 DPI — полиграфия)</option>
                    </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                    <span style="width:85px;">Фон карты:</span>
                    <select id="ymc-unl-bg" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:4px;">
                        <option value="map" selected>🗺️ Карта + Схема (с тайлами)</option>
                        <option value="solid">🎨 Только схема (светлый фон)</option>
                        <option value="transparent">✨ Только схема (прозрачный PNG)</option>
                    </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                    <span style="width:85px;">Метки/линии:</span>
                    <select id="ymc-unl-objscale" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:4px;">
                        <option value="auto" selected>Авто (крупнее на больших картах)</option>
                        <option value="1">1x (Штатный размер)</option>
                        <option value="1.5">1.5x (Средне)</option>
                        <option value="2">2x (Крупно)</option>
                        <option value="3">3x (Для гигантских карт)</option>
                        <option value="4">4x (Плакатный)</option>
                    </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                    <span style="width:85px;">Зум карты:</span>
                    <button id="ymc-unl-z-minus" style="padding:3px 10px;cursor:pointer;border:1px solid #ccc;background:#f8f8f8;border-radius:4px;">−</button>
                    <strong id="ymc-unl-zoom-val" style="min-width:24px;text-align:center;">—</strong>
                    <button id="ymc-unl-z-plus" style="padding:3px 10px;cursor:pointer;border:1px solid #ccc;background:#f8f8f8;border-radius:4px;">+</button>
                    <button id="ymc-unl-apply-size" style="flex:1;padding:4px 6px;cursor:pointer;border:1px solid #ccc;background:#f8f8f8;border-radius:4px;">Предпросмотр</button>
                </div>
                <button id="ymc-unl-autofit" style="width:100%;padding:7px;margin-bottom:8px;cursor:pointer;background:#f0f6ff;border:1px solid #99c2ff;border-radius:5px;color:#0044aa;font-weight:bold;">
                    🎯 Авто-размер под все объекты
                </button>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-size:12px;color:#555;">
                    <label style="cursor:pointer;"><input type="checkbox" id="ymc-unl-autocenter" checked> Авто-центровка схемы при экспорте</label>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;color:#555;">
                    <label style="cursor:pointer;"><input type="checkbox" id="ymc-unl-restore" checked> Вернуть размер UI после экспорта</label>
                    <label style="cursor:pointer;"><input type="checkbox" id="ymc-unl-logo"> Лого Яндекса</label>
                </div>
                <button id="ymc-unl-export" style="width:100%;padding:9px;cursor:pointer;background:#ffdb4d;border:none;border-radius:5px;font-weight:bold;font-size:14px;color:#000;">
                    💾 Скачать карту в PNG
                </button>
                <div id="ymc-unl-status" style="margin-top:8px;font-size:11px;color:#555;line-height:1.35;word-break:break-word;">
                    Готов к работе. Честные тайлы любого зума!
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        setTimeout(() => getActiveTarget(), 900);
        window.addEventListener('wheel', scheduleZoomBadgeSync, { passive: true });

        const bodyEl = document.getElementById('ymc-unl-body');
        document.getElementById('ymc-unl-min').addEventListener('click', () => {
            bodyEl.style.display = bodyEl.style.display === 'none' ? 'block' : 'none';
        });

        const headerEl = document.getElementById('ymc-unl-header');
        let dragging = false,
            startX = 0,
            startY = 0,
            origLeft = 0,
            origBottom = 0;

        headerEl.addEventListener('mousedown', (e) => {
            if (e.target.id === 'ymc-unl-min') return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            origLeft = rect.left;
            origBottom = window.innerHeight - rect.bottom;
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const maxLeft = Math.max(0, window.innerWidth - rect.width);
            const maxBottom = Math.max(0, window.innerHeight - rect.height);
            panel.style.left = `${Math.min(maxLeft, Math.max(0, origLeft + (e.clientX - startX)))}px`;
            panel.style.bottom = `${Math.min(maxBottom, Math.max(0, origBottom - (e.clientY - startY)))}px`;
        });

        window.addEventListener('mouseup', () => {
            dragging = false;
        });
        document.getElementById('ymc-unl-z-minus').addEventListener('click', () => changeZoom(-1));
        document.getElementById('ymc-unl-z-plus').addEventListener('click', () => changeZoom(1));
        document.getElementById('ymc-unl-apply-size').addEventListener('click', async () => {
            const w = Math.max(100, parseInt(document.getElementById('ymc-unl-w').value, 10) || DEFAULT_WIDTH);
            const h = Math.max(100, parseInt(document.getElementById('ymc-unl-h').value, 10) || DEFAULT_HEIGHT);
            if (w > 3500 || h > 3500) {
                setStatus(`Превью в окне ограничено 3500px (при скачивании будет полный ${w} × ${h} px)`);
                await applyContainerSize(Math.min(w, 3500), Math.min(h, 3500), null, null, false);
            } else {
                await applyContainerSize(w, h, null, null, false);
                setStatus(`Размер контейнера применён: ${w} × ${h} px`);
            }
        });
        document.getElementById('ymc-unl-autofit').addEventListener('click', () => autoFitAllObjects(90));
        document.getElementById('ymc-unl-export').addEventListener('click', exportMap);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createPanel);
    else createPanel();
})();