const { app, BrowserWindow, dialog, ipcMain, net, screen, session, shell, utilityProcess } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { getCrashReportingConfig } = require('./crash-reporting-config.cjs');
const {
  captureException,
  deactivateCrashReporting,
  initializeCrashReporting,
  isCrashReportingActive,
  isCrashReportingInitialized,
  sendTestReport
} = require('./crash-reporting.cjs');
const { readSettings, writeSettings } = require('./settings.cjs');
const { requestLocalJson } = require('./local-service-client.cjs');
const { getPortableRelaunchOptions } = require('./portable-relaunch.cjs');
const portableUpdater = require('./portable-updater.cjs');
const { isSteamClientReady } = require('./startup-gate.cjs');
const {
  MIN_HEIGHT,
  MIN_WIDTH,
  fitWindowStateToDisplay,
  readWindowState,
  writeWindowState
} = require('./window-state.cjs');

const SERVER_URL = 'http://127.0.0.1:3824';
const GITHUB_REPOSITORY_URL = 'https://github.com/lwkshy/hollowrun';
const RELEASES_URL = 'https://github.com/lwkshy/hollowrun/releases';
const LOADING_PAGE_PATH = path.join(__dirname, 'loading.html');
const LOADING_PAGE_URL = pathToFileURL(LOADING_PAGE_PATH).href;
const SERVER_STARTUP_TIMEOUT_MS = 15000;
const SERVER_RETRY_INTERVAL_MS = 150;
const DEFAULT_WINDOW_WIDTH = 1600;
const DEFAULT_WINDOW_HEIGHT = 900;
const DEFAULT_WINDOW_WORK_AREA_INSET = 48;
const LEGACY_STEAM_COMMUNITY_PARTITION = 'persist:hollowrun-steam-community';
const LEGACY_STEAM_COMMUNITY_CLEANUP_MARKER = 'legacy-steam-community-cleared-v1';
const instanceToken = crypto.randomBytes(32).toString('hex');
let mainWindow;
let serverProcess;
let windowStateSaveTimer;
let backendReady = false;
let backendExitCode = null;
let backendStderr = '';
let isQuitting = false;
let downloadedUpdateVersion = null;
let availableUpdateVersion = null;
let isUpdateDownloading = false;
let isUpdatePromptVisible = false;
let autoUpdaterConfigured = false;
let updateCheckPromise = null;
let portableUpdateCheckPromise = null;
let portableUpdateDownloadPromise = null;
let portableUpdateManifest = null;
let portableUpdateFilePath = null;
let portableUpdateStatePath = null;
let portableUpdateError = null;
let portableUpdateErrorShown = false;
let portableUpdateHandoffStarted = false;
let startupState = {
  progress: 8,
  action: 'Preparing application window...'
};

app.setName('HollowRun');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const crashReportingConfig = getCrashReportingConfig();
let appSettings = readSettings(settingsFile);

if (appSettings.diagnostics.autoSendCrashReports && crashReportingConfig.configured) {
  initializeCrashReporting({
    dsn: crashReportingConfig.dsn,
    release: `hollowrun@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development'
  });
}

function getPublicSettings() {
  const reportingActive = isCrashReportingActive();
  const reportingInitialized = isCrashReportingInitialized();
  const autoSendCrashReports = appSettings.diagnostics.autoSendCrashReports;
  return {
    diagnostics: {
      autoSendCrashReports,
      reportingConfigured: crashReportingConfig.configured,
      reportingActive,
      restartRequired: crashReportingConfig.configured && (
        autoSendCrashReports ? !reportingActive : reportingInitialized
      )
    }
  };
}

ipcMain.handle('settings:get', () => getPublicSettings());

ipcMain.handle('app:open-repository', () => shell.openExternal(GITHUB_REPOSITORY_URL));

ipcMain.handle('app:open-releases', () => shell.openExternal(RELEASES_URL));

ipcMain.handle('app:check-for-updates', async () => {
  if (!app.isPackaged || process.platform !== 'win32') return { status: 'unsupported' };
  if (isPortableBuild()) return checkForPortableUpdate();
  if (!isAutoUpdateSupported()) return { status: 'unsupported' };
  if (downloadedUpdateVersion) {
    promptForDownloadedUpdate();
    return { status: 'downloaded', version: downloadedUpdateVersion };
  }
  if (isUpdateDownloading && availableUpdateVersion) {
    return { status: 'downloading', version: availableUpdateVersion };
  }

  try {
    const result = await requestUpdateCheck();
    if (!result) return { status: 'unsupported' };
    if (downloadedUpdateVersion) {
      return { status: 'downloaded', version: downloadedUpdateVersion };
    }
    if (!result.isUpdateAvailable) {
      return { status: 'current', version: app.getVersion() };
    }

    const version = result.updateInfo?.version || availableUpdateVersion;
    if (version) availableUpdateVersion = version;
    return {
      status: isUpdateDownloading ? 'downloading' : 'available',
      version
    };
  } catch (error) {
    return {
      status: 'error',
      message: error?.message || 'HollowRun could not check for updates.'
    };
  }
});

ipcMain.handle('settings:set-crash-reports', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new TypeError('Crash reporting preference must be a boolean.');
  if (enabled && !crashReportingConfig.configured) {
    throw new Error('Crash reporting is not configured in this build.');
  }

  appSettings = writeSettings(settingsFile, {
    ...appSettings,
    diagnostics: {
      ...appSettings.diagnostics,
      autoSendCrashReports: enabled
    }
  });
  if (!enabled) await deactivateCrashReporting();
  return getPublicSettings();
});

ipcMain.handle('app:restart', async () => {
  if (downloadedUpdateVersion && isPortableBuild()) {
    await startPortableUpdateHandoff();
    setImmediate(() => app.quit());
    return true;
  }
  if (downloadedUpdateVersion && isAutoUpdateSupported()) {
    autoUpdater.quitAndInstall();
    return true;
  }

  const relaunchOptions = getPortableRelaunchOptions({
    isPackaged: app.isPackaged,
    platform: process.platform,
    environment: process.env
  });
  if (relaunchOptions) app.relaunch(relaunchOptions);
  else app.relaunch();

  // Let the invoke response reach the renderer before beginning normal shutdown.
  setImmediate(() => app.quit());
  return true;
});

if (!app.isPackaged) {
  ipcMain.handle('crash-reporting:test', async () => ({
    eventId: await sendTestReport()
  }));
}

function promptForDownloadedUpdate() {
  if (
    !downloadedUpdateVersion
    || isUpdatePromptVisible
    || !backendReady
    || !mainWindow
    || mainWindow.isDestroyed()
  ) return;

  if (mainWindow.webContents.getURL() !== SERVER_URL) {
    mainWindow.webContents.once('did-finish-load', promptForDownloadedUpdate);
    return;
  }

  isUpdatePromptVisible = true;
  const version = downloadedUpdateVersion;
  const portableBuild = isPortableBuild();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'HollowRun Update Ready',
    message: `HollowRun ${version} has been downloaded.`,
    detail: portableBuild
      ? 'Restart now to replace the portable executable at its current location, or choose Later to keep working. The update will apply when you next close HollowRun.'
      : 'Restart now to install it, or choose Later to keep working. The update will install when you next close HollowRun.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }).then(({ response }) => {
    if (response !== 0) return;
    if (!portableBuild) {
      autoUpdater.quitAndInstall();
      return;
    }
    return startPortableUpdateHandoff()
      .then(() => app.quit())
      .catch(async (error) => {
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'HollowRun Update Failed',
          message: 'HollowRun could not start the portable update helper.',
          detail: error.message,
          buttons: ['Close'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
      });
  }).catch((error) => {
    console.error(`Could not show the update prompt: ${error.message}`);
  }).finally(() => {
    isUpdatePromptVisible = false;
  });
}

function isPortableBuild() {
  return Boolean(getPortableRelaunchOptions({
    isPackaged: app.isPackaged,
    platform: process.platform,
    environment: process.env
  }));
}

function isAutoUpdateSupported() {
  return app.isPackaged
    && process.platform === 'win32'
    && !isPortableBuild();
}

function configureAutoUpdater() {
  if (!isAutoUpdateSupported() || autoUpdaterConfigured) return false;

  autoUpdaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    availableUpdateVersion = info.version;
    isUpdateDownloading = true;
    console.log(`HollowRun ${info.version} is available; downloading in the background.`);
  });
  autoUpdater.on('update-not-available', () => {
    availableUpdateVersion = null;
    isUpdateDownloading = false;
    console.log('HollowRun is up to date.');
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info.version;
    isUpdateDownloading = false;
    promptForDownloadedUpdate();
  });
  autoUpdater.on('error', (error) => {
    isUpdateDownloading = false;
    console.warn(`HollowRun update check failed: ${error.message}`);
  });

  return true;
}

function requestUpdateCheck() {
  if (!isAutoUpdateSupported()) return Promise.resolve(null);
  configureAutoUpdater();
  if (updateCheckPromise) return updateCheckPromise;

  updateCheckPromise = autoUpdater.checkForUpdates();
  const currentCheck = updateCheckPromise;
  currentCheck.then(
    () => {
      if (updateCheckPromise === currentCheck) updateCheckPromise = null;
    },
    () => {
      if (updateCheckPromise === currentCheck) updateCheckPromise = null;
    }
  );
  return currentCheck;
}

async function checkForPortableUpdate() {
  if (!isPortableBuild()) return { status: 'unsupported' };
  if (downloadedUpdateVersion && portableUpdateFilePath) {
    promptForDownloadedUpdate();
    return { status: 'downloaded', version: downloadedUpdateVersion };
  }
  if (portableUpdateDownloadPromise && portableUpdateManifest) {
    return { status: 'downloading', version: portableUpdateManifest.version };
  }
  if (portableUpdateCheckPromise) {
    try {
      return await portableUpdateCheckPromise;
    } catch (error) {
      return {
        status: 'error',
        message: error?.message || 'HollowRun could not check for portable updates.'
      };
    }
  }

  const currentCheck = (async () => {
    const userDataPath = app.getPath('userData');
    const pending = await portableUpdater.loadPendingPortableUpdate(userDataPath, app.getVersion());
    if (pending) {
      portableUpdateManifest = pending.manifest;
      portableUpdateFilePath = pending.updateFilePath;
      portableUpdateStatePath = pending.pendingFilePath;
      downloadedUpdateVersion = pending.manifest.version;
      promptForDownloadedUpdate();
      return { status: 'downloaded', version: downloadedUpdateVersion };
    }

    const fetchImpl = (url, options) => net.fetch(url, options);
    const result = await portableUpdater.fetchLatestPortableUpdate(app.getVersion(), fetchImpl);
    if (result.status === 'current' || result.status === 'unavailable') return result;

    portableUpdateManifest = result.manifest;
    availableUpdateVersion = result.manifest.version;
    isUpdateDownloading = true;
    portableUpdateError = null;
    portableUpdateErrorShown = false;
    portableUpdateDownloadPromise = portableUpdater.downloadPortableUpdate(
      result.manifest,
      userDataPath,
      fetchImpl
    ).then((downloaded) => {
      portableUpdateFilePath = downloaded.updateFilePath;
      portableUpdateStatePath = downloaded.pendingFilePath;
      downloadedUpdateVersion = result.manifest.version;
      isUpdateDownloading = false;
      portableUpdateError = null;
      promptForDownloadedUpdate();
    }).catch((error) => {
      isUpdateDownloading = false;
      portableUpdateError = error;
      portableUpdateManifest = null;
      availableUpdateVersion = null;
      console.warn(`HollowRun portable update download failed: ${error.message}`);
      showPortableUpdateDownloadError();
    }).finally(() => {
      portableUpdateDownloadPromise = null;
    });

    return { status: 'downloading', version: result.manifest.version };
  })();

  portableUpdateCheckPromise = currentCheck;
  try {
    return await currentCheck;
  } catch (error) {
    return {
      status: 'error',
      message: error?.message || 'HollowRun could not check for portable updates.'
    };
  } finally {
    if (portableUpdateCheckPromise === currentCheck) portableUpdateCheckPromise = null;
  }
}

function showPortableUpdateDownloadError() {
  if (
    !portableUpdateError
    || portableUpdateErrorShown
    || !backendReady
    || !mainWindow
    || mainWindow.isDestroyed()
  ) return;

  portableUpdateErrorShown = true;
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Portable Update Failed',
    message: 'HollowRun could not download the portable update.',
    detail: `${portableUpdateError.message}\n\nYou can retry from Settings or use View releases.`,
    buttons: ['Close', 'View releases'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }).then(({ response }) => {
    if (response === 1) shell.openExternal(RELEASES_URL);
  }).catch((error) => {
    console.error(`Could not show the portable update error: ${error.message}`);
  });
}

function startPortableUpdateHandoff() {
  if (portableUpdateHandoffStarted) return Promise.resolve();
  if (!isPortableBuild() || !portableUpdateManifest || !portableUpdateFilePath || !portableUpdateStatePath) {
    return Promise.reject(new Error('The portable update is not ready to install.'));
  }

  const targetPath = getPortableRelaunchOptions({
    isPackaged: app.isPackaged,
    platform: process.platform,
    environment: process.env
  })?.execPath;
  if (!targetPath) return Promise.reject(new Error('The portable executable path is unavailable.'));

  const helperSource = path.join(process.resourcesPath, 'HollowRun.PortableUpdater.exe');
  if (!fs.existsSync(helperSource)) {
    return Promise.reject(new Error('The portable update helper is missing from this build.'));
  }

  const helperPath = path.join(app.getPath('userData'), `portable-updater-${app.getVersion()}.exe`);
  fs.copyFileSync(helperSource, helperPath);
  const installedMarkerPath = path.join(app.getPath('userData'), 'portable-update-installed.txt');
  const helperArguments = [
    '--apply-portable-update',
    '--parent-process-id', String(process.ppid),
    '--target', targetPath,
    '--staged-update', portableUpdateFilePath,
    '--pending-file', portableUpdateStatePath,
    '--installed-marker', installedMarkerPath,
    '--sha512', portableUpdateManifest.sha512,
    '--version', portableUpdateManifest.version
  ];

  let helperProcess;
  try {
    helperProcess = spawn(helperPath, helperArguments, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (error) {
    return Promise.reject(error);
  }

  portableUpdateHandoffStarted = true;
  return new Promise((resolve, reject) => {
    helperProcess.once('spawn', () => {
      helperProcess.unref();
      resolve();
    });
    helperProcess.once('error', (error) => {
      portableUpdateHandoffStarted = false;
      reject(error);
    });
  });
}

function cleanupSuccessfulPortableUpdate() {
  if (!isPortableBuild()) return;
  const targetPath = getPortableRelaunchOptions({
    isPackaged: app.isPackaged,
    platform: process.platform,
    environment: process.env
  })?.execPath;
  if (!targetPath) return;

  const markerPath = path.join(app.getPath('userData'), 'portable-update-installed.txt');
  try {
    const installedVersion = fs.readFileSync(markerPath, 'utf8').trim();
    if (installedVersion !== app.getVersion()) return;
    fs.rmSync(`${targetPath}.previous`, { force: true });
    fs.rmSync(markerPath, { force: true });
  } catch {
    // The marker is created only when the portable helper applies an update.
  }
}

function startUpdateCheck() {
  if (isPortableBuild()) {
    checkForPortableUpdate().catch((error) => {
      console.warn(`HollowRun portable update check failed: ${error.message}`);
    });
    return;
  }
  if (!isAutoUpdateSupported()) return;
  requestUpdateCheck().catch(() => {});
}

async function clearLegacySteamCommunitySession() {
  const markerPath = path.join(app.getPath('userData'), LEGACY_STEAM_COMMUNITY_CLEANUP_MARKER);
  if (fs.existsSync(markerPath)) return;

  const legacySession = session.fromPartition(LEGACY_STEAM_COMMUNITY_PARTITION);
  await Promise.all([
    legacySession.clearStorageData(),
    legacySession.clearCache()
  ]);
  fs.writeFileSync(markerPath, '', { flag: 'a' });
}

function scheduleLegacySteamCommunityCleanup() {
  const timer = setTimeout(() => {
    clearLegacySteamCommunitySession().catch(() => {});
  }, 5000);
  timer.unref?.();
}

function getDefaultWindowBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(
    MIN_WIDTH,
    Math.min(DEFAULT_WINDOW_WIDTH, workArea.width - DEFAULT_WINDOW_WORK_AREA_INSET)
  );
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(DEFAULT_WINDOW_HEIGHT, workArea.height - DEFAULT_WINDOW_WORK_AREA_INSET)
  );

  return {
    x: workArea.x + Math.max(0, Math.round((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)),
    width,
    height
  };
}

function publishStartupProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const currentUrl = mainWindow.webContents.getURL();
  if (currentUrl !== LOADING_PAGE_URL && !currentUrl.startsWith(`${LOADING_PAGE_URL}?`)) return;
  mainWindow.webContents.send('startup-progress', startupState);
}

function updateStartupProgress(progress, action) {
  startupState = {
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    action
  };
  publishStartupProgress();
}

const checkServer = async () => Boolean(await requestLocalJson(
  `${SERVER_URL}/api/health`,
  instanceToken,
  { timeoutMs: 750 }
));

const waitForServer = async () => {
  const startedAt = Date.now();
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  updateStartupProgress(34, 'Waiting for local services...');

  do {
    if (backendExitCode !== null) return false;
    if (await checkServer()) {
      updateStartupProgress(78, 'Local services are ready.');
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const elapsedRatio = (Date.now() - startedAt) / SERVER_STARTUP_TIMEOUT_MS;
    updateStartupProgress(34 + Math.min(40, Math.floor(elapsedRatio * 40)), 'Waiting for local services...');
    await new Promise(resolve => setTimeout(resolve, Math.min(SERVER_RETRY_INTERVAL_MS, remaining)));
  } while (Date.now() < deadline);

  return false;
};

const getBackendStatus = () => requestLocalJson(
  `${SERVER_URL}/api/status`,
  instanceToken
);

async function showSteamClientRequired(status) {
  const steamWasFound = status?.steamInstalled === true;
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Steam Client Required',
    message: steamWasFound
      ? 'Steam Client must be running and signed in before HollowRun can start.'
      : 'Steam could not be found on this computer.',
    detail: steamWasFound
      ? 'Open Steam, sign in to your account, then start HollowRun again.'
      : 'Install Steam or repair its installation, then start HollowRun again.',
    buttons: ['Close HollowRun'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
}

async function showBackendStartupFailure() {
  const portIsOccupied = /\bEADDRINUSE\b/.test(backendStderr);
  const detail = portIsOccupied
    ? 'Another HollowRun background process is already using local port 3824. Close any remaining HollowRun or Node process in Task Manager, then start HollowRun again.'
    : backendExitCode !== null
      ? `The local service exited unexpectedly (code ${backendExitCode}). Restart HollowRun and check whether security software blocked one of its processes.`
      : 'The local service did not respond within 15 seconds. Restart HollowRun and check whether security software blocked one of its processes.';

  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'HollowRun Startup Failed',
    message: 'HollowRun could not start its local service.',
    detail,
    buttons: ['Close HollowRun'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
}

function isAllowedNavigation(url) {
  return url === SERVER_URL
    || url === `${SERVER_URL}/`
    || url === LOADING_PAGE_URL
    || url.startsWith(`${LOADING_PAGE_URL}?`);
}

function loadWindowContent() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const load = backendReady
    ? mainWindow.loadURL(SERVER_URL)
    : mainWindow.loadFile(LOADING_PAGE_PATH);

  load.catch((error) => {
    if (error?.code !== 'ERR_ABORTED' && error?.errno !== -3) {
      console.error(`Could not load the HollowRun window: ${error.message}`);
      captureException(error, { component: 'window-load' });
    }
  });
}

function createWindow() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const savedState = readWindowState(stateFile);
  const restoredState = savedState ? fitWindowStateToDisplay(savedState, screen) : null;
  const shouldMaximize = restoredState?.isMaximized === true;
  const initialBounds = restoredState
    ? {
        x: restoredState.x,
        y: restoredState.y,
        width: restoredState.width,
        height: restoredState.height
      }
    : getDefaultWindowBounds();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#010203',
    title: 'HollowRun',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#030405',
      symbolColor: '#f3f5f7',
      height: 28
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'loading-preload.cjs'),
      additionalArguments: [
        `--hollowrun-crash-reporting=${isCrashReportingActive() ? '1' : '0'}`,
        `--hollowrun-test-reports=${app.isPackaged ? '0' : '1'}`
      ]
    },
    icon: path.join(__dirname, 'frontend/dist/hollowrun.png')
  });

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${SERVER_URL}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'X-HollowRun-Instance': instanceToken
        }
      });
    }
  );

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', publishStartupProgress);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    captureException(
      new Error(`HollowRun renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`),
      { component: 'renderer-process' }
    );
  });

  const saveWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    writeWindowState(stateFile, {
      ...mainWindow.getNormalBounds(),
      isMaximized: mainWindow.isMaximized()
    });
  };

  const scheduleWindowStateSave = () => {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(saveWindowState, 250);
  };

  mainWindow.once('ready-to-show', () => {
    if (shouldMaximize) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);
  mainWindow.on('close', saveWindowState);
  loadWindowContent();

  mainWindow.on('closed', function () {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;

  createWindow();
  startUpdateCheck();
  scheduleLegacySteamCommunityCleanup();
  updateStartupProgress(20, 'Starting local services...');
  const serverPath = path.join(__dirname, 'backend', 'server.js');
  serverProcess = utilityProcess.fork(serverPath, [], {
    env: {
      ...process.env,
      ELECTRON_APP: 'true',
      HOLLOWRUN_INSTANCE_TOKEN: instanceToken,
      HOLLOWRUN_USER_DATA: app.getPath('userData')
    },
    stdio: 'pipe'
  });
  serverProcess.stdout?.on('data', (data) => console.log(data.toString().trimEnd()));
  serverProcess.stderr?.on('data', (data) => {
    const message = data.toString().trimEnd();
    backendStderr = `${backendStderr}\n${message}`.slice(-4000);
    console.error(message);
  });
  serverProcess.on('exit', (code) => {
    backendExitCode = code ?? -1;
    if (code !== 0) {
      console.error(`Backend process exited with code ${code}.`);
      if (!isQuitting) {
        captureException(
          new Error(`HollowRun backend exited unexpectedly with code ${code}.`),
          { component: 'backend-process' }
        );
      }
    }
  });

  if (await waitForServer()) {
    updateStartupProgress(82, 'Checking the Steam Client connection...');
    const status = await getBackendStatus();
    if (!isSteamClientReady(status)) {
      await showSteamClientRequired(status);
      app.quit();
      return;
    }

    updateStartupProgress(88, 'Loading your Steam library...');
    backendReady = true;
    loadWindowContent();
    cleanupSuccessfulPortableUpdate();
    showPortableUpdateDownloadError();
    promptForDownloadedUpdate();
  } else {
    console.error('Backend server failed to start on port 3824 in time.');
    await showBackendStartupFailure();
    app.quit();
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  const startupError = error instanceof Error ? error : new Error(String(error));
  console.error(`Unexpected HollowRun startup failure: ${startupError.message}`);
  captureException(startupError, { component: 'app-startup' });
  if (app.isReady()) {
    dialog.showErrorBox(
      'HollowRun Startup Failed',
      'HollowRun encountered an unexpected error while starting. Restart the application and check whether security software blocked one of its processes.'
    );
  }
  app.quit();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (isPortableBuild() && downloadedUpdateVersion && !portableUpdateHandoffStarted) {
    try {
      startPortableUpdateHandoff().catch((error) => {
        console.error(`Could not start the portable update helper on exit: ${error.message}`);
      });
    } catch (error) {
      console.error(`Could not start the portable update helper on exit: ${error.message}`);
    }
  }
  if (serverProcess) {
    console.log('Terminating backend server...');
    serverProcess.kill();
    serverProcess = null;
  }
});
