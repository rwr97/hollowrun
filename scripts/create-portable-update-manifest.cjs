const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

async function hashFile(filePath) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

exports.default = async function createPortableUpdateManifest(buildResult) {
  const version = String(packageJson.version || '');
  const artifactFile = `HollowRun ${version}.exe`;
  const file = `HollowRun.${version}.exe`;
  const portablePath = buildResult.artifactPaths.find(
    artifactPath => path.basename(artifactPath) === file
      || path.basename(artifactPath) === artifactFile
  );
  if (!portablePath) {
    throw new Error(`Could not find the portable executable for version ${version}.`);
  }

  const stat = fs.statSync(portablePath);
  const manifest = {
    schemaVersion: 1,
    version,
    file,
    size: stat.size,
    sha512: await hashFile(portablePath),
    url: `https://github.com/rwr97/hollowrun/releases/latest/download/${encodeURIComponent(file)}`
  };
  const manifestPath = path.join(buildResult.outDir, 'portable-update.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Created the portable update manifest for HollowRun ${version}.`);
  return [manifestPath];
};
