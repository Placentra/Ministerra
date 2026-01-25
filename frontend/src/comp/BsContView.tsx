import { memo } from 'react';

// CONTENT VIEW SELECTOR COMPONENT ---
// Toggles between events and users display based on available data and map state
function BsContView({ fadedIn, brain, snapMan, map, fetchInProg, show, avail: { types: avaTypes }, snap = {} as any, noFriendly }) {
	// EFFECTIVE TYPE SELECTION ------------------------------------------------------
	// Raw `snap.types` can include types unavailable for current cats/time/cities. Only intersection should count as selected.
	const effectiveSelectedTypeCount = (snap.types || []).filter(type => avaTypes.includes(type)).length;
	const selExists = effectiveSelectedTypeCount > 0 && avaTypes.length > 0;
	const selMeetings = !noFriendly && (map === true ? brain.itemsOnMap?.some(item => brain.events[item].type.startsWith('a')) : true);
	const src = {
		bs: { ...((selExists || selMeetings) && { Events: 'Události' }), ...(selMeetings && { Users: 'Účastníci' }) },
		abb: { Events: 'events', Users: 'users' },
	};
	const sherChanged = show.sherlock && snap.sherChanged === true;
	const shouldRender = selExists && (selMeetings || snap.changed);

	// NAVIGATION AND FETCH MANAGER ---
	// Handles scrolling to content or initiating new data fetch
	async function handleViewSelection(val) {
		if ((!snap.changed && !sherChanged && val === snap.contView) || (sherChanged && val === 'events'))
			requestAnimationFrame(() => {
				// CONTENT SCROLL TARGET --------------------------------------------------
				// Steps: query can return Element; cast to HTMLElement so `offsetTop` is available.
				const contentElement = document.querySelector('#content') as HTMLElement | null;
				if (!contentElement) return;
				window.scrollTo({
					top: contentElement.offsetTop,
					behavior: 'smooth',
				});
			});
		else snapMan('fetch', val);
	}

	// COMPONENT RENDERING ---
	// Renders the view navigation buttons with status indicators and warnings
	return (
		shouldRender && (
			<cont-view-bs class={`fadingIn ${fadedIn.includes('Content') ? 'fadedIn' : ''}   flexCen   noBackground  aliStretch gapXxxs zin1       posRel w100 marAuto`}>
				{/* CONTENT STATUS INDICATORS --- */}
				{/* Visual dividers and warning labels for map-restricted views */}
				{snap.changed && <blue-divider class="hr0-5  bsContentGlow   posAbs topCen  zinMaXl block noPoint    w90 marAuto" />}
				{snap.changed && <blue-divider class="h100 noPoint bInsetGreenTop posAbs topCen  zin1 block     w80 marAuto" />}
				{brain.stillShowingMapContent && map !== true && <span className="bDarkGreen  posAbs topCen tSha10 upLittle zinMenu textAli inlineBlock pointer marAuto arrowDown1Green     tWhite padAllXxs w100 mw50 boRadXxs xBold fs7">Pozor! Zobrazuješ obsah jenom z části mapy.</span>}
				<blue-divider style={{ filter: 'saturate(1) hue-rotate(0deg)' }} class={` hr11  posAbs topCen noPoint  block bInsetBlueTopS zin0 maskLow    w100      marAuto   `} />
				<blue-divider style={{ filter: 'saturate(0.2) hue-rotate(0deg) brightness(0.2) opacity(0.2)' }} class={` hr0-3   posAbs topCen block bInsetBlueTopXl  zinMenu  downLittle   w33   zin1 noPoint   marAuto   `} />

				{/* INDIVIDUAL NAVIGATION BUTTONS --- */}
				{/* Maps through view types to create interactive control buttons */}
				{Object.keys(src.bs).map(val => (
					<button
						key={val}
						disabled={!selExists && snap.contView !== val.toLowerCase()}
						onClick={() => !fetchInProg && handleViewSelection(src.abb[val])}
						className={`${val === 'Users' && !snap.changed && sherChanged ? 'bInsetPurpleTop borTopPurple8 padTopXl  fs29  xBold' : snap.changed ? ` fs29 bgTrans padTopXl xBold` : snap.contView === val.toLowerCase() && selExists ? ` fs29 padTopXl    bgTrans  tSha10 posRel   xBold ` : `${show.mode === 'expert' ? 'shaTopLight borTopLight' : ''}  padTopL posRel bgTransXs bold  fs23`}  flexCol  padBotM   maskLowXs   textSha bHover`}>
						{/* BUTTON LABEL CONTENT --- */}
						{/* Displays current state, loading progress, or navigational guidance */}
						{fetchInProg && snap.contView === val.toLowerCase() ? 'Pracuji ...' : snap.changed ? `${selMeetings ? `${brain.stillShowingMapContent ? `Přepočítat ${src.bs[val] === 'Události' ? 'události' : 'účastníky'}` : val === 'Users' && !snap.changed && sherChanged ? 'Změna Sherlocka' : src.bs[val]}` : `${brain.stillShowingMapContent ? 'Přepočítat události' : 'Zobrazit události'} ${show.map === true ? 'z mapy' : brain.stillShowingMapContent ? '' : 'z filtru'}`}` : src.bs[val]}
						{/* ADDITIONAL STATUS DESCRIPTIONS --- */}
						{/* Contextual information about the current or target view state */}
						{snap.contView === val.toLowerCase() && selExists && !snap.changed && !sherChanged && <span className="fs10  posRel padBotXxs">{'Právě je níže prohlížíš. Klikni pro auto-scroll.'}</span>}
						{snap.contView !== val.toLowerCase() && selExists && !snap.changed && (val !== 'Users' || !sherChanged) && <span className="fs10  posRel padBotXxs">{'Klikni přepnutí na tento typ obsahu.'}</span>}
						{sherChanged && val === 'Users' && <span className="fs10">Klikni pro aplikaci aktuálního Sherlocka</span>}
						{brain.stillShowingMapContent && <span className="fs10 marBotXxs">z celého území tvých lokalit</span>}
						{!brain.stillShowingMapContent && snap.changed && (
							<span className="fs10 arrowDown1Green posRel padBotXxs">
								{val === 'Users' && !sherChanged ? 'přátelských událostí' : !selMeetings ? '(pokud chceš účastníky, musíš přiznačit přátelská setkání)' : val === 'Events' ? 'ze zvoleného filtru' : ''}
								{show.map === true && <strong className="fs10 xBold bsContentGlow borRed"> z mapy </strong>}
							</span>
						)}
					</button>
				))}
			</cont-view-bs>
		)
	);
}

// PROPS COMPARISON LOGIC ---
// Optimizes re-rendering by checking specific property changes
function areEqual(prevProps, nextProps) {
	return prevProps.snap === nextProps.snap && prevProps.fadedIn === nextProps.fadedIn && prevProps.fetchInProg === nextProps.fetchInProg && prevProps.show.sherlock === nextProps.show.sherlock && prevProps.snap.changed === nextProps.snap.changed && prevProps.brain.stillShowingMapContent === nextProps.brain.stillShowingMapContent && prevProps.map === nextProps.map;
}
export default memo(BsContView, areEqual);
