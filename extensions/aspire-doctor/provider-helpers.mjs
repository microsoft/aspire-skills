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

export async function runLatestDiagnostics(entry, runDiagnostics, publishCurrent) {
    const revision = beginDiagnosticsRun(entry);
    const rawResult = await runDiagnostics();
    const completion = completeDiagnosticsRun(entry, revision, rawResult);

    if (completion.isCurrent) {
        publishCurrent?.(completion.result);
    }

    return completion;
}
