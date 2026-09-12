import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PRODUCTS_MAX_AGE_MS,
  pruneManagedTestProductsDirectory,
} from '../test-products-lifecycle.ts';
import {
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
} from '../test-products-path.ts';
import {
  getWorkspaceFilesystemLayout,
  setXcodeBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_OWNER_PID = 999_999_999;

function managedName(name: string, pid = DEAD_OWNER_PID): string {
  return `${name}_2026-05-02T12-00-00-000Z_pid${pid}_abcdef12.xctestproducts`;
}

function writeTestProducts(directory: string, mtimeMs: number, completed = false): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'Tests.xctestrun'), 'stub');
  const mtime = new Date(mtimeMs);
  utimesSync(directory, mtime, mtime);
  if (completed) {
    const markerPath = getTestProductsCompletionMarkerPath(directory);
    writeFileSync(markerPath, 'completed');
    utimesSync(markerPath, mtime, mtime);
  }
}

describe('test products lifecycle', () => {
  let appDir: string;
  let root: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-test-products-lifecycle-'));
    setXcodeBuildMCPAppDirOverrideForTests(appDir);
    root = getWorkspaceFilesystemLayout('workspace-a').testProducts;
    mkdirSync(root, { recursive: true });
  });

  afterEach(async () => {
    setXcodeBuildMCPAppDirOverrideForTests(null);
    await rm(appDir, { recursive: true, force: true });
  });

  it('prunes managed products after the default retention age while preserving caller-owned paths', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const oldManaged = path.join(root, managedName('old'));
    const recentManaged = path.join(root, managedName('recent'));
    const callerOwned = path.join(root, 'caller-provided.xctestproducts');
    const externalCallerOwned = path.join(
      appDir,
      'external-caller.xctestproducts',
    );
    writeTestProducts(oldManaged, now - TEST_PRODUCTS_MAX_AGE_MS - 1, true);
    writeTestProducts(recentManaged, now - TEST_PRODUCTS_MAX_AGE_MS / 2, true);
    writeTestProducts(callerOwned, now - 10 * DAY_MS, true);
    writeTestProducts(externalCallerOwned, now - 10 * DAY_MS, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
    });

    expect(result).toEqual({ scanned: 2, deleted: 1 });
    expect(existsSync(oldManaged)).toBe(false);
    expect(existsSync(recentManaged)).toBe(true);
    expect(existsSync(callerOwned)).toBe(true);
    expect(existsSync(externalCallerOwned)).toBe(true);
  });

  it('protects live in-progress products until their completion marker exists', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const live = path.join(root, managedName('live', process.pid));
    writeTestProducts(live, now - 4 * DAY_MS);

    expect(isXcodeBuildMCPManagedTestProductsName(path.basename(live))).toBe(true);
    expect(
      await pruneManagedTestProductsDirectory({ testProductsDir: root, now, minVisibleMs: 0 }),
    ).toEqual({ scanned: 1, deleted: 0 });
    expect(existsSync(live)).toBe(true);

    writeFileSync(getTestProductsCompletionMarkerPath(live), 'completed');
    expect(
      await pruneManagedTestProductsDirectory({ testProductsDir: root, now, minVisibleMs: 0 }),
    ).toEqual({ scanned: 1, deleted: 1 });
    expect(existsSync(live)).toBe(false);
  });

  it('preserves a managed product with a symbolic completion marker', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const product = path.join(root, managedName('live', process.pid));
    const markerTarget = path.join(appDir, 'old-completion-marker');
    writeTestProducts(product, now - 4 * DAY_MS);
    writeFileSync(markerTarget, 'completed');
    const old = new Date(now - 4 * DAY_MS);
    utimesSync(markerTarget, old, old);
    symlinkSync(markerTarget, getTestProductsCompletionMarkerPath(product));

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        maxCount: 0,
        activeProducerReservationNames: new Set(),
      }),
    ).toEqual({ scanned: 0, deleted: 0 });
    expect(existsSync(product)).toBe(true);
  });

  it('uses producer reservations as the authoritative active-producer state', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const live = path.join(root, managedName('live', process.pid));
    writeTestProducts(live, now - 4 * DAY_MS);

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        maxCount: 0,
        activeProducerReservationNames: new Set(),
      }),
    ).toEqual({ scanned: 1, deleted: 1 });
    expect(existsSync(live)).toBe(false);
  });

  it('keeps the newest completed handoff within the idle count budget', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const older = path.join(root, managedName('older'));
    const newest = path.join(root, managedName('newest'));
    writeTestProducts(older, now - 2000, true);
    writeTestProducts(newest, now - 1000, true);

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 60 * 60 * 1000,
        maxCount: 1,
        activeProducerReservationNames: new Set([managedName('pending', process.pid)]),
      }),
    ).toEqual({ scanned: 2, deleted: 1 });
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it('preserves only the artifact whose completion marker state is malformed', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const productsPath = path.join(root, managedName('malformed_marker'));
    const deletablePath = path.join(root, managedName('deletable'));
    writeTestProducts(productsPath, now - 4 * DAY_MS);
    writeTestProducts(deletablePath, now - 4 * DAY_MS, true);
    mkdirSync(getTestProductsCompletionMarkerPath(productsPath));

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        maxCount: 0,
        activeProducerReservationNames: new Set(),
      }),
    ).toEqual({ scanned: 1, deleted: 1 });
    expect(existsSync(productsPath)).toBe(true);
    expect(existsSync(deletablePath)).toBe(false);
  });

  it('uses a separate count cap for retained test products', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const oldest = path.join(root, managedName('oldest'));
    const middle = path.join(root, managedName('middle'));
    const newest = path.join(root, managedName('newest'));
    writeTestProducts(oldest, now - 3 * DAY_MS, true);
    writeTestProducts(middle, now - 2 * DAY_MS, true);
    writeTestProducts(newest, now - DAY_MS, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 2,
    });

    expect(result).toEqual({ scanned: 3, deleted: 1 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('reserves capacity before allocation even when completed products are newly visible', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const completed = Array.from({ length: 4 }, (_, index) => {
      const productsPath = path.join(root, managedName(`completed_${index}`));
      writeTestProducts(productsPath, now - 2 * 60 * 60 * 1000 - index * 1000, true);
      return productsPath;
    });

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 60 * 60 * 1000,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 1,
      activeProducerReservationNames: new Set([managedName('pending', process.pid)]),
    });

    expect(result).toEqual({ scanned: 4, deleted: 3 });
    expect(existsSync(completed[0]!)).toBe(true);
    expect(completed.slice(1).every((productsPath) => !existsSync(productsPath))).toBe(true);
  });

  it('does not subtract active producers from the idle retention budget', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const live = path.join(root, managedName('live', process.pid));
    writeTestProducts(live, now - 2 * DAY_MS);
    const completed = ['oldest', 'middle', 'newest'].map((name, index) => {
      const productsPath = path.join(root, managedName(name));
      writeTestProducts(productsPath, now - (3 - index) * 1000, true);
      return productsPath;
    });

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 3,
      activeProducerReservationNames: new Set([
        path.basename(live),
        managedName('pending', process.pid),
      ]),
    });

    expect(result).toEqual({ scanned: 4, deleted: 0 });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(completed[0]!)).toBe(true);
    expect(existsSync(completed[1]!)).toBe(true);
    expect(existsSync(completed[2]!)).toBe(true);
  });

  it('does not subtract other protected products from the idle retention budget', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const protectedProduct = path.join(root, managedName('protected'));
    const completed = path.join(root, managedName('completed'));
    writeTestProducts(protectedProduct, now - 2 * DAY_MS);
    writeTestProducts(completed, now - 1000, true);

    const result = await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 3 * DAY_MS,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 1,
      activeProducerReservationNames: new Set(),
    });

    expect(result).toEqual({ scanned: 2, deleted: 0 });
    expect(existsSync(protectedProduct)).toBe(true);
    expect(existsSync(completed)).toBe(true);
  });

  it('orders completed products by completion marker time', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const completedFirst = path.join(root, managedName('completed_first'));
    const completedLast = path.join(root, managedName('completed_last'));
    writeTestProducts(completedFirst, now - 1000, true);
    writeTestProducts(completedLast, now - 2000, true);
    utimesSync(
      getTestProductsCompletionMarkerPath(completedFirst),
      new Date(now - 4000),
      new Date(now - 4000),
    );
    utimesSync(
      getTestProductsCompletionMarkerPath(completedLast),
      new Date(now - 3000),
      new Date(now - 3000),
    );

    await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 1,
    });

    expect(existsSync(completedFirst)).toBe(false);
    expect(existsSync(completedLast)).toBe(true);
  });

  it('retains the preferred completed handoff when marker times tie', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const first = path.join(root, managedName('first'));
    const preferred = path.join(root, managedName('preferred'));
    writeTestProducts(first, now - 1000, true);
    writeTestProducts(preferred, now - 1000, true);

    await pruneManagedTestProductsDirectory({
      testProductsDir: root,
      now,
      minVisibleMs: 0,
      maxAgeMs: 10 * DAY_MS,
      maxCount: 1,
      preferredRetainedArtifactName: path.basename(preferred),
    });

    expect(existsSync(first)).toBe(false);
    expect(existsSync(preferred)).toBe(true);
  });

  it('counts the preferred handoff while protecting it from age deletion', async () => {
    const now = Date.UTC(2026, 4, 6, 12);
    const preferred = path.join(root, managedName('preferred'));
    const other = path.join(root, managedName('other'));
    writeTestProducts(preferred, now - 2 * DAY_MS, true);
    writeTestProducts(other, now - 1000, true);

    expect(
      await pruneManagedTestProductsDirectory({
        testProductsDir: root,
        now,
        minVisibleMs: 0,
        maxAgeMs: 0,
        maxCount: 1,
        preferredRetainedArtifactName: path.basename(preferred),
      }),
    ).toEqual({ scanned: 2, deleted: 1 });
    expect(existsSync(preferred)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });
});
