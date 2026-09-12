import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { displayPath } from './build-preflight.ts';
import { tryAcquireFsLock, type AcquiredFsLock } from './fs-lock.ts';
import {
  getWorkspaceFilesystemLayout,
  getWorkspacesDir,
  getXcodeBuildMCPAppDir,
} from './log-paths.ts';

export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS = 10 * 60 * 1000;
export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE = 'filesystem-lifecycle';
export const WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_WAIT_MS = 60 * 1000;

export interface AcquireWorkspaceFilesystemLockOptions {
  workspaceKey: string;
  waitMs?: number;
}

export interface TryAcquireWorkspaceFilesystemLockOptions {
  workspaceKey: string;
  now?: number;
  purpose?: string;
}

export class WorkspaceFilesystemLifecycleLockTimeoutError extends Error {}

let acquisitionAttemptHookForTests: ((workspaceKey: string) => void) | null = null;

export function setWorkspaceFilesystemLockAcquisitionAttemptHookForTests(
  hook: ((workspaceKey: string) => void) | null,
): void {
  acquisitionAttemptHookForTests = hook;
}

async function ensureRegularDirectory(directory: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw mkdirError;
      }
    }
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Managed workspace lock directory is not a regular directory: ${displayPath(directory)}`,
    );
  }
}

async function resolveWorkspaceFilesystemLifecycleLockPath(
  workspaceKey: string,
): Promise<string> {
  const appDir = getXcodeBuildMCPAppDir();
  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  await fs.mkdir(path.dirname(appDir), { recursive: true, mode: 0o700 });
  const directories = [appDir, getWorkspacesDir(), layout.root, layout.locks];
  for (const directory of directories) {
    await ensureRegularDirectory(directory);
  }

  const canonicalDirectories = await Promise.all(
    directories.map((directory) => fs.realpath(directory)),
  );
  for (let index = 1; index < canonicalDirectories.length; index += 1) {
    if (
      canonicalDirectories[index] !==
      path.join(
        canonicalDirectories[index - 1]!,
        path.basename(directories[index]!),
      )
    ) {
      throw new Error(
        `Managed workspace lock directory escaped its parent: ${displayPath(directories[index]!)}`,
      );
    }
  }
  return path.join(
    canonicalDirectories.at(-1)!,
    path.basename(layout.filesystemLifecycle.lockDir),
  );
}

export async function tryAcquireWorkspaceFilesystemLifecycleLock(
  options: TryAcquireWorkspaceFilesystemLockOptions,
): Promise<AcquiredFsLock | null> {
  return tryAcquireFsLock({
    lockDir: await resolveWorkspaceFilesystemLifecycleLockPath(options.workspaceKey),
    purpose: options.purpose ?? WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_PURPOSE,
    leaseMs: WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_LEASE_MS,
    now: options.now,
  });
}

export async function acquireWorkspaceFilesystemLifecycleLock(
  options: AcquireWorkspaceFilesystemLockOptions,
): Promise<AcquiredFsLock> {
  acquisitionAttemptHookForTests?.(options.workspaceKey);
  const layout = getWorkspaceFilesystemLayout(options.workspaceKey);
  const waitMs = options.waitMs ?? WORKSPACE_FILESYSTEM_LIFECYCLE_LOCK_WAIT_MS;
  const startedAtMs = Date.now();

  for (;;) {
    const lock = await tryAcquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: options.workspaceKey,
    });
    if (lock) {
      return lock;
    }

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= waitMs) {
      throw new WorkspaceFilesystemLifecycleLockTimeoutError(
        `Timed out waiting for workspace filesystem lock after ${String(waitMs)}ms: ${displayPath(layout.filesystemLifecycle.lockDir)}`,
      );
    }
    await delay(Math.min(25, waitMs - elapsedMs));
  }
}
