export const generatedPaths = ["CHANGELOG.md", "opencode"];

export function requireSourceOnly(repo, sha) {
  const paths = [...repo.files(sha, ["opencode"]).keys()];
  if (paths.length) throw new Error(`Dev must not contain OpenCode catalogs:\n${paths.join("\n")}`);
}
