import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  corruptNextReaderLeasePublication: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rename: vi.fn(async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      await actual.rename(oldPath, newPath);
      const publishedPath = String(newPath);
      if (
        fsMockState.corruptNextReaderLeasePublication &&
        publishedPath.includes('/test-products-readers/') &&
        publishedPath.endsWith('.json')
      ) {
        fsMockState.corruptNextReaderLeasePublication = false;
        await actual.writeFile(newPath, '{', 'utf8');
      }
    }),
  };
});

import { setXcodeBuildMCPAppDirOverrideForTests } from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import {
  createDefaultTestProductsPath,
  getTestProductsCompletionMarkerPath,
} from '../test-products-path.ts';
import {
  resetTestProductsReaderLeaseReleaseRetriesForTests,
  withTestProductsReaderLease,
} from '../test-products-reader-lease.ts';

describe('test products reader lease', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-reader-lease-'));
    setXcodeBuildMCPAppDirOverrideForTests(appDir);
    setRuntimeInstanceForTests({
      instanceId: 'test-products-reader-lease',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
    resetTestProductsReaderLeaseReleaseRetriesForTests();
    fsMockState.corruptNextReaderLeasePublication = false;
  });

  afterEach(() => {
    resetTestProductsReaderLeaseReleaseRetriesForTests();
    fsMockState.corruptNextReaderLeasePublication = false;
    setRuntimeInstanceForTests(null);
    setXcodeBuildMCPAppDirOverrideForTests(null);
    rmSync(appDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('notifies retention after a failed admission rollback eventually releases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const productsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(productsPath);
    writeFileSync(getTestProductsCompletionMarkerPath(productsPath), 'completed');
    const onReleased = vi.fn();
    fsMockState.corruptNextReaderLeasePublication = true;

    await expect(
      withTestProductsReaderLease(productsPath, async () => undefined, {
        onReleased,
      }),
    ).rejects.toThrow('Reader lease acquisition and rollback both failed');
    expect(onReleased).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(onReleased).toHaveBeenCalledOnce();
    expect(onReleased).toHaveBeenCalledWith('workspace-a');
  });
});
