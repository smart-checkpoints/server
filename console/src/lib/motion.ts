import type { Transition, Variants } from "framer-motion";

/** Precise, never bouncy. Everything on the site shares this curve. */
export const ease = [0.22, 1, 0.36, 1] as const;

export const transition: Transition = {
  duration: 0.6,
  ease,
};

/** Fade and rise, the site's one scroll-reveal gesture. */
export const riseVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0 },
};

/** Same gesture, applied to a list so children arrive in sequence. */
export const staggerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

export const viewport = { once: true, margin: "-80px" } as const;
