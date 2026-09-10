export function classifyServiceKind(value) {
    const type = String(value ?? "").trim().toLowerCase();
    if (/valkey|redis|\bcache\b/.test(type)) {
        return "cache";
    }
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

export function classifyAspireResourceKind(value) {
    const type = String(value ?? "").trim().toLowerCase();
    if (/next|vite|frontend|web/.test(type)) return "frontend";
    if (/\.net project|node|python|executable/.test(type)) return "project";
    if (/postgres|sql|database|mongo|cosmos/.test(type)) return "database";
    if (/redis|valkey|cache/.test(type)) return "cache";
    if (/rabbit|broker|service bus|messag/.test(type)) return "broker";
    if (/container|docker/.test(type)) return "container";
    return "external";
}

export function isCompatibleAspireResourceKind(currentType, candidateType) {
    return classifyAspireResourceKind(currentType) === classifyAspireResourceKind(candidateType);
}

export function compatibleAspireResourceTypes(serviceType, framework = "", generatedType = "") {
    const evidence = `${serviceType ?? ""} ${framework ?? ""}`.trim().toLowerCase();
    const generated = String(generatedType ?? "").trim().toLowerCase();
    let compatible;

    if (/valkey/.test(evidence)) {
        compatible = ["valkey", "redis", "container", "external service"];
    } else if (/redis|\bcache\b/.test(evidence)) {
        compatible = ["redis", "valkey", "container", "external service"];
    } else if (/nest(?:js)?/.test(evidence)) {
        compatible = ["node.js", "executable", "container"];
    } else if (/next(?:\.js|js)?/.test(evidence)) {
        compatible = ["next.js", "node.js", "executable", "container"];
    } else if (/svelte(?:kit)?|vite|react/.test(evidence)) {
        compatible = ["vite", "vite spa", "node.js", "executable", "container"];
    } else if (/fastapi|flask|django|python|\bpy\b/.test(evidence)) {
        compatible = ["python", "executable", "container"];
    } else {
        switch (classifyServiceKind(serviceType)) {
            case "cache":
                compatible = ["valkey", "redis", "container", "external service"];
                break;
            case "dotnet":
                compatible = [".net project", "executable", "container"];
                break;
            case "node":
                compatible = ["node.js", "executable", "container"];
                break;
            case "python":
                compatible = ["python", "executable", "container"];
                break;
            case "dockerfile":
            case "container":
                compatible = ["container", "external service"];
                break;
            default:
                compatible = ["executable"];
                break;
        }
    }

    return new Set(generated ? [...compatible, generated] : compatible);
}

export function isCompatibleAspireResourceType(
    serviceType,
    resourceType,
    framework = "",
    generatedType = "",
) {
    const type = String(resourceType ?? "").trim().toLowerCase();
    return Boolean(type) &&
        compatibleAspireResourceTypes(serviceType, framework, generatedType).has(type);
}
