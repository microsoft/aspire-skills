import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyServiceKind,
    isCompatibleAspireResourceType,
    isDotNetType,
} from "../../extensions/aspireify/ui/resource-types.js";

test("explicit non-.NET runtimes outrank language-neutral gRPC and worker labels", () => {
    for (const [type, kind] of [
        ["Node.js gRPC service", "node"],
        ["TypeScript gRPC API", "node"],
        ["Node.js worker service", "node"],
        ["Python gRPC server", "python"],
        ["Python worker service", "python"],
        ["gRPC container image", "container"],
    ]) {
        assert.equal(classifyServiceKind(type), kind, type);
        assert.equal(isDotNetType(type), false, `${type} must not default to .NET Service Defaults`);
    }
    assert.equal(isCompatibleAspireResourceType("Node.js gRPC service", "node.js"), true);
    assert.equal(isCompatibleAspireResourceType("Node.js gRPC service", ".net project"), false);
});

test(".NET evidence and unqualified .NET template labels still classify as .NET", () => {
    for (const type of [
        "ASP.NET Core gRPC",
        ".NET Worker Service",
        "C# gRPC service",
        ".NET MAUI",
        "Worker Service",
        "gRPC service",
    ]) {
        assert.equal(classifyServiceKind(type), "dotnet", type);
        assert.equal(isCompatibleAspireResourceType(type, ".net project"), true, type);
    }
});
