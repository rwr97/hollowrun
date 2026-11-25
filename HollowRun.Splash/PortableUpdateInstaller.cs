using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace HollowRun.Splash;

internal static class PortableUpdateInstaller
{
    private const int ParentWaitTimeoutMilliseconds = 120_000;
    private const int ReplacementAttempts = 30;
    private const int ReplacementRetryDelayMilliseconds = 500;

    public static void Run(string[] args)
    {
        try
        {
            var options = ParseOptions(args);
            ApplyUpdate(options);
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                $"HollowRun could not finish the portable update.\n\n{exception.Message}",
                "HollowRun Update Failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index + 1 < args.Length; index++)
        {
            if (args[index].Equals("--apply-portable-update", StringComparison.OrdinalIgnoreCase)) continue;
            if (args[index].StartsWith("--", StringComparison.Ordinal))
            {
                values[args[index]] = args[++index];
            }
        }

        string Required(string name)
        {
            if (!values.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException($"Missing portable update option: {name}.");
            }
            return value;
        }

        _ = int.TryParse(Required("--parent-process-id"), out var parentProcessId);
        if (parentProcessId <= 0) throw new ArgumentException("The portable launcher process ID is invalid.");

        var targetPath = Path.GetFullPath(Required("--target"));
        var stagedUpdatePath = Path.GetFullPath(Required("--staged-update"));
        var pendingFilePath = Path.GetFullPath(Required("--pending-file"));
        var markerFilePath = Path.GetFullPath(Required("--installed-marker"));
        var hashAlgorithm = Required("--hash-algorithm").ToLowerInvariant();
        var checksum = Required("--checksum").ToLowerInvariant();
        var version = Required("--version");

        if (!Path.GetExtension(targetPath).Equals(".exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("The portable target must be an executable file.");
        }
        if (!File.Exists(targetPath)) throw new FileNotFoundException("The portable executable was not found.", targetPath);
        if (!File.Exists(stagedUpdatePath)) throw new FileNotFoundException("The downloaded update was not found.", stagedUpdatePath);
        if (hashAlgorithm is not ("sha256" or "sha512"))
        {
            throw new ArgumentException("The portable update hash algorithm is invalid.");
        }
        if ((hashAlgorithm == "sha256" && !System.Text.RegularExpressions.Regex.IsMatch(checksum, "^[0-9a-f]{64}$"))
            || (hashAlgorithm == "sha512" && (checksum.Length != 88 || !Convert.TryFromBase64String(checksum, new byte[64], out var hashLength) || hashLength != 64)))
        {
            throw new ArgumentException("The portable update checksum is invalid.");
        }

        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["--parent-process-id"] = parentProcessId.ToString(),
            ["--target"] = targetPath,
            ["--staged-update"] = stagedUpdatePath,
            ["--pending-file"] = pendingFilePath,
            ["--installed-marker"] = markerFilePath,
            ["--hash-algorithm"] = hashAlgorithm,
            ["--checksum"] = checksum,
            ["--version"] = version
        };
    }

    private static void ApplyUpdate(IReadOnlyDictionary<string, string> options)
    {
        var targetPath = options["--target"];
        var stagedUpdatePath = options["--staged-update"];
        var pendingFilePath = options["--pending-file"];
        var markerFilePath = options["--installed-marker"];
        var hashAlgorithm = options["--hash-algorithm"];
        var expectedChecksum = options["--checksum"];
        var version = options["--version"];
        var parentProcessId = int.Parse(options["--parent-process-id"]);
        var targetDirectory = Path.GetDirectoryName(targetPath)
                              ?? throw new ArgumentException("The portable executable has no parent directory.");
        var replacementPath = Path.Combine(targetDirectory, $".{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.update");
        var backupPath = $"{targetPath}.previous";
        var replaced = false;

        try
        {
            if (!string.Equals(HashFile(stagedUpdatePath, hashAlgorithm), expectedChecksum, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"The downloaded portable executable failed its {hashAlgorithm.ToUpperInvariant()} integrity check.");
            }

            File.Copy(stagedUpdatePath, replacementPath, overwrite: true);
            if (!string.Equals(HashFile(replacementPath, hashAlgorithm), expectedChecksum, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"The copied portable executable failed its {hashAlgorithm.ToUpperInvariant()} integrity check.");
            }

            WaitForParentProcess(parentProcessId);
            ReplaceWithRetry(replacementPath, targetPath, backupPath);
            replaced = true;

            try
            {
                if (Process.Start(new ProcessStartInfo
                {
                    FileName = targetPath,
                    WorkingDirectory = targetDirectory,
                    UseShellExecute = true
                }) is null)
                {
                    throw new InvalidOperationException("Windows did not start the updated portable executable.");
                }
            }
            catch
            {
                RestoreBackup(backupPath, targetPath);
                replaced = false;
                throw;
            }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(markerFilePath)!);
                File.WriteAllText(markerFilePath, version, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
            catch
            {
                // The updated app can remove its backup on its next successful startup.
            }

            TryDelete(stagedUpdatePath);
            TryDelete(pendingFilePath);
        }
        finally
        {
            TryDelete(replacementPath);
            if (!replaced && File.Exists(backupPath) && !File.Exists(targetPath))
            {
                TryMove(backupPath, targetPath);
            }
        }
    }

    private static void WaitForParentProcess(int processId)
    {
        try
        {
            using var parentProcess = Process.GetProcessById(processId);
            if (!parentProcess.WaitForExit(ParentWaitTimeoutMilliseconds))
            {
                throw new TimeoutException("The portable launcher did not close in time to replace its executable.");
            }
        }
        catch (ArgumentException)
        {
            // The launcher already exited before this helper began waiting.
        }
    }

    private static void ReplaceWithRetry(string replacementPath, string targetPath, string backupPath)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < ReplacementAttempts; attempt++)
        {
            try
            {
                TryDelete(backupPath);
                try
                {
                    File.Replace(replacementPath, targetPath, backupPath, ignoreMetadataErrors: true);
                }
                catch (IOException)
                {
                    ReplaceWithMoves(replacementPath, targetPath, backupPath);
                }
                catch (PlatformNotSupportedException)
                {
                    ReplaceWithMoves(replacementPath, targetPath, backupPath);
                }
                return;
            }
            catch (IOException exception)
            {
                lastError = exception;
                Thread.Sleep(ReplacementRetryDelayMilliseconds);
            }
        }

        throw new IOException("Windows could not replace the portable executable after several attempts.", lastError);
    }

    private static void ReplaceWithMoves(string replacementPath, string targetPath, string backupPath)
    {
        File.Move(targetPath, backupPath, overwrite: true);
        try
        {
            File.Move(replacementPath, targetPath);
        }
        catch
        {
            if (File.Exists(backupPath) && !File.Exists(targetPath))
            {
                File.Move(backupPath, targetPath, overwrite: true);
            }
            throw;
        }
    }

    private static void RestoreBackup(string backupPath, string targetPath)
    {
        if (!File.Exists(backupPath)) return;
        try
        {
            File.Replace(backupPath, targetPath, destinationBackupFileName: null, ignoreMetadataErrors: true);
        }
        catch
        {
            File.Move(backupPath, targetPath, overwrite: true);
        }
    }

    private static string HashFile(string filePath, string algorithm)
    {
        using var stream = File.OpenRead(filePath);
        return algorithm == "sha256"
            ? Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()
            : Convert.ToBase64String(SHA512.HashData(stream));
    }

    private static void TryDelete(string filePath)
    {
        try
        {
            if (File.Exists(filePath)) File.Delete(filePath);
        }
        catch
        {
            // Leave the staged or backup file in place if the volume is temporarily unavailable.
        }
    }

    private static void TryMove(string sourcePath, string destinationPath)
    {
        try
        {
            if (File.Exists(sourcePath) && !File.Exists(destinationPath)) File.Move(sourcePath, destinationPath);
        }
        catch
        {
            // The next app launch can still use the existing target or report the failure.
        }
    }
}
