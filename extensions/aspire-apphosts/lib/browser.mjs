import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openSystemBrowser(value, { platform = process.platform, launch = execFileAsync } = {}) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS URLs can open in a browser.");
    }
    const command = platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
    try {
        await launch(command, args, {
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
        });
    } catch (error) {
        const reason = error?.killed ? "timed out" : error?.code ?? "launch failed";
        throw new Error(`Could not open the default browser (${reason}). Check your default browser and try again.`);
    }
}
