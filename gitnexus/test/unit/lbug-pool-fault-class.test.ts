import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepare, execute, readOnly } = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
  readOnly: vi.fn(() => false),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Connection: vi.fn(function (this: any) {
      this.prepare = prepare;
      this.execute = execute;
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: readOnly,
  loadFTSExtension: async () => false,
  loadVectorExtension: async () => false,
}));
vi.mock('../../src/core/lbug/query-memory-guard.js', () => ({
  queryMemoryGuard: { begin: () => ({}), end: () => {} },
}));

import {
  closeLbug,
  ensureVectorExtension,
  executeParameterized,
  initLbugWithDb,
} from '../../src/core/lbug/pool-adapter.js';
import { SymbolIdentityError } from '../../src/core/lbug/query-result-integrity.js';
import { faultOf, queryStageOf } from '../../src/core/fault-class.js';

const REPO = 'fault-class-pool';
const query = () => executeParameterized(REPO, 'RETURN 1 AS n', {}).catch((e) => e);

describe('read pool fault marks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    readOnly.mockReturnValue(false);
    prepare.mockResolvedValue({ isSuccess: () => true });
    execute.mockResolvedValue({ getAll: async () => [{ n: 1 }], close: vi.fn() });
    await initLbugWithDb(REPO, {} as any, '/tmp/fault-class-pool-db');
  });

  afterEach(async () => {
    await closeLbug();
    vi.useRealTimers();
  });

  it('marks an uninitialized pool as a server fault without a query stage', async () => {
    const error = await executeParameterized('missing-repo', 'RETURN 1', {}).catch((e) => e);
    expect(error.message).toBe(
      'LadybugDB not initialized for repo "missing-repo". Call initLbug first.',
    );
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
  });

  it('marks a native prepare failure with the prepare stage', async () => {
    prepare.mockResolvedValueOnce({
      isSuccess: () => false,
      getErrorMessage: async () => 'Parser exception: bad',
    });
    const error = await query();
    expect(error.message).toBe('Prepare failed: Parser exception: bad');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('prepare');
  });

  it('rethrows the same native execute error with the execute stage', async () => {
    const native = new Error('IO exception: synthetic');
    execute.mockRejectedValueOnce(native);
    const error = await query();
    expect(error).toBe(native);
    expect(error.message).toBe('IO exception: synthetic');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('execute');
  });

  it('keeps the read-only wrapper text and stages it as execute', async () => {
    const native = new Error('Cannot execute write operations in a read-only database!');
    readOnly.mockReturnValueOnce(true);
    execute.mockRejectedValueOnce(native);
    const error = await query();
    expect(error.message).toBe('Write operations are not allowed. The pool adapter is read-only.');
    expect(error.cause).toBe(native);
    expect(queryStageOf(error)).toBe('execute');
  });

  it('stages the adapter timeout as execute', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    execute.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = query();
    await vi.advanceTimersByTimeAsync(30_001);
    release({ getAll: async () => [], close: vi.fn() });
    const error = await pending;
    expect(error.message).toBe('Query timed out after 30000ms');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('execute');
  });

  it('stages a timeout during prepare as prepare', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    prepare.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = query();
    await vi.advanceTimersByTimeAsync(30_001);
    release({ isSuccess: () => true });
    const error = await pending;
    expect(error.message).toBe('Query timed out after 30000ms');
    expect(faultOf(error)).toBe('server');
    expect(queryStageOf(error)).toBe('prepare');
  });

  it('marks vector extension failures as server faults', async () => {
    const error = await ensureVectorExtension('missing-repo').catch((e) => e);
    expect(error.message).toBe(
      'LadybugDB not initialized for repo "missing-repo". Call initLbug first.',
    );
    expect(faultOf(error)).toBe('server');
  });

  it('marks an invalid symbol identity as a server fault', () => {
    const error = new SymbolIdentityError();
    expect(error.name).toBe('SymbolIdentityError');
    expect(faultOf(error)).toBe('server');
  });
});
