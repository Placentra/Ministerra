import { memo, useState, useRef } from 'react';
import useCentralFlex from '../hooks/useCentralFlex';
import { USER_INDICATORS } from '../../../shared/constants';
import { MAX_COUNTS } from '../../../shared/constants';

function Indicators(props) {
	const { data, superMan, nowAt, avail = {}, sherMode } = props,
		wraperRef = useRef(null),
		indiWidth = useCentralFlex('indicators', [...(nowAt !== 'setup' ? [avail] : [])], nowAt, Math.min(10, avail.indis?.length || USER_INDICATORS.size), wraperRef),
		[invertButton, setInvertButton] = useState(null),
		invertTimeout = useRef(null);

	function man(inp) {
		// MANAGER -----------------------------------------------------------------------------
		let newIndis = [...(data.indis || [])];
		if (nowAt === 'setup')
			newIndis = newIndis.includes(inp) ? newIndis.filter(item => item !== inp) : newIndis.length >= MAX_COUNTS.indis ? newIndis : [...newIndis, inp];
		else if (inp === 'noneAll') newIndis = data.indis.length > 0 ? [] : avail.indis;
		else {
			if (invertButton === inp) {
				clearTimeout(invertTimeout.current), setInvertButton(null);
				newIndis = [...data.indis.filter(item => !avail.indis.includes(item)), ...avail.indis.filter(item => !data.indis.includes(item))];
			} else if (sherMode !== 'strict' && avail.indis.every(indi => data.indis.includes(indi)) && avail.indis.length > 1) {
				newIndis = data.indis.filter(item => !avail.indis.includes(item) || item === inp);
				(invertTimeout.current = setTimeout(() => setInvertButton(null), 2000)), setInvertButton(inp);
			} else newIndis = data.indis?.includes(inp) ? data.indis.filter(item => item !== inp) : [...(data.indis || []), inp];
		}
		superMan(
			'indis',
			newIndis.map(Number).sort((a, b) => a - b)
		);
	}

	return (
		<persona-indicators class={`${nowAt === 'home' ? 'imw7 iw50 marAuto bPadVerS shaBot' : '  imw7 iw45 bPadVerS '} marAuto  posRel block w100   posRel`}>
			{/* TITLE TEXTS -------------------------------------------------------- */}
			{nowAt === 'setup' && data.id && (
				<title-texts>
					<span className='xBold marBotXxs inlineBlock fs15'>{'Povahové indikátory'}</span>
					<p className='fs8 marBotS mw160 lh1 marAuto'>{'Vyber si indikátory, které o tobě opravdu 100% platí a pomohou ti najít specifické uživatele s podobnými zájmy.'}</p>
					{Array.isArray(data.indis) && data.indis.length >= MAX_COUNTS.indis && (
						<span className='fs7 tGrey inlineBlock'>
							Dosažen limit: {MAX_COUNTS.indis}/{MAX_COUNTS.indis}
						</span>
					)}
				</title-texts>
			)}

			{/* INDICATOR BUTTONS ---------------------------------------- */}
			<indicator-bs ref={wraperRef} class={`flexCen w100 marAuto  posRel aliStretch wrap `}>
				{[...USER_INDICATORS.entries()]
					.filter(([id]) => nowAt === 'setup' || avail.indis?.includes(id))
					.map(([id, value]) => (
						<button
							key={id}
							onClick={() => (nowAt === 'setup' || avail.indis?.includes(id) || data.indis.includes(id)) && man(id)}
							style={{ width: '100%', ...(indiWidth && { maxWidth: `${indiWidth}px` }) }}
							className={`${nowAt !== 'setup' && !avail.indis?.includes(id) ? ' opaque' : ''} ${
								data.indis?.includes(id) ? ' boRadXxs sideBors bInsetBlueTopXs2 borTop     zin1' : 'shaBlue zin2'
							}  posRel grow bgTrans  bHover `}>
							<img className='marBotXxxs posRel downTiny maskLowXs' src={`/icons/indicators/${id}.png`} alt='' />
							<span className={`${data.indis?.includes(id) ? ' boldM   borBotLight' : 'boldM'} lh1 marBotXxxs textSha fs9 marVerXxs`}>
								{invertButton === id ? 'invert?' : value.label}
							</span>
							<span className='fs6 w90 lh1'> {nowAt !== 'home' ? value.longDesc : value.shortDesc}</span>
						</button>
					))}
			</indicator-bs>

			{/* SELECT / DESELECT ALL BUTTON ------------------------ */}
			{nowAt === 'home' && data.mode !== 'strict' && (
				<button
					key={'noneAll'}
					onClick={() => man('noneAll')}
					className={`  ${data.indis?.length > 0 ? 'tRed' : 'tDarkBlue'} padAllXxs miw16 fs9 xBold marAuto posAbs botCen  moveDown inlineBlock hr3 zinMax borderLight`}>
					{data.indis?.length > 0 ? 'nic' : 'vše'}
				</button>
			)}
		</persona-indicators>
	);
}

export default memo(Indicators);
