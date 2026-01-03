import { useState, useLayoutEffect, useRef, useCallback } from 'react';

// DYNAMIC SCALE FACTOR ---------------------------------------------------------
// Steps: compute a scale factor from viewport width + DPI so masonry column count stays stable across zoom/DPR; recomputed on resize rather than frozen at module load.
const getScaleFactor = () => {
	const vw = window.visualViewport?.width || window.screen.width; // PREFER VISUAL VIEWPORT ---------------------------
	const maxDimension = 1920, dpi = window.devicePixelRatio || 1;
	return dpi === 1 ? 1 : Math.min(dpi * (vw / maxDimension), 1.5); // CAP AT 1.5 TO PREVENT OVER-SCALING ---------------------------
};

/** ----------------------------------------------------------------------------
 * USE MASON RESIZE HOOK
 * Calculates the number of columns for masonry layouts based on container width
 * and dynamic scale factor. Responsive to resize events.
 * -------------------------------------------------------------------------- */
const useMasonResize = ({ wrapper, brain, contType, contLength, isMobile, contSetter, fetching, disableResize, nowAt }: any) => {
	const [numOfCols, setNumOfCols] = useState(brain.user.cols[contType]);
	const contViewCols = useRef({}), lastCols = useRef(null), scaleFactorRef = useRef(getScaleFactor()); // STORE SCALE FACTOR IN REF ---------------------------
	const propsRef = useRef({ contType, contLength, isMobile, contSetter, fetching, disableResize, nowAt }); // REFS TO ALWAYS READ FRESH VALUES IN CALLBACK ---------------------------
	propsRef.current = { contType, contLength, isMobile, contSetter, fetching, disableResize, nowAt };

	const handleResize = useCallback(() => {
		// RESIZE HANDLER -----------------------------------------------------
		// Steps: schedule via rAF, read latest props from refs, compute new column count from container width and scale factor, then only set state when the value actually changes.
		requestAnimationFrame(() => {
			const { contType, contLength, isMobile, contSetter, fetching, disableResize, nowAt } = propsRef.current;
			const containerWidth = wrapper.current?.offsetWidth || document.documentElement.clientWidth;
			if (disableResize || !containerWidth || fetching || !contLength) return;
			scaleFactorRef.current = getScaleFactor(); // RECALC SCALE FACTOR ON RESIZE ---------------------------
			const hardMax = nowAt === 'event' ? 4 : Infinity; // EVENT PAGE MAX 4 COLS ---------------------------
			const newMaxCols = isMobile ? 1 : Math.max(1, Math.floor(Math.min(Math.floor(containerWidth / (360 * scaleFactorRef.current)), brain.user.cols[contType], contLength, hardMax))); // FLOOR TO 1 MINIMUM ---------------------------
			if (newMaxCols !== lastCols.current) {
				(lastCols.current = newMaxCols), (contViewCols.current[contType] = newMaxCols);
				if (contSetter) contSetter(null, newMaxCols);
				else setNumOfCols(newMaxCols);
			}
		});
	}, [wrapper, brain.user.cols]);

	// LISTENER SETUP ---------------------------------------------------------
	// Steps: observe wrapper size changes via ResizeObserver and window resize; teardown cleanly to avoid leaking observers across route changes.
	useLayoutEffect(() => {
		if (!wrapper?.current) return;
		const resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(wrapper.current);
		window.addEventListener('resize', handleResize);
		return () => {
			resizeObserver.disconnect(), window.removeEventListener('resize', handleResize);
		};
	}, [wrapper, handleResize]);

	// PROP-DRIVEN RECALC -----------------------------------------------------
	// Steps: trigger recalculation when key inputs change (mobile, content length, fetching gate) so columns match layout constraints.
	useLayoutEffect(() => {
		if (wrapper?.current) handleResize();
	}, [isMobile, contLength, fetching, disableResize, handleResize, wrapper]);

	return [numOfCols, setNumOfCols, scaleFactorRef.current];
};

export default useMasonResize;
