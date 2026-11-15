const COLORS = ['#244fd4', '#ffc940', '#ff7a59', '#2bc48a', '#8b7cf6'];

/** Two quick bursts. Skipped for people who prefer reduced motion, and never throws. */
export async function celebrate() {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const confetti = (await import('canvas-confetti')).default;
    confetti({ particleCount: 110, spread: 75, origin: { y: 0.65 }, colors: COLORS, disableForReducedMotion: true });
    setTimeout(() => confetti({ particleCount: 70, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors: COLORS, disableForReducedMotion: true }), 250);
    setTimeout(() => confetti({ particleCount: 70, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors: COLORS, disableForReducedMotion: true }), 400);
  } catch {
    // Confetti is a nicety; never let it break the flow.
  }
}
