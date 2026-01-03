// TODO udělat maping topiců na čísla na frontendu a na backed posílat jen čísla
import useCentralFlex from '../hooks/useCentralFlex';
import { useState, useRef } from 'react';
import { BASIC_TOPICS } from '../../../shared/constants';
import { MAX_COUNTS } from '../../../shared/constants';

// BASICS COMPONENT DEFINITION ---
// Handles selection of progressive topics with inversion logic and multi-select capabilities
function Basics(props) {
	const { data, superMan, inform = [], nowAt, avail, sherMode } = props,
		wraperRef = useRef(null),
		bWidth = useCentralFlex('basics', [], nowAt, avail?.basics.length || BASIC_TOPICS.size, wraperRef),
		[invertButton, setInvertButton] = useState(null),
		invertTimeout = useRef(null);

	// SELECTION MANAGER LOGIC ---
	// Processes topic selection, deselection, and inversion based on current application state
	function processTopicSelection(inp) {
		let newBasics;
		if (inp === 'noneAll') newBasics = data.basics.length > 0 ? [] : avail.basics;
		else {
			if (invertButton === inp) {
				clearTimeout(invertTimeout.current), setInvertButton(null);
				newBasics = [...data.basics.filter(item => !avail.basics.includes(item)), ...avail.basics.filter(item => !data.basics.includes(item))];
			} else if (nowAt !== 'setup' && sherMode !== 'strict' && ((avail.basics.every(basic => data.basics.includes(basic)) && avail.basics.length > 1) || !data.basics.length)) {
				newBasics = !data.basics.length ? [inp] : data.basics.filter(item => !avail.basics.includes(item) || item === inp);
				(invertTimeout.current = setTimeout(() => setInvertButton(null), 2000)), setInvertButton(inp);
			} else
				newBasics = data.basics?.includes(inp)
					? data.basics.filter(t => t !== inp)
					: nowAt === 'setup' && (data.basics || []).length >= MAX_COUNTS.basics
					? data.basics || []
					: [...(data.basics || []), inp];
		}
		superMan(
			'basics',
			newBasics.map(Number).sort((a, b) => a - b)
		);
	}

	// COMPONENT RENDERING ---
	// Renders the main container for basic topic selection
	return (
		<basics-comp class={` posRel flexCen      marAuto  w100 block`}>
			{/* SETUP TITLE SECTION --- */}
			{/* Displays introductory text when in setup mode for existing users */}
			{nowAt === 'setup' && data.id && (
				<title-texts>
					<span className='xBold marBotXxs inlineBlock fs15'>Progresivní témata</span>
					<p className='fs8 marBotS mw160 lh1 marAuto'>
						Nejdůležitější témata, o kterých bychom se měli všichni bavit. Vyber si alespoň 3, ke kterým máš nejblíže a ideálně o nich i něco víš.
					</p>
					{Array.isArray(data.basics) && data.basics.length >= MAX_COUNTS.basics && (
						<span className='fs7 tGrey inlineBlock'>
							Dosažen limit: {MAX_COUNTS.basics}/{MAX_COUNTS.basics}
						</span>
					)}
				</title-texts>
			)}

			{/* TOPIC BUTTONS CONTAINER --- */}
			{/* Wraps individual topic selection buttons with flexible layout */}
			<basics-bs
				ref={wraperRef}
				class={`flexCen  ${inform.includes('addBasics') ? 'borderRed' : ''} flexRow iw60 marAuto ${
					nowAt === 'home' ? `padTopXxl ${data.mode === 'strict' ? 'padBotXxl' : ''}` : ''
				}  aliStretch   wrap w100  `}>
				{/* INDIVIDUAL TOPIC BUTTONS --- */}
				{/* Maps through available topics to create interactive selection buttons */}
				{Array.from(BASIC_TOPICS.keys())
					.filter(id => nowAt === 'setup' || avail?.basics.includes(id))
					.map(id => (
						<button
							style={{ width: '100%', ...(bWidth && { maxWidth: `${bWidth}px` }) }}
							key={id}
							className={`${invertButton === id ? 'xBold' : ''} ${nowAt !== 'setup' && !avail.basics.includes(id) ? 'opaque' : ''}  ${
								data.basics?.includes(id) ? 'bInter bGlassSubtle  fs7 bInsetBlueTopXs posRel bold shaCon posRel' : 'fs7 borderLight '
							}  shaBlue justCen aliCen borBotLight preWrap  textSha grow hvw7 mh3-5 flexCol bHover  grow`}
							onClick={() => (nowAt === 'setup' || avail.basics.includes(id) || data.basics.includes(id)) && processTopicSelection(id)}>
							{invertButton === id ? 'invert?' : BASIC_TOPICS.get(id)}
						</button>
					))}
			</basics-bs>

			{/* ERROR MESSAGE DISPLAY --- */}
			{/* Shows validation error if minimum topics are not selected during setup */}
			{data.id && inform.includes('addBasics') && <span className='tRed fs8 inlineBlock marTopXs xBold'>Přidej alespoň 3 témata</span>}

			{/* SELECT ALL BUTTON --- */}
			{/* Provides a quick way to toggle all topics when not in strict mode */}
			{nowAt === 'home' && data.mode !== 'strict' && (
				<button
					className={`${data.basics.length > 0 ? 'tRed' : 'tDarkBlue'} marBotXl  padAllXxs miw16 fs9 xBold zinMaXl marAuto inlineBlock  borderLight `}
					onClick={() => processTopicSelection('noneAll')}>
					{data.basics.length > 0 ? 'nic' : 'vše'}
				</button>
			)}
		</basics-comp>
	);
}

export default Basics;
