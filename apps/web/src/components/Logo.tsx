interface LogoProps {
  className?: string;
  ariaLabel?: string;
}

/**
 * UMI brand logo - uses currentColor so it follows the active theme (light/dark).
 * Replaces the Figma MCP asset URL which is not publicly accessible from browsers.
 */
export function Logo({ className = 'h-[25px] w-9', ariaLabel }: LogoProps) {
  return (
    <svg
      viewBox="0 0 36 25"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      <path d="M0 23.2143H36V25H0V23.2143Z" fill="currentColor" />
      <path d="M0 5.35714H36V7.14286H0V5.35714Z" fill="currentColor" />
      <path d="M16.2 8.92857H19.8V21.4286H16.2V8.92857Z" fill="currentColor" />
      <path d="M28.8 8.92857H32.4V21.4286H28.8V8.92857Z" fill="currentColor" />
      <path d="M3.6 8.92857H7.2V21.4286H3.6V8.92857Z" fill="currentColor" />
      <path d="M28.8 0H32.4V3.57143H28.8V0Z" fill="currentColor" />
    </svg>
  );
}
