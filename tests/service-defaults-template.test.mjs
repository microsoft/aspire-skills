import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceDefaults = readFileSync(
    new URL("../skills/aspireify/references/service-defaults.md", import.meta.url),
    "utf8",
).replace(/\r\n/g, "\n");

function addProjectCommands() {
    const section = /## Add the Project\n([\s\S]*?)\n## /.exec(serviceDefaults)?.[1];
    assert.ok(section, "service-defaults.md must keep its Add the Project section");
    return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
}

// aspire-servicedefaults ships in Aspire.ProjectTemplates. Aspire CLI 13.6.4 installs it for
// C# `aspire init` but not for TypeScript AppHosts, so `dotnet new` must not assume it exists.
test("ServiceDefaults creation installs Aspire.ProjectTemplates when the template is missing", () => {
    const commands = addProjectCommands();
    const create = commands.indexOf("dotnet new aspire-servicedefaults");
    assert.ok(create >= 0, "must still show how to create the ServiceDefaults project");
    const install = commands.search(/dotnet new install Aspire\.ProjectTemplates@<aspire-version>/);
    assert.ok(install >= 0 && install < create, "must install versioned Aspire.ProjectTemplates before dotnet new");
    assert.match(commands, /dotnet new list aspire-servicedefaults \|\| dotnet new install/);
});

test("ServiceDefaults guidance explains why the template can be missing", () => {
    assert.match(serviceDefaults, /`Aspire\.ProjectTemplates` package/);
    assert.match(serviceDefaults, /TypeScript AppHost/);
});
