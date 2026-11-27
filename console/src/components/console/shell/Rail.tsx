"use client";

import { Icons, RailButton } from "./parts";

export type DrawerId = "cameras" | "sections" | "violations" | "quality" | "settings";

type RailProps = {
  drawer: DrawerId | null;
  onDrawer: (drawer: DrawerId) => void;
  /** Violations in the last seven days, shown on the Violations icon. */
  violationsThisWeek: number;
  /** Cameras the quality check flagged. */
  flagged: number;
  isDemo: boolean;
  testDriveOpen: boolean;
  onTestDrive: () => void;
};

/** The left rail: one icon per drawer, one drawer at a time. */
export default function Rail({ drawer, onDrawer, violationsThisWeek, flagged, isDemo, testDriveOpen, onTestDrive }: RailProps) {
  return (
    <nav
      aria-label="Console"
      data-cursor-avoid
      className="relative z-40 flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2"
    >
      <RailButton label="Cameras" shortcut="1" active={drawer === "cameras"} onClick={() => onDrawer("cameras")} data-agent-target="cameras">
        {Icons.cameras}
      </RailButton>
      <RailButton label="Sections" shortcut="2" active={drawer === "sections"} onClick={() => onDrawer("sections")} data-agent-target="sections">
        {Icons.sections}
      </RailButton>
      <RailButton
        label="Violations"
        shortcut="3"
        badge={violationsThisWeek}
        active={drawer === "violations"}
        onClick={() => onDrawer("violations")}
        data-agent-target="violations"
      >
        {Icons.violations}
      </RailButton>
      <RailButton
        label="Quality"
        shortcut="4"
        badge={flagged}
        badgeTone="warn"
        active={drawer === "quality"}
        onClick={() => onDrawer("quality")}
        data-agent-target="quality"
      >
        {Icons.quality}
      </RailButton>
      {isDemo ? (
        <>
          <span className="my-1 h-px w-7 bg-border" aria-hidden="true" />
          <RailButton label={testDriveOpen ? "End test drive" : "Test drive"} active={testDriveOpen} onClick={onTestDrive}>
            {Icons.car}
          </RailButton>
        </>
      ) : null}
      <span className="flex-1" />
      <RailButton label="Settings" shortcut="5" active={drawer === "settings"} onClick={() => onDrawer("settings")} data-agent-target="settings">
        {Icons.settings}
      </RailButton>
    </nav>
  );
}
