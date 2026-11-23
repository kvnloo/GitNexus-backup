/**
 * Fault class of a failed MCP tool call: the caller's mistake (`client`) or a
 * failure of the server, its engine or its storage (`server`).
 *
 * The class is attached where an error is born — a non-enumerable mark on the
 * error object, or a report into the per-call scope when a tool turns a caught
 * error into an `{ error }` result. It is never derived from the message text:
 * engines and wrappers phrase messages freely, so a typo and a storage failure
 * can read alike while their origins never do.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type FaultClass = 'client' | 'server';

/** Where a native query failed: preparing the statement or running it. */
export type QueryStage = 'prepare' | 'execute';

const FAULT_CLASS = Symbol.for('gitnexus.faultClass');
const QUERY_STAGE = Symbol.for('gitnexus.queryStage');
const MAX_CAUSE_DEPTH = 5;

/**
 * Set a mark once: a later mark on the same value does not replace the first.
 * Frozen and non-extensible values are left unmarked.
 */
function setMark(value: unknown, key: symbol, mark: string): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    if (Object.prototype.hasOwnProperty.call(value, key) || !Object.isExtensible(value)) return;
    Object.defineProperty(value, key, { value: mark, enumerable: false, configurable: true });
  } catch {
    // A proxy or exotic object refused the property; the value stays unmarked.
  }
}

/**
 * Read a mark from the value itself, then along its `cause` chain: the value's
 * own mark wins over any mark further down the chain. Never throws: a throwing
 * `cause` getter or proxy trap reads as unmarked.
 */
function readMark(value: unknown, key: symbol): string | undefined {
  try {
    let current = value;
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
      if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
        return undefined;
      }
      const own = Object.getOwnPropertyDescriptor(current, key);
      if (own && typeof own.value === 'string') return own.value;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Fall through: an unreadable value has no mark.
  }
  return undefined;
}

/**
 * Mark `value` with a fault class and return it unchanged otherwise. Message,
 * name, code, stack and JSON serialization stay the same.
 */
export function markFault<T>(value: T, fault: FaultClass): T {
  setMark(value, FAULT_CLASS, fault);
  return value;
}

/** An `Error` the caller can fix by changing the call. */
export function clientError(message: string, options?: ErrorOptions): Error {
  return markFault(new Error(message, options), 'client');
}

/** Filesystem error codes that the path itself causes, whoever opens it. */
const CLIENT_PATH_ERROR_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ENAMETOOLONG',
  'ELOOP',
  'EINVAL',
  'ERR_INVALID_ARG_VALUE',
]);

/**
 * Mark an error from opening a path the caller supplied: a missing, malformed
 * or wrong-kind path is a client fault, decided by `code`. Permission, I/O and
 * descriptor-limit errors, and errors without a code, stay unmarked and so
 * classify as server faults.
 */
export function markPathFault<T>(err: T): T {
  let code: unknown;
  try {
    code = (err as { code?: unknown } | null)?.code;
  } catch {
    return err;
  }
  return typeof code === 'string' && CLIENT_PATH_ERROR_CODES.has(code)
    ? markFault(err, 'client')
    : err;
}

/** The fault class marked on `value`, or else on the nearest error in its `cause` chain. */
export function faultOf(value: unknown): FaultClass | undefined {
  const mark = readMark(value, FAULT_CLASS);
  return mark === 'client' || mark === 'server' ? mark : undefined;
}

export function markQueryStage<T>(value: T, stage: QueryStage): T {
  setMark(value, QUERY_STAGE, stage);
  return value;
}

export function queryStageOf(value: unknown): QueryStage | undefined {
  const stage = readMark(value, QUERY_STAGE);
  return stage === 'prepare' || stage === 'execute' ? stage : undefined;
}

interface FaultRecord {
  client: boolean;
  server: boolean;
}

const scopeStore = new AsyncLocalStorage<FaultRecord>();

/** Collects the faults reported while one tool call runs. */
export interface FaultScope {
  run<T>(fn: () => T): T;
  /** `server` if any server fault was reported, `client` if only client ones, else undefined. */
  fault(): FaultClass | undefined;
}

export function createFaultScope(): FaultScope {
  const record: FaultRecord = { client: false, server: false };
  return {
    run: (fn) => scopeStore.run(record, fn),
    fault: () => (record.server ? 'server' : record.client ? 'client' : undefined),
  };
}

/** Record a fault for the current tool call; a no-op outside a scope. */
export function reportFault(fault: FaultClass): void {
  const record = scopeStore.getStore();
  if (record) record[fault] = true;
}

/**
 * Record the class of an error a tool caught and turned into a result. With
 * `clientQuery`, an error raised while preparing or running the caller's own
 * statement is the caller's, even though every error leaving the read pool
 * also carries a server mark: native engine errors cannot be told apart
 * without reading their text, so a storage failure that surfaces while the
 * caller's statement runs is classified client too. Anything else keeps its
 * mark, and an unmarked error is a server fault.
 */
export function reportCaughtFault(err: unknown, options?: { clientQuery?: boolean }): void {
  if (options?.clientQuery && queryStageOf(err) !== undefined) {
    reportFault('client');
    return;
  }
  reportFault(faultOf(err) ?? 'server');
}
