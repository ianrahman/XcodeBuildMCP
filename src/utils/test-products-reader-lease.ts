import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import { withAcquiredFsLock } from './fs-lock.ts';
import { log } from './logger.ts';
import { getWorkspaceFilesystemLayout } from './log-paths.ts';
import { isPidAlive } from './process-liveness.ts';
import {
  isXcodeBuildMCPManagedTestProductsName,
  resolveManagedTestProductsOwnership,
  resolvePreparedTestSource,
  type ManagedTestProductsOwnership,
} from './test-products-path.ts';
import {
  captureTestProductsStateRootIdentity,
  resolveTestProductsStateDirectory,
  validateTestProductsStateRootIdentity,
  type TestProductsStateRootIdentity,
} from './test-products-state-path.ts';
import { acquireWorkspaceFilesystemLifecycleLock } from './workspace-filesystem-lock.ts';

const READER_LEASE_VERSION = 1;
const MAX_PREPARED_SOURCE_WORKSPACE_TRANSITIONS = 3;
const READER_LEASE_RELEASE_RETRY_DELAY_MS = 60 * 1000;

interface TestProductsReaderLeaseRecord {
  version: typeof READER_LEASE_VERSION;
  token: string;
  pid: number;
  testProductsPath: string;
  createdAtMs: number;
  releasedAtMs?: number;
}

type ReaderLeaseReadResult =
  | { status: 'missing' }
  | { status: 'valid'; record: TestProductsReaderLeaseRecord }
  | { status: 'unreadable'; error: unknown };

export interface TestProductsReaderLeaseTimingOptions {
  lockWaitMs?: number;
  onReleased?: (workspaceKey: string) => void;
}

const scheduledReaderLeaseReleaseRetries = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

export function resetTestProductsReaderLeaseReleaseRetriesForTests(): void {
  for (const timer of scheduledReaderLeaseReleaseRetries.values()) {
    clearTimeout(timer);
  }
  scheduledReaderLeaseReleaseRetries.clear();
}

function readerLeaseDirectory(workspaceKey: string, artifactName: string): string {
  return path.join(
    getWorkspaceFilesystemLayout(workspaceKey).state,
    'test-products-readers',
    artifactName,
  );
}

export function getTestProductsReaderLeaseDirectory(
  workspaceKey: string,
  artifactName: string,
): string {
  if (!isXcodeBuildMCPManagedTestProductsName(artifactName)) {
    throw new Error(`Invalid managed test products name: ${artifactName}`);
  }
  return readerLeaseDirectory(workspaceKey, artifactName);
}

function isReaderLeaseRecord(value: unknown): value is TestProductsReaderLeaseRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<TestProductsReaderLeaseRecord>;
  return (
    record.version === READER_LEASE_VERSION &&
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.testProductsPath === 'string' &&
    Number.isFinite(record.createdAtMs) &&
    (record.releasedAtMs === undefined || Number.isFinite(record.releasedAtMs))
  );
}

async function readReaderLease(filePath: string): Promise<ReaderLeaseReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable', error };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReaderLeaseRecord(parsed)
      ? { status: 'valid', record: parsed }
      : {
          status: 'unreadable',
          error: new Error(`Invalid reader lease record at ${displayPath(filePath)}`),
        };
  } catch (error) {
    return { status: 'unreadable', error };
  }
}

async function writeReaderLeaseAtomically(
  filePath: string,
  record: TestProductsReaderLeaseRecord,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Reader lease write and temporary-file cleanup both failed: ${displayPath(filePath)}`,
      );
    }
    throw error;
  }
}

function readerLeaseIsActive(
  record: TestProductsReaderLeaseRecord,
  ownership: ManagedTestProductsOwnership,
): boolean {
  return (
    record.testProductsPath === ownership.canonicalPath &&
    record.releasedAtMs === undefined &&
    isPidAlive(record.pid)
  );
}

export async function hasActiveTestProductsReaderLease(
  testProductsPath: string,
  _evaluationTimeMs: number,
  options: { cleanupStale: boolean },
): Promise<boolean> {
  const ownership = await resolveManagedTestProductsOwnership(testProductsPath);
  if (!ownership) {
    return false;
  }

  const leaseDirectory = readerLeaseDirectory(ownership.layout.workspaceKey, ownership.name);
  let managedLeaseDirectory: string | null;
  try {
    managedLeaseDirectory = await resolveTestProductsStateDirectory(
      ownership.layout.workspaceKey,
      'test-products-readers',
      { create: false, artifactName: ownership.name },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Unable to validate test products reader state at ${displayPath(leaseDirectory)}: ${message}`,
    );
    return true;
  }
  if (!managedLeaseDirectory) {
    return false;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(managedLeaseDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Unable to inspect test products reader leases at ${displayPath(leaseDirectory)}: ${message}`,
    );
    return true;
  }

  let active = false;
  for (const entry of entries) {
    const leasePath = path.join(managedLeaseDirectory, entry);
    if (entry.endsWith('.tmp')) {
      if (options.cleanupStale) {
        await fs.rm(leasePath, { recursive: true, force: true });
      }
      continue;
    }
    const result = await readReaderLease(leasePath);
    if (result.status === 'valid' && readerLeaseIsActive(result.record, ownership)) {
      active = true;
      continue;
    }
    if (result.status === 'unreadable') {
      const message =
        result.error instanceof Error ? result.error.message : String(result.error);
      log(
        'warn',
        `Unable to validate test products reader lease at ${displayPath(leasePath)}: ${message}`,
      );
      active = true;
      continue;
    }
    if (options.cleanupStale) {
      await fs.rm(leasePath, { recursive: true, force: true });
    }
  }

  if (options.cleanupStale && !active) {
    await fs.rmdir(managedLeaseDirectory).catch(() => undefined);
  }
  return active;
}

export async function removeTestProductsReaderLeaseDirectory(
  workspaceKey: string,
  artifactName: string,
): Promise<void> {
  if (!isXcodeBuildMCPManagedTestProductsName(artifactName)) {
    return;
  }
  const leaseDirectory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-readers',
    { create: false, artifactName },
  );
  if (!leaseDirectory) {
    return;
  }
  await fs.rm(leaseDirectory, { recursive: true, force: true });
}

interface AcquiredReaderLease {
  ownership: ManagedTestProductsOwnership;
  leasePath: string;
  record: TestProductsReaderLeaseRecord;
  stateRootIdentity: TestProductsStateRootIdentity;
  lockWaitMs?: number;
}

function readerLeaseRecordsEqual(
  left: TestProductsReaderLeaseRecord,
  right: TestProductsReaderLeaseRecord,
): boolean {
  return (
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.testProductsPath === right.testProductsPath &&
    left.createdAtMs === right.createdAtMs &&
    left.releasedAtMs === right.releasedAtMs
  );
}

async function createReaderLeaseUnderLock(
  ownership: ManagedTestProductsOwnership,
  lockWaitMs?: number,
): Promise<AcquiredReaderLease> {
  const now = Date.now();
  const token = randomUUID();
  const leaseDirectory = await resolveTestProductsStateDirectory(
    ownership.layout.workspaceKey,
    'test-products-readers',
    { create: true, artifactName: ownership.name },
  );
  const stateRootIdentity = await captureTestProductsStateRootIdentity(
    ownership.layout.workspaceKey,
  );
  const leasePath = path.join(leaseDirectory, `${token}.json`);
  const record: TestProductsReaderLeaseRecord = {
    version: READER_LEASE_VERSION,
    token,
    pid: process.pid,
    testProductsPath: ownership.canonicalPath,
    createdAtMs: now,
  };
  await writeReaderLeaseAtomically(leasePath, record);
  return { ownership, leasePath, record, stateRootIdentity, lockWaitMs };
}

async function validateCreatedReaderLease(lease: AcquiredReaderLease): Promise<void> {
  await validateTestProductsStateRootIdentity(lease.stateRootIdentity);
  const leaseDirectory = await resolveTestProductsStateDirectory(
    lease.ownership.layout.workspaceKey,
    'test-products-readers',
    { create: false, artifactName: lease.ownership.name },
  );
  if (!leaseDirectory || leaseDirectory !== path.dirname(lease.leasePath)) {
    throw new Error(
      `Reader lease directory changed during acquisition: ${displayPath(lease.leasePath)}`,
    );
  }
  const published = await readReaderLease(lease.leasePath);
  if (published.status === 'unreadable') {
    throw published.error;
  }
  if (
    published.status === 'missing' ||
    !readerLeaseRecordsEqual(published.record, lease.record)
  ) {
    throw new Error(
      `Reader lease was not published in the validated state root: ${displayPath(lease.leasePath)}`,
    );
  }
  await validateTestProductsStateRootIdentity(lease.stateRootIdentity);
}

async function acquireReaderLease(
  ownership: ManagedTestProductsOwnership,
  options: TestProductsReaderLeaseTimingOptions,
): Promise<AcquiredReaderLease> {
  const lock = await acquireWorkspaceFilesystemLifecycleLock({
    workspaceKey: ownership.layout.workspaceKey,
    waitMs: options.lockWaitMs,
  });
  let createdLease: AcquiredReaderLease | null = null;
  try {
    return await withAcquiredFsLock(lock, async () => {
      const currentOwnership = await resolveManagedTestProductsOwnership(ownership.path);
      if (!currentOwnership) {
        throw new Error(
          `Managed test products disappeared before test execution: ${displayPath(ownership.path)}`,
        );
      }
      createdLease = await createReaderLeaseUnderLock(
        currentOwnership,
        options.lockWaitMs,
      );
      await validateCreatedReaderLease(createdLease);
      return createdLease;
    });
  } catch (error) {
    await rethrowAfterReaderLeaseAcquisitionFailure(
      error,
      createdLease,
      options.onReleased,
    );
  }
}

async function releaseReaderLease(lease: AcquiredReaderLease): Promise<void> {
  await validateTestProductsStateRootIdentity(lease.stateRootIdentity);
  const lock = await acquireWorkspaceFilesystemLifecycleLock({
    workspaceKey: lease.ownership.layout.workspaceKey,
    waitMs: lease.lockWaitMs,
  });
  await withAcquiredFsLock(lock, () => releaseReaderLeaseUnderLock(lease));
}

async function releaseReaderLeaseUnderLock(
  lease: AcquiredReaderLease,
): Promise<void> {
  await validateTestProductsStateRootIdentity(lease.stateRootIdentity);
  const leaseDirectory = await resolveTestProductsStateDirectory(
    lease.ownership.layout.workspaceKey,
    'test-products-readers',
    { create: false, artifactName: lease.ownership.name },
  );
  if (!leaseDirectory) {
    return;
  }
  if (leaseDirectory !== path.dirname(lease.leasePath)) {
    throw new Error(
      `Reader lease directory changed before release: ${displayPath(lease.leasePath)}`,
    );
  }
  await validateTestProductsStateRootIdentity(lease.stateRootIdentity);
  const current = await readReaderLease(lease.leasePath);
  if (current.status === 'missing') {
    return;
  }
  let validationError: unknown;
  if (current.status === 'unreadable') {
    validationError = current.error;
  }
  if (current.status === 'valid') {
    if (current.record.token !== lease.record.token) {
      validationError = new Error(
        `Reader lease token changed before release at ${displayPath(lease.leasePath)}`,
      );
    }
  }
  if (current.status === 'valid' && !validationError) {
    lease.record = {
      ...current.record,
      releasedAtMs: current.record.releasedAtMs ?? Date.now(),
    };
    await writeReaderLeaseAtomically(lease.leasePath, lease.record);
  }
  try {
    await fs.rm(lease.leasePath, { force: true });
  } catch (cleanupError) {
    if (validationError) {
      throw new AggregateError(
        [validationError, cleanupError],
        `Reader lease validation and cleanup both failed: ${displayPath(lease.leasePath)}`,
      );
    }
    throw cleanupError;
  }
  if (validationError) {
    throw validationError;
  }
}

function notifyReaderLeaseReleased(
  lease: AcquiredReaderLease,
  onReleased: TestProductsReaderLeaseTimingOptions['onReleased'],
): void {
  try {
    onReleased?.(lease.ownership.layout.workspaceKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Reader lease release callback failed for ${displayPath(lease.ownership.path)}: ${message}`,
    );
  }
}

function scheduleReaderLeaseReleaseRetry(
  lease: AcquiredReaderLease,
  onReleased?: TestProductsReaderLeaseTimingOptions['onReleased'],
): void {
  const retryKey = `${lease.leasePath}:${lease.record.token}`;
  if (scheduledReaderLeaseReleaseRetries.has(retryKey)) {
    return;
  }
  const timer = setTimeout(() => {
    scheduledReaderLeaseReleaseRetries.delete(retryKey);
    void releaseReaderLease(lease)
      .then(() => {
        notifyReaderLeaseReleased(lease, onReleased);
      })
      .catch(() => {
        scheduleReaderLeaseReleaseRetry(lease, onReleased);
      });
  }, READER_LEASE_RELEASE_RETRY_DELAY_MS);
  timer.unref?.();
  scheduledReaderLeaseReleaseRetries.set(retryKey, timer);
}

async function rethrowAfterReaderLeaseAcquisitionFailure(
  acquisitionError: unknown,
  createdLease: AcquiredReaderLease | null,
  onReleased: TestProductsReaderLeaseTimingOptions['onReleased'],
): Promise<never> {
  if (createdLease) {
    try {
      await releaseReaderLease(createdLease);
      notifyReaderLeaseReleased(createdLease, onReleased);
    } catch (cleanupError) {
      scheduleReaderLeaseReleaseRetry(createdLease, onReleased);
      throw new AggregateError(
        [acquisitionError, cleanupError],
        `Reader lease acquisition and rollback both failed: ${displayPath(createdLease.leasePath)}`,
      );
    }
  }
  throw acquisitionError;
}

async function runWithReaderLease<T>(
  lease: AcquiredReaderLease,
  operation: () => Promise<T>,
  onReleased: TestProductsReaderLeaseTimingOptions['onReleased'],
): Promise<T> {
  let operationFailure: { error: unknown } | undefined;
  try {
    return await operation();
  } catch (error) {
    operationFailure = { error };
    throw error;
  } finally {
    try {
      await releaseReaderLease(lease);
      notifyReaderLeaseReleased(lease, onReleased);
    } catch (releaseError) {
      scheduleReaderLeaseReleaseRetry(lease, onReleased);
      if (operationFailure) {
        throw new AggregateError(
          [operationFailure.error, releaseError],
          `Test operation and reader lease release both failed: ${displayPath(lease.ownership.path)}`,
        );
      }
      throw releaseError;
    }
  }
}

export async function withTestProductsReaderLease<T>(
  testProductsPath: string,
  operation: () => Promise<T>,
  options: TestProductsReaderLeaseTimingOptions = {},
): Promise<T> {
  const ownership = await resolveManagedTestProductsOwnership(testProductsPath);
  if (!ownership) {
    return operation();
  }

  const lease = await acquireReaderLease(ownership, options);
  return runWithReaderLease(lease, operation, options.onReleased);
}

export async function withPreparedTestProductsReaderLease<T>(
  preparedSourcePath: string,
  operation: (canonicalSourcePath: string) => Promise<T>,
  options: TestProductsReaderLeaseTimingOptions = {},
): Promise<T> {
  const initialSource = await resolvePreparedTestSource(preparedSourcePath);
  if (!initialSource.location) {
    return operation(initialSource.sourcePath);
  }
  let workspaceKey = initialSource.location.layout.workspaceKey;

  for (
    let transitionCount = 0;
    transitionCount < MAX_PREPARED_SOURCE_WORKSPACE_TRANSITIONS;
    transitionCount += 1
  ) {
    const lock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey,
      waitMs: options.lockWaitMs,
    });
    let createdLease: AcquiredReaderLease | null = null;
    let resolution: {
      canonicalSourcePath: string;
      lease: AcquiredReaderLease | null;
      nextWorkspaceKey: string | null;
    };
    try {
      resolution = await withAcquiredFsLock(lock, async () => {
        const resolvedSource = await resolvePreparedTestSource(preparedSourcePath);
        if (!resolvedSource.location) {
          throw new Error(
            `Managed prepared test source moved outside managed storage before reader lease acquisition: ${displayPath(preparedSourcePath)}`,
          );
        }
        let nextWorkspaceKey: string | null = null;
        const sourceWorkspaceKey = resolvedSource.location.layout.workspaceKey;
        if (sourceWorkspaceKey === workspaceKey) {
          if (!resolvedSource.ownership) {
            throw new Error(
              `Managed test products became invalid before reader lease acquisition: ${displayPath(resolvedSource.location.path)}`,
            );
          }
          createdLease = await createReaderLeaseUnderLock(
            resolvedSource.ownership,
            options.lockWaitMs,
          );
          await validateCreatedReaderLease(createdLease);
        } else {
          nextWorkspaceKey = sourceWorkspaceKey;
        }
        return {
          canonicalSourcePath: resolvedSource.sourcePath,
          lease: createdLease,
          nextWorkspaceKey,
        };
      });
    } catch (error) {
      await rethrowAfterReaderLeaseAcquisitionFailure(
        error,
        createdLease,
        options.onReleased,
      );
    }

    if (resolution.nextWorkspaceKey) {
      workspaceKey = resolution.nextWorkspaceKey;
      continue;
    }
    if (!resolution.lease) {
      return operation(resolution.canonicalSourcePath);
    }
    return runWithReaderLease(
      resolution.lease,
      () => operation(resolution.canonicalSourcePath),
      options.onReleased,
    );
  }

  throw new Error(
    `Prepared test source changed workspaces while acquiring a reader lease: ${displayPath(preparedSourcePath)}`,
  );
}
