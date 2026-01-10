import { useState, useRef, memo } from 'react';
const lang = { Expertise: 'Odbornost', Services: 'Služby', Hobbies: 'Zájmy', Persona: 'Osobnost', Special: 'Speciální', Ethnics: 'Etnicita' };
import useCentralFlex from '../hooks/useCentralFlex';
import { USER_GROUPS } from '../../../shared/constants';
import { MAX_COUNTS } from '../../../shared/constants';

const test = USER_GROUPS.get('test');

function Groups({ data = {}, superMan, nowAt, avail = {}, sherMode }: any) {
	const topEdge = useRef(null);
	const [activeCat, setActiveCat] = useState(Array.from(USER_GROUPS.keys())[0]);
	const [design, setDesign] = useState(1),
		[invertButton, setInvertButton] = useState(null),
		invertTimeout = useRef(null),
		bWidth = (useCentralFlex as any)('groupsCats', [], nowAt, Array.from(USER_GROUPS.keys()).length);

	// MANAGER -----------------------------------------------------------------------------
	function man(inp, cat) {
		let [curGroups, newGroups] = [[...(data.groups || [])], null];
		const tarGroups = cat ? Array.from(USER_GROUPS.get(cat).keys()).filter(key => nowAt === 'setup' || avail.groups.includes(key)) : [];
		if (inp === 'noneAll') {
			if (!cat) newGroups = curGroups.length > 0 ? [] : avail.groups;
			else
				newGroups = !data.groups?.some(group => tarGroups.includes(group))
					? Array.from(new Set(curGroups.concat(tarGroups.filter(key => nowAt === 'setup' || avail.groups.includes(key)))))
					: curGroups.filter(group => !tarGroups.includes(group));
		} else {
			if (invertButton === inp)
				clearTimeout(invertTimeout.current), setInvertButton(null), (newGroups = [...curGroups.filter(item => !tarGroups.includes(item)), ...tarGroups.filter(item => item !== inp)]);
			else if (
				(nowAt !== 'setup' || data.id) &&
				sherMode !== 'strict' &&
				data.groups &&
				(tarGroups.every(key => data.groups.includes(key)) || tarGroups.every(key => !data.groups.includes(key))) &&
				tarGroups.length > 1
			)
				setInvertButton(inp), (newGroups = [...curGroups.filter(item => !tarGroups.includes(item)), inp]), (invertTimeout.current = setTimeout(() => setInvertButton(null), 2000));
			else newGroups = curGroups.includes(inp) ? curGroups.filter(topic => topic !== inp) : curGroups.length >= MAX_COUNTS.groups && nowAt === 'setup' ? curGroups : [...curGroups, inp];
		}
		// SETUP LIMIT CLAMP -----------------------------------------------------------
		// Hard cap selection size to prevent abuse.
		if (nowAt === 'setup' && Array.isArray(newGroups) && newGroups.length > MAX_COUNTS.groups) newGroups = Array.from(new Set(newGroups)).slice(0, MAX_COUNTS.groups);
		superMan(
			'groups',
			newGroups.sort((a, b) => a - b)
		);
	}

	return (
		<groups-comp class={`block marAuto mw170 w100 posRel`} ref={topEdge}>
			{nowAt === 'setup' && (
				<title-texts class='posRel block'>
					{/* SECTION DESCRIPTION (EXISTING USERS ONLY) --- */}
					{data.id && (
						<>
							<span className='xBold marBotXxs inlineBlock fs15'>{'Zájmové skupiny'}</span>
							<p className='fs8 marBotXs mw160 lh1 marAuto'>{'Pomůže ti to lépe vyhledávat lidi a zvýší šance na seznámení.'}</p>
						</>
					)}
					{/* LIMIT WARNING (ALL USERS) --- */}
					{Array.isArray(data.groups) && data.groups.length >= MAX_COUNTS.groups && (
						<span className='fs16 tRed xBold textSha marBotXs block'>
							Dosažen limit: {MAX_COUNTS.groups}/{MAX_COUNTS.groups}
						</span>
					)}
				</title-texts>
			)}
			{/* DESIGN CHANGE BUTTON -------------------------------------------------------*/}
			<button
				className={`w80 mw40 fs7 borRed  arrowDown1 posRel hr3 boldM boRadXs tDarkBlue shaTopLight borTopLight boRadXs marBotXxs marAuto`}
				onClick={() => setDesign(design === 1 ? 2 : 1)}>{`Změnit zobrazení`}</button>
			{/* CATEGORIES VIEW -------------------------------------------------- */}
			{design === 1 && (
				<categories-view>
					{/* CATEGORIES BUTTONS -------------------------------------- */}
					<groups-cats class='flexCen w100 marAuto imw4 wrap'>
						{Array.from(USER_GROUPS.keys()).map(cat => {
							const keys = Array.from(USER_GROUPS.get(cat).keys()).filter(key => nowAt === 'setup' || avail.groups?.includes(key));
							const isCategoryEmpty = nowAt !== 'setup' && !keys.some(group => avail.groups.includes(group));
							const selectedCount = keys.filter(group => data.groups?.includes(group))?.length;
							return (
								<button
									style={{ width: '100%', ...(bWidth && { maxWidth: `${bWidth}px` }) }}
									className={`${
										activeCat === cat ? 'bInsetBlueTopXs2 posRel fs17  sideBors borTop  xBold' : selectedCount > 1 ? 'boldM  tBlue' : 'bgTrans boldS shaSubtle'
									} padVerXs fs11 textSha `}
									key={cat}
									onClick={() => setActiveCat(cat)}>
									<div className={`${isCategoryEmpty ? 'tDis' : ''} ${activeCat === cat ? 'arrowDown1' : 'tDarkBlue'} flexCen gapXxs`}>
										{selectedCount > 0 && (
											<span className='boRadXs shaCon tDarkBlue borderBot miw3 fs9 boldM'>
												{selectedCount}
												{avail.groups && `/${avail.groups.filter(group => keys.includes(group)).length}`}
											</span>
										)}
										{lang[cat] ? lang[cat] : cat}
									</div>
								</button>
							);
						})}
					</groups-cats>
					{/* GROUPS BUTTONS ---------------------------------------------- */}
					<groups-bs class='flexCen  bInsetBlueTopXs posRel growAll marAuto wrap'>
						<blue-divider class={`hr1 borTop zinMin block bInsetBlueTopXl bgTrans posRel w90 mw80 marAuto`} />
						<bs-wrapper class='marTopXxs flexCen wrap w100 marTopS marAuto'>
							{Array.from(USER_GROUPS.get(activeCat).entries()).map(([key, type]) => (
								<button
									className={`${invertButton === key ? 'boldM' : ''} ${nowAt !== 'setup' && !avail.groups.includes(key) ? 'tDis' : ''} ${
										data.groups?.includes(key) ? 'bInsetBlueTopS borTop xBold fs7 posRel' : 'shaBlue fs7 borBotLight'
									} padHorS mw14 bHover  padVerXxs`}
									key={key}
									onClick={() => (nowAt === 'setup' || avail.groups.includes(key) || data.groups.includes(key)) && man(key, activeCat)}>
									{invertButton === key ? 'invert?' : type}
								</button>
							))}
						</bs-wrapper>
					</groups-bs>
				</categories-view>
			)}
			{/* CLOUD VIEW ---------------------------------------------------------*/}
			{design === 2 && (
				<collapsed-view class='flexCen marTopS gapXxxs marAuto wrap'>
					{Array.from(USER_GROUPS.keys()).flatMap((cat, idx) => {
						const keys = Array.from(USER_GROUPS.get(cat).keys()).filter(key => nowAt === 'setup' || avail.groups.includes(key));
						const someGroupSelected = data.groups?.some(group => keys.includes(group));
						if (keys.length > 0)
							return [
								// CATEGORY NAME -------------------------------------
								<span key={cat} className={`${idx > 0 ? 'marLefM' : ''} textAli fs10 marRigS inlineBlock xBold`}>
									{lang[cat] ? lang[cat] : cat}
								</span>,
								// SELECT / DESELECT CAT BUTTON -------------------------------------
								keys.length > 1 && (sherMode !== 'strict' || (sherMode === 'strict' && someGroupSelected)) && (
									<button className={`${someGroupSelected ? 'tRed' : 'tBlue '} padAllXxs miw4 padVerXxs fs9 xBold borderLight boRadXs`} onClick={() => man('noneAll', cat)}>
										{someGroupSelected ? 'nic' : 'vše'}
									</button>
								),
								// GROUPS BUTTONS -------------------------------------
								Array.from(USER_GROUPS.get(cat).entries()).map(
									([key, type]) =>
										(nowAt === 'setup' || avail.groups.includes(key)) && (
											<button
												key={key}
												disabled={nowAt !== 'setup' && !avail.groups.includes(key)}
												className={`${invertButton === key ? 'boldM' : ''} ${
													data.groups?.includes(key) ? ' bInter bGlassSubtle borTop   fs7  posRel bold shaCon ' : 'fs7 borderLight '
												} padHorS padVerXxs fs7 bHover mw14`}
												onClick={() => man(key, cat)}>
												{invertButton === key ? 'invert?' : type}
											</button>
										)
								),
							].filter(Boolean);
					})}
				</collapsed-view>
			)}

			{/* SELECT / DESELECT CAT BUTTON -------------------------------------------*/}
			{((nowAt !== 'setup' &&
				(sherMode !== 'strict' || data.groups?.length > 0) &&
				(design === 1 ? Array.from(USER_GROUPS.get(activeCat).keys()).some(key => data.groups?.includes(key)) : data.groups?.length === 0)) ||
				data.groups?.length > 0) && (
				<button
					className={`${data.groups?.length > 0 ? 'tRed' : 'tBlue'} padAllXxs posAbs botCen moveDown miw16 fs11 xBold marAuto inlineBlock marTopXs borderLight boRadXs`}
					onClick={() => man('noneAll', design === 1 ? activeCat : null)}>
					{sherMode === 'strict' ||
					(design === 1
						? Array.from(USER_GROUPS.get(activeCat).keys()).some(key => data.groups?.includes(key))
						: nowAt === 'setup' || avail.groups?.some(group => data.groups?.includes(group)))
						? 'nic'
						: 'vše'}
				</button>
			)}
		</groups-comp>
	);
}
export default memo(Groups);
