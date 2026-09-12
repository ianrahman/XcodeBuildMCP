import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFileSystemExecutor } from '../../test-utils/mock-executors.ts';
import {
  __resetConfigStoreForTests,
  initConfigStore,
} from '../config-store.ts';
import { tryAcquireFsLock } from '../fs-lock.ts';
import {
  finalizeManagedTestProductsPath,
  prepareManagedTestProductsPath,
  resetManagedTestProductsFinalizationStateForTests,
  scheduleWorkspaceTestProductsPrune,
  withManagedTestProductsFinalization,
} from '../managed-test-products.ts';
import {
  getWorkspaceFilesystemLayout,
  setXcodeBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import {
  createDefaultTestProductsPath,
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';
import {
  getTestProductsReaderLeaseDirectory,
  hasActiveTestProductsReaderLease,
  resetTestProductsReaderLeaseReleaseRetriesForTests,
  withPreparedTestProductsReaderLease,
  withTestProductsReaderLease,
} from '../test-products-reader-lease.ts';
import {
  createTestProductsProducerReservation,
  getActiveTestProductsProducerReservationNames,
  TEST_PRODUCTS_HANDOFF_LEASE_MS,
  TestProductsProducerReservationPublicationError,
  transitionTestProductsProducerReservationToFinalizing,
  transitionTestProductsProducerReservationToHandoff,
  validateCreatedTestProductsProducerReservation,
} from '../test-products-producer-reservation.ts';
import {
  acquireWorkspaceFilesystemLifecycleLock,
  setWorkspaceFilesystemLockAcquisitionAttemptHookForTests,
  tryAcquireWorkspaceFilesystemLifecycleLock,
  WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
  WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
} from '../workspace-filesystem-lock.ts';
import {
  resetWorkspaceFilesystemLifecycleStateForTests,
  runWorkspaceFilesystemLifecycleSweep,
} from '../workspace-filesystem-lifecycle.ts';

function ageCompletionMarker(testProductsPath: string): void {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(getTestProductsCompletionMarkerPath(testProductsPath), old, old);
}

function afterHandoffNow(): number {
  return Date.now() + TEST_PRODUCTS_HANDOFF_LEASE_MS + 1;
}

function nextWorkspaceLockAcquisitionAttempt(): Promise<void> {
  return new Promise((resolve) => {
    setWorkspaceFilesystemLockAcquisitionAttemptHookForTests((workspaceKey) => {
      if (workspaceKey === 'workspace-a') {
        setWorkspaceFilesystemLockAcquisitionAttemptHookForTests(null);
        resolve();
      }
    });
  });
}

describe('managed test products', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-managed-test-products-'));
    setXcodeBuildMCPAppDirOverrideForTests(appDir);
    setRuntimeInstanceForTests({
      instanceId: 'managed-test-products',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    __resetConfigStoreForTests();
    resetManagedTestProductsFinalizationStateForTests();
    resetTestProductsReaderLeaseReleaseRetriesForTests();
    resetWorkspaceFilesystemLifecycleStateForTests();
  });

  afterEach(() => {
    setWorkspaceFilesystemLockAcquisitionAttemptHookForTests(null);
    resetManagedTestProductsFinalizationStateForTests();
    resetTestProductsReaderLeaseReleaseRetriesForTests();
    resetWorkspaceFilesystemLifecycleStateForTests();
    __resetConfigStoreForTests();
    setRuntimeInstanceForTests(null);
    setXcodeBuildMCPAppDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
  });

  it('initializes the workspace lock hierarchy safely under contention', async () => {
    const attempts = await Promise.all([
      tryAcquireWorkspaceFilesystemLifecycleLock({ workspaceKey: 'workspace-a' }),
      tryAcquireWorkspaceFilesystemLifecycleLock({ workspaceKey: 'workspace-a' }),
    ]);
    const acquired = attempts.filter((attempt) => attempt !== null);

    expect(acquired).toHaveLength(1);
    await acquired[0]!.release();
  });

  it('rejects a producer reservation missing from the validated state root', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const reservation = await createTestProductsProducerReservation(
      'workspace-a',
      testProductsPath,
    );
    const canonicalAppDir = realpathSync(appDir);
    const originalAppDir = `${appDir}-original`;
    renameSync(appDir, originalAppDir);
    rmSync(
      path.join(
        originalAppDir,
        path.relative(canonicalAppDir, reservation.filePath),
      ),
      { force: true },
    );
    renameSync(originalAppDir, appDir);

    await expect(
      validateCreatedTestProductsProducerReservation(reservation),
    ).rejects.toThrow(
      'Producer reservation was not published in the validated state root',
    );
  });

  it('classifies malformed producer publication readback as retryable', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const reservation = await createTestProductsProducerReservation(
      'workspace-a',
      testProductsPath,
    );
    writeFileSync(reservation.filePath, '{');

    await expect(
      validateCreatedTestProductsProducerReservation(reservation),
    ).rejects.toBeInstanceOf(
      TestProductsProducerReservationPublicationError,
    );
  });

  it('keeps a live producer active when its completion marker is symbolic', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const markerTarget = path.join(appDir, 'old-completion-marker');
    writeFileSync(markerTarget, 'completed');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(markerTarget, old, old);
    symlinkSync(markerTarget, getTestProductsCompletionMarkerPath(productsPath));

    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
        now: Date.now() + TEST_PRODUCTS_HANDOFF_LEASE_MS + 1,
      }),
    ).toEqual(new Set([path.basename(productsPath)]));
  });

  it('counts the newest handoff toward the retention bound before returning', async () => {
    await initConfigStore({
      cwd: '/repo',
      fs: createMockFileSystemExecutor(),
      overrides: { testProductsMaxCount: 1, testProductsMaxAgeDays: 10 },
    });
    const first = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(first);
    await finalizeManagedTestProductsPath(first);
    await transitionTestProductsProducerReservationToHandoff(
      'workspace-a',
      first,
      Date.now() - 2 * TEST_PRODUCTS_HANDOFF_LEASE_MS,
    );
    ageCompletionMarker(first);

    const second = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(second);
    await finalizeManagedTestProductsPath(second);

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(second).not.toBe(first);
  });

  it('restores the retention bound after overlapping handoffs expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      await initConfigStore({
        cwd: '/repo',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 3, testProductsMaxAgeDays: 10 },
      });
      const productsPaths: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const productsPath = await prepareManagedTestProductsPath(`test_${index}`);
        mkdirSync(productsPath);
        await finalizeManagedTestProductsPath(productsPath);
        productsPaths.push(productsPath);
      }

      expect(productsPaths.every(existsSync)).toBe(true);
      await vi.advanceTimersByTimeAsync(TEST_PRODUCTS_HANDOFF_LEASE_MS + 1);

      const retainedNames = readdirSync(
        getWorkspaceFilesystemLayout('workspace-a').testProducts,
      ).filter(isXcodeBuildMCPManagedTestProductsName);
      expect(retainedNames).toHaveLength(3);
      expect(existsSync(productsPaths.at(-1)!)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('restores the retention bound after a spanning reader releases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      await initConfigStore({
        cwd: '/repo',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 1, testProductsMaxAgeDays: 10 },
      });
      const first = await prepareManagedTestProductsPath('test_first');
      mkdirSync(first);
      await finalizeManagedTestProductsPath(first);

      let releaseReader!: () => void;
      const reader = withTestProductsReaderLease(
        first,
        () =>
          new Promise<void>((resolve) => {
            releaseReader = resolve;
          }),
        {
          onReleased: (workspaceKey) => {
            scheduleWorkspaceTestProductsPrune(workspaceKey, Date.now());
          },
        },
      );
      const second = await prepareManagedTestProductsPath('test_second');
      mkdirSync(second);
      await finalizeManagedTestProductsPath(second);

      await vi.advanceTimersByTimeAsync(TEST_PRODUCTS_HANDOFF_LEASE_MS + 1);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);

      releaseReader();
      await reader;
      await vi.advanceTimersByTimeAsync(2);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('uses the producing workspace policy for cross-workspace release pruning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      await initConfigStore({
        cwd: '/repo-a',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 2, testProductsMaxAgeDays: 10 },
      });
      const seed = await prepareManagedTestProductsPath('policy_seed');
      await finalizeManagedTestProductsPath(seed);

      const productsPaths = Array.from({ length: 3 }, (_, index) => {
        const productsPath = createDefaultTestProductsPath(`retained_${index}`);
        mkdirSync(productsPath);
        writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
        return productsPath;
      });

      __resetConfigStoreForTests();
      setRuntimeInstanceForTests({
        instanceId: 'cross-workspace-reader',
        pid: process.pid,
        workspaceKey: 'workspace-b',
      });
      await initConfigStore({
        cwd: '/repo-b',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 1, testProductsMaxAgeDays: 10 },
      });

      scheduleWorkspaceTestProductsPrune('workspace-a', Date.now());
      await vi.advanceTimersByTimeAsync(2);

      const retainedNames = readdirSync(
        getWorkspaceFilesystemLayout('workspace-a').testProducts,
      ).filter(isXcodeBuildMCPManagedTestProductsName);
      expect(retainedNames).toHaveLength(2);
      expect(
        productsPaths.filter((productsPath) => existsSync(productsPath)),
      ).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries scheduled pruning after a transient retention-policy read failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const policyPath = path.join(
      getWorkspaceFilesystemLayout('workspace-a').state,
      'test-products-retention',
      'policy.json',
    );
    try {
      await initConfigStore({
        cwd: '/repo',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 1, testProductsMaxAgeDays: 10 },
      });
      const seed = await prepareManagedTestProductsPath('policy_seed');
      await finalizeManagedTestProductsPath(seed);

      const productsPaths = Array.from({ length: 2 }, (_, index) => {
        const productsPath = createDefaultTestProductsPath(`retained_${index}`);
        mkdirSync(productsPath);
        writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
        return productsPath;
      });

      chmodSync(policyPath, 0o000);
      scheduleWorkspaceTestProductsPrune('workspace-a', Date.now());
      await vi.advanceTimersByTimeAsync(2);
      expect(productsPaths.every(existsSync)).toBe(true);

      chmodSync(policyPath, 0o600);
      await vi.advanceTimersByTimeAsync(1002);
      expect(productsPaths.filter(existsSync)).toHaveLength(1);
    } finally {
      if (existsSync(policyPath)) {
        chmodSync(policyPath, 0o600);
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries scheduled pruning after a transient artifact-deletion failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const testProductsDirectory =
      getWorkspaceFilesystemLayout('workspace-a').testProducts;
    try {
      await initConfigStore({
        cwd: '/repo',
        fs: createMockFileSystemExecutor(),
        overrides: { testProductsMaxCount: 1, testProductsMaxAgeDays: 10 },
      });
      const seed = await prepareManagedTestProductsPath('policy_seed');
      await finalizeManagedTestProductsPath(seed);

      const productsPaths = Array.from({ length: 2 }, (_, index) => {
        const productsPath = createDefaultTestProductsPath(`retained_${index}`);
        mkdirSync(productsPath);
        writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
        return productsPath;
      });

      chmodSync(testProductsDirectory, 0o500);
      scheduleWorkspaceTestProductsPrune('workspace-a', Date.now());
      await vi.advanceTimersByTimeAsync(2);
      expect(productsPaths.every(existsSync)).toBe(true);

      chmodSync(testProductsDirectory, 0o700);
      await vi.advanceTimersByTimeAsync(1002);
      expect(productsPaths.filter(existsSync)).toHaveLength(1);
    } finally {
      if (existsSync(testProductsDirectory)) {
        chmodSync(testProductsDirectory, 0o700);
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('makes concurrent reservations visible before their products materialize', async () => {
    await initConfigStore({
      cwd: '/repo',
      fs: createMockFileSystemExecutor(),
      overrides: { testProductsMaxCount: 2, testProductsMaxAgeDays: 10 },
    });
    const existing = createDefaultTestProductsPath('test_existing');
    mkdirSync(existing);
    await finalizeManagedTestProductsPath(existing);
    ageCompletionMarker(existing);

    const first = await prepareManagedTestProductsPath('test_first');
    expect(existsSync(first)).toBe(false);
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(first)]));
    expect(existsSync(existing)).toBe(true);

    const second = await prepareManagedTestProductsPath('test_second');
    expect(existsSync(existing)).toBe(true);
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(first), path.basename(second)]));

    mkdirSync(first);
    mkdirSync(second);
    await finalizeManagedTestProductsPath(first);
    await finalizeManagedTestProductsPath(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(first), path.basename(second)]));
    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      force: true,
      now: afterHandoffNow(),
      minVisibleMs: 0,
      testProductsMaxCount: 2,
    });
    expect(existsSync(existing)).toBe(false);
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: true,
        now: afterHandoffNow(),
      }),
    ).toEqual(new Set());
  });

  it('bounds a producer reservation when its completed handoff rewrite fails', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');

    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(productsPath)]));

    const afterHandoff = afterHandoffNow();
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: true,
        now: afterHandoff,
      }),
    ).toEqual(new Set());
  });

  it('refreshes a completed handoff before returning its path', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
    await transitionTestProductsProducerReservationToHandoff(
      'workspace-a',
      productsPath,
      Date.now() - 2 * TEST_PRODUCTS_HANDOFF_LEASE_MS,
    );

    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set());

    await transitionTestProductsProducerReservationToHandoff(
      'workspace-a',
      productsPath,
    );
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(productsPath)]));
  });

  it('fails before allocation when the shared workspace lock stays held', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const lock = await tryAcquireFsLock({
      lockDir: layout.filesystemLifecycle.lockDir,
      purpose: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
      leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
    });
    expect(lock).not.toBeNull();

    try {
      await expect(
        prepareManagedTestProductsPath('test_sim', { lockWaitMs: 0 }),
      ).rejects.toThrow('Timed out waiting for workspace filesystem lock');
    } finally {
      await lock?.release();
    }
  });

  it('serializes completion state under the shared workspace lock', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const lock = await tryAcquireFsLock({
      lockDir: layout.filesystemLifecycle.lockDir,
      purpose: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
      leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
    });
    expect(lock).not.toBeNull();

    const lockAcquisitionAttempted = nextWorkspaceLockAcquisitionAttempt();
    const finalization = finalizeManagedTestProductsPath(productsPath);
    await lockAcquisitionAttempted;
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(false);

    await lock?.release();
    await finalization;
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(true);
  });

  it('coalesces a lock-timeout finalization into a later retry', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const lock = await tryAcquireFsLock({
      lockDir: layout.filesystemLifecycle.lockDir,
      purpose: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
      leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
    });
    expect(lock).not.toBeNull();

    await finalizeManagedTestProductsPath(productsPath, {
      lockWaitMs: 0,
      retryDelayMs: 25,
    });
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(false);
    await lock?.release();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(getTestProductsCompletionMarkerPath(productsPath))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(true);
  });

  it('bounds lock-timeout retries for a one-shot process', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const lock = await tryAcquireFsLock({
      lockDir: layout.filesystemLifecycle.lockDir,
      purpose: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
      leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
    });
    expect(lock).not.toBeNull();

    await finalizeManagedTestProductsPath(productsPath, {
      lockWaitMs: 0,
      maxRetryAttempts: 0,
      retryDelayMs: 25,
    });
    await lock?.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(false);

    await finalizeManagedTestProductsPath(productsPath);
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(true);
  });

  it('protects a prepared product with a reader lease and releases it in finally', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(productsPath);
    await finalizeManagedTestProductsPath(productsPath);
    const leaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      path.basename(productsPath),
    );

    await withTestProductsReaderLease(productsPath, async () => {
      expect(readdirSync(leaseDirectory)).toHaveLength(1);

      await runWorkspaceFilesystemLifecycleSweep({
        workspaceKey: 'workspace-a',
        trigger: 'manual',
        force: true,
        now: afterHandoffNow(),
        minVisibleMs: 0,
        testProductsMaxCount: 0,
      });

      expect(existsSync(productsPath)).toBe(true);
    });

    expect(readdirSync(leaseDirectory)).toHaveLength(0);
    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      force: true,
      now: afterHandoffNow(),
      minVisibleMs: 0,
      testProductsMaxCount: 0,
    });
    expect(existsSync(productsPath)).toBe(false);
  });

  it('does not wait on the current workspace lock for caller-owned prepared products', async () => {
    const callerOwnedProductsPath = path.join(appDir, 'Caller.xctestproducts');
    mkdirSync(callerOwnedProductsPath);
    const lock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: 'workspace-a',
    });

    try {
      const result = await withPreparedTestProductsReaderLease(
        callerOwnedProductsPath,
        async (canonicalSourcePath) => canonicalSourcePath,
        { lockWaitMs: 10 },
      );

      expect(result).toBe(realpathSync(callerOwnedProductsPath));
    } finally {
      await lock.release();
    }
  });

  it('locks the owning workspace for prepared products from another workspace', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim', 'workspace-b');
    mkdirSync(productsPath);
    const leaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-b',
      path.basename(productsPath),
    );
    const unrelatedLock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: 'workspace-a',
    });

    try {
      await withPreparedTestProductsReaderLease(
        productsPath,
        async (canonicalSourcePath) => {
          expect(canonicalSourcePath).toBe(realpathSync(productsPath));
          expect(readdirSync(leaseDirectory)).toHaveLength(1);
        },
        { lockWaitMs: 10 },
      );
    } finally {
      await unrelatedLock.release();
    }

    expect(readdirSync(leaseDirectory)).toHaveLength(0);
  });

  it('does not execute a managed-looking prepared source with invalid ownership', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim');
    writeFileSync(productsPath, 'not a directory');
    let operationRan = false;

    await expect(
      withPreparedTestProductsReaderLease(productsPath, async () => {
        operationRan = true;
      }),
    ).rejects.toThrow('became invalid before reader lease acquisition');
    expect(operationRan).toBe(false);
  });

  it('does not charge an active reader against the idle completed-product budget', async () => {
    const older = createDefaultTestProductsPath('test_older');
    mkdirSync(older);
    await finalizeManagedTestProductsPath(older);
    ageCompletionMarker(older);
    const newest = createDefaultTestProductsPath('test_newest');
    mkdirSync(newest);
    await finalizeManagedTestProductsPath(newest);

    await withTestProductsReaderLease(older, async () => {
      await runWorkspaceFilesystemLifecycleSweep({
        workspaceKey: 'workspace-a',
        trigger: 'manual',
        force: true,
        now: afterHandoffNow(),
        minVisibleMs: 0,
        testProductsMaxCount: 1,
      });

      expect(existsSync(older)).toBe(true);
      expect(existsSync(newest)).toBe(true);
    });

    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      force: true,
      now: afterHandoffNow(),
      minVisibleMs: 0,
      testProductsMaxCount: 1,
    });
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it('keeps a live reader reservation active for the full operation', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(productsPath);
    await finalizeManagedTestProductsPath(productsPath);

    await withTestProductsReaderLease(productsPath, async () => {
      const lock = await acquireWorkspaceFilesystemLifecycleLock({
        workspaceKey: 'workspace-a',
      });
      try {
        expect(
          await hasActiveTestProductsReaderLease(productsPath, Number.MAX_SAFE_INTEGER, {
            cleanupStale: false,
          }),
        ).toBe(true);
      } finally {
        await lock.release();
      }
    });
  });

  it('surfaces reader-lease release failure after removing the invalid token', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(productsPath);
    await finalizeManagedTestProductsPath(productsPath);
    const leaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      path.basename(productsPath),
    );

    await expect(
      withTestProductsReaderLease(productsPath, async () => {
        const leasePath = path.join(leaseDirectory, readdirSync(leaseDirectory)[0]!);
        const record = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>;
        writeFileSync(leasePath, `${JSON.stringify({ ...record, token: 'changed' })}\n`);
        return 42;
      }),
    ).rejects.toThrow('Reader lease token changed before release');

    expect(readdirSync(leaseDirectory)).toHaveLength(0);
  });

  it('does not release a reader token through a regular replacement app root', async () => {
    const productsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(productsPath);
    await finalizeManagedTestProductsPath(productsPath);
    const leaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      path.basename(productsPath),
    );
    const originalAppDir = `${appDir}-original`;
    let externalLeasePath = '';

    try {
      await expect(
        withTestProductsReaderLease(productsPath, async () => {
          const leasePath = path.join(leaseDirectory, readdirSync(leaseDirectory)[0]!);
          externalLeasePath = path.join(
            appDir,
            path.relative(appDir, leasePath),
          );
          renameSync(appDir, originalAppDir);
          mkdirSync(path.dirname(externalLeasePath), { recursive: true });
          writeFileSync(externalLeasePath, 'valuable');
        }),
      ).rejects.toThrow('Managed coordination state root identity changed');

      expect(readFileSync(externalLeasePath, 'utf8')).toBe('valuable');
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      if (existsSync(originalAppDir)) {
        renameSync(originalAppDir, appDir);
      }
    }
  });

  it('cleans dead or released reader reservations and preserves a live owner', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const products = [
      {
        path: createDefaultTestProductsPath('test_dead'),
        pid: 999_999_999,
      },
      {
        path: createDefaultTestProductsPath('test_released'),
        pid: process.pid,
        releasedAtMs: Date.now(),
      },
      { path: createDefaultTestProductsPath('test_active'), pid: process.pid },
    ];
    for (const artifact of products) {
      mkdirSync(artifact.path);
      writeFileSync(getTestProductsCompletionMarkerPath(artifact.path), 'completed');
      const leaseDirectory = getTestProductsReaderLeaseDirectory(
        layout.workspaceKey,
        path.basename(artifact.path),
      );
      mkdirSync(leaseDirectory, { recursive: true });
      writeFileSync(
        path.join(leaseDirectory, 'stale.json'),
        JSON.stringify({
          version: 1,
          token: 'stale',
          pid: artifact.pid,
          testProductsPath: realpathSync(artifact.path),
          createdAtMs: 0,
          expiresAtMs: 0,
          releasedAtMs: artifact.releasedAtMs,
        }),
      );
    }

    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: layout.workspaceKey,
      trigger: 'manual',
      force: true,
      minVisibleMs: 0,
      testProductsMaxCount: 0,
    });

    expect(existsSync(products[0]!.path)).toBe(false);
    expect(
      existsSync(
        getTestProductsReaderLeaseDirectory(
          layout.workspaceKey,
          path.basename(products[0]!.path),
        ),
      ),
    ).toBe(false);
    expect(existsSync(products[1]!.path)).toBe(false);
    expect(
      existsSync(
        getTestProductsReaderLeaseDirectory(
          layout.workspaceKey,
          path.basename(products[1]!.path),
        ),
      ),
    ).toBe(false);
    expect(existsSync(products[2]!.path)).toBe(true);
    expect(
      existsSync(
        getTestProductsReaderLeaseDirectory(
          layout.workspaceKey,
          path.basename(products[2]!.path),
        ),
      ),
    ).toBe(true);
  });

  it('protects a product when reader lease state is malformed', async () => {
    const productsPath = createDefaultTestProductsPath('test_corrupt_reader');
    mkdirSync(productsPath);
    await finalizeManagedTestProductsPath(productsPath);
    const leaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      path.basename(productsPath),
    );
    mkdirSync(leaseDirectory, { recursive: true });
    writeFileSync(path.join(leaseDirectory, 'corrupt.json'), '{');

    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      force: true,
      now: afterHandoffNow(),
      minVisibleMs: 0,
      testProductsMaxCount: 0,
    });

    expect(existsSync(productsPath)).toBe(true);
  });

  it('aborts allocation when producer reservation state is malformed', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const reservationDirectory = path.join(layout.state, 'test-products-producers');
    mkdirSync(reservationDirectory, { recursive: true });
    writeFileSync(path.join(reservationDirectory, 'corrupt.json'), '{');

    await expect(prepareManagedTestProductsPath('test_new')).rejects.toThrow(
      'Invalid producer reservation',
    );
  });

  it('rejects symlinked coordination state without touching its target', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    createDefaultTestProductsPath('test_existing');
    const externalState = path.join(appDir, 'external-state');
    const externalReservationDirectory = path.join(
      externalState,
      'test-products-producers',
    );
    const valuablePath = path.join(externalReservationDirectory, 'valuable.tmp');
    mkdirSync(externalReservationDirectory, { recursive: true });
    writeFileSync(valuablePath, 'valuable');
    symlinkSync(externalState, layout.state, 'dir');

    await expect(prepareManagedTestProductsPath('test_new')).rejects.toThrow(
      'Managed coordination directory is not a regular directory',
    );
    expect(readFileSync(valuablePath, 'utf8')).toBe('valuable');
  });

  it('rejects a symlinked lifecycle-lock directory without touching its target', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    createDefaultTestProductsPath('test_existing');
    const externalLocks = path.join(appDir, 'external-locks');
    const externalLifecycleLock = path.join(externalLocks, 'filesystem-lifecycle.lock');
    const valuablePath = path.join(externalLifecycleLock, 'valuable');
    mkdirSync(externalLifecycleLock, { recursive: true });
    writeFileSync(valuablePath, 'valuable');
    symlinkSync(externalLocks, layout.locks, 'dir');

    await expect(
      acquireWorkspaceFilesystemLifecycleLock({
        workspaceKey: 'workspace-a',
        waitMs: 0,
      }),
    ).rejects.toThrow('Managed workspace lock directory is not a regular directory');
    expect(readFileSync(valuablePath, 'utf8')).toBe('valuable');
  });

  it('falls back to validated environment retention when project configuration is invalid', async () => {
    const configPath = path.join('/repo', '.xcodebuildmcp', 'config.yaml');
    await initConfigStore({
      cwd: '/repo',
      fs: createMockFileSystemExecutor({
        existsSync: (targetPath) => targetPath === configPath,
        readFile: async () => 'schemaVersion: 1\ntestProductsMaxCount: 0\n',
      }),
      env: {
        XCODEBUILDMCP_TEST_PRODUCTS_MAX_COUNT: '1',
        XCODEBUILDMCP_TEST_PRODUCTS_MAX_AGE_DAYS: '10',
      },
    });
    const existing = createDefaultTestProductsPath('test_existing');
    mkdirSync(existing);
    await finalizeManagedTestProductsPath(existing);
    ageCompletionMarker(existing);

    const next = await prepareManagedTestProductsPath('test_new');
    mkdirSync(next);
    await finalizeManagedTestProductsPath(next);
    await runWorkspaceFilesystemLifecycleSweep({
      workspaceKey: 'workspace-a',
      trigger: 'manual',
      force: true,
      now: afterHandoffNow(),
      minVisibleMs: 0,
      testProductsMaxCount: 1,
    });

    expect(existsSync(existing)).toBe(false);
  });

  it('fails finalization and releases the reservation when the marker cannot be written', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    mkdirSync(getTestProductsCompletionMarkerPath(productsPath));

    await expect(finalizeManagedTestProductsPath(productsPath)).rejects.toBeDefined();
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set());
  });

  it('keeps a finalizing producer protected until handoff succeeds', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const reservationPath = path.join(
      getWorkspaceFilesystemLayout('workspace-a').state,
      'test-products-producers',
      `${path.basename(productsPath)}.json`,
    );
    const reservationDirectory = path.dirname(reservationPath);
    await transitionTestProductsProducerReservationToFinalizing(
      'workspace-a',
      productsPath,
    );
    writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');

    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
        now: afterHandoffNow(),
      }),
    ).toEqual(new Set([path.basename(productsPath)]));

    chmodSync(reservationDirectory, 0o500);
    try {
      await expect(
        finalizeManagedTestProductsPath(productsPath, { retryDelayMs: 25 }),
      ).rejects.toBeDefined();
    } finally {
      chmodSync(reservationDirectory, 0o700);
    }
    expect(JSON.parse(readFileSync(reservationPath, 'utf8'))).toMatchObject({
      phase: 'finalizing',
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reservation = JSON.parse(readFileSync(reservationPath, 'utf8')) as {
        phase: string;
      };
      if (reservation.phase === 'handoff') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(readFileSync(reservationPath, 'utf8'))).toMatchObject({
      phase: 'handoff',
    });
  });

  it('fails finalization on malformed producer state', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const reservationPath = path.join(
      getWorkspaceFilesystemLayout('workspace-a').state,
      'test-products-producers',
      `${path.basename(productsPath)}.json`,
    );
    writeFileSync(reservationPath, '{');

    await expect(finalizeManagedTestProductsPath(productsPath)).rejects.toThrow(
      'Invalid producer reservation',
    );
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(false);
  });

  it('does not write a completion marker through a replaced test-products root', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const originalRoot = `${layout.testProducts}-original`;
    const externalRoot = path.join(appDir, 'external-test-products');
    renameSync(layout.testProducts, originalRoot);
    mkdirSync(path.join(externalRoot, path.basename(productsPath)), { recursive: true });
    symlinkSync(externalRoot, layout.testProducts, 'dir');

    await finalizeManagedTestProductsPath(productsPath);

    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(false);
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set());
  });

  it('retries finalization after a regular app-root replacement is restored', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const originalAppDir = `${appDir}-original`;
    const originalReservationPath = path.join(
      originalAppDir,
      path.relative(
        appDir,
        path.join(
          getWorkspaceFilesystemLayout('workspace-a').state,
          'test-products-producers',
          `${path.basename(productsPath)}.json`,
        ),
      ),
    );
    renameSync(appDir, originalAppDir);
    mkdirSync(appDir);

    try {
      await expect(
        finalizeManagedTestProductsPath(productsPath, { retryDelayMs: 25 }),
      ).rejects.toThrow('Managed coordination state root identity changed');
      expect(existsSync(originalReservationPath)).toBe(true);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      renameSync(originalAppDir, appDir);
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(getTestProductsCompletionMarkerPath(productsPath))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(true);
  });

  it('retries preserved producer state after an ownership inspection failure', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const originalRoot = `${layout.testProducts}-original`;
    renameSync(layout.testProducts, originalRoot);
    symlinkSync(layout.testProducts, layout.testProducts, 'dir');

    await expect(
      finalizeManagedTestProductsPath(productsPath, { retryDelayMs: 25 }),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    expect(
      await getActiveTestProductsProducerReservationNames('workspace-a', {
        cleanupStale: false,
      }),
    ).toEqual(new Set([path.basename(productsPath)]));

    rmSync(layout.testProducts, { force: true });
    renameSync(originalRoot, layout.testProducts);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(getTestProductsCompletionMarkerPath(productsPath))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(getTestProductsCompletionMarkerPath(productsPath))).toBe(true);
  });

  it('preserves both operation and finalization infrastructure failures', async () => {
    const productsPath = await prepareManagedTestProductsPath('test_sim');
    mkdirSync(productsPath);
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const originalRoot = `${layout.testProducts}-original`;
    const operationError = new Error('spawn failed');
    let caughtError: unknown;

    try {
      await withManagedTestProductsFinalization(productsPath, async () => {
        renameSync(layout.testProducts, originalRoot);
        symlinkSync(layout.testProducts, layout.testProducts, 'dir');
        throw operationError;
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    const aggregateError = caughtError as AggregateError;
    expect(aggregateError.errors[0]).toBe(operationError);
    expect(aggregateError.errors[1]).toMatchObject({ code: 'ELOOP' });
  });
});
