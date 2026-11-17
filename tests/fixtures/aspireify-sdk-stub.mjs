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
        get capabilities() {
            return { ui: { elicitation: typeof session.confirm === "function" } };
        },
        ui: {
            confirm(message) {
                return session.confirm(message);
            },
        },
        async log() {},
        async send(message) {
            if (session.sendError) {
                throw session.sendError;
            }
            session.messages.push(message.prompt);
        },
        rpc: { canvas: { list: async () => ({ canvases: [] }), open: async () => {} } },
    };
}
