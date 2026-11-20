import assert from "node:assert/strict";

// Apply only the existing-file text diff emitted by our pinned-checkout validator.
// The writer verifies the preview against base blobs without running patch/code.
export function applyPreviewDiff(diff, originals) {
  assert.equal(typeof diff, "string");
  assert.ok(Buffer.byteLength(diff) <= 4 * 1024 * 1024);
  const lines = diff.split("\n");
  assert.equal(lines.pop(), "");
  const output = new Map();
  let index = 0;
  while (index < lines.length) {
    const header = /^diff --git a\/([A-Za-z0-9_./-]+) b\/\1$/.exec(lines[index++]);
    assert.ok(header, "Unsupported preview diff header.");
    const path = header[1];
    assert.ok(originals.has(path) && !output.has(path), "Unexpected or repeated preview file.");
    assert.match(lines[index++], /^index [0-9a-f]{7,40}\.\.[0-9a-f]{7,40} 100644$/);
    assert.equal(lines[index++], `--- a/${path}`);
    assert.equal(lines[index++], `+++ b/${path}`);
    const original = originals.get(path).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const result = [];
    let cursor = 0;
    let hunks = 0;
    while (index < lines.length && !lines[index].startsWith("diff --git ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index++]);
      assert.ok(hunk, "Unsupported preview hunk.");
      const oldCount = Number(hunk[2] ?? 1);
      const newCount = Number(hunk[4] ?? 1);
      const offset = Number(hunk[1]) - (oldCount === 0 ? 0 : 1);
      assert.ok(Number.isSafeInteger(offset) && offset >= cursor && offset <= original.length);
      result.push(...original.slice(cursor, offset));
      cursor = offset;
      assert.equal(Number(hunk[3]), result.length + (newCount === 0 ? 0 : 1), "Preview new-line range mismatch.");
      let removed = 0;
      let added = 0;
      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("diff --git ")) {
        const line = lines[index++];
        const kind = line[0];
        assert.ok([" ", "-", "+"].includes(kind), "Unsupported preview line.");
        const noNewline = lines[index] === "\\ No newline at end of file";
        if (noNewline) index++;
        const content = line.slice(1) + (noNewline ? "" : "\n");
        if (kind !== "+") {
          assert.equal(original[cursor++], content, "Preview does not apply to the pinned base.");
          removed++;
        }
        if (kind !== "-") { result.push(content); added++; }
      }
      assert.equal(removed, oldCount, "Incomplete preview old-line range.");
      assert.equal(added, newCount, "Incomplete preview new-line range.");
      hunks++;
    }
    assert.ok(hunks > 0);
    result.push(...original.slice(cursor));
    output.set(path, result.join(""));
  }
  assert.equal(output.size, originals.size, "Preview must cover every outbound file.");
  return output;
}
