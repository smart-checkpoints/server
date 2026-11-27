/**
 * The Sayes mark: a raised hand, the gesture a sayes (the man who waves cars
 * into a parking space) makes, with two arcs for the wave. Drawn on a 24 grid
 * so it holds up at 24 px. Three variants are kept so they can be compared on
 * /sayes-logo; `palm` is the one the console uses.
 */

export type SayesMarkVariant = "palm" | "outline" | "mitten";

export const SAYES_MARK_VARIANTS: { id: SayesMarkVariant; name: string; note: string }[] = [
  { id: "palm", name: "Palm", note: "Solid hand, four fingers, two arcs. Reads best on the cyan disc." },
  { id: "outline", name: "Outline", note: "The same hand as a single stroke. Lighter, closer to the line icons." },
  { id: "mitten", name: "Mitten", note: "Fingers merged into one shape. Simplest at 16 px, least hand-like large." },
];

const ARCS = (
  <>
    <path d="M18.4 4.6 C19.6 5.5 20.3 6.8 20.4 8.3" />
    <path d="M20.1 1.9 C22 3.3 23.1 5.4 23.2 7.8" />
  </>
);

export default function SayesMark({
  variant = "palm",
  className,
  title,
  size,
}: {
  variant?: SayesMarkVariant;
  className?: string;
  title?: string;
  /** Pixels; otherwise the class sets the size. */
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {variant === "palm" ? (
        <>
          <g strokeWidth="2.5">
            <path d="M6.6 11.2 V6.2" />
            <path d="M9.4 11.2 V4.4" />
            <path d="M12.2 11.2 V5" />
            <path d="M14.9 12 V7.4" />
            <path d="M6.4 15.6 L3.7 12.6" />
          </g>
          <path
            d="M5.4 10.6 H16.1 V15.6 A5.6 5.6 0 0 1 10.5 21.2 A5.1 5.1 0 0 1 5.4 16.1 Z"
            fill="currentColor"
            strokeWidth="1"
          />
          <g strokeWidth="1.7">{ARCS}</g>
        </>
      ) : variant === "outline" ? (
        <>
          <path
            strokeWidth="1.7"
            d="M8.1 11.5 V5.9 a1.35 1.35 0 0 1 2.7 0 V11 V4.6 a1.35 1.35 0 0 1 2.7 0 V11 V5.6 a1.35 1.35 0 0 1 2.7 0 V12 V8.4 a1.3 1.3 0 0 1 2.6 0 V15.4 A5.8 5.8 0 0 1 13 21.2 H12 A5.6 5.6 0 0 1 7.4 18.8 L4.1 14 a1.4 1.4 0 0 1 2.2 -1.7 L8.1 14.2"
            transform="translate(-2.4 0)"
          />
          <g strokeWidth="1.7">{ARCS}</g>
        </>
      ) : (
        <>
          <path
            d="M5.6 6.8 A3.2 3.2 0 0 1 11.6 5.2 A3.2 3.2 0 0 1 16.4 8 V15.4 A5.8 5.8 0 0 1 10.6 21.2 A5.6 5.6 0 0 1 5.6 18 L3.6 13.6 A1.5 1.5 0 0 1 6.2 12.2 L5.6 11 Z"
            fill="currentColor"
            strokeWidth="1"
          />
          <g strokeWidth="1.7">{ARCS}</g>
        </>
      )}
    </svg>
  );
}
