/**
 * Minimal RFC 6902 JSON Patch (add / replace / remove), used for AG-UI
 * STATE_DELTA events. Prototype-polluting paths are ignored.
 */

export class JsonPatch {
  /**
   * Apply `ops` to a deep copy of `state`.
   * @param {object} state
   * @param {Array<{op: string, path: string, value?: *}>} ops
   * @returns {object} The patched copy.
   */
  static apply(state, ops) {
    const next = JSON.parse(JSON.stringify(state || {}));
    for (const op of Array.isArray(ops) ? ops : []) {
      const path = String(op.path || '').split('/').slice(1)
        .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!path.length || path.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) continue;
      let target = next;
      for (let i = 0; i < path.length - 1 && target != null; i++) target = target[path[i]];
      if (target == null || typeof target !== 'object') continue;
      const key = path[path.length - 1];
      const isArr = Array.isArray(target);
      const idx = isArr ? (key === '-' ? target.length : Number(key)) : key;
      if (op.op === 'add') {
        if (isArr) target.splice(idx, 0, op.value); else target[idx] = op.value;
      } else if (op.op === 'replace') {
        target[idx] = op.value;
      } else if (op.op === 'remove') {
        if (isArr) target.splice(idx, 1); else delete target[idx];
      }
    }
    return next;
  }
}

export default JsonPatch;
