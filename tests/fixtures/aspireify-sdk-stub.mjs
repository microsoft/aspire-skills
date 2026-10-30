// Minimal Copilot SDK boundary for driving the Aspireify provider in tests.
export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export const createCanvas = (options) => options;

export async function joinSession(options) {
    const session = globalThis.__aspireifyTestSession;
    session.canvas = options.canvases[0];
    return {
        workspacePath: session.workspacePath,
        log() {},
        async send(message) {
            session.messages.push(message.prompt);
        },
        rpc: { canvas: { list: async () => ({ canvases: [] }), open: async () => {} } },
    };
}
