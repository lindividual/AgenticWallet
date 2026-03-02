import { AssetListItem } from './AssetListItem';

type SkeletonBlockProps = {
  className?: string;
};

type SkeletonAssetListItemProps = {
  className?: string;
};

export function SkeletonBlock({ className = 'h-4 w-full' }: SkeletonBlockProps) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-base-300/70 ${className}`} />;
}

export function SkeletonAssetListItem({ className = 'bg-base-100 py-3' }: SkeletonAssetListItemProps) {
  return (
    <AssetListItem
      className={className}
      leftIcon={<SkeletonBlock className="h-10 w-10 rounded-full" />}
      leftPrimary={<SkeletonBlock className="h-4 w-20" />}
      leftSecondary={<SkeletonBlock className="mt-2 h-3 w-28" />}
      rightPrimary={<SkeletonBlock className="h-4 w-20" />}
      rightSecondary={<SkeletonBlock className="mt-2 h-3 w-14" />}
    />
  );
}
