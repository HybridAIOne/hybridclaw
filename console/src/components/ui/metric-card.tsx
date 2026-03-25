import { cn } from '../../lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}

function MetricCard({ label, value, detail, className }: MetricCardProps) {
  return (
    <div
      data-slot="metric-card"
      className={cn(
        'grid gap-1.5 px-[18px] py-4 rounded-md border border-line bg-panel-muted',
        className,
      )}
    >
      <span>{label}</span>
      <strong className="text-[1.8rem] font-bold">{value}</strong>
      {detail ? <small className="text-muted">{detail}</small> : null}
    </div>
  );
}

export { MetricCard };
