import { useState, memo, useRef } from 'react';
import { catsSrc } from '../../sources';
import useCentralFlex from '../hooks/useCentralFlex';

//TODO přesunout type bs do filter, aplikovat moveUp
// TODO figure out, how to handle avaCats change when new event of new type is created and fetched by the user. (add the type to the availArray, but it has to also recalculate!)
// CATEGORY FILTER COMPONENT ---
// Manages event category selection with complex availability and timeframe logic
function CatFilter(props) {
	const { snap, avail = {}, snapMan, nowAt, fadedIn, timeLabel } = props,
		[cats, avaCats, avaCatsInTime] = [snap.cats || [], avail.cats || [], avail.catsInTime || []],
		wrapperRef = useRef(null),
		catWidth = useCentralFlex('catFilter', [fadedIn.length], 'editor', 4, wrapperRef.current),
		[lastClickedCat, setLastClickedCat] = useState(null);

	// SELECTION MANAGER LOGIC ---
	// Handles category toggling, multi-select behaviors, and editor-mode constraints
	async function handleCategorySelection(val) {
		if (nowAt === 'editor') return (!cats.includes(val) && snapMan('cats', val), val !== cats[0] && snapMan('types', null));
		let newCats;
		const isSel = cats.includes(val);
		const isAvail = avaCats.includes(val);
		const isInTime = avaCatsInTime.includes(val);
		const effectivelyUnavail = !isAvail || (isAvail && !isInTime && snap.time !== 'anytime');
		const allUnavailCats = catsSrc.cz.filter(cat => !avaCats.includes(cat) || (avaCats.includes(cat) && !avaCatsInTime.includes(cat) && snap.time !== 'anytime'));
		const allAvailSel = cats.every(cat => avaCats.includes(cat)) && cats.length === avaCats.length;
		const allCatsSel = cats.length === catsSrc.cz.length;

		// UNAVAILABLE CATEGORY HANDLING ---
		// Both red (no events) and orange (no events in timeframe) follow same rules
		if (effectivelyUnavail && avaCats.length === 0) return;
		else if (effectivelyUnavail && isSel) newCats = allCatsSel ? [...cats].filter(cat => !allUnavailCats.includes(cat)) : [...cats].filter(cat => cat !== val);
		else if (effectivelyUnavail && !isSel) newCats = [...cats, val];
		// AVAILABLE CATEGORY HANDLING ---
		else if (isAvail && isSel) {
			if (allAvailSel || allCatsSel) {
				if (lastClickedCat === val) newCats = cats.length === 1 ? [...catsSrc.cz] : [val];
				else newCats = [val];
			} else {
				if (cats.length === 1 && cats[0] === val) newCats = [...catsSrc.cz];
				else if (val !== lastClickedCat) newCats = [...cats].filter(cat => cat !== val);
				else newCats = [val];
			}
		} else if (isAvail && !isSel) {
			if (lastClickedCat === val) newCats = [val];
			else newCats = [...cats, val];
		}
		if (newCats.length === 0) newCats = avaCats;
		(setLastClickedCat(val), snapMan('cats', newCats.sort()));
	}

	// COMPONENT RENDERING ---
	// Renders category icons and labels with state-driven visual feedback
	return (
		<cat-filter ref={wrapperRef} class={`fadingIn ${fadedIn.includes('CatFilter') ? 'fadedIn' : ''}  shaTop  gapXxxxs posRel aliStretch flexCen w100 ${nowAt !== 'editor' ? '' : ''} wrap `}>
			{/* BACKGROUND OVERLAY --- */}
			{/* Semi-transparent background for better text legibility */}
			<div className={`bgWhite topCen opacityXs shaCon hr2 posAbs w100 zinMaXl`} />
			{/* INDIVIDUAL CATEGORY ITEMS --- */}
			{/* Maps through all categories to create interactive selection cards */}
			{catsSrc.cz.map((cat, i) => {
				const [isSel, isAvail, isInTime] = [cats.includes(cat), avaCats.includes(cat), avaCatsInTime.includes(cat)];
				const notInTimeButAvail = isAvail && !isInTime && snap.time !== 'anytime';
				return (
					<img-wrapper key={cat} style={{ width: '100%', ...(catWidth && { maxWidth: `${catWidth}px` }) }} class={` ${nowAt === 'editor' ? 'hvw30 mh28' : 'aspect165 hvw22 mh18'} ${nowAt === 'editor' && isSel ? 'bsContentGlow' : ''} noBackground  flexCol  posRel  grow bHover  marBotXxxxs  `} onClick={() => handleCategorySelection(cat)}>
						{/* CATEGORY IMAGE DISPLAY --- */}
						{/* Visual representation of the category with desaturation when inactive */}
						<img title={catsSrc.cz[i]} style={{ filter: 'brightness(1)' }} draggable="false" src={`/covers/eventCategories/${['meet.jpg', 'public.jpg', 'proffesional.jpg', 'volunteers.jpg'][i]}`} className={`${nowAt === 'editor' && isSel ? ' arrowDown   bsContentGlow zinMax' : ''} ${!isSel && nowAt !== 'editor' ? 'desaturated' : ''} h100     boRadXxs  grow }  cover posRel   w100`} />

						{/* CATEGORY TEXT OVERLAY --- */}
						{/* Contains the category name and status indicators (availability, counts) */}
						<span-wrapper style={{ bottom: '-0px' }} class={` 	 posAbs   marAuto  ${nowAt === 'editor' && isSel ? 'padVerS' : 'padVerXxxxs'} bgTrans  textAli  zinMaXl   hvw10 mh1-5  flexCol aliCen justCen              botCen ${nowAt === 'editor' ? 'w100' : 'mw16  '}`}>
							<span
								className={`inlineBlock ${
									nowAt !== 'editor' ? (isInTime ? 'fs14 xBold     tShaWhiteXl    ' : notInTimeButAvail ? `fs12 ${isSel ? 'opacityL' : 'opacityS'} tSha10 tWhite bOrange bgTrans bold  lh1` : `fs8 ${isSel ? 'opacityM' : 'opacityS'} tSha10 tWhite bRed  bgTrans      lh1 `) : nowAt === 'editor' && isSel ? 'boldM fs15 tWhite w100  posRel bBlue tWhite arrowDown1  tSha10 padVerXxs ' : 'fs12    tShaWhiteXl   xBold'
								}        posRel    textAli        w100    marAuto      zinMax      `}>
								{nowAt !== 'editor' && notInTimeButAvail ? `${timeLabel[snap.time][0].toUpperCase() + timeLabel[snap.time].slice(1)} nic` : `${catsSrc.cz[i]}${nowAt !== 'editor' && !isInTime ? ' (0)' : ''}`}
							</span>
						</span-wrapper>
					</img-wrapper>
				);
			})}
			{/* VISUAL DIVIDER --- */}
			{/* Bottom decorative divider for the category filter section */}
			{nowAt !== 'editor' && <blue-divider class={` hr1  block bInsetBlueTopXl opacityL  borTopLight bgTrans  posAbs botCen  w100 posRel mw120 zinMax   marAuto   `} />}
		</cat-filter>
	);
}

// PERFORMANCE OPTIMIZATION ---
// Prevents unnecessary re-renders by comparing relevant selection and availability state
function areEqualCatFilter(prevProps, nextProps) {
	return prevProps.snap?.cats === nextProps.snap?.cats && prevProps.snap?.types === nextProps.snap?.types && prevProps.snap?.time === nextProps.snap?.time && prevProps.fadedIn === nextProps.fadedIn && prevProps.avail?.cats === nextProps.avail?.cats && prevProps.avail?.catsInTime === nextProps.avail?.catsInTime && prevProps.brain?.user?.curCities === nextProps.brain?.user?.curCities && prevProps.nowAt === nextProps.nowAt;
}

export default memo(CatFilter, areEqualCatFilter);
