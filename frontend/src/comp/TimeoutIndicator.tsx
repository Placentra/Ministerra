// TIMEOUT INDICATOR COMPONENT ---
// Visual countdown bar that shrinks towards the center and changes color smoothly.
// Uses HSL interpolation for programmatic color and a CSS mask for segmented "gaps".

export default function TimeoutIndicator({ progress, invert = false, noRedColor = false, posAbs }: { progress: number; invert?: boolean; noRedColor?: boolean; posAbs?: string }) {
	// PROGRAMMATIC COLOR CALCULATION ------------------------------------------
	// Steps: map 0-100 progress to 0-120 hue (Red to Green).
	// If noRedColor is true, map to 120-240 (Green to Blue).
	const hue = noRedColor ? Math.min(240, Math.max(120, progress * 1.2 + 120)) : Math.min(120, Math.max(0, progress * 1.2));
	const color = `hsl(${hue}, 75%, 50%)`;
	const colorAlpha = `hsla(${hue}, 75%, 50%, 0.2)`;

	// INVERT LOGIC ------------------------------------------------------------
	// If invert is true, the line grows instead of shrinking.
	const displayProgress = invert ? 100 - progress : progress;

	return (
		<timeout-indicator class={`${posAbs ? `posAbs ${posAbs}` : ''}  w100`} style={{ height: '2px', zIndex: 2500 }}>
			<div
				className="posAbs w100 h100"
				style={{
					background: `linear-gradient(90deg, transparent 0%, ${colorAlpha} ${50 - displayProgress / 2}%, ${color} 50%, ${colorAlpha} ${50 + displayProgress / 2}%, transparent 100%)`,
					// SEGMENTED GAPS ---
					// Steps: use a repeating mask to create 30px segments with 2px transparent gaps.
					WebkitMaskImage: 'repeating-linear-gradient(90deg, black, black 30px, transparent 30px, transparent 32px)',
					maskImage: 'repeating-linear-gradient(90deg, black, black 30px, transparent 30px, transparent 32px)',
					transition: 'background 0.1s linear',
				}}
			/>
		</timeout-indicator>
	);
}
