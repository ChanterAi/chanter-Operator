const statusLabels: Record<string, string> = {
  awaiting_approval: "Awaiting approval",
  pending_approval: "Pending approval",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status--${status}`}>
      <span aria-hidden="true" className="status__dot" />
      {statusLabels[status] ?? status.replaceAll("_", " ")}
    </span>
  );
}

