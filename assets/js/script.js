/**
 * Central script loader for Boardroom | Business Infinity.
 *
 * This is the mandatory subdomain entry point (assets/js/script.js),
 * loaded automatically by the theme's head.html on every page, right
 * after the theme's own common.js (a separate file that lives in the
 * theme repo — there is no boardroom-side common.js, so this file does
 * not import one).
 *
 * Imported modules (side-effect imports):
 * - `./boardroom/sidebar-element.js` : registers sidebar custom element
 * - `./boardroom-app-new.js`        : registers <boardroom-app>, the
 *                                      ChatroomApp subclass used by
 *                                      boardroom/index.html's
 *                                      `component: boardroom-app`
 * - `./dashboard-panel.js`          : dashboard panel UI
 * - `./mentor-element.js`           : mentor UI element
 * - `./openapi-loader.js`           : OpenAPI spec loader (exposes `window.openApiSpec`)
 * - `./initializer.js`              : wires startup (loads spec, DOMContentLoaded init)
 *
 * Note: Prefer importing exported functions/classes from these modules in
 * new code rather than relying on side effects or globals.
 */
import './boardroom/sidebar-element.js';
import './boardroom-app-new.js';
import './dashboard-panel.js';
import './mentor-element.js';
// `app-utils.js` is imported where needed (initializer imports it explicitly)
import './openapi-loader.js';
import './initializer.js';
