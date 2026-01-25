import { useRef, Fragment, memo, useState, useEffect } from 'react';
import { catTypesStructure, typesMap } from '../../sources';
import useCentralFlex from '../hooks/useCentralFlex';
import { areEqual } from '../../helpers';

// TODO put a switch between types and tags => tags show only selected filters which include tags. selecting a type revelas tags below. alternative would be to click whether tags should be rendered and then they would be rendered for all selected types automatically. possibly third option is having each type button divided on two parts, one for selecton only and one for tags. this would be probably most effective, but it doubles the number of active button areas. Tags would be represented by their own number for metas.

function Filter(props) {
	const { avail, nowAt, snap, snapMan, map } = props,
		[{ cats: avaCats = [], types: avaTypes = [] } = {}, { cats, types }] = [avail, snap],
		isAllAvailableTypesSelected = avaTypes.length > 0 && avaTypes.every(typeID => types.includes(typeID)),
		bWidth = useCentralFlex('typesFilter', [types, avaTypes], nowAt, nowAt !== 'editor' ? avaTypes.concat(avaCats).length : catTypesStructure.get(cats[0])?.ids.length),
		[invertButton, setInvertButton] = useState(null),
		allSel = isAllAvailableTypesSelected,
		[active, setActive] = useState(!isAllAvailableTypesSelected),
		scrollTarget = useRef(null);

	// MANAGER FUNCTION -----------------------------------------------------
	function man(cat, inp) {
		const isIn = (typeID, list) => list.includes(typeID);
		if (nowAt === 'editor') return snapMan('types', isIn(inp, types) ? null : inp);

		if (!active) setActive(true);
		let newSelTypes = !active ? [] : [...types];
		const typesInCat = catTypesStructure.get(cat)?.ids.filter(typeID => isIn(typeID, avaTypes));

		// none / all select handling -------------------
		if (['none', 'all'].includes(inp)) {
			if (!cat) return snapMan('types', inp === 'all' ? avaTypes.sort((a, b) => a - b) : []);
			else newSelTypes = inp === 'all' ? [...newSelTypes, ...typesInCat] : newSelTypes.filter(typeID => !typesInCat.includes(typeID));
		} else {
			// invert button handling -------------------
			if (invertButton === inp) {
				setInvertButton(null);
				newSelTypes = [...types.filter(typeID => !typesInCat.includes(typeID)), ...typesInCat.filter(typeID => !newSelTypes.includes(typeID))];
			} else if (typesInCat.length > 1 && (typesInCat.every(typeID => isIn(typeID, newSelTypes)) || !typesInCat.some(typeID => isIn(typeID, newSelTypes)))) {
				const otherCatTypes = newSelTypes.filter(typeID => !typesInCat.includes(typeID));
				((newSelTypes = !typesInCat.some(typeID => isIn(typeID, newSelTypes)) ? [...otherCatTypes, inp] : [...otherCatTypes, ...typesInCat.filter(typeID => typeID === inp)]), setInvertButton(inp), setTimeout(() => setInvertButton(null), 2000));
			} else newSelTypes = newSelTypes.includes(inp) ? newSelTypes.filter(typeID => typeID !== inp) : [...newSelTypes, inp];
		}
		snapMan(
			'types',
			newSelTypes.sort((a, b) => a - b)
		);
	}

	useEffect(() => {
		if (nowAt === 'editor') return;
		// SCROLL TO CENTER FILTER ON OPEN ---------------------------
		scrollTarget.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);

	return (
		<types-filter ref={scrollTarget} class={`${nowAt !== 'editor' ? 'padBotXl' : ''}    textAli ${map === true ? 'padBotS' : ''} posRel flexCol marAuto block aliCen w100 `}>
			<blue-divider style={{ filter: 'saturate(1) hue-rotate(-10deg) brightness(0.8) opacity(0.3)' }} class={` hr0-2  posAbs topCen block bInsetBlueTopXl  zinMenu  downLittle   w50  mw80 zinMaXl opacityS  marAuto   `} />
			<blue-divider style={{ filter: 'saturate(1) hue-rotate(0deg)' }} class={` ${nowAt === 'editor' ? 'hr2' : 'hr10'} bInsetBlueTopXs2  block zin1 maskLowXs     w80   mw95 zinMax   marAuto   `} />

			{/* SELECT / DESELECT ALL --------------------------------------------------------------------- */}
			{nowAt !== 'editor' && avail.types?.length > 1 && (
				<button className={`${allSel && active ? 'tRed' : 'tGreen'} textSha   padBotXxs   w100 mw25 borBotLight fs8  shaBlueLight bBor  bold borBotLight   posRel marBotXs marAuto inlineBlock  borderLight boRadXxxs `} onClick={() => man(null, allSel && active ? 'none' : 'all')}>
					{allSel && active ? 'odznačit vše' : 'označit vše'}
				</button>
			)}

			<types-bs class={`flexCen wrap ${nowAt === 'editor' ? 'iw60 bPadVerS ' : 'iw50 bPadVerXs'}   w100 marAuto textAli aliStretch `}>
				{Array.from(catTypesStructure.keys()).map(cat => {
					const availCat = nowAt === 'editor' || catTypesStructure.get(cat).ids.some(typeID => avaTypes.includes(typeID));
					const allSel = catTypesStructure
						.get(cat)
						.ids.filter(typeID => avaTypes.includes(typeID))
						.every(typeID => types.includes(typeID));
					const typesToRender = catTypesStructure.get(cat).ids.filter(id => nowAt === 'editor' || avaTypes.includes(id));
					return (
						cats?.includes(cat) &&
						availCat && (
							<Fragment key={cat}>
								{/* SELECT / DESELECT ALL IN CAT ------------------------------------------------------------- */}
								{nowAt === 'home' && typesToRender.length > 0 && (
									<button style={{ width: `100%`, maxWidth: `${Math.min(bWidth, 100)}px` }} className={`noBackground flexCol xBold bInsetBlueTopXs bBor2     posRel  grow textSha   bHover`} onClick={() => man(cat, allSel && active ? 'none' : 'all')}>
										<span className="lh0-6 fs16 marBotXxxs xBold">{cat.slice(0, 4)}</span>
										<span className={`${allSel && active ? 'tRed' : 'tBlue'} lh1   fs6 boldS`}>{allSel && active ? 'nic >' : 'vše >'}</span>
									</button>
								)}

								{/* // TYPES BS -------------------------------------------------------------------------------- */}
								{typesToRender.map(typeID => {
									return (
										<button
											style={{ width: `100%`, maxWidth: `${Math.min(bWidth, 100)}px` }}
											className={` ${invertButton === typeID ? 'boldM xBold' : ''}   ${nowAt === 'editor' ? (types.includes(typeID) ? 'thickBors shaBot xBold posRel bgTrans  boRadS zinMax  shaComment ' : 'boldXs ') : ''} ${avaTypes.includes(typeID) && types.includes(typeID) && active ? 'shaBlue boRadXxs bInsetBlueTopS boldXs posRel' : avaTypes.includes(typeID) ? '  shaSubtle boRadXxs  textSha' : ''} fs6      w100  bHover`}
											onClick={() => ((nowAt === 'home' && avaTypes.includes(typeID)) || nowAt === 'editor') && man(cat, typeID)}
											key={typeID}>
											<img className={`${nowAt === 'home' ? (!avaTypes.includes(typeID) ? 'opaque mw4 mh4 ' : 'mw6 mh5') : 'mw7'} shaWhite boRadXxs     posRel   `} src={`/icons/types/${typeID}.png`} alt="" />
											{invertButton === typeID ? 'invert?' : typesMap.get(typeID).cz}
										</button>
									);
								})}
							</Fragment>
						)
					);
				})}
			</types-bs>
			{/* WARNING FOR NO TYPES SELECTED -------------------------------------------- */}
		</types-filter>
	);
}

function dontRender(prevProps, nextProps) {
	return prevProps.snap.types === nextProps.snap.types && prevProps.avail === nextProps.avail && prevProps.snap.cats === nextProps.snap.cats && areEqual(prevProps.fadedIn, nextProps.fadedIn) && prevProps.avail?.types === nextProps.avail?.types && prevProps.snap.time === nextProps.snap.time && prevProps.map === nextProps.map;
}

export default memo(Filter, dontRender);
