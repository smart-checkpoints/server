"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { riseVariants, transition, viewport } from "@/lib/motion";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
};

/** Fade and rise once, when the element scrolls into view. */
export default function Reveal({ children, className, delay = 0 }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      variants={riseVariants}
      initial="hidden"
      whileInView="visible"
      viewport={viewport}
      transition={{ ...transition, delay }}
    >
      {children}
    </motion.div>
  );
}
