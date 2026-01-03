import RateAwards from './RateAwards';
import IntersPrivsButtons from './IntersPrivsButtons';

// SOCIAL ICON ASSETS ---
const src = { Facebook: '/icons/facebook.png', Google: '/icons/google.png', Instagram: '/icons/instagram.png', Twitter: '/icons/twitter.png' };

function EveActionsBs({ obj, nowAt, fadedIn, setModes, brain, status, setStatus, modes, isInactive, thisIs, isPast }: any) {
	// INTERESTS VIEW - REPLACES DEFAULT BUTTONS ---------------------------

	return (
		<secondary-bs onClick={e => e.stopPropagation()} class={`fadingIn ${fadedIn.includes('BsEvent') ? 'fadedIn' : ''}  flexCol zinMenu posRel marAuto aliStretch w100`}>
			{!isPast && <IntersPrivsButtons obj={obj} nowAt={nowAt} fadedIn={fadedIn} setModes={setModes} brain={brain} status={status} setStatus={setStatus} modes={modes} isInactive={isInactive} />}

			{!isPast && !modes.privs && (
				<RateAwards obj={obj} nowAt={nowAt} fadedIn={fadedIn} setModes={setModes} brain={brain} status={status} setStatus={setStatus} modes={modes} isInactive={isInactive} thisIs={thisIs} />
			)}

			{!modes.privs && (
				<share-b class='flexCen aliStretch zinMax   w100'>
					{Object.keys(src).map(button => {
						return (
							<button key={button} className={`bHover bBor w25 posRel ${nowAt === 'event' ? 'padVerXs' : 'padBotXs padTopXxs'}`}>
								<button-texture style={{ filter: 'brightness(1.5) saturate(1.5)' }} class=' posAbs padAllXxxs topCen zin1 w100 h100 bInsetBlueTopXs  hr2     ' />
								<img className={`w80 posRel aspect1610 downTinyBit maskLowXs ${nowAt === 'event' ? 'mw4' : 'mw4'}`} src={src[button]} alt='' />
								<span className='fs5   tLightGrey lh1 '>{button}</span>
							</button>
						);
					})}
				</share-b>
			)}
		</secondary-bs>
	);
}
export default EveActionsBs;
