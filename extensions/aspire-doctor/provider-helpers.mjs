import { stat } from "node:fs/promises";
import { win32 } from "node:path";

export const MAX_BODY_BYTES = 64 * 1024;

export class RequestBodyError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.name = "RequestBodyError";
        this.statusCode = statusCode;
    }
}

export function requestErrorStatus(error) {
    return error instanceof RequestBodyError ? error.statusCode : 400;
}

// win32.isAbsolute also accepts drive-dependent paths such as \aspire.exe.
const fullyQualified = (value) => win32.isAbsolute(value) && win32.parse(value).root.length > 1;

// Keep aligned with AppHosts' resolver; extension bundles install independently.
export async function resolveCliExecutable(command, env = process.env) {
    if (process.platform !== "win32") {
        return command;
    }

    const extension = win32.extname(command).toLowerCase();
    if ([".cmd", ".bat"].includes(extension)) {
        throw new Error("ASPIRE_CLI batch wrappers (.cmd/.bat) are unsupported on Windows. Set ASPIRE_CLI to the Aspire executable (.exe).");
    }

    const commandPath = win32.normalize(command);
    if (fullyQualified(commandPath)) {
        return commandPath;
    }
    if (/[\\/]/.test(command) || win32.parse(command).root) {
        throw new Error("ASPIRE_CLI must name an executable on PATH or a fully qualified executable path on Windows. Relative executable paths are unsupported.");
    }

    const executableNames = extension ? [command, `${command}.exe`] : [`${command}.exe`];
    const pathKey = Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH");
    const searchPath = pathKey === undefined ? "" : env[pathKey];
    for (const entry of String(searchPath ?? "").split(";")) {
        const directory = win32.normalize(entry.trim().replace(/^"(.*)"$/, "$1"));
        if (!fullyQualified(directory)) {
            continue;
        }
        for (const executableName of executableNames) {
            const candidate = win32.join(directory, executableName);
            try {
                if ((await stat(candidate)).isFile()) {
                    return candidate;
                }
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                    throw error;
                }
            }
        }
    }
    throw new Error(`Could not find '${command}' in fully qualified PATH directories. Set ASPIRE_CLI to the full path of the Aspire executable (.exe).`);
}

// Explorer lives in the Windows directory; a bare name would be looked up in the working directory first.
export function windowsExplorerExecutable(env = process.env) {
    const windowsDirectory = env.SystemRoot ?? "";
    if (!fullyQualified(windowsDirectory)) {
        throw new Error("SystemRoot must be a fully qualified path to locate explorer.exe on Windows.");
    }
    return win32.join(windowsDirectory, "explorer.exe");
}

export function windowsExplorerInvocation(absolutePath, isFile) {
    return isFile
        ? {
            args: [`/select,"${absolutePath}"`],
            windowsVerbatimArguments: true,
        }
        : {
            args: [absolutePath],
            windowsVerbatimArguments: false,
        };
}

export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks = [];

        req.on("data", (chunk) => {
            if (settled) {
                return;
            }

            size += chunk.length;
            if (size > maxBytes) {
                settled = true;
                chunks.length = 0;
                // Keep draining the request so the route can return a deterministic
                // 413 response instead of resetting the loopback connection.
                reject(new RequestBodyError(413, "Request body too large."));
                return;
            }

            chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) {
                return;
            }

            settled = true;
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch (error) {
                reject(new RequestBodyError(400, `Invalid JSON: ${error.message}`));
            }
        });
        req.on("error", (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
    });
}

export function listenOnLoopback(server) {
    return new Promise((resolve, reject) => {
        const cleanup = () => server.off("error", onError);
        const onError = (error) => {
            cleanup();
            reject(error);
        };

        server.once("error", onError);
        try {
            server.listen(0, "127.0.0.1", () => {
                cleanup();
                resolve();
            });
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

export function beginDiagnosticsRun(entry) {
    const revision = (entry.nextRevision ?? 0) + 1;
    entry.nextRevision = revision;
    entry.latestRequestedRevision = revision;
    return revision;
}

export function completeDiagnosticsRun(entry, revision, result) {
    const isCurrent = revision === entry.latestRequestedRevision;
    return {
        result: { ...result, revision, superseded: !isCurrent },
        isCurrent,
    };
}

export function selectDiagnosticsResult(entry, completion) {
    const latestResult = entry.latestResult;
    return latestResult?.revision > completion.result.revision
        ? latestResult
        : completion.result;
}

export function replayLatestDiagnostics(entry, publish) {
    if (!entry.latestResult) {
        return false;
    }

    publish(entry.latestResult);
    return true;
}

export async function runLatestDiagnostics(entry, runDiagnostics, publishCurrent) {
    const revision = beginDiagnosticsRun(entry);
    const rawResult = await runDiagnostics();
    const completion = completeDiagnosticsRun(entry, revision, rawResult);

    if (completion.isCurrent) {
        entry.latestResult = completion.result;
        publishCurrent?.(completion.result);
    }

    return completion;
}
