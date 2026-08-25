export function classifyServiceKind(value) {
    const type = String(value ?? "").trim().toLowerCase();
    if (/asp\.?net|\.net|dotnet|c#|csharp|csproj|blazor|worker service|\bgrpc\b|\bmaui\b/.test(type)) {
        return "dotnet";
    }
    if (/node|javascript|typescript|next(?:\.js|js)?|vite|react/.test(type)) {
        return "node";
    }
    if (/python|fastapi|flask|\bpy\b/.test(type)) {
        return "python";
    }
    if (/dockerfile/.test(type)) {
        return "dockerfile";
    }
    if (/container|docker compose|image/.test(type)) {
        return "container";
    }
    return "executable";
}

export function isDotNetType(value) {
    return classifyServiceKind(value) === "dotnet";
}
