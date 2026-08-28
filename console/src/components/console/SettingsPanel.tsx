"use client";

import { useState } from "react";
import DriverStatus from "@/components/console/DriverStatus";
import Button from "@/components/ui/Button";
import CopyButton from "@/components/ui/CopyButton";
import Panel from "@/components/ui/Panel";
import { maskKey, pluralise } from "@/lib/format";
import type { ConsoleSession } from "@/lib/session";
import { docsLinks } from "@/lib/site";

type SettingsPanelProps = {
  open: boolean;
  onClose: () => void;
  session: ConsoleSession;
  nodeCount: number;
  connectionCount: number;
  driverConnected: boolean;
  realtimeConnected: boolean;
  onSignOut: () => void;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-3 last:border-0">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
        {label}
      </span>
      <span className="text-right font-mono text-sm text-text">{value}</span>
    </div>
  );
}

/**
 * What this session is: which project, how big, and what is attached to it.
 *
 * The API key is masked by default. It is the credential for the whole
 * project, and it should not be sitting in plain text on a screen that
 * somebody might be sharing.
 */
export default function SettingsPanel({
  open,
  onClose,
  session,
  nodeCount,
  connectionCount,
  driverConnected,
  realtimeConnected,
  onSignOut,
}: SettingsPanelProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Project"
      side="left"
      footer={
        <Button variant="secondary" size="sm" onClick={onSignOut} className="w-full">
          Close project
        </Button>
      }
    >
      <div className="px-5 py-4">
        <h3 className="font-display text-lg font-bold text-text">
          {session.project_name}
        </h3>

        <div className="mt-4">
          <Row label="Project" value={`#${session.project_id}`} />
          <Row label="Checkpoints" value={pluralise(nodeCount, "node")} />
          <Row label="Edges" value={pluralise(connectionCount, "edge")} />
          <Row
            label="Realtime"
            value={
              <span className={realtimeConnected ? "text-text" : "text-yellow"}>
                {realtimeConnected ? "connected" : "reconnecting"}
              </span>
            }
          />
        </div>

        <div className="mt-5">
          <DriverStatus connected={driverConnected} />
          <p className="mt-3 text-xs text-text-dim">
            {driverConnected
              ? "Edge distances are resolved from real road routing, so they cannot be edited by hand."
              : "Without a driver attached, edge distances are whatever is typed in here."}{" "}
            <a
              href={docsLinks.distanceDrivers}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-cyan-dark underline decoration-border-strong underline-offset-4 transition-colors duration-200 hover:decoration-cyan"
            >
              Distance drivers
            </a>
          </p>
        </div>

        <div className="mt-6 rounded-xl border border-border bg-bg-subtle p-4">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
            API key
          </p>
          <p className="mt-2 break-all font-mono text-xs text-text">
            {revealed ? session.apiKey : maskKey(session.apiKey)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <CopyButton value={session.apiKey} label="Copy key" />
          </div>
          <p className="mt-3 text-xs text-text-dim">
            The same key authenticates this console, every camera reporting
            sightings, and the project&apos;s distance driver. It is held for
            this tab only and is never put in a link.
          </p>
        </div>
      </div>
    </Panel>
  );
}
