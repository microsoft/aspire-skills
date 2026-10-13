export const generatedPaths = ["CHANGELOG.md", "opencode"];

export function requireSourceOnly(repo, sha) {
  const paths = [...repo.files(sha, generatedPaths).keys()];
  if (paths.length) throw new Error(`Dev must not contain generated changelog or catalogs:\n${paths.join("\n")}`);
}
