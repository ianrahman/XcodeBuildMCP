import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import { getTestProductsRetentionConfig } from './config-store.ts';
import { withAcquiredFsLock } from './fs-lock.ts';
import { log } from './logger.ts';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import {
  createDefaultTestProductsPath,
  markTestProductsPathCompleted,
  resolveManagedTestProductsLocation,
  resolveManagedTestProductsOwnership,
} from './test-products-path.ts';
import { pruneManagedTestProductsDirectory } from './test-products-lifecycle.ts';
import {
  createTestProductsProducerReservation,
  getActiveTestProductsProducerReservationNames,
  removeTestProductsProducerReservation,
  TEST_PRODUCTS_HANDOFF_LEASE_MS,
  TestProductsProducerReservationValidationError,
  transitionTestProductsProducerReservationToFinalizing,
  transitionTestProductsProducerReservationToHandoff,
  validateCreatedTestProductsProducerReservation,
} from './test-products-producer-reservation.ts';
import {
  TEST_PRODUCTS_DAY_MS,
  TEST_PRODUCTS_INCOMPLETE_MIN_VISIBLE_MS,
} from './test-products-retention-policy.ts';
import {
  readWorkspaceTestProductsRetentionPolicy,
  WorkspaceTestProductsRetentionPolicyValidationError,
  writeWorkspaceTestProductsRetentionPolicy,
  type WorkspaceTestProductsRetentionPolicy,
} from './test-products-retention-state.ts';
import {
  validateTestProductsStateRootIdentity,
  type TestProductsStateRootIdentity,
} from './test-products-state-path.ts';
import { workspaceKeyForRoot } from './workspace-identity.ts';
import {
  acquireWorkspaceFilesystemLifecycleLock,
  tryAcquireWorkspaceFilesystemLifecycleLock,
  WorkspaceFilesystemLifecycleLockTimeoutError,
} from './workspace-filesystem-lock.ts';

export interface PrepareManagedTestProductsPathOptions {
  lockWaitMs?: number;
  now?: number;
}

export interface FinalizeManagedTestProductsPathOptions {
  lockWaitMs?: number;
  maintenanceRetryDelayMs?: number;
  maxRetryAttempts?: number;
  retryDelayMs?: number;
}

export interface ManagedTestProductsOperationFailure {
  error: unknown;
}

const TEST_PRODUCTS_FINALIZATION_MAINTENANCE_RETRY_DELAY_MS = 60 * 1000;
const TEST_PRODUCTS_FINALIZATION_RETRY_DELAY_MS = 1000;
const TEST_PRODUCTS_FINALIZATION_MAX_RETRY_ATTEMPTS = 2;
const scheduledFinalizationRetries = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const scheduledWorkspaceTestProductsPrunes = new Map<
  string,
  {
    notBeforeMs: number;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const managedTestProductsStateRootIdentities = new Map<
  string,
  TestProductsStateRootIdentity
>();

interface FinalizationAttemptOptions
  extends FinalizeManagedTestProductsPathOptions {
  retriesRemaining: number;
}

function resolveWorkspaceKey(): string {
  return getRuntimeInstanceIfConfigured()?.workspaceKey ?? workspaceKeyForRoot(process.cwd());
}

function resolveCurrentTestProductsRetentionPolicy(): WorkspaceTestProductsRetentionPolicy {
  const retention = getTestProductsRetentionConfig();
  if (retention.status === 'invalid') {
    log(
      'warn',
      'Project configuration is invalid; applying test-products retention from validated environment values or defaults.',
    );
  }
  return {
    maxCount: retention.maxCount,
    maxAgeDays: retention.maxAgeDays,
  };
}

async function pruneWorkspaceManagedTestProducts(
  workspaceKey: string,
  evaluationTimeMs: number,
  preferredRetainedArtifactName?: string,
  retentionPolicy = resolveCurrentTestProductsRetentionPolicy(),
): Promise<void> {
  const activeProducerReservationNames =
    await getActiveTestProductsProducerReservationNames(workspaceKey, {
      cleanupStale: true,
      now: evaluationTimeMs,
    });
  if (preferredRetainedArtifactName) {
    activeProducerReservationNames.delete(preferredRetainedArtifactName);
  }
  await pruneManagedTestProductsDirectory({
    testProductsDir: getWorkspaceFilesystemLayout(workspaceKey).testProducts,
    now: evaluationTimeMs,
    minVisibleMs: TEST_PRODUCTS_INCOMPLETE_MIN_VISIBLE_MS,
    maxAgeMs: retentionPolicy.maxAgeDays * TEST_PRODUCTS_DAY_MS,
    maxCount: retentionPolicy.maxCount,
    preferredRetainedArtifactName,
    activeProducerReservationNames,
    cleanupStaleReaderLeases: true,
  });
}

async function pruneWorkspaceManagedTestProductsBestEffort(
  workspaceKey: string,
  testProductsPath: string,
  preferredRetainedArtifactName?: string,
): Promise<void> {
  try {
    await pruneWorkspaceManagedTestProducts(
      workspaceKey,
      Date.now(),
      preferredRetainedArtifactName,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Post-completion test products retention failed for ${displayPath(testProductsPath)}: ${message}`,
    );
  }
}

export function scheduleWorkspaceTestProductsPrune(
  workspaceKey: string,
  notBeforeMs: number,
): void {
  const existing = scheduledWorkspaceTestProductsPrunes.get(workspaceKey);
  const scheduledNotBeforeMs = Math.max(
    existing?.notBeforeMs ?? notBeforeMs,
    notBeforeMs,
  );
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(async () => {
    const scheduled = scheduledWorkspaceTestProductsPrunes.get(workspaceKey);
    if (!scheduled || scheduled.timer !== timer) {
      return;
    }
    scheduledWorkspaceTestProductsPrunes.delete(workspaceKey);

    try {
      const lock = await tryAcquireWorkspaceFilesystemLifecycleLock({ workspaceKey });
      if (!lock) {
        throw new Error('Workspace filesystem lifecycle lock is busy');
      }
      await withAcquiredFsLock(lock, async () => {
        const retentionPolicy =
          await readWorkspaceTestProductsRetentionPolicy(workspaceKey);
        if (!retentionPolicy) {
          log(
            'warn',
            `Scheduled test products retention skipped because workspace policy is unavailable: ${workspaceKey}`,
          );
          return;
        }
        await pruneWorkspaceManagedTestProducts(
          workspaceKey,
          Math.max(Date.now(), scheduledNotBeforeMs),
          undefined,
          retentionPolicy,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        'warn',
        `Scheduled test products retention failed for workspace ${workspaceKey}: ${message}`,
      );
      if (error instanceof WorkspaceTestProductsRetentionPolicyValidationError) {
        return;
      }
      if (!scheduledWorkspaceTestProductsPrunes.has(workspaceKey)) {
        scheduleWorkspaceTestProductsPrune(
          workspaceKey,
          Date.now() + TEST_PRODUCTS_FINALIZATION_RETRY_DELAY_MS,
        );
      }
    }
  }, Math.max(1, scheduledNotBeforeMs - Date.now() + 1));
  timer.unref?.();
  scheduledWorkspaceTestProductsPrunes.set(workspaceKey, {
    notBeforeMs: scheduledNotBeforeMs,
    timer,
  });
}

function cancelScheduledFinalizationRetry(testProductsPath: string): void {
  const timer = scheduledFinalizationRetries.get(testProductsPath);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  scheduledFinalizationRetries.delete(testProductsPath);
}

function scheduleFinalizationRetry(
  testProductsPath: string,
  options: FinalizationAttemptOptions,
): void {
  if (scheduledFinalizationRetries.has(testProductsPath)) {
    return;
  }
  const isMaintenanceRetry = options.retriesRemaining <= 0;
  if (isMaintenanceRetry) {
    log(
      'warn',
      `Managed test products finalization foreground retries were exhausted for ${displayPath(testProductsPath)}; continuing background maintenance without keeping this process alive.`,
    );
  }
  const retryDelayMs = Math.max(
    25,
    isMaintenanceRetry
      ? (options.maintenanceRetryDelayMs ??
        TEST_PRODUCTS_FINALIZATION_MAINTENANCE_RETRY_DELAY_MS)
      : (options.retryDelayMs ?? TEST_PRODUCTS_FINALIZATION_RETRY_DELAY_MS),
  );
  const timer = setTimeout(() => {
    scheduledFinalizationRetries.delete(testProductsPath);
    void finalizeManagedTestProductsPathAttempt(testProductsPath, {
      ...options,
      retriesRemaining: Math.max(0, options.retriesRemaining - 1),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(
        'warn',
        `Managed test products finalization retry failed for ${displayPath(testProductsPath)}: ${message}`,
      );
    });
  }, retryDelayMs);
  if (isMaintenanceRetry) {
    timer.unref?.();
  }
  scheduledFinalizationRetries.set(testProductsPath, timer);
}

export function resetManagedTestProductsFinalizationStateForTests(): void {
  for (const timer of scheduledFinalizationRetries.values()) {
    clearTimeout(timer);
  }
  scheduledFinalizationRetries.clear();
  for (const scheduled of scheduledWorkspaceTestProductsPrunes.values()) {
    clearTimeout(scheduled.timer);
  }
  scheduledWorkspaceTestProductsPrunes.clear();
  managedTestProductsStateRootIdentities.clear();
}

export async function prepareManagedTestProductsPath(
  toolName: string,
  options: PrepareManagedTestProductsPathOptions = {},
): Promise<string> {
  const workspaceKey = resolveWorkspaceKey();
  const lock = await acquireWorkspaceFilesystemLifecycleLock({
    workspaceKey,
    waitMs: options.lockWaitMs,
  });

  let preparedTestProductsPath: string | null = null;
  try {
    return await withAcquiredFsLock(lock, async () => {
      const evaluationTimeMs = options.now ?? Date.now();
      const testProductsPath = createDefaultTestProductsPath(toolName, workspaceKey);
      preparedTestProductsPath = testProductsPath;
      const reservation = await createTestProductsProducerReservation(
        workspaceKey,
        testProductsPath,
        evaluationTimeMs,
      );
      const { stateRootIdentity } = reservation;
      const retentionPolicy = resolveCurrentTestProductsRetentionPolicy();
      managedTestProductsStateRootIdentities.set(testProductsPath, stateRootIdentity);
      try {
        await validateCreatedTestProductsProducerReservation(reservation);
        await writeWorkspaceTestProductsRetentionPolicy(
          workspaceKey,
          retentionPolicy,
          stateRootIdentity,
        );
        await pruneWorkspaceManagedTestProducts(
          workspaceKey,
          evaluationTimeMs,
          undefined,
          retentionPolicy,
        );
        return testProductsPath;
      } catch (error) {
        try {
          await removeTestProductsProducerReservation(
            workspaceKey,
            path.basename(testProductsPath),
            stateRootIdentity,
          );
          managedTestProductsStateRootIdentities.delete(testProductsPath);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Unable to prepare managed test products and release its reservation: ${displayPath(testProductsPath)}`,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (
      preparedTestProductsPath &&
      managedTestProductsStateRootIdentities.has(preparedTestProductsPath)
    ) {
      scheduleFinalizationRetry(preparedTestProductsPath, {
        retriesRemaining: TEST_PRODUCTS_FINALIZATION_MAX_RETRY_ATTEMPTS,
      });
    }
    throw error;
  }
}

export async function finalizeManagedTestProductsPath(
  testProductsPath: string | undefined,
  options: FinalizeManagedTestProductsPathOptions = {},
): Promise<void> {
  await finalizeManagedTestProductsPathAttempt(testProductsPath, {
    ...options,
    retriesRemaining: Math.max(
      0,
      Math.floor(
        options.maxRetryAttempts ??
          TEST_PRODUCTS_FINALIZATION_MAX_RETRY_ATTEMPTS,
      ),
    ),
  });
}

export async function finalizeManagedTestProductsPathPreservingFailure(
  testProductsPath: string | undefined,
  operationFailure?: ManagedTestProductsOperationFailure,
  options: FinalizeManagedTestProductsPathOptions = {},
): Promise<void> {
  try {
    await finalizeManagedTestProductsPath(testProductsPath, options);
  } catch (finalizationError) {
    if (operationFailure) {
      throw new AggregateError(
        [operationFailure.error, finalizationError],
        `Managed test products finalization also failed for ${
          testProductsPath ? displayPath(testProductsPath) : 'an unknown path'
        }`,
      );
    }
    throw finalizationError;
  }
}

export async function withManagedTestProductsFinalization<T>(
  testProductsPath: string | undefined,
  operation: () => Promise<T>,
  options: FinalizeManagedTestProductsPathOptions = {},
): Promise<T> {
  let operationFailure: ManagedTestProductsOperationFailure | undefined;
  try {
    return await operation();
  } catch (error) {
    operationFailure = { error };
    throw error;
  } finally {
    await finalizeManagedTestProductsPathPreservingFailure(
      testProductsPath,
      operationFailure,
      options,
    );
  }
}

async function finalizeManagedTestProductsPathAttempt(
  testProductsPath: string | undefined,
  options: FinalizationAttemptOptions,
): Promise<void> {
  if (!testProductsPath) {
    return;
  }

  const location = resolveManagedTestProductsLocation(testProductsPath);
  if (!location) {
    return;
  }
  const expectedStateRootIdentity =
    managedTestProductsStateRootIdentities.get(location.path);
  if (expectedStateRootIdentity) {
    try {
      await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
    } catch (error) {
      scheduleFinalizationRetry(location.path, options);
      throw error;
    }
  }

  let lock: Awaited<ReturnType<typeof acquireWorkspaceFilesystemLifecycleLock>>;
  try {
    lock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: location.layout.workspaceKey,
      waitMs: options.lockWaitMs,
    });
  } catch (error) {
    scheduleFinalizationRetry(location.path, options);
    if (!(error instanceof WorkspaceFilesystemLifecycleLockTimeoutError)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Managed test products finalization was deferred for ${displayPath(testProductsPath)}: ${message}`,
    );
    return;
  }
  cancelScheduledFinalizationRetry(location.path);

  await withAcquiredFsLock(lock, async () => {
    if (expectedStateRootIdentity) {
      try {
        await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
      } catch (error) {
        scheduleFinalizationRetry(location.path, options);
        throw error;
      }
    }
    let ownership: Awaited<ReturnType<typeof resolveManagedTestProductsOwnership>>;
    try {
      ownership = await resolveManagedTestProductsOwnership(testProductsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        'warn',
        `Unable to validate managed test products before finalization at ${displayPath(testProductsPath)}: ${message}`,
      );
      scheduleFinalizationRetry(location.path, options);
      throw error;
    }

    if (!ownership) {
      log(
        'warn',
        `Managed test products ownership changed before finalization; skipping completion marker: ${displayPath(testProductsPath)}`,
      );
      try {
        await removeTestProductsProducerReservation(
          location.layout.workspaceKey,
          location.name,
          expectedStateRootIdentity,
        );
        managedTestProductsStateRootIdentities.delete(location.path);
      } catch (error) {
        scheduleFinalizationRetry(location.path, options);
        throw error;
      }
      await pruneWorkspaceManagedTestProductsBestEffort(
        location.layout.workspaceKey,
        testProductsPath,
      );
      return;
    }

    try {
      await transitionTestProductsProducerReservationToFinalizing(
        ownership.layout.workspaceKey,
        ownership.path,
        expectedStateRootIdentity,
      );
    } catch (error) {
      if (!(error instanceof TestProductsProducerReservationValidationError)) {
        scheduleFinalizationRetry(location.path, options);
      }
      throw error;
    }

    let completionResult: ReturnType<typeof markTestProductsPathCompleted>;
    try {
      completionResult = markTestProductsPathCompleted(ownership.canonicalPath);
    } catch (completionError) {
      try {
        await removeTestProductsProducerReservation(
          ownership.layout.workspaceKey,
          ownership.name,
          expectedStateRootIdentity,
        );
        managedTestProductsStateRootIdentities.delete(location.path);
      } catch (reservationError) {
        scheduleFinalizationRetry(location.path, options);
        throw new AggregateError(
          [completionError, reservationError],
          `Test products completion and reservation cleanup both failed: ${displayPath(testProductsPath)}`,
        );
      }
      await pruneWorkspaceManagedTestProductsBestEffort(
        ownership.layout.workspaceKey,
        testProductsPath,
        ownership.name,
      );
      throw completionError;
    }

    if (completionResult === 'missing') {
      try {
        await removeTestProductsProducerReservation(
          ownership.layout.workspaceKey,
          ownership.name,
          expectedStateRootIdentity,
        );
        managedTestProductsStateRootIdentities.delete(location.path);
      } catch (error) {
        scheduleFinalizationRetry(location.path, options);
        throw error;
      }
      await pruneWorkspaceManagedTestProductsBestEffort(
        ownership.layout.workspaceKey,
        testProductsPath,
      );
      return;
    }

    await pruneWorkspaceManagedTestProductsBestEffort(
      ownership.layout.workspaceKey,
      testProductsPath,
      ownership.name,
    );
    const handoffAtMs = Date.now();
    try {
      await transitionTestProductsProducerReservationToHandoff(
        ownership.layout.workspaceKey,
        ownership.path,
        handoffAtMs,
        expectedStateRootIdentity,
      );
      scheduleWorkspaceTestProductsPrune(
        ownership.layout.workspaceKey,
        handoffAtMs + TEST_PRODUCTS_HANDOFF_LEASE_MS,
      );
      managedTestProductsStateRootIdentities.delete(location.path);
    } catch (error) {
      if (!(error instanceof TestProductsProducerReservationValidationError)) {
        scheduleFinalizationRetry(location.path, options);
      }
      throw error;
    }
  });
}
