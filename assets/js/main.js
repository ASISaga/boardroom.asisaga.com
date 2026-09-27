/**
 * Entry module for Business Infinity (boardroom) assets.
 *
 * This file is intentionally import-only. All implementation details have
 * been refactored into focused ESM modules to improve testability and
 * reusability. Keep this file minimal so bundlers and HTML can include a
 * single script that wires the application via module imports.
 *
 * Imported modules (side-effect imports):
 * - `./boardroom/sidebar-element.js` : registers sidebar custom element
 * - `./boardroom-app.js`            : initializes boardroom app components
 * - `./dashboard-panel.js`         : dashboard panel UI
 * - `./mentor-element.js`          : mentor UI element
 * - `./openapi-loader.js`          : OpenAPI spec loader (exposes `window.openApiSpec`)
 * - `./initializer.js`             : wires startup (loads spec, DOMContentLoaded init)
 *
 * Note: Prefer importing exported functions/classes from these modules in
 * new code rather than relying on side effects or globals.
 */
import './boardroom/sidebar-element.js';
//import './boardroom-app.js';
import './dashboard-panel.js';
import './mentor-element.js';
// `app-utils.js` is imported where needed (initializer imports it explicitly)
import './openapi-loader.js';
import './initializer.js';
