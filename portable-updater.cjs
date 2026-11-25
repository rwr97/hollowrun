const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PORTABLE_MANIFEST_URL = 'https://github.com/rwr97/hollowrun/releases/latest/download/portable-update.json';
const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/rwr97/hollowrun/releases/latest';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PORTABLE_UPDATE_SIZE = 1024 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
]);

function parseVersion(version) {
  const match = String(version || '').match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  };
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) throw new Error('Could not compare invalid HollowRun versions.');

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true });
}

function getPortableAssetUrl(version, file) {
  return `https://github.com/rwr97/hollowrun/releases/latest/download/${encodeURIComponent(file)}`;
}

function validatePortableManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2].includes(value.schemaVersion)) {
    throw new Error('The portable update manifest has an unsupported format.');
  }

  const version = String(value.version || '');
  if (!parseVersion(version)) throw new Error('The portable update manifest has an invalid version.');

  const file = String(value.file || '');
  if (!/^HollowRun(?:[ ._-])\d+\.\d+\.\d+\.exe$/i.test(file) || /setup/i.test(file)) {
    throw new Error('The portable update manifest has an invalid file name.');
  }

  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PORTABLE_UPDATE_SIZE) {
    throw new Error('The portable update manifest has an invalid file size.');
  }

  const url = String(value.url || '');
  validateGithubDownloadUrl(url);
  if (value.schemaVersion === 1) {
    const encodedFile = encodeURIComponent(file);
    const expectedUrls = new Set([
      `https://github.com/rwr97/hollowrun/releases/latest/download/${encodedFile}`,
      `https://github.com/rwr97/hollowrun/releases/download/${version}/${encodedFile}`,
      `https://github.com/rwr97/hollowrun/releases/download/v${version}/${encodedFile}`
    ]);
    if (!expectedUrls.has(url)) throw new Error('The portable update manifest has an invalid download URL.');
    const sha512 = String(value.sha512 || '');
    const decodedHash = Buffer.from(sha512, 'base64');
    if (decodedHash.length !== 64 || decodedHash.toString('base64') !== sha512) {
      throw new Error('The portable update manifest has an invalid SHA-512 checksum.');
    }
    return { schemaVersion: 1, version, file, size, sha512, hashAlgorithm: 'sha512', url };
  }

  const sha256 = String(value.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('The portable update manifest has an invalid SHA-256 checksum.');
  }
  return { schemaVersion: 2, version, file, size, sha256, hashAlgorithm: 'sha256', url };
}

function validateGithubDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('The portable update download redirected to an untrusted host.');
  }
}

async function fetchLatestPortableUpdate(currentVersion, fetchImpl = globalThis.fetch) {
  validateGithubDownloadUrl(PORTABLE_MANIFEST_URL);
  const response = await fetchImpl(PORTABLE_MANIFEST_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 404) {
    const releaseResponse = await fetchImpl(GITHUB_RELEASE_API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `HollowRun/${currentVersion}` },
      signal: AbortSignal.timeout(20000)
    });
    if (releaseResponse.status === 404) return { status: 'unavailable', version: currentVersion };
    if (!releaseResponse.ok) {
      throw new Error(`Could not fetch the latest portable release (HTTP ${releaseResponse.status}).`);
    }
    const release = await releaseResponse.json();
    const releaseVersion = String(release.tag_name || '').replace(/^v/i, '');
    if (!parseVersion(releaseVersion)) throw new Error('The latest portable release has an invalid version.');
    const asset = (release.assets || []).find(candidate => (
      typeof candidate?.name === 'string'
      && candidate.name.toLowerCase() === `hollowrun.${releaseVersion}.exe`.toLowerCase()
    ));
    const digest = String(asset?.digest || '');
    if (!asset || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
      return { status: 'unavailable', version: currentVersion };
    }
    const manifest = validatePortableManifest({
      schemaVersion: 2,
      version: releaseVersion,
      file: asset.name,
      size: asset.size,
      sha256: digest.slice(7),
      url: asset.browser_download_url
    });
    if (compareVersions(manifest.version, currentVersion) <= 0) return { status: 'current', version: currentVersion };
    return { status: 'available', manifest };
  }
  if (!response.ok) {
    throw new Error(`Could not fetch the portable update manifest (HTTP ${response.status}).`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('The portable update manifest is too large.');
  }

  let rawManifest;
  try {
    rawManifest = JSON.parse(text);
  } catch {
    throw new Error('The portable update manifest is not valid JSON.');
  }
  const manifest = validatePortableManifest(rawManifest);
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { status: 'current', version: currentVersion };
  }
  return { status: 'available', manifest };
}

function getPortableUpdatePaths(userDataPath, version) {
  if (!parseVersion(version)) throw new Error('Cannot create paths for an invalid update version.');
  const updateDirectory = path.join(userDataPath, 'portable-updates');
  return {
    updateDirectory,
    updateFilePath: path.join(updateDirectory, `HollowRun-${version}.exe`),
    pendingFilePath: path.join(userDataPath, 'portable-update-pending.json')
  };
}

async function sha512File(filePath) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

async function hashFile(filePath, manifest) {
  if (manifest.hashAlgorithm === 'sha512') return sha512File(filePath);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyPortableUpdateFile(filePath, manifest) {
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile() || stat.size !== manifest.size) return false;
    return await hashFile(filePath, manifest) === (manifest.sha512 || manifest.sha256);
  } catch {
    return false;
  }
}

async function savePendingPortableUpdate(userDataPath, manifest) {
  const { pendingFilePath } = getPortableUpdatePaths(userDataPath, manifest.version);
  const temporaryPath = `${pendingFilePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsPromises.rm(pendingFilePath, { force: true });
  await fsPromises.rename(temporaryPath, pendingFilePath);
  return pendingFilePath;
}

async function downloadPortableUpdate(manifest, userDataPath, fetchImpl = globalThis.fetch) {
  const paths = getPortableUpdatePaths(userDataPath, manifest.version);
  await fsPromises.mkdir(paths.updateDirectory, { recursive: true });

  if (await verifyPortableUpdateFile(paths.updateFilePath, manifest)) {
    const pendingFilePath = await savePendingPortableUpdate(userDataPath, manifest);
    return { ...paths, pendingFilePath };
  }

  const partialPath = `${paths.updateFilePath}.partial`;
  await fsPromises.rm(partialPath, { force: true });

  try {
    validateGithubDownloadUrl(manifest.url);
    const response = await fetchImpl(manifest.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (!response.ok || !response.body) {
      throw new Error(`Could not download the portable update (HTTP ${response.status}).`);
    }
    const responseSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(responseSize) && responseSize > 0 && responseSize !== manifest.size) {
      throw new Error('The portable update size does not match its manifest.');
    }

    const hash = crypto.createHash(manifest.hashAlgorithm);
    let receivedBytes = 0;
    const verifyStream = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > manifest.size) {
          callback(new Error('The portable update is larger than its manifest.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(response.body),
      verifyStream,
      fs.createWriteStream(partialPath, { flags: 'wx' })
    );

    const digest = manifest.hashAlgorithm === 'sha512' ? hash.digest('base64') : hash.digest('hex');
    if (receivedBytes !== manifest.size || digest !== (manifest.sha512 || manifest.sha256)) {
      throw new Error(`The portable update failed its ${manifest.hashAlgorithm.toUpperCase()} integrity check.`);
    }

    await fsPromises.rm(paths.updateFilePath, { force: true });
    await fsPromises.rename(partialPath, paths.updateFilePath);
    const pendingFilePath = await savePendingPortableUpdate(userDataPath, manifest);
    return { ...paths, pendingFilePath };
  } catch (error) {
    await fsPromises.rm(partialPath, { force: true });
    throw error;
  }
}

async function loadPendingPortableUpdate(userDataPath, currentVersion) {
  const pendingFilePath = path.join(userDataPath, 'portable-update-pending.json');
  let manifest;
  try {
    manifest = validatePortableManifest(JSON.parse(await fsPromises.readFile(pendingFilePath, 'utf8')));
  } catch {
    await fsPromises.rm(pendingFilePath, { force: true });
    return null;
  }

  const paths = getPortableUpdatePaths(userDataPath, manifest.version);
  if (
    compareVersions(manifest.version, currentVersion) <= 0
    || !(await verifyPortableUpdateFile(paths.updateFilePath, manifest))
  ) {
    await fsPromises.rm(pendingFilePath, { force: true });
    await fsPromises.rm(paths.updateFilePath, { force: true });
    return null;
  }

  return { ...paths, pendingFilePath, manifest };
}

module.exports = {
  compareVersions,
  downloadPortableUpdate,
  fetchLatestPortableUpdate,
  getPortableUpdatePaths,
  loadPendingPortableUpdate,
  validatePortableManifest
};
