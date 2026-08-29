/**
 * The design tokens, readable from canvas code.
 *
 * The graph and the thumbnails are drawn on a 2D canvas, which cannot use a
 * CSS variable. Rather than transcribing hex values into JavaScript, where
 * they would quietly drift out of step with `globals.css`, the values are
 * read off the document at runtime, so the stylesheet stays the single source
 * for every colour in the console.
 */
export type Tokens = {
  cyan: string;
  cyanHover: string;
  cyanDark: string;
  bg: string;
  bgSubtle: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  green: string;
  yellow: string;
  red: string;
};

const FALLBACK: Tokens = {
  cyan: "#19c4d8",
  cyanHover: "#15aabb",
  cyanDark: "#0e7f8c",
  bg: "#eceff0",
  bgSubtle: "#e3e7e9",
  surface: "#ffffff",
  surfaceHover: "#f6f8f9",
  border: "#dde3e5",
  borderStrong: "#c8d1d4",
  text: "#1e2628",
  textDim: "#6b7679",
  green: "#4ecb71",
  yellow: "#f7c948",
  red: "#e74c5e",
};

const VARIABLES: Record<keyof Tokens, string> = {
  cyan: "--cyan",
  cyanHover: "--cyan-hover",
  cyanDark: "--cyan-dark",
  bg: "--bg",
  bgSubtle: "--bg-subtle",
  surface: "--surface",
  surfaceHover: "--surface-hover",
  border: "--border",
  borderStrong: "--border-strong",
  text: "--text",
  textDim: "--text-dim",
  green: "--green",
  yellow: "--yellow",
  red: "--red",
};

let cached: Tokens | null = null;

/** Reads the tokens once per page. The console has one theme, so once is enough. */
export function readTokens(): Tokens {
  if (cached) return cached;
  if (typeof window === "undefined") return FALLBACK;

  const computed = getComputedStyle(document.documentElement);
  const resolved = { ...FALLBACK };
  for (const [key, variable] of Object.entries(VARIABLES) as Array<
    [keyof Tokens, string]
  >) {
    const value = computed.getPropertyValue(variable).trim();
    if (value) resolved[key] = value;
  }

  cached = resolved;
  return resolved;
}

/** `#19c4d8` at a given opacity, for the washes canvas draws under things. */
const MONO_FALLBACK = '"JetBrains Mono", ui-monospace, monospace';
let cachedMono: string | null = null;

/**
 * The mono family, in a form `ctx.font` will actually accept.
 *
 * Canvas parses `font` with the CSS font shorthand parser, and that parser
 * does not resolve `var()`. Assigning a font string containing one is not an
 * error and not a warning: the assignment is silently dropped and the context
 * keeps the font it had, which is `10px sans-serif` - ten units of a world
 * measured in metres, so the label is drawn a thousandth of a pixel tall and
 * simply never appears. So the family is read off the document, the same way
 * the colours are, and interpolated as a literal.
 */
export function monoFamily(): string {
  if (cachedMono) return cachedMono;
  if (typeof window === "undefined") return MONO_FALLBACK;

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-jetbrains-mono")
    .trim();
  // The variable names the loaded face and its metric fallback, and stops
  // there; the generic is this file's job.
  cachedMono = value ? `${value}, ui-monospace, monospace` : MONO_FALLBACK;
  return cachedMono;
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.trim();
  if (!value.startsWith("#") || (value.length !== 7 && value.length !== 4)) {
    return value;
  }
  const full =
    value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The congestion ramp: green at free-flowing, through the warning yellow, to
 * the status red at twice the expected travel time. These are the same three
 * status tokens the badges use, so a red edge and a red badge are one red.
 */
export function congestionColor(
  ratio: number | undefined,
  tokens: Tokens,
): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return tokens.borderStrong;
  if (ratio <= 1) return tokens.green;
  if (ratio >= 2) return tokens.red;
  const t = ratio <= 1.5 ? (ratio - 1) / 0.5 : (ratio - 1.5) / 0.5;
  const from = ratio <= 1.5 ? tokens.green : tokens.yellow;
  const to = ratio <= 1.5 ? tokens.yellow : tokens.red;
  return mix(from, to, t);
}

/** Straight sRGB interpolation. Both ends are tokens, so the path stays in family. */
function mix(fromHex: string, toHex: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  try {
    const [r1, g1, b1] = parse(fromHex);
    const [r2, g2, b2] = parse(toHex);
    const clamped = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(r1 + (r2 - r1) * clamped)}, ${Math.round(
      g1 + (g2 - g1) * clamped,
    )}, ${Math.round(b1 + (b2 - b1) * clamped)})`;
  } catch {
    return toHex;
  }
}
