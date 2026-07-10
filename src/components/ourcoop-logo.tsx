import { cn } from "@/lib/utils";

/** The ✳ mark — six flat-ended arms, the cooperative's asterisk. */
export function AsteriskMark({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={className}
    >
      <g fill="currentColor">
        <rect x="41" y="3" width="18" height="94" rx="2" />
        <rect
          x="41"
          y="3"
          width="18"
          height="94"
          rx="2"
          transform="rotate(60 50 50)"
        />
        <rect
          x="41"
          y="3"
          width="18"
          height="94"
          rx="2"
          transform="rotate(120 50 50)"
        />
      </g>
    </svg>
  );
}

/** O.U.R.COOP lockup: asterisk mark + wordmark. */
export function OurCoopLogo({
  size = 26,
  className,
  wordmarkClassName,
}: {
  size?: number;
  className?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <AsteriskMark size={size} className="text-core-orange" />
      <span
        className={cn(
          "font-breadDisplay text-text-standard font-black tracking-tight",
          wordmarkClassName,
        )}
      >
        O.U.R.COOP
      </span>
    </span>
  );
}
