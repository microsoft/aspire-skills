import { spawn } from "node:child_process";

export async function openSystemBrowser(value, {
    platform = process.platform,
    launch = spawn,
    onError = (error) => console.error(error.message),
} = {}) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS URLs can open in a browser.");
    }
    const command = platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
    await new Promise((resolve, reject) => {
        let spawned = false;
        let failureReported = false;
        const fail = (reason) => {
            if (failureReported) return;
            failureReported = true;
            const error = new Error(`Could not open the default browser (${reason}). Check your default browser and try again.`);
            if (spawned) onError(error);
            else reject(error);
        };
        try {
            const child = launch(command, args, {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            child.on("error", (error) => fail(error?.code ?? "launch failed"));
            child.once("close", (code, signal) => {
                if (code !== 0) fail(signal ? `signal ${signal}` : `exit code ${code}`);
            });
            child.once("spawn", () => {
                spawned = true;
                child.unref();
                resolve();
            });
        } catch (error) {
            fail(error?.code ?? "launch failed");
        }
    });
}
