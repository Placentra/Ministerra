import { useState, useEffect, useRef } from 'react';

/** ----------------------------------------------------------------------------
 * USE SCROLL DIR HOOK
 * Detects scroll direction (up/down) to toggle UI elements like sticky headers.
 * Uses a threshold to prevent jitter.
 * -------------------------------------------------------------------------- */
const useScrollDir = (bypass = false) => {
	const [scrollDir, setScrollDir] = useState('up'),
		threshold = 50,
		accumulatedDeltaY = useRef(0),
		lastDir = useRef('up');
	useEffect(() => {
		// EVENT LISTENER LIFECYCLE -------------------------------------------
		// Steps: when bypass is active, do nothing; otherwise accumulate wheel deltas until threshold, then emit direction changes only when direction flips (jitter guard).
		if (bypass) return;
		const onWheel = e => {
			accumulatedDeltaY.current += e.deltaY;
			if (Math.abs(accumulatedDeltaY.current) < threshold) return;
			const newDir = accumulatedDeltaY.current > 0 ? 'down' : 'up';
			accumulatedDeltaY.current = 0;
			if (newDir !== lastDir.current) (lastDir.current = newDir), setScrollDir(newDir); // ONLY UPDATE STATE IF DIRECTION CHANGED ---------------------------
		};
		window.addEventListener('wheel', onWheel, { passive: true });
		return () => window.removeEventListener('wheel', onWheel);
	}, [bypass]);
	return [scrollDir, setScrollDir];
};

export default useScrollDir;
