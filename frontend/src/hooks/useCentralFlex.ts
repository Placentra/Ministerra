import { useState, useLayoutEffect, useRef, useMemo } from 'react';

/** ----------------------------------------------------------------------------
 * USE CENTRAL FLEX HOOK
 * Calculates dynamic item width for flexbox/grid containers to ensure optimal
 * layout across different screen sizes and DPIs.
 * -------------------------------------------------------------------------- */
const useCentralFlex = (mode, dependencyArr = [], nowAt, numOfItems, wrapperRef = null) => {
	// STABLE DEPENDENCY KEY ----------------------------------------------------
	// Steps: stringify dependencyArr to a stable key so effect doesn't re-run just because array identity changed; this keeps resize observers from thrashing.
	const depsKey = useMemo(() => JSON.stringify(dependencyArr), [JSON.stringify(dependencyArr)]);
	const src = {
		galleryCats: { cont: 'gallery-menu', minOnRow: 2, maxOnRow: 6 },
		thumbs: { cont: 'user-card', minOnRow: 4, maxOnRow: 4 },
		typesFilter: { cont: 'types-filter', minOnRow: 6, maxOnRow: 22 },
		awards: { cont: 'awards-bs', minOnRow: numOfItems > 4 ? 3 : 4, maxOnRow: Math.min(numOfItems || 6, 6) },
		groupsCats: { cont: 'groups-comp', minOnRow: 3, maxOnRow: 6 },
		eventBs: { cont: 'attend-bs', minOnRow: 3, maxOnRow: 3 },
		basics: { cont: 'basics-bs', minOnRow: 4, maxOnRow: 10, minWidth: 140 },
		decades: { cont: 'decade-picker', minOnRow: 5, maxOnRow: 10 },
		months: { cont: 'month-picker', minOnRow: 6, maxOnRow: 12 },
		days: { cont: 'day-picker', minOnRow: 7, maxOnRow: 7 },
		hours: { cont: 'hour-picker', minOnRow: 6, maxOnRow: 12 },
		minutes: { cont: 'minutes-picker', minOnRow: 6, maxOnRow: 12 },
		indicators: { cont: 'indicator-bs', minOnRow: nowAt === 'home' ? 5 : 3, maxOnRow: nowAt !== 'home' ? 5 : 10, minWidth: 100 },
		catFilter: { cont: 'cat-filter', minOnRow: 2, maxOnRow: 4, minWidth: 300 },
		quicks: { cont: 'quick-friendly', minOnRow: 2, maxOnRow: Math.min(numOfItems || 6, 6) },
		feedbackPraises: { cont: 'praises-grid', minOnRow: 4, maxOnRow: 7 },
		feedbackReprimands: { cont: 'reprimands-grid', minOnRow: 5, maxOnRow: 7 },
		feedbackAspects: { cont: 'aspects-grid', minOnRow: 1, maxOnRow: 4 },
		changeHomeView: { cont: 'change-home', minOnRow: 1, maxOnRow: 2 },
		sortMenu: { cont: 'sort-menu', minOnRow: 5, maxOnRow: numOfItems || 5 },
		timesFilter: { cont: 'times-filter', minOnRow: 5, maxOnRow: numOfItems || 5 },
	};

	const config = src[mode] || { minOnRow: 2, maxOnRow: 6 }; // FALLBACK CONFIG ---------------------------
	const calcWidth = elem => {
		// WIDTH CALC --------------------------------------------------------
		// Steps: read container width, bail during overlays, compute minWidth from config and item count, pick onRow within bounds, optionally adjust to even distribution, then return final px width.
		const width = elem?.offsetWidth || 0;
		if (!width) return null; // NO WIDTH YET ---------------------------
		if (mode !== 'galleryCats' && document.body.classList.contains('overHidden')) return null; // SKIP DURING MODAL/OVERLAY ---------------------------
		const safeNumItems = Math.max(numOfItems || 1, 1);
		let minWidth = Math.max(config.minWidth || 0, Math.floor(360 / (config.minOnRow || 1)), Math.floor(width / safeNumItems));
		let onRow = Math.min(Math.ceil(width / (minWidth || 1)), config.maxOnRow || 6);
		if (onRow > safeNumItems) onRow = safeNumItems;
		if (onRow < 1) onRow = 1; // FLOOR TO 1 ---------------------------
		// EVEN DISTRIBUTION: ONLY WHEN ITEMS FIT IN 2 ROWS OR LESS (SKIP FOR LARGE ITEM COUNTS) ---------------------------
		if (onRow > 0 && safeNumItems <= onRow * 2 && safeNumItems > onRow) {
			for (let i = onRow; i >= (config.minOnRow || 1); i--) {
				if (safeNumItems % i === 0) {
					onRow = i;
					break;
				}
			}
		}
		// FINAL WIDTH CALCULATION ---------------------------
		return Math.max(width / onRow, 50) - 1;
	};

	const [itemWidth, setItemWidth] = useState(null);
	const retryCountRef = useRef(0); // TRACK RETRIES ---------------------------
	const MAX_RETRIES = 30; // 3 SECONDS MAX ---------------------------

	useLayoutEffect(() => {
		// OBSERVE + RETRY ----------------------------------------------------
		// Steps: attach ResizeObserver to the correct wrapper element, compute width on rAF, and retry briefly when element isn't ready yet (initial mount/layout shifts).
		let raf,
			retryTimer,
			observedElem = null;
		retryCountRef.current = 0; // RESET ON EFFECT RUN ---------------------------

		const updateWidth = elem => {
			const w = calcWidth(elem);
			if (w && w > 0) {
				setItemWidth(w);
				return true;
			}
			return false;
		};

		const resizeObserver = new ResizeObserver(entries => {
			requestAnimationFrame(() => {
				const elem = entries[0]?.target;
				if (elem) updateWidth(elem);
			});
		});

		const tryAttachObserver = () => {
			const elem = wrapperRef?.current || (typeof wrapperRef === 'object' && wrapperRef) || document.querySelector(config.cont);
			if (elem && elem !== observedElem) {
				// ATTACH OBSERVER TO NEW ELEMENT ---------------------------
				if (observedElem) resizeObserver.unobserve(observedElem);
				resizeObserver.observe(elem), (observedElem = elem);
			}
			if (elem && updateWidth(elem)) {
				// SUCCESS - CLEAR RETRY TIMER ---------------------------
				retryTimer && clearInterval(retryTimer), (retryTimer = null);
			} else if (!retryTimer && retryCountRef.current < MAX_RETRIES) {
				// START RETRY LOOP ---------------------------
				retryTimer = setInterval(() => {
					retryCountRef.current++;
					const el = wrapperRef?.current || document.querySelector(config.cont);
					if ((el && updateWidth(el)) || retryCountRef.current >= MAX_RETRIES) clearInterval(retryTimer), (retryTimer = null);
				}, 100);
			}
		};

		raf = requestAnimationFrame(tryAttachObserver);
		window.addEventListener('resize', tryAttachObserver);
		return () => {
			raf && cancelAnimationFrame(raf);
			retryTimer && clearInterval(retryTimer);
			observedElem && resizeObserver.unobserve(observedElem);
			resizeObserver.disconnect();
			window.removeEventListener('resize', tryAttachObserver);
		};
	}, [mode, depsKey, numOfItems]);

	return itemWidth; // RETURN NULL IF NOT CALCULATED YET - COMPONENTS SHOULD HANDLE NULL ---------------------------
};

export default useCentralFlex;
