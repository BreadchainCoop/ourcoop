/** Tiny structured-ish logger; the relay is ops-facing, keep lines greppable. */
export function log(scope: string, message: string, extra?: object): void {
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra, bigintSafe)}` : "";
  console.log(`${ts} [${scope}] ${message}${tail}`);
}

export function warn(scope: string, message: string, extra?: object): void {
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra, bigintSafe)}` : "";
  console.warn(`${ts} [${scope}] WARN ${message}${tail}`);
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** One-line error rendering (never dump full RPC bodies into the store). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message.split("\n")[0] ?? e.message;
  return String(e);
}
