import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FS_LOCK_OWNER_FILE,
  resetFsLockReleaseRetriesForTests,
  tryAcquireFsLock,
  withAcquiredFsLock,
  type FsLockOwner,
} from '../fs-lock.ts';
import { guardDirForLockDir } from '../fs-lock-shared.ts';
import { tryAcquireFsLockSync } from '../fs-lock-sync.ts';

const renameFailure = vi.hoisted(() => ({
  error: undefined as NodeJS.ErrnoException | undefined,
  sourcePath: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    async rename(sourcePath: string, destinationPath: string): Promise<void> {
      if (sourcePath === renameFailure.sourcePath && renameFailure.error) {
        throw renameFailure.error;
      }
      await actual.rename(sourcePath, destinationPath);
    },
  };
});

const PURPOSE = 'filesystem-lifecycle';
const LEASE_MS = 10_000;
const DEAD_PID = 999_999_999;

let tempDirs: string[] = [];

function makeOwner(overrides: Partial<FsLockOwner> = {}): FsLockOwner {
  const now = Date.UTC(2026, 4, 2, 12);
  return {
    token: 'stale-owner-token',
    pid: DEAD_PID,
    purpose: PURPOSE,
    acquiredAtMs: now - 2 * LEASE_MS,
    expiresAtMs: now - LEASE_MS,
    ...overrides,
  };
}

function ownerPath(lockDir: string): string {
  return path.join(lockDir, FS_LOCK_OWNER_FILE);
}

function lockDirFor(appDir: string): string {
  return path.join(appDir, 'workspace-a', 'locks', 'filesystem-lifecycle.lock');
}

async function makeTempDir(): Promise<string> {
  const tempDir = await fsPromises.mkdtemp(
    path.join(tmpdir(), 'xcodebuildmcp-fs-lock-'),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

function makeTempDirSync(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-fs-lock-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeOwner(lockDir: string, owner: FsLockOwner): Promise<void> {
  await fsPromises.mkdir(lockDir, { recursive: true });
  await fsPromises.writeFile(
    ownerPath(lockDir),
    `${JSON.stringify(owner)}\n`,
    'utf8',
  );
}

function writeOwnerSync(lockDir: string, owner: FsLockOwner): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(ownerPath(lockDir), `${JSON.stringify(owner)}\n`, 'utf8');
}

async function readOwner(lockDir: string): Promise<FsLockOwner> {
  return JSON.parse(
    await fsPromises.readFile(ownerPath(lockDir), 'utf8'),
  ) as FsLockOwner;
}

function readOwnerSync(lockDir: string): FsLockOwner {
  return JSON.parse(readFileSync(ownerPath(lockDir), 'utf8')) as FsLockOwner;
}

afterEach(async () => {
  renameFailure.error = undefined;
  renameFailure.sourcePath = undefined;
  resetFsLockReleaseRetriesForTests();
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(
    dirs.map((tempDir) =>
      fsPromises.rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe('tryAcquireFsLock', () => {
  it('acquires and releases a normal lock', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    expect(lock).not.toBeNull();
    expect(await readOwner(lockDir)).toMatchObject({
      token: lock?.owner.token,
      pid: process.pid,
      purpose: PURPOSE,
    });

    await lock?.release();

    await expect(
      fsPromises.readFile(ownerPath(lockDir), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create the main lock while a guard is held', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    await fsPromises.mkdir(guardDirForLockDir(lockDir), { recursive: true });

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    expect(lock).toBeNull();
    await expect(
      fsPromises.readFile(ownerPath(lockDir), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an expired stale guard before acquiring the main lock', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    await writeOwner(
      guardDirForLockDir(lockDir),
      makeOwner({ purpose: `${PURPOSE}:guard`, expiresAtMs: now - 1 }),
    );

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).not.toBeNull();
    expect(await readOwner(lockDir)).toMatchObject({ purpose: PURPOSE, token: lock?.owner.token });
    await lock?.release();
  });

  it('recovers an expired stale main lock after acquiring the guard', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    const staleOwner = makeOwner({ token: 'expired-main-lock', expiresAtMs: now - 1 });
    await writeOwner(lockDir, staleOwner);

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).not.toBeNull();
    const currentOwner = await readOwner(lockDir);
    expect(currentOwner.token).toBe(lock?.owner.token);
    expect(currentOwner.token).not.toBe(staleOwner.token);
    await lock?.release();
  });

  it('propagates operational stale-lock quarantine failures', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    await writeOwner(lockDir, makeOwner({ expiresAtMs: now - 1 }));
    const quarantineError = Object.assign(new Error('quarantine failed'), {
      code: 'EIO',
    });
    renameFailure.sourcePath = lockDir;
    renameFailure.error = quarantineError;

    await expect(
      tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now }),
    ).rejects.toBe(quarantineError);
  });

  it('does not recover an expired lock owned by a live process', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    const liveOwner = makeOwner({
      pid: process.pid,
      token: 'live-main-lock',
      expiresAtMs: now - 1,
    });
    await writeOwner(lockDir, liveOwner);

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).toBeNull();
    expect(await readOwner(lockDir)).toMatchObject(liveOwner);
  });

  it('releases its lock even if the owner file becomes unreadable', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    await fsPromises.rm(ownerPath(lockDir));
    await fsPromises.symlink(ownerPath(lockDir), ownerPath(lockDir));
    await lock?.release();

    await expect(fsPromises.lstat(lockDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not recover an old lock whose owner file cannot be read', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.symlink(ownerPath(lockDir), ownerPath(lockDir));
    const old = new Date(now - 2 * LEASE_MS);
    await fsPromises.utimes(lockDir, old, old);

    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).toBeNull();
    expect((await fsPromises.lstat(ownerPath(lockDir))).isSymbolicLink()).toBe(
      true,
    );
  });

  it('preserves both an operation failure and a lock-release failure', async () => {
    const operationError = new Error('operation failed');
    const releaseError = new Error('release failed');
    let caughtError: unknown;

    try {
      await withAcquiredFsLock(
        {
          owner: makeOwner(),
          release: async () => {
            throw releaseError;
          },
        },
        async () => {
          throw operationError;
        },
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    const aggregateError = caughtError as AggregateError;
    expect(aggregateError.errors).toEqual([operationError, releaseError]);
  });

  it('marks a physically unreleased lock as recoverable despite its live owner', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const locksDir = path.dirname(lockDir);
    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    await fsPromises.chmod(locksDir, 0o500);
    try {
      await expect(lock?.release()).rejects.toBeDefined();
    } finally {
      await fsPromises.chmod(locksDir, 0o700);
    }
    expect(await readOwner(lockDir)).toMatchObject({
      pid: process.pid,
      releasedAtMs: expect.any(Number),
    });

    const recovered = await tryAcquireFsLock({
      lockDir,
      purpose: PURPOSE,
      leaseMs: LEASE_MS,
    });

    expect(recovered).not.toBeNull();
    await recovered?.release();
  });

  it('does not publish a release marker over changed owner state', async () => {
    const tempDir = await makeTempDir();
    const lockDir = lockDirFor(tempDir);
    const locksDir = path.dirname(lockDir);
    const lock = await tryAcquireFsLock({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });
    const changedOwner = { changed: true };
    await fsPromises.writeFile(
      ownerPath(lockDir),
      `${JSON.stringify(changedOwner)}\n`,
      'utf8',
    );

    await fsPromises.chmod(locksDir, 0o500);
    try {
      await expect(lock?.release()).rejects.toThrow(
        'Filesystem lock release and recoverable-owner update both failed',
      );
    } finally {
      await fsPromises.chmod(locksDir, 0o700);
    }

    expect(
      JSON.parse(await fsPromises.readFile(ownerPath(lockDir), 'utf8')),
    ).toEqual(changedOwner);
  });
});

describe('tryAcquireFsLockSync', () => {
  it('acquires and releases a normal lock', () => {
    const tempDir = makeTempDirSync();
    const lockDir = lockDirFor(tempDir);

    const lock = tryAcquireFsLockSync({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    expect(lock).not.toBeNull();
    expect(readOwnerSync(lockDir)).toMatchObject({
      token: lock?.owner.token,
      pid: process.pid,
      purpose: PURPOSE,
    });

    lock?.release();

    expect(() => readFileSync(ownerPath(lockDir), 'utf8')).toThrow();
  });

  it('does not create the main lock while a guard is held', () => {
    const tempDir = makeTempDirSync();
    const lockDir = lockDirFor(tempDir);
    mkdirSync(guardDirForLockDir(lockDir), { recursive: true });

    const lock = tryAcquireFsLockSync({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS });

    expect(lock).toBeNull();
    expect(() => readFileSync(ownerPath(lockDir), 'utf8')).toThrow();
  });

  it('recovers an expired stale guard before acquiring the main lock', () => {
    const tempDir = makeTempDirSync();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    writeOwnerSync(
      guardDirForLockDir(lockDir),
      makeOwner({ purpose: `${PURPOSE}:guard`, expiresAtMs: now - 1 }),
    );

    const lock = tryAcquireFsLockSync({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).not.toBeNull();
    expect(readOwnerSync(lockDir)).toMatchObject({ purpose: PURPOSE, token: lock?.owner.token });
    lock?.release();
  });

  it('recovers an expired stale main lock after acquiring the guard', () => {
    const tempDir = makeTempDirSync();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    const staleOwner = makeOwner({ token: 'expired-main-lock', expiresAtMs: now - 1 });
    writeOwnerSync(lockDir, staleOwner);

    const lock = tryAcquireFsLockSync({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).not.toBeNull();
    const currentOwner = readOwnerSync(lockDir);
    expect(currentOwner.token).toBe(lock?.owner.token);
    expect(currentOwner.token).not.toBe(staleOwner.token);
    lock?.release();
  });

  it('does not recover an expired lock owned by a live process', () => {
    const tempDir = makeTempDirSync();
    const lockDir = lockDirFor(tempDir);
    const now = Date.UTC(2026, 4, 2, 12);
    const liveOwner = makeOwner({
      pid: process.pid,
      token: 'live-main-lock',
      expiresAtMs: now - 1,
    });
    writeOwnerSync(lockDir, liveOwner);

    const lock = tryAcquireFsLockSync({ lockDir, purpose: PURPOSE, leaseMs: LEASE_MS, now });

    expect(lock).toBeNull();
    expect(readOwnerSync(lockDir)).toMatchObject(liveOwner);
  });
});
