/**
 * @param {'log'|'warn'|'error'} method
 * @param {string} level
 * @param {string} area
 * @param {string} message
 * @param {Record<string, unknown>} fields
 */
function write(method, level, area, message, fields) {
  console[method](JSON.stringify({ level, area, message, ...fields }));
}

export const log = {
  /**
   * @param {string} area
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  info(area, message, fields = {}) {
    write('log', 'info', area, message, fields);
  },
  /**
   * @param {string} area
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  warn(area, message, fields = {}) {
    write('warn', 'warn', area, message, fields);
  },
  /**
   * @param {string} area
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  error(area, message, fields = {}) {
    write('error', 'error', area, message, fields);
  },
};
