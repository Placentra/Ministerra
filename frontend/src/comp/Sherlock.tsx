// SHERLOCK FILTER SYSTEM ---
// Drives the advanced event filtering engine: gender/age matching, personality indicators,
// basic interest matching, and group affiliation logic based on selected modes.
import { sherlockObj } from '../../sources';
import GenderAge from './GenderAge';
import Indicators from './Indicators';
import Basics from './Basics';
import Groups from './Groups';
import { useEffect, useRef, memo } from 'react';

function Sherlock(props) {
	// PROPS AND STATE INITIALIZATION ------------------------------------------
	const { sherData, setSherData, map, sherAvail, brain, filter, show, inform, snap, nowAt, snapMan, isSherActive } = props;
	const sherlockProps = { data: sherData, avail: sherAvail, superMan: snapMan, nowAt, brain, snap, sherMode: sherData.mode, inform };
	const scrollTarget = useRef(null);

	// AUTO-FOCUS ON MOUNT ---------------------------
	useEffect(() => {
		if (brain.scrollTo) return;
		scrollTarget.current.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
	}, []);

	return (
		<sherlock-comp ref={scrollTarget} class={`  ${!show.sherlock ? 'hide' : ''} posRel  marBotS marAuto flexCol block padBotXxl w100 textAli`}>
			<blue-divider
				style={{ filter: 'saturate(1) hue-rotate(0deg)' }}
				class={` hr14 bInsetBlueTopXl  block zin1 maskLowXs ${show.filter && !show.map ? 'opacityXs' : 'opacityM'}   w80   zinMax   marAuto   `}
			/>

			<span
				className={`fs29 textSha xBold  mw100   marAuto    block ${
					inform.includes('noMeetSel') || (map && !sherAvail.basics.length) || !snap.types?.length ? 'borderRed padBotS' : 'padBotXs'
				}`}>
				Sherlock
			</span>

			{/* NO FRIENDLY MEETINGS SELECTED WARNING -------------------------------- */}
			{/* Alerts user when no compatible events are selected for advanced matching. */}
			{inform.includes('noMeetSel') || (map && !sherAvail.basics.length) || !snap.types?.length ? (
				<warning-wrapper
					onClick={() => (show.filter ? snapMan('filter', !show.filter) : snapMan('sherlock', !show.sherlock))}
					className=' textAli inlineBlock pointer  mw100 bInsetRedDark  marAuto   padAllXs w100  shaBot borBotLight padHorXl   '>
					<span className='fs12 tRed xBold marBotXxxxs lh1-2 inlineBlock '>
						{map !== true ? 'POZOR: Nemáš zvolen ani jeden typ přátelské události' : 'POZOR: Na mapě není žádné přátelské setkání'}
					</span>
					<span className='fs8 marBotXxs block'>
						{map !== true
							? 'Sherlock je deaktivován. Nahoře ve filtru přiznač alespoň jeden typ přátelskÉ událostí.'
							: 'Posuň mapu a Sherlock se automaticky přepočítá, jakmile na ní bude alespoň jedna ikonka přátelského setkání '}
					</span>
				</warning-wrapper>
			) : (
				<>
					{/* SHERLOCK MATCHING MODES ----------------------------------------- */}
					{/* Loose (OR), Standard (Mixed), and Strict (AND) logic selectors. */}
					<mode-bs class='flexCen mw120 sideBors borderBot shaBlue marTopS    bw33 w100 boRadXxs aliStretch  marAuto bPadVerXs'>
						{['loose', 'standard', 'strict'].map(mode => {
							const isSel = (sherData?.mode || 'standard') === mode;
							const sherActive = isSherActive();
							return (
								<button
									key={mode}
									onClick={() => (sherActive && isSel ? setSherData({ ...sherlockObj }) : !isSel && snapMan('mode', mode))}
									className={`${isSel ? (!sherActive ? 'bBlue    tWhite' : '  bDarkBlue borBot2') : ' noBackground'} bHover `}>
									<span className={`${isSel ? 'tWhite fs16 tSha10 boldM' : 'fs16 boldS'}  posRel  lh1 `}>
										{isSel && sherActive ? 'Resetovat ' : mode === 'loose' ? 'volný' : mode === 'standard' ? 'standardní' : 'striktní'}
									</span>
									<span className={`${isSel ? 'tWhite' : ''}  fs7`}>
										{isSel && sherActive
											? 'odznačí aktuální výběr'
											: mode === 'loose'
											? 'splňuje cokoliv ve výběru'
											: mode === 'standard'
											? 'splňuje něco v každé sekci'
											: 'splňuje všechno naráz'}
									</span>
								</button>
							);
						})}
					</mode-bs>
					<blue-divider style={{ filter: 'brightness(0.9)' }} class={` hr1  block bInsetBlueTopXl  bgTrans  w100  mw100   marAuto   `} />

					{/* SUB-FILTER SECTIONS -------------------------------------------- */}
					<GenderAge {...sherlockProps} />
					<Indicators {...sherlockProps} />
					<Basics {...sherlockProps} />
					<Groups {...sherlockProps} />
				</>
			)}
		</sherlock-comp>
	);
}

// RENDER OPTIMIZATION ---------------------------
const areEqual = (prev, next) =>
	prev.sherData === next.sherData && prev.fadedIn === next.fadedIn && prev.sherAvail === next.sherAvail && prev.inform === next.inform && prev.snap === next.snap && prev.show === next.show;

export default memo(Sherlock, areEqual);
