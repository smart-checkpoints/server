import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";

type ContainerProps = {
  as?: ElementType;
  size?: "default" | "narrow";
  className?: string;
  children: ReactNode;
};

/** The one horizontal measure on the site. */
export default function Container({
  as: Tag = "div",
  size = "default",
  className,
  children,
}: ContainerProps) {
  return (
    <Tag
      className={cn(
        "mx-auto w-full px-6 lg:px-10",
        size === "narrow" ? "max-w-4xl" : "max-w-7xl",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
