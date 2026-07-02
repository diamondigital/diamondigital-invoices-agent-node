function write(
  method: 'log' | 'warn' | 'error',
  level: string,
  area: string,
  message: string,
  fields: Record<string, unknown>,
): void {
  console[method](JSON.stringify({ level, area, message, ...fields }));
}

export const log = {
  info(area: string, message: string, fields: Record<string, unknown> = {}): void {
    write('log', 'info', area, message, fields);
  },
  warn(area: string, message: string, fields: Record<string, unknown> = {}): void {
    write('warn', 'warn', area, message, fields);
  },
  error(area: string, message: string, fields: Record<string, unknown> = {}): void {
    write('error', 'error', area, message, fields);
  },
};
