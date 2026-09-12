import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from './process-liveness.ts';
import {
  FS_LOCK_OWNER_FILE,
  fsLockOwnersEqual,
  guardDirForLockDir,
  isFsLockOwner,
  type FsLockOwner,
} from './fs-lock-shared.ts';

export { FS_LOCK_OWNER_FILE, type FsLockOwner } from './fs-lock-shared.ts';

export interface AcquiredFsLock {
  readonly owner: FsLockOwner;
  release(): Promise<void>;
}

export interface FsLockOperationFailure {
  error: unknown;
}

export interface TryAcquireFsLockOptions {
  lockDir: string;
  purpose: string;
  leaseMs: number;
  now?: number;
  pid?: number;
}

export async function releaseFsLockPreservingFailure(
  lock: AcquiredFsLock,
  operationFailure?: FsLockOperationFailure,
): Promise<void> {
  try {
    await lock.release();
  } catch (releaseError) {
    if (operationFailure) {
      throw new AggregateError(
        [operationFailure.error, releaseError],
        'Filesystem operation and lock release both failed',
      );
    }
    throw releaseError;
  }
}

export async function withAcquiredFsLock<T>(
  lock: AcquiredFsLock,
  operation: () => Promise<T>,
): Promise<T> {
  let operationFailure: FsLockOperationFailure | undefined;
  try {
    return await operation();
  } catch (error) {
    operationFailure = { error };
    throw error;
  } finally {
    await releaseFsLockPreservingFailure(lock, operationFailure);
  }
}

type LockOwnerReadResult =
  | { status: 'valid'; owner: FsLockOwner }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'unreadable'; error: unknown };

interface LockDirectoryIdentity {
  dev: number;
  ino: number;
}

type LockDirectoryReleaseResult =
  | { status: 'removed' }
  | { status: 'logically-released'; error: unknown };

type MarkLockReleasedResult = 'marked' | 'gone' | 'owner-mismatch';

const FS_LOCK_RELEASE_RETRY_ATTEMPTS = 3;
const FS_LOCK_RELEASE_RETRY_DELAY_MS = 10;
const FS_LOCK_RELEASE_MAINTENANCE_RETRY_DELAY_MS = 60 * 1000;
const scheduledLockReleaseRetries = new Map<string, ReturnType<typeof setTimeout>>();

function lockReleaseRetryKey(
  lockDir: string,
  identity: LockDirectoryIdentity,
): string {
  return `${lockDir}:${String(identity.dev)}:${String(identity.ino)}`;
}

export function resetFsLockReleaseRetriesForTests(): void {
  for (const timer of scheduledLockReleaseRetries.values()) {
    clearTimeout(timer);
  }
  scheduledLockReleaseRetries.clear();
}

async function readLockOwner(lockDir: string): Promise<LockOwnerReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(lockDir, FS_LOCK_OWNER_FILE), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable', error };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isFsLockOwner(parsed)
      ? { status: 'valid', owner: parsed }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

async function captureLockDirectoryIdentity(lockDir: string): Promise<LockDirectoryIdentity> {
  const stat = await fs.lstat(lockDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Filesystem lock is not a regular directory: ${lockDir}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function lockDirectoryIdentityMatches(
  lockDir: string,
  expectedIdentity: LockDirectoryIdentity,
): Promise<boolean> {
  let currentIdentity: LockDirectoryIdentity;
  try {
    currentIdentity = await captureLockDirectoryIdentity(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return (
    currentIdentity.dev === expectedIdentity.dev &&
    currentIdentity.ino === expectedIdentity.ino
  );
}

async function writeLockOwnerAtomically(
  lockDir: string,
  owner: FsLockOwner,
): Promise<void> {
  const ownerPath = path.join(lockDir, FS_LOCK_OWNER_FILE);
  const tempPath = `${ownerPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tempPath, ownerPath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Filesystem lock owner publication and temporary-file cleanup both failed: ${lockDir}`,
      );
    }
    throw error;
  }
}

async function markLockReleased(
  lockDir: string,
  expectedIdentity: LockDirectoryIdentity,
  owner: FsLockOwner,
): Promise<MarkLockReleasedResult> {
  if (!(await lockDirectoryIdentityMatches(lockDir, expectedIdentity))) {
    return 'gone';
  }
  const currentOwner = await readLockOwner(lockDir);
  if (currentOwner.status === 'unreadable') {
    throw currentOwner.error;
  }
  if (
    currentOwner.status !== 'valid' ||
    !fsLockOwnersEqual(currentOwner.owner, owner)
  ) {
    return 'owner-mismatch';
  }
  if (!(await lockDirectoryIdentityMatches(lockDir, expectedIdentity))) {
    return 'gone';
  }
  await writeLockOwnerAtomically(lockDir, {
    ...owner,
    releasedAtMs: Date.now(),
  });
  return 'marked';
}

async function releaseLockDirectory(
  lockDir: string,
  expectedIdentity: LockDirectoryIdentity,
  owner: FsLockOwner,
): Promise<LockDirectoryReleaseResult> {
  let releaseError: unknown = new Error(`Filesystem lock release failed: ${lockDir}`);
  for (let attempt = 0; attempt < FS_LOCK_RELEASE_RETRY_ATTEMPTS; attempt += 1) {
    if (!(await lockDirectoryIdentityMatches(lockDir, expectedIdentity))) {
      return { status: 'removed' };
    }
    try {
      await fs.rm(lockDir, { recursive: true, force: true });
      return { status: 'removed' };
    } catch (error) {
      releaseError = error;
      if (attempt + 1 < FS_LOCK_RELEASE_RETRY_ATTEMPTS) {
        await delay(FS_LOCK_RELEASE_RETRY_DELAY_MS);
      }
    }
  }

  try {
    const markResult = await markLockReleased(lockDir, expectedIdentity, owner);
    if (markResult === 'gone') {
      return { status: 'removed' };
    }
    if (markResult === 'owner-mismatch') {
      throw new Error(`Filesystem lock owner changed before release: ${lockDir}`);
    }
  } catch (markError) {
    throw new AggregateError(
      [releaseError, markError],
      `Filesystem lock release and recoverable-owner update both failed: ${lockDir}`,
    );
  }
  return { status: 'logically-released', error: releaseError };
}

function scheduleLockReleaseRetry(
  lockDir: string,
  expectedIdentity: LockDirectoryIdentity,
  owner: FsLockOwner,
): void {
  if (owner.pid !== process.pid) {
    return;
  }
  const key = lockReleaseRetryKey(lockDir, expectedIdentity);
  if (scheduledLockReleaseRetries.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    scheduledLockReleaseRetries.delete(key);
    void markLockReleased(lockDir, expectedIdentity, owner)
      .catch(() => {
        scheduleLockReleaseRetry(lockDir, expectedIdentity, owner);
      });
  }, FS_LOCK_RELEASE_MAINTENANCE_RETRY_DELAY_MS);
  timer.unref?.();
  scheduledLockReleaseRetries.set(key, timer);
}

async function isDirectoryOlderThan(dir: string, now: number, ageMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return now - stat.mtimeMs > ageMs;
  } catch {
    return false;
  }
}

async function quarantineLockDir(lockDir: string): Promise<string | null> {
  const quarantineDir = path.join(
    path.dirname(lockDir),
    `.${path.basename(lockDir)}.stale.${process.pid}.${randomUUID()}`,
  );

  try {
    await fs.rename(lockDir, quarantineDir);
    return quarantineDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function restoreQuarantinedLockDir(quarantineDir: string, lockDir: string): Promise<void> {
  try {
    await fs.rename(quarantineDir, lockDir);
  } catch {
    // Another contender may already have acquired the lock. Leave the quarantined
    // directory intact rather than deleting a lock we could not validate.
  }
}

async function shouldRecoverLockDir(
  lockDir: string,
  purpose: string,
  now: number,
  leaseMs: number,
): Promise<{ recover: false } | { recover: true; owner: FsLockOwner | null }> {
  const ownerResult = await readLockOwner(lockDir);
  if (ownerResult.status === 'unreadable') {
    return { recover: false };
  }
  if (ownerResult.status !== 'valid') {
    return (await isDirectoryOlderThan(lockDir, now, leaseMs))
      ? { recover: true, owner: null }
      : { recover: false };
  }
  const staleOwner = ownerResult.owner;
  if (staleOwner.releasedAtMs !== undefined) {
    return { recover: true, owner: staleOwner };
  }
  if (
    staleOwner.purpose !== purpose ||
    staleOwner.expiresAtMs > now ||
    isPidAlive(staleOwner.pid)
  ) {
    return { recover: false };
  }
  return { recover: true, owner: staleOwner };
}

async function tryRecoverExpiredLockDir(
  lockDir: string,
  purpose: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const recovery = await shouldRecoverLockDir(lockDir, purpose, now, leaseMs);
  if (!recovery.recover) {
    return false;
  }

  const quarantineDir = await quarantineLockDir(lockDir);
  if (!quarantineDir) {
    return false;
  }

  if (recovery.owner) {
    const quarantinedOwner = await readLockOwner(quarantineDir);
    if (
      quarantinedOwner.status !== 'valid' ||
      !fsLockOwnersEqual(quarantinedOwner.owner, recovery.owner)
    ) {
      await restoreQuarantinedLockDir(quarantineDir, lockDir);
      return false;
    }
  }

  await fs.rm(quarantineDir, { recursive: true, force: true });
  return true;
}

async function createLock(lockDir: string, owner: FsLockOwner): Promise<AcquiredFsLock> {
  await fs.mkdir(lockDir, { mode: 0o700 });
  const lockIdentity = await captureLockDirectoryIdentity(lockDir);
  try {
    await writeLockOwnerAtomically(lockDir, owner);
  } catch (error) {
    let cleanupResult: LockDirectoryReleaseResult;
    try {
      cleanupResult = await releaseLockDirectory(lockDir, lockIdentity, owner);
    } catch (cleanupError) {
      scheduleLockReleaseRetry(lockDir, lockIdentity, owner);
      throw new AggregateError(
        [error, cleanupError],
        `Filesystem lock initialization and cleanup both failed: ${lockDir}`,
      );
    }
    if (cleanupResult.status === 'logically-released') {
      throw new AggregateError(
        [error, cleanupResult.error],
        `Filesystem lock initialization and physical cleanup both failed: ${lockDir}`,
      );
    }
    throw error;
  }

  return {
    owner,
    async release(): Promise<void> {
      const key = lockReleaseRetryKey(lockDir, lockIdentity);
      let releaseResult: LockDirectoryReleaseResult;
      try {
        releaseResult = await releaseLockDirectory(lockDir, lockIdentity, owner);
      } catch (error) {
        scheduleLockReleaseRetry(lockDir, lockIdentity, owner);
        throw error;
      }
      const scheduledRetry = scheduledLockReleaseRetries.get(key);
      if (scheduledRetry) {
        clearTimeout(scheduledRetry);
        scheduledLockReleaseRetries.delete(key);
      }
      if (releaseResult.status === 'logically-released') {
        throw releaseResult.error;
      }
    },
  };
}

async function tryAcquireGuard(
  lockDir: string,
  purpose: string,
  leaseMs: number,
  now: number,
): Promise<AcquiredFsLock | null> {
  const guardDir = guardDirForLockDir(lockDir);
  const guardOwner: FsLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    purpose: `${purpose}:guard`,
    acquiredAtMs: now,
    expiresAtMs: now + leaseMs,
  };

  try {
    return await createLock(guardDir, guardOwner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const recovered = await tryRecoverExpiredLockDir(guardDir, guardOwner.purpose, now, leaseMs);
    if (!recovered) {
      return null;
    }
    try {
      return await createLock(guardDir, guardOwner);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
        return null;
      }
      throw retryError;
    }
  }
}

export async function tryAcquireFsLock(
  options: TryAcquireFsLockOptions,
): Promise<AcquiredFsLock | null> {
  const now = options.now ?? Date.now();
  const owner: FsLockOwner = {
    token: randomUUID(),
    pid: options.pid ?? process.pid,
    purpose: options.purpose,
    acquiredAtMs: now,
    expiresAtMs: now + options.leaseMs,
  };

  await fs.mkdir(path.dirname(options.lockDir), { recursive: true, mode: 0o700 });
  const guard = await tryAcquireGuard(options.lockDir, options.purpose, options.leaseMs, now);
  if (!guard) {
    return null;
  }

  let acquiredLock: AcquiredFsLock | null = null;
  let acquisitionFailure: FsLockOperationFailure | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        acquiredLock = await createLock(options.lockDir, owner);
        return acquiredLock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        const recovered = await tryRecoverExpiredLockDir(
          options.lockDir,
          options.purpose,
          now,
          options.leaseMs,
        );
        if (!recovered) {
          return null;
        }
      }
    }
  } catch (error) {
    acquisitionFailure = { error };
    throw error;
  } finally {
    try {
      await guard.release();
    } catch (guardReleaseError) {
      const failures = [
        ...(acquisitionFailure ? [acquisitionFailure.error] : []),
        guardReleaseError,
      ];
      if (acquiredLock) {
        try {
          await acquiredLock.release();
        } catch (lockReleaseError) {
          failures.push(lockReleaseError);
        }
      }
      if (failures.length === 1) {
        throw guardReleaseError;
      }
      throw new AggregateError(failures, 'Filesystem lock acquisition cleanup failed');
    }
  }

  return null;
}
