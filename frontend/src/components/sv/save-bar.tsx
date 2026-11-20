import { AnimatePresence, motion } from 'motion/react';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Sticky "Unsaved changes" bar (School Profile). Appears only while the form is dirty. */
export function SaveBar({ visible, saving, onDiscard }: { visible: boolean; saving: boolean; onDiscard: () => void }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="region"
          aria-label="Unsaved changes"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 md:left-[248px]"
        >
          <div className="mx-auto flex max-w-[1280px] flex-col gap-3 rounded-2xl bg-navy px-5 py-3.5 text-white shadow-pop sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="flex items-center gap-2.5 text-sm font-semibold">
              <span className="size-2 animate-pulse rounded-full bg-sun" aria-hidden="true" />
              You have unsaved changes
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={onDiscard} disabled={saving}>
                <Undo2 /> Discard
              </Button>
              <Button type="submit" variant="sun" size="sm" loading={saving} loadingText="Saving…">
                Save Changes
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
