// Strips YAML comments from workflow text for the secrets guard (tests/unit/workflow-secrets.test.mjs).
// A `#` starts a comment only at the start of a line or after whitespace, and only OUTSIDE single quotes, double quotes and `${{ ... }}`
// expressions. So `run: echo "#" "${{ secrets.X }}"` keeps its secret reference, while `run: make # uses secrets.X` loses the trailing comment.
// Quote state is tracked per line. An unbalanced quote (an apostrophe in prose) keeps the rest of the line as code, which errs on the strict side.
export function stripComment(line) {
  let quote = null; // "'" or '"'
  let expr = false; // inside ${{ ... }}
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (expr) { if (c === "}" && line[i + 1] === "}") { expr = false; i++; } continue; }
    if (c === "$" && line[i + 1] === "{" && line[i + 2] === "{") { expr = true; i += 2; continue; }
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
export const stripComments = (text) => text.split("\n").map(stripComment).join("\n");
