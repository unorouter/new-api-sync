export function Row(props: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-32 shrink-0">{props.label}</dt>
      <dd className="min-w-0 font-mono">{props.children}</dd>
    </div>
  );
}
