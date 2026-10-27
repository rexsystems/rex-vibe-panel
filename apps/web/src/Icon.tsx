import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

type Props = {
  icon: IconSvgElement;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

export function Icon({ icon, size = 18, strokeWidth = 1.75, className }: Props) {
  return (
    <span className={className} style={{ display: 'inline-flex', lineHeight: 0 }} aria-hidden="true">
      <HugeiconsIcon icon={icon} size={size} color="currentColor" strokeWidth={strokeWidth} />
    </span>
  );
}
