import assert from "node:assert/strict";

export function job(workflow, name) {
  const section = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(section, `Missing job ${name}`);
  return section.split(/\n  [\w-]+:\n/)[0];
}

export function steps(section) {
  return section.split(/^      - name: /m).slice(1);
}

export function step(section, name) {
  const found = steps(section).find(value => value.startsWith(`${name}\n`));
  assert.ok(found, `Missing step ${name}`);
  return found;
}

export function script(section, name) {
  const content = step(section, name);
  const block = content.split("        run: |\n")[1];
  if (block) return block.replace(/^          /gm, "").trimEnd() + "\n";
  const inline = content.match(/^        run: (.+)$/m)?.[1];
  assert.ok(inline, `Missing script in ${name}`);
  return inline + "\n";
}
