import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultTestProductsPath,
  findXctestrunPaths,
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
  markTestProductsPathCompleted,
  resolveCallerOwnedTestProductsOutputPath,
  resolveManagedTestProductsOwnership,
} from '../test-products-path.ts';
import {
  getWorkspaceFilesystemLayout,
  getWorkspacesDir,
  setXcodeBuildMCPAppDirOverrideForTests,
} from '../log-paths.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';

describe('test products paths', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-test-products-path-'));
    setXcodeBuildMCPAppDirOverrideForTests(appDir);
    setRuntimeInstanceForTests({
      instanceId: 'test-products-path',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
  });

  afterEach(async () => {
    setRuntimeInstanceForTests(null);
    setXcodeBuildMCPAppDirOverrideForTests(null);
    await rm(appDir, { recursive: true, force: true });
  });

  it('creates unique workspace-scoped managed paths', () => {
    const first = createDefaultTestProductsPath('build_sim');
    const second = createDefaultTestProductsPath('build_sim');

    expect(path.dirname(first)).toBe(getWorkspaceFilesystemLayout('workspace-a').testProducts);
    expect(first).not.toBe(second);
    expect(isXcodeBuildMCPManagedTestProductsName(path.basename(first))).toBe(true);
    expect(isXcodeBuildMCPManagedTestProductsName('caller-provided.xctestproducts')).toBe(false);
  });

  it('rejects explicit output paths inside or aliased into managed storage', async () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const appDirAlias = `${appDir}-alias`;
    symlinkSync(appDir, appDirAlias, 'dir');
    expect(existsSync(getWorkspacesDir())).toBe(false);
    try {
      await expect(
        resolveCallerOwnedTestProductsOutputPath(
          path.join(
            appDirAlias,
            path.relative(appDir, layout.testProducts),
            'Caller.xctestproducts',
          ),
        ),
      ).rejects.toThrow('cannot alias XcodeBuildMCP-managed storage');
    } finally {
      rmSync(appDirAlias, { force: true });
    }

    mkdirSync(layout.testProducts, { recursive: true });
    const managedOutput = path.join(layout.testProducts, 'Caller.xctestproducts');
    await expect(
      resolveCallerOwnedTestProductsOutputPath(managedOutput),
    ).rejects.toThrow('cannot use XcodeBuildMCP-managed storage');

    const alias = path.join(appDir, 'test-products-alias');
    symlinkSync(layout.testProducts, alias, 'dir');
    await expect(
      resolveCallerOwnedTestProductsOutputPath(
        path.join(alias, 'Caller.xctestproducts'),
      ),
    ).rejects.toThrow('cannot alias XcodeBuildMCP-managed storage');

    const danglingAlias = path.join(appDir, 'dangling-output.xctestproducts');
    symlinkSync(
      path.join(layout.testProducts, 'Absent.xctestproducts'),
      danglingAlias,
    );
    await expect(
      resolveCallerOwnedTestProductsOutputPath(danglingAlias),
    ).rejects.toThrow('contains an unresolved symbolic link');

    const callerRoot = path.join(appDir, 'caller-owned');
    const callerAlias = path.join(appDir, 'caller-alias');
    mkdirSync(callerRoot);
    symlinkSync(callerRoot, callerAlias, 'dir');
    const pinnedOutput = await resolveCallerOwnedTestProductsOutputPath(
      path.join(callerAlias, 'Caller.xctestproducts'),
    );
    rmSync(callerAlias);
    symlinkSync(layout.testProducts, callerAlias, 'dir');
    expect(pinnedOutput).toBe(
      path.join(realpathSync(callerRoot), 'Caller.xctestproducts'),
    );

    await expect(
      resolveCallerOwnedTestProductsOutputPath(
        path.join(appDir, 'Caller.xctestproducts'),
      ),
    ).resolves.toBe(path.join(realpathSync(appDir), 'Caller.xctestproducts'));
  });

  it('atomically marks a generated test products directory completed', () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(testProductsPath);

    expect(markTestProductsPathCompleted(testProductsPath)).toBe('completed');

    expect(existsSync(getTestProductsCompletionMarkerPath(testProductsPath))).toBe(true);
  });

  it('surfaces a completion marker write failure', () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(testProductsPath);
    mkdirSync(getTestProductsCompletionMarkerPath(testProductsPath));

    expect(() => markTestProductsPathCompleted(testProductsPath)).toThrow();
  });

  it('rejects a symbolic link used as the managed test products root', () => {
    const layout = getWorkspaceFilesystemLayout('workspace-a');
    const external = path.join(appDir, 'external-test-products');
    mkdirSync(layout.root, { recursive: true });
    mkdirSync(external);
    symlinkSync(external, layout.testProducts, 'dir');

    expect(() => createDefaultTestProductsPath('test_sim')).toThrow(
      'Managed directory is not a regular directory',
    );
  });

  it('finds xctestrun files without traversing symbolic links', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const nested = path.join(testProductsPath, 'nested');
    const outside = path.join(appDir, 'outside');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(testProductsPath, 'B.xctestrun'), 'b');
    writeFileSync(path.join(nested, 'A.xctestrun'), 'a');
    writeFileSync(path.join(outside, 'Outside.xctestrun'), 'outside');
    symlinkSync(outside, path.join(testProductsPath, 'linked-outside'));

    expect(await findXctestrunPaths(testProductsPath)).toEqual([
      path.join(testProductsPath, 'B.xctestrun'),
      path.join(nested, 'A.xctestrun'),
    ]);
  });

  it('recognizes only canonical direct children of a managed workspace', async () => {
    const managed = createDefaultTestProductsPath('test_sim');
    mkdirSync(managed);

    const ownership = await resolveManagedTestProductsOwnership(managed);
    expect(ownership).toMatchObject({
      name: path.basename(managed),
      layout: { workspaceKey: 'workspace-a' },
    });

    const external = path.join(appDir, path.basename(createDefaultTestProductsPath('test_sim')));
    mkdirSync(external);
    expect(await resolveManagedTestProductsOwnership(external)).toBeNull();

    const linked = createDefaultTestProductsPath('test_sim');
    symlinkSync(managed, linked, 'dir');
    expect(await resolveManagedTestProductsOwnership(linked)).toBeNull();
  });

  it('surfaces operational ownership inspection failures', async () => {
    const managedName =
      'test_sim_2026-09-12T12-00-00-000Z_pid999999999_abcdef12.xctestproducts';
    const tooLongPath = path.join(
      getWorkspacesDir(),
      'a'.repeat(5000),
      'test-products',
      managedName,
    );

    await expect(resolveManagedTestProductsOwnership(tooLongPath)).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
  });
});
