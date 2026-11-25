# HollowRun commands

Run all commands from:

```powershell
cd C:\path\to\hollowrun
```

## Install dependencies

```powershell
npm.cmd ci
npm.cmd run setup
```

## Build the installer and portable executable

```powershell
npm.cmd run build
```

Output:

```text
dist-electron\HollowRun <version>.exe
dist-electron\HollowRun Setup <version>.exe
```

## Publish a release with auto-updates

The NSIS installer and portable executable both check GitHub Releases for
updates. The portable updater replaces the executable at its current location;
the Settings release-page link remains available for manual downloads. Before
the first updater-enabled release, bump the version above the existing 2.0.4
release:

```powershell
npm.cmd run version:patch
git tag v2.0.5
```

Set `GH_TOKEN` in the release environment to a GitHub token that can create and
upload releases, then run `npm.cmd run release:publish` from that version tag.
The command builds both Windows targets and publishes a non-draft GitHub
release with the NSIS updater metadata and the `portable-update.json` manifest.
Do not omit `latest.yml`, its matching installer `.blockmap`, or
`portable-update.json` when managing release assets manually; they must come
from the same build as their respective executables.

The ordinary `npm.cmd run build` command builds locally and never publishes.

## Run the application from source

Build the frontend once, then start Electron:

```powershell
npm.cmd run build:frontend
npm.cmd start
```

## Verify changes

Run the automated JavaScript tests and frontend lint checks:

```powershell
npm.cmd test
npm.cmd run lint
```

Compile both native projects without publishing release artifacts:

```powershell
dotnet build HollowRun.Worker\HollowRun.Worker.csproj -c Release
dotnet build HollowRun.Splash\HollowRun.Splash.csproj -c Release
```

## Bump the version

Use one of the synchronized version commands. Each updates the root, backend,
frontend, lockfiles, worker, and splash project versions:

```powershell
npm.cmd run version:patch
npm.cmd run version:minor
npm.cmd run version:major
```

## Optional Sentry source maps

Local builds do not upload source maps by default. For a release build, copy
`frontend\.env.example` to `frontend\.env.local`, set the Sentry organization,
project, and token, then set `SENTRY_UPLOAD_SOURCEMAPS=true`. Never commit the
token or `.env.local` file.
