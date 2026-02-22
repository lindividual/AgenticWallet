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
  const classes = ['auth-btn', `auth-btn--${variant}`];

  if (fullWidth) {
    classes.push('auth-btn--block');
  }

  if (className) {
    classes.push(className);
  }

  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}
