# Yandex Map Constructor — Unlimited Hi-Res Export

<img width="1525" height="934" alt="Экспорт без лимитов" src="https://github.com/user-attachments/assets/751ce381-104f-4d17-a764-1ac3e1e8f3d3" />

> [Русская версия (README.ru.md)](./README.ru.md)

A userscript for exporting custom maps and schemas from Yandex Map Constructor (`yandex.*/map-constructor`) as high-resolution PNG images without built-in size or zoom restrictions.

## Features

- **Direct tile rendering** at any zoom level (supports Map, Satellite, and Hybrid layers).
- **Fast mode prompt** when exporting large areas (> 2000 tiles), allowing you to choose between full-detail tiles or `z-1` at `scale=4` (4× fewer requests).
- **Native vector rendering** of lines and polygons via `Path2D` (with SVG fallback for other shapes).
- **Scalable placemarks, lines, and captions** (`1x`–`4x` or `Auto` scaling for oversized maps).
- **Auto-fit & auto-center** (`🎯 Авто-размер под все объекты`) calculated from geo coordinates or DOM geometry.
- **Background options:** full map tiles, solid light background, or transparent PNG.
- **2D Canvas memory protection** that automatically clamps the output scale multiplier to stay within browser limits (`32000 px` max side, `~260 MP` max area).

## Installation

1. Install a userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)
2. Install [`yandex-map-constructor-export.user.js`](./yandex-map-constructor-export.user.js) by clicking **Raw** on GitHub (or via GreasyFork).
3. Open Yandex Map Constructor — a draggable control panel will appear in the bottom-left area.

## Usage

1. If the zoom badge shows `—`, slightly pan or zoom the map so the script captures the active map instance.
2. Click **Auto-fit (`🎯 Авто-размер под все объекты`)** or enter custom width and height in pixels.
3. Choose the scale multiplier (`1x`, `2x`, `3.125x` for 300 DPI), background mode, and object scale.
4. Click **Export PNG (`💾 Скачать карту в PNG`)**.

## Privacy & Limitations

- Runs 100% locally in your browser; no analytics, tracking, or third-party servers are used.
- Maximum output resolution is bounded by your browser's 2D Canvas memory limits.

## License

[MIT](./LICENSE)
