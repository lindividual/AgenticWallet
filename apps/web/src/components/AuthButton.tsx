import type { ButtonHTMLAttributes, ReactNode } from 'react';

type AuthButtonProps = {
  variant?: 'primary' | 'secondary';
  fullWidth?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function AuthButton({
  variant = 'primary',
  fullWidth = true,
  children,
  className,
  type = 'button',
  ...rest
}: AuthButtonProps) {
  const btnClass = variant === 'primary' ? 'btn-primary' : 'btn-outline';
  const classes = [
    'btn',
    btnClass,
    fullWidth && 'w-full',
    'min-h-12 font-semibold',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
