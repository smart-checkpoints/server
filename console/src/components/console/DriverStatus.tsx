import Badge from "@/components/ui/Badge";

type DriverStatusProps = {
  connected: boolean;
  className?: string;
};

/**
 * Whether a distance driver is attached to this project.
 *
 * It matters to the operator on every screen, because it decides who owns edge
 * distances: with a driver connected the server resolves them from real road
 * routing and the distance fields go read-only, without one they are typed in
 * by hand and are only ever as good as the person typing.
 */
export default function DriverStatus({ connected, className }: DriverStatusProps) {
  return (
    <Badge tone={connected ? "green" : "yellow"} mono className={className}>
      {connected ? "Driver attached" : "No driver"}
    </Badge>
  );
}
