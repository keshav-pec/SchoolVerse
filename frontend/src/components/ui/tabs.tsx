import type { ComponentProps } from 'react';
import { Tabs as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List className={cn('flex gap-1 overflow-x-auto border-b border-line', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        '-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 border-transparent px-4 text-sm font-semibold whitespace-nowrap text-muted transition-colors outline-none hover:text-ink focus-visible:bg-brand-soft data-[state=active]:border-brand data-[state=active]:text-brand [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content className={cn('pt-4 outline-none', className)} {...props} />;
}
