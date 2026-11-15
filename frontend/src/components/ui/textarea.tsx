import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { inputClass } from './input';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(inputClass, 'h-auto min-h-24 py-2.5 leading-relaxed', className)} {...props} />;
}
