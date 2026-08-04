/**
 * Minimal glob matcher for filesystem paths.
 *
 * Supports `*` (no separator), `**` (any depth), `?`, and `{a,b}` alternation —
 * the subset `privacy.ignoredWorkspaces` needs. Paths are normalised to forward
 * slashes and matched case-insensitively, since macOS and Windows are.
 */
export function matchGlob(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const target = normalise(path);
  return patterns.some((pattern) => toRegExp(pattern).test(target));
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const source = normalise(pattern);
  let out = "";

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (char === "*") {
      // `**` crosses separators; `*` stops at one.
      if (source[i + 1] === "*") {
        // `**/` should also match zero segments, so `/**/x` matches `/x`.
        if (source[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      out += "(?:";
    } else if (char === "}") {
      out += ")";
    } else if (char === ",") {
      out += "|";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  // A bare directory pattern should match everything beneath it too.
  const regexp = new RegExp(`^${out}(?:/.*)?$`);
  cache.set(pattern, regexp);
  return regexp;
}
