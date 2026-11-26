import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getIdleWorkerDirectory, prepareWorkerExecutablePath } from './worker-path.js';

test('prepares an app-specific worker copy without changing the packaged worker', t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hollowrun-worker-path-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const packagedDirectory = path.join(temporaryDirectory, 'packaged-worker');
  const userDataDirectory = path.join(temporaryDirectory, 'user-data');
  fs.mkdirSync(packagedDirectory);
  const packagedExecutable = path.join(packagedDirectory, 'HollowRun.Worker.exe');
  fs.writeFileSync(packagedExecutable, 'worker');
  fs.writeFileSync(path.join(packagedDirectory, 'steam_appid.txt'), '779640');

  const preparedExecutable = prepareWorkerExecutablePath(
    packagedExecutable,
    getIdleWorkerDirectory(userDataDirectory, 779640)
  );

  assert.equal(
    preparedExecutable,
    path.join(userDataDirectory, 'workers', 'app_779640', 'HollowRun.Worker.exe')
  );
  assert.equal(fs.readFileSync(preparedExecutable, 'utf8'), 'worker');
  assert.equal(fs.existsSync(path.join(path.dirname(preparedExecutable), 'steam_appid.txt')), false);
  assert.equal(fs.readFileSync(path.join(packagedDirectory, 'steam_appid.txt'), 'utf8'), '779640');
});

test('does not prepare a worker when its packaged executable is missing', () => {
  assert.equal(prepareWorkerExecutablePath(null, os.tmpdir()), null);
});
