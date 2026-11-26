import fs from 'fs';
import path from 'path';
import { copyFileIfChanged } from './worker-files.js';

const WORKER_FILES = [
  'HollowRun.Worker.exe',
  'HollowRun.Worker.dll',
  'HollowRun.Worker.deps.json',
  'HollowRun.Worker.runtimeconfig.json',
  'Facepunch.Steamworks.Win64.dll',
  'steam_api64.dll'
];

export function resolveAsarUnpackedPath(filePath) {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(asarSegment)) return filePath;
  return filePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
}

export function getWorkerExecutableCandidates(baseDirectory) {
  const publishedWorker = path.join(
    baseDirectory,
    '..',
    'HollowRun.Worker',
    'publish',
    'HollowRun.Worker.exe'
  );

  return [...new Set([
    resolveAsarUnpackedPath(publishedWorker),
    publishedWorker,
    path.join(
      baseDirectory,
      '..',
      'HollowRun.Worker',
      'bin',
      'Release',
      'net10.0',
      'win-x64',
      'HollowRun.Worker.exe'
    ),
    path.join(
      baseDirectory,
      '..',
      'HollowRun.Worker',
      'bin',
      'Debug',
      'net10.0',
      'HollowRun.Worker.exe'
    )
  ])];
}

export function findWorkerExecutablePath(baseDirectory, existsSync = fs.existsSync) {
  return getWorkerExecutableCandidates(baseDirectory).find(candidate => existsSync(candidate)) || null;
}

export function getIdleWorkerDirectory(userDataDirectory, appId) {
  return getWorkerDirectory(userDataDirectory, `app_${appId}`);
}

export function getWorkerDirectory(userDataDirectory, workerDirectoryName) {
  return path.join(userDataDirectory, 'workers', workerDirectoryName);
}

export function prepareWorkerExecutablePath(workerExecutablePath, workerDirectory) {
  if (!workerExecutablePath) return null;

  fs.mkdirSync(workerDirectory, { recursive: true });

  for (const fileName of WORKER_FILES) {
    const sourcePath = path.join(path.dirname(workerExecutablePath), fileName);
    if (fs.existsSync(sourcePath)) {
      copyFileIfChanged(sourcePath, path.join(workerDirectory, fileName));
    }
  }

  const preparedExecutablePath = path.join(workerDirectory, path.basename(workerExecutablePath));
  return fs.existsSync(preparedExecutablePath) ? preparedExecutablePath : null;
}
