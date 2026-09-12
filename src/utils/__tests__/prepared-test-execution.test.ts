import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandExecutor } from '../command.ts';
import { createMockCommandResponse } from '../../test-utils/mock-executors.ts';
import { DefaultStreamingExecutionContext } from '../execution/index.ts';
import { setXcodeBuildMCPAppDirOverrideForTests } from '../log-paths.ts';
import { createDefaultTestProductsPath, markTestProductsPathCompleted } from '../test-products-path.ts';
import { getTestProductsReaderLeaseDirectory } from '../test-products-reader-lease.ts';
import { setRuntimeInstanceForTests } from '../runtime-instance.ts';
import { createTestExecutor } from '../test-common.ts';
import { resetWorkspaceFilesystemLifecycleStateForTests } from '../workspace-filesystem-lifecycle.ts';
import {
  acquireWorkspaceFilesystemLifecycleLock,
  setWorkspaceFilesystemLockAcquisitionAttemptHookForTests,
} from '../workspace-filesystem-lock.ts';
import { XcodePlatform } from '../xcode.ts';

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

describe('prepared test execution', () => {
  let tempAppDir: string;

  beforeEach(() => {
    tempAppDir = mkdtempSync(join(tmpdir(), 'xcodebuildmcp-prepared-test-'));
    setXcodeBuildMCPAppDirOverrideForTests(tempAppDir);
    setRuntimeInstanceForTests({
      instanceId: 'prepared-test',
      pid: process.pid,
      workspaceKey: 'workspace-a',
    });
  });

  afterEach(() => {
    setWorkspaceFilesystemLockAcquisitionAttemptHookForTests(null);
    resetWorkspaceFilesystemLifecycleStateForTests();
    setXcodeBuildMCPAppDirOverrideForTests(null);
    setRuntimeInstanceForTests(null);
    rmSync(tempAppDir, { recursive: true, force: true });
  });

  it('runs prepared test products without source or DerivedData arguments', async () => {
    const preparedTestProductsPath = join(tempAppDir, 'Prepared Tests.xctestproducts');
    mkdirSync(preparedTestProductsPath);
    const commands: string[][] = [];
    const workingDirectories: Array<string | undefined> = [];
    const executor: CommandExecutor = async (command, _logPrefix, _useShell, options) => {
      commands.push(command);
      workingDirectories.push(options?.cwd);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    const result = await executeTest(
      {
        testProductsPath: preparedTestProductsPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
        extraArgs: ['-only-testing:WeatherTests/testWeather'],
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual([
      'xcodebuild',
      '-testProductsPath',
      realpathSync(preparedTestProductsPath),
      '-destination',
      'platform=iOS Simulator,id=A2C64636-37E9-4B68-B872-E7F0A82A5670',
      '-collect-test-diagnostics',
      'never',
      '-only-testing:WeatherTests/testWeather',
      '-resultBundlePath',
      expect.stringContaining('/result-bundles/test_sim_'),
      'test-without-building',
    ]);
    expect(result.artifacts.testProductsPath).toBe(preparedTestProductsPath);
    expect(result.artifacts.xcresultPath).toEqual(expect.stringMatching(/\.xcresult$/u));
    expect(workingDirectories).toEqual([undefined]);
  });

  it('runs an xctestrun artifact directly for a physical device', async () => {
    const xctestrunPath = join(tempAppDir, 'Weather.xctestrun');
    writeFileSync(xctestrunPath, 'stub');
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_device',
      target: 'device',
      request: { platform: XcodePlatform.iOS, deviceId: 'DEVICE-123' },
    });

    const result = await executeTest(
      {
        xctestrunPath,
        deviceId: 'DEVICE-123',
        platform: XcodePlatform.iOS,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('-xctestrun');
    expect(commands[0]).toContain(realpathSync(xctestrunPath));
    expect(commands[0]).toContain('platform=iOS,id=DEVICE-123');
    expect(commands[0]).not.toContain('-scheme');
    expect(commands[0]).not.toContain('-derivedDataPath');
    expect(commands[0]!.at(-1)).toBe('test-without-building');
    expect(result.artifacts.xctestrunPath).toBe(xctestrunPath);
  });

  it('returns structured failures for unavailable prepared artifacts without executing', async () => {
    let executionCount = 0;
    const executor: CommandExecutor = async () => {
      executionCount += 1;
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_device',
      target: 'device',
      request: {
        platform: XcodePlatform.iOS,
        deviceId: 'DEVICE-123',
      },
    });

    for (const preparedSource of [
      { testProductsPath: join(tempAppDir, 'Missing.xctestproducts') },
      { xctestrunPath: join(tempAppDir, 'Missing.xctestrun') },
    ]) {
      const result = await executeTest(
        {
          ...preparedSource,
          deviceId: 'DEVICE-123',
          platform: XcodePlatform.iOS,
        },
        new DefaultStreamingExecutionContext(),
      );

      expect(result).toMatchObject({
        kind: 'test-result',
        didError: true,
      });
      expect(result.diagnostics.rawOutput).toEqual([
        expect.stringContaining('Prepared test artifact is unavailable'),
      ]);
    }
    expect(executionCount).toBe(0);
  });

  it('does not forward source-only arguments to the prepared test phase', async () => {
    const commands: string[][] = [];
    const executor: CommandExecutor = async (command) => {
      commands.push(command);
      return createMockCommandResponse({ success: true, output: '', exitCode: 0 });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_macos',
      target: 'macos',
      request: {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        platform: XcodePlatform.macOS,
      },
    });

    await executeTest(
      {
        scheme: 'Weather',
        projectPath: 'Weather.xcodeproj',
        platform: XcodePlatform.macOS,
        extraArgs: [
          '-destination',
          'platform=macOS,arch=arm64',
          '-scheme=Injected',
          '-derivedDataPath',
          '/tmp/OtherDerivedData',
          '-quiet',
          '-only-testing:WeatherTests/testWeather',
        ],
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('-destination');
    expect(commands[0]).toContain('-scheme=Injected');
    expect(commands[0]).toContain('-derivedDataPath');
    expect(commands[1]).toContain('platform=macOS,arch=arm64');
    expect(commands[1].filter((argument) => argument === '-destination')).toHaveLength(1);
    expect(commands[1]).not.toContain('-scheme=Injected');
    expect(commands[1]).not.toContain('/tmp/OtherDerivedData');
    expect(commands[1]).toContain('-quiet');
    expect(commands[1]).toContain('-only-testing:WeatherTests/testWeather');
  });

  it('holds a managed reader lease for the command and releases it after an infrastructure error', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    mkdirSync(testProductsPath);
    markTestProductsPathCompleted(testProductsPath);
    const artifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(testProductsPath),
    );
    const executor: CommandExecutor = async () => {
      expect(readdirSync(artifactLeaseDirectory)).toHaveLength(1);
      throw new Error('spawn failed');
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    await expect(
      executeTest(
        {
          testProductsPath,
          simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
          platform: XcodePlatform.iOSSimulator,
        },
        new DefaultStreamingExecutionContext(),
      ),
    ).rejects.toThrow('spawn failed');

    expect(readdirSync(artifactLeaseDirectory)).toHaveLength(0);
  });

  it('holds the same reader lease when the prepared source is a nested xctestrun path', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const xctestrunPath = join(testProductsPath, 'Tests', 'App.xctestrun');
    mkdirSync(join(testProductsPath, 'Tests'), { recursive: true });
    markTestProductsPathCompleted(testProductsPath);
    const artifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(testProductsPath),
    );
    const executor: CommandExecutor = async () => {
      expect(readdirSync(artifactLeaseDirectory)).toHaveLength(1);
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    await executeTest(
      {
        xctestrunPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(readdirSync(artifactLeaseDirectory)).toHaveLength(0);
  });

  it('holds the managed reader lease when an xctestrun is passed through a symbolic link', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const xctestrunPath = join(testProductsPath, 'Tests', 'App.xctestrun');
    const linkedXctestrunPath = join(tempAppDir, 'Linked.xctestrun');
    mkdirSync(join(testProductsPath, 'Tests'), { recursive: true });
    writeFileSync(xctestrunPath, 'stub');
    symlinkSync(xctestrunPath, linkedXctestrunPath);
    markTestProductsPathCompleted(testProductsPath);
    const artifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(testProductsPath),
    );
    const executor: CommandExecutor = async () => {
      expect(readdirSync(artifactLeaseDirectory)).toHaveLength(1);
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    await executeTest(
      {
        xctestrunPath: linkedXctestrunPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(readdirSync(artifactLeaseDirectory)).toHaveLength(0);
  });

  it('holds the managed reader lease when test products are passed through a symbolic link', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const linkedTestProductsPath = join(tempAppDir, 'Linked.xctestproducts');
    mkdirSync(testProductsPath);
    symlinkSync(testProductsPath, linkedTestProductsPath);
    markTestProductsPathCompleted(testProductsPath);
    const artifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(testProductsPath),
    );
    const executor: CommandExecutor = async () => {
      expect(readdirSync(artifactLeaseDirectory)).toHaveLength(1);
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    await executeTest(
      {
        testProductsPath: linkedTestProductsPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(readdirSync(artifactLeaseDirectory)).toHaveLength(0);
  });

  it('uses the leased canonical source if a symbolic link is retargeted before execution', async () => {
    const firstTestProductsPath = createDefaultTestProductsPath('test_sim');
    const secondTestProductsPath = createDefaultTestProductsPath('test_sim');
    const linkedTestProductsPath = join(tempAppDir, 'Linked.xctestproducts');
    mkdirSync(firstTestProductsPath);
    mkdirSync(secondTestProductsPath);
    symlinkSync(firstTestProductsPath, linkedTestProductsPath);
    markTestProductsPathCompleted(firstTestProductsPath);
    markTestProductsPathCompleted(secondTestProductsPath);
    const firstArtifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(firstTestProductsPath),
    );
    const secondArtifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(secondTestProductsPath),
    );
    const executor: CommandExecutor = async (command) => {
      const replacementLinkPath = join(tempAppDir, 'Replacement.xctestproducts');
      symlinkSync(secondTestProductsPath, replacementLinkPath);
      renameSync(replacementLinkPath, linkedTestProductsPath);
      expect(command).toContain(realpathSync(firstTestProductsPath));
      expect(command).not.toContain(linkedTestProductsPath);
      expect(command).not.toContain(realpathSync(secondTestProductsPath));
      expect(readdirSync(firstArtifactLeaseDirectory)).toHaveLength(1);
      expect(() => readdirSync(secondArtifactLeaseDirectory)).toThrow();
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    await executeTest(
      {
        testProductsPath: linkedTestProductsPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );

    expect(readdirSync(firstArtifactLeaseDirectory)).toHaveLength(0);
  });

  it('resolves the prepared source while holding the lifecycle lock that creates its lease', async () => {
    const firstTestProductsPath = createDefaultTestProductsPath('test_sim');
    const secondTestProductsPath = createDefaultTestProductsPath('test_sim');
    const linkedTestProductsPath = join(tempAppDir, 'Linked.xctestproducts');
    mkdirSync(firstTestProductsPath);
    mkdirSync(secondTestProductsPath);
    symlinkSync(firstTestProductsPath, linkedTestProductsPath);
    markTestProductsPathCompleted(firstTestProductsPath);
    markTestProductsPathCompleted(secondTestProductsPath);
    const secondArtifactLeaseDirectory = getTestProductsReaderLeaseDirectory(
      'workspace-a',
      basename(secondTestProductsPath),
    );
    const heldLock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: 'workspace-a',
    });
    const executor: CommandExecutor = async (command) => {
      expect(command).toContain(realpathSync(secondTestProductsPath));
      expect(command).not.toContain(realpathSync(firstTestProductsPath));
      expect(readdirSync(secondArtifactLeaseDirectory)).toHaveLength(1);
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    const lockAcquisitionAttempted = nextWorkspaceLockAcquisitionAttempt();
    const execution = executeTest(
      {
        testProductsPath: linkedTestProductsPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );
    await lockAcquisitionAttempted;
    const replacementLinkPath = join(tempAppDir, 'Replacement.xctestproducts');
    symlinkSync(secondTestProductsPath, replacementLinkPath);
    renameSync(replacementLinkPath, linkedTestProductsPath);
    await heldLock.release();
    await execution;

    expect(readdirSync(secondArtifactLeaseDirectory)).toHaveLength(0);
  });

  it('does not downgrade a managed prepared-source alias to unmanaged execution', async () => {
    const testProductsPath = createDefaultTestProductsPath('test_sim');
    const unmanagedProductsPath = join(tempAppDir, 'Unmanaged.xctestproducts');
    const linkedTestProductsPath = join(tempAppDir, 'Linked.xctestproducts');
    mkdirSync(testProductsPath);
    mkdirSync(unmanagedProductsPath);
    symlinkSync(testProductsPath, linkedTestProductsPath);
    markTestProductsPathCompleted(testProductsPath);
    const heldLock = await acquireWorkspaceFilesystemLifecycleLock({
      workspaceKey: 'workspace-a',
    });
    let executorRan = false;
    const executor: CommandExecutor = async () => {
      executorRan = true;
      return createMockCommandResponse({ success: true, output: '' });
    };
    const executeTest = createTestExecutor(executor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: {
        platform: XcodePlatform.iOSSimulator,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
      },
    });

    const lockAcquisitionAttempted = nextWorkspaceLockAcquisitionAttempt();
    const execution = executeTest(
      {
        testProductsPath: linkedTestProductsPath,
        simulatorId: 'A2C64636-37E9-4B68-B872-E7F0A82A5670',
        platform: XcodePlatform.iOSSimulator,
      },
      new DefaultStreamingExecutionContext(),
    );
    await lockAcquisitionAttempted;
    const replacementLinkPath = join(tempAppDir, 'Replacement.xctestproducts');
    symlinkSync(unmanagedProductsPath, replacementLinkPath);
    renameSync(replacementLinkPath, linkedTestProductsPath);
    await heldLock.release();

    await expect(execution).rejects.toThrow('moved outside managed storage');
    expect(executorRan).toBe(false);
  });
});
