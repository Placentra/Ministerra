// SEARCH AND FILTER HISTORY ---
// Manages and displays a gallery of previous filter configurations (snapshots).
// Organizes history by city groups, deduplicates redundant entries, and allows rapid retrieval of past search states.
import { useState, memo, useRef, useMemo } from 'react';
import { trim, areEqual } from '../../helpers';

function History(props) {
	// PROPS AND STATE INITIALIZATION ------------------------------------------
	const { fadedIn, brain, setAvailOrGetAvaTypes, snap, provideSnap, filter, superMan } = props;
	const scrollTarget = useRef();

	// CITY NORMALIZATION HELPER ---------------------------
	const normalizeCities = arr => (arr || []).map(c => c?.cityID || c).sort((a, b) => a - b);

	// BUILD CITY GROUPS FROM HISTORY SNAPS ------------------------------------
	// Clusters history entries based on the specific set of cities they target.
	const cityGroups = useMemo(() => {
		const map = new Map();
		for (const s of brain.user.history) {
			const ids = normalizeCities(s.cities);
			if (!ids.length) continue;
			const key = ids.join('|');
			if (!map.has(key)) map.set(key, ids);
		}
		return map;
	}, [brain.user.history.length]);

	// DEFAULT SELECTED GROUP --------------------------------------------------
	// Priority: 1. Currently active cities, 2. Most recent history entry's cities.
	const defaultGroupKey = useMemo(() => {
		const curKey = normalizeCities(brain.user.curCities).join('|');
		if (curKey && cityGroups.has(curKey)) return curKey;
		for (let i = brain.user.history.length - 1; i >= 0; i--) {
			const ids = normalizeCities(brain.user.history[i].cities);
			if (ids.length) return ids.join('|');
		}
		return Array.from(cityGroups.keys())[0] || '';
	}, [brain.user.history.length, cityGroups]);

	const [groupKey, setGroupKey] = useState(defaultGroupKey);

	// FILTER AND DEDUPE SNAPS BY SELECTED GROUP --------------------------------
	// Processes history items to ensure only unique and relevant snapshots are shown.
	const { eventsSnaps, usersSnaps } = useMemo(() => {
		const ids = (groupKey && cityGroups.get(groupKey)) || [];
		const filtered = brain.user.history.filter(s => normalizeCities(s.cities).join('|') === (ids.join('|') || ''));

		// CONTEXT-SPECIFIC FILTERING ---------------------------
		// Keep only the most recent 'init' events snap for this group
		let lastInitIdx = -1;
		for (let i = 0; i < filtered.length; i++) if (filtered[i].init && filtered[i].contView === 'events') lastInitIdx = i;
		if (lastInitIdx !== -1) {
			for (let i = filtered.length - 1; i >= 0; i--) if (filtered[i].init && filtered[i].contView === 'events' && i !== lastInitIdx) filtered.splice(i, 1);
		}

		// DEDUPLICATION LOGIC ---------------------------
		// Ensures identical filter combinations (types, cats, time, sort) aren't repeated.
		const seen = new Set();
		const deduped = [];
		for (let i = filtered.length - 1; i >= 0; i--) {
			const s = filtered[i];
			const key = JSON.stringify({ contView: s.contView, types: [...(s.types || [])].slice().sort((a, b) => a - b), cats: [...(s.cats || [])].slice().sort(), time: s.time, sort: s.sort });
			if (!seen.has(key)) seen.add(key), deduped.push(s);
		}
		deduped.reverse();

		// CATEGORIZATION ---------------------------
		const splitByView = list => list.reduce((acc, s) => ((s.contView === 'events' ? acc[0] : acc[1]).push(s), acc), [[], []]);
		const [ev, us] = splitByView(deduped);
		return { eventsSnaps: ev, usersSnaps: us };
	}, [brain.user.history.length, groupKey, cityGroups]);

	// RENDER COMPACT SNAPSHOTS ------------------------------------------------
	// Renders individual history cards with metadata about the search state.
	const renderSnapshots = snapshots => (
		<content-snaps className='flexCen halo wrap gapXxs posRel marHorXs'>
			{snapshots.map((obj, idx) => {
				const availTypes = setAvailOrGetAvaTypes(obj);
				const isSel = areEqual(trim(obj), trim(provideSnap('exact') || {}));
				const [t, s] = [obj.time, obj.sort];
				return (
					<snap-wrapper
						key={`${obj.id}_${obj.contView}`}
						onClick={() => {
							if (isSel) return;
							// SYNC BRAIN STATE BEFORE FETCH ---------------------------
							if (obj.cities && obj.cities.length) brain.user.curCities = obj.cities.map(c => c?.cityID || c).sort((a, b) => a - b);
							superMan('fetch', obj);
						}}
						className={`${isSel ? 'bBlue tSha tWhite borRedSel boRadXs' : ''} bHover flexRow mh5 padAllXs shaBlue borderLight boRadXxs pointer textSha`}>
						{/* SECTION INDICATOR (EVENT vs USERS) --------------------------- */}
						{(idx === 0 || idx === eventsSnaps.length) && (
							<img src={`/icons/${idx === 0 && eventsSnaps.length ? 'event' : 'people'}.png`} className='boRadXxs shaCon h100 mh6 padHorXs padVerXxs bDarkBlue borRed' />
						)}
						<snap-wrapper className='flexCol aliStart fs6 padHorS padVerXxxs'>
							<span className='fs7'>
								<strong className='fs9'>{`${obj.contView === 'users' ? 'Přá' : obj.cats.length === 4 ? 'Všechny' : obj.cats.map(cat => ` ${cat.slice(0, 3)}`)} `}</strong>
								{`(${Math.min(obj.types.length, availTypes.length)}/${availTypes.length})`}
							</span>
							<second-row className='flexInline'>
								<strong className='boldXs marRigXs tDarkBlue'>
									{t === 'anytime'
										? 'kdykoliv'
										: t === 'today'
										? 'Dnes'
										: t === 'tomorrow'
										? 'Zítra'
										: t === 'week'
										? 'týden'
										: t === 'month'
										? 'měsíc'
										: t === 'nextMonth'
										? 'příští měsíc'
										: t === 'nextWeek'
										? 'příští týden'
										: t === 'twoMonths'
										? '2 měsíce'
										: 'víkend'}
								</strong>
								<span>{s === 'popular' ? 'oblíbené' : s === 'earliest' ? 'brzké' : s === 'nearest' ? 'blízké' : s === 'intimate' ? 'intimní' : 'rušné'}</span>
							</second-row>
						</snap-wrapper>
					</snap-wrapper>
				);
			})}
		</content-snaps>
	);

	return (
		<filter-history
			ref={scrollTarget}
			className={`fadingIn ${fadedIn.includes('Content') ? 'fadedIn' : ''} flexCol textAli wrap padTopXxl ${!filter ? 'padBotM' : ''} posRel bRadS marBotM marAuto`}>
			
			{/* CITY GROUP SELECTOR ----------------------------------------------------- */}
			<city-groups className='flexCen aliStretch fitContent marAuto mh4 wrap bInsetBlueXs posRel marBotL'>
				{Array.from(cityGroups.entries()).map(([key, ids]) => {
					const names = ids.map(id => brain.cities.find(c => c.cityID === id)?.city).filter(Boolean);
					return (
						<button
							key={key}
							onClick={() => setGroupKey(key)}
							className={`bHover ${groupKey === key ? 'shaCon xBold' : 'tDarkBlue'} mw35 grow flexCen padHorL boRadXs borderLight padVerXxs fs8`}>
							{names.join(' • ')}
						</button>
					);
				})}
				{!cityGroups.size && <span className='fs11 borderRed bRed tWhite marTopXxs xBold padAllXs borderLight mw60 w100 marAuto inlineBlock textSha'>Žádné skupiny měst v historii</span>}
			</city-groups>

			{/* SNAPSHOT GALLERY ------------------------------------------------------- */}
			<snaps-wrapper className='flexCen marTopS wrap w100'>{renderSnapshots([...eventsSnaps, ...usersSnaps])}</snaps-wrapper>
			
			{/* ACTIVE SNAPSHOT DETAILS -------------------------------------------------- */}
			<types-icons className='flexCen marTopXxs gapXxxs padAllXs boRadS wrap aliCen'>
				{(() => {
					const selectedSnapshot = provideSnap('exact');
					const renderTypes = snapshot => snapshot.types.map(typeID => <img key={`${snapshot.id}_${typeID}`} className='mw3 miw2 w10' src={`/icons/types/${typeID}.png`} alt='' />);
					return selectedSnapshot ? renderTypes(selectedSnapshot) : null;
				})()}
			</types-icons>
		</filter-history>
	);
}

export default memo(History);
