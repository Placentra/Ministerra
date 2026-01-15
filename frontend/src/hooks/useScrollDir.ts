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
		// Steps: when bypass is active, do nothing; otherwise monitor scroll position and wheel deltas to emit direction changes (jitter guard).
		if (bypass) return;

		let lastScrollY = window.scrollY;

		const onScroll = () => {
			const currentScrollY = window.scrollY;

			// Force 'up' direction when at the very top
			if (currentScrollY <= 10) {
				if (lastDir.current !== 'up') {
					lastDir.current = 'up';
					setScrollDir('up');
				}
				lastScrollY = currentScrollY;
				return;
			}

			const deltaY = currentScrollY - lastScrollY;
			if (Math.abs(deltaY) < threshold) return;

			const newDir = deltaY > 0 ? 'down' : 'up';
			lastScrollY = currentScrollY;

			if (newDir !== lastDir.current) {
				lastDir.current = newDir;
				setScrollDir(newDir);
			}
		};

		const onWheel = e => {
			accumulatedDeltaY.current += e.deltaY;
			if (Math.abs(accumulatedDeltaY.current) < threshold) return;
			const newDir = accumulatedDeltaY.current > 0 ? 'down' : 'up';
			accumulatedDeltaY.current = 0;
			if (newDir !== lastDir.current) {
				lastDir.current = newDir;
				setScrollDir(newDir);
			}
		};

		window.addEventListener('wheel', onWheel, { passive: true });
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			window.removeEventListener('wheel', onWheel);
			window.removeEventListener('scroll', onScroll);
		};
	}, [bypass]);
	return [scrollDir, setScrollDir];
};

export default useScrollDir;
