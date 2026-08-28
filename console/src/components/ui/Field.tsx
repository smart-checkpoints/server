"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  /** Units, or what the value means. Sits under the input, never beside it. */
  hint?: ReactNode;
  /** Replaces the hint while it is set, in the status red. */
  error?: string | null;
  /** Coordinates, distances, keys and plates are set in the mono face. */
  mono?: boolean;
  className?: string;
};

/**
 * A labelled control. Every input in the console is one of these, so the label,
 * the hint and the error line up the same way on every surface.
 */
export default function Field({
  label,
  hint,
  error,
  mono = false,
  className,
  id,
  ...rest
}: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = `${inputId}-description`;

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="mb-2 block font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim"
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={error || hint ? describedBy : undefined}
        aria-invalid={error ? true : undefined}
        className={cn("field", mono && "field-mono")}
        {...rest}
      />
      {error || hint ? (
        <p
          id={describedBy}
          className={cn("mt-2 text-xs", error ? "text-red" : "text-text-dim")}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
