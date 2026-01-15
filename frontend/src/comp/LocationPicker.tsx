import { useRef, useState, useLayoutEffect, useMemo, useCallback, useContext } from 'react';
import { areEqual } from '../../helpers';
import { fetchLocationSuggestions, processLocationItems, getDistance } from '../utils/locationUtils';
import Masonry from './Masonry';
import useMasonResize from '../hooks/useMasonResize';
import { globalContext } from '../contexts/globalContext';
import { MAX_COUNTS } from '../../../shared/constants';

// TODO check if its possible to scroll down, when suggest reaches below the screen
// BUG changing  place mode is not updating the locaInput
// TODO need to store detaild data into mysql as well (such as the geo structure)
// IDEA přidat komponentu pro přidání dalších měst pokud je velmi málo obsahu (za obsah)

// Custom hook for debounced value
const useDebounce = (value, delay) => {
	const [debouncedValue, setDebouncedValue] = useState(value);

	useLayoutEffect(() => {
		const timer = setTimeout(() => setDebouncedValue(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);

	return debouncedValue;
};

function LocationPicker(props) {
	const { isMobile } = useContext(globalContext);
	const {
			brain,
			nowAt,
			data = {},
			superMan,
			inform = [],
			curSelCities = props.cities || [],
			setCurSelCities,
			inMenu,
			isIntroduction,
			isEditing = false,
			isFriendly = false,
			eventCity = null,
		} = props,
		citiesSrc = nowAt === 'setup' ? data.cities || [] : curSelCities || [];

	// EDITOR RESTRICTIONS ------------------------------------------------------------
	const isEditingFriendly = isEditing && isFriendly; // friendly events cannot change city at all
	const hasUserCitySelected = nowAt === 'editor' && data.locaMode === 'city' && brain.user.cities.some(city => city === data.cityID); // user city button selected
	const eventCityObj = eventCity ? brain.cities.find(c => c.cityID === eventCity) : null; // get event's city object for restrictions

	const getLocaInput = (item = data) => {
		if (!item) return '';
		const { city, place, location, is, label, part, hashID } = item;
		if (![city, place, location, label, part].some(Boolean)) return '';
		if (inMenu && brain.user.cities.includes(curSelCities[0]?.cityID || curSelCities[0])) {
			const storedCity = brain.cities.find(c => c.hashID === hashID);
			if (storedCity && brain.user.cities.includes(storedCity.cityID)) return '';
		} else if (nowAt === 'setup') return '';

		let newValue = '';
		if (is === 'city') newValue = `${label ? `${label} ` : ''}${city}${location ? `, ${location}` : ''}`;
		else if (is === 'part') newValue = `${label ? `${label} ` : ''}${part ? `${part}, ` : ''}${city ? `${city}, ` : ''}${location ? `${location}` : ''}`;
		else if (is === 'place') newValue = `${place ? `${place}, ` : ''}${location ? `${location}` : ''} ${label ? `(${label})` : ''}`;
		else newValue = `${place ? `${place}, ` : ''}${location ? `${location}` : ''} ${label ? `(${label})` : ''}`;
		return newValue;
	};

	const [locaInput, setLocaInput] = useState(getLocaInput(curSelCities[0]).trim()),
		[suggestItems, setSuggestItems] = useState([]),
		[showSuggest, setShowSuggest] = useState(false),
		[invertButton, setInvertButton] = useState(null),
		[suggestClicked, invertTimeout, locaInp] = [useRef(), useRef(), useRef()],
		[searchValue, setSearchValue] = useState('');

	const resetSearchState = useCallback(() => {
		setLocaInput('');
		setSearchValue('');
		setSuggestItems([]);
		setShowSuggest(false);
	}, []);

	// SETUP CITIES NORMALIZATION ----------------------------------------------------
	// Setup mode can contain a mix of raw city IDs and city objects (loader vs search results).
	// Normalize + dedupe so "set home" cannot create duplicates and only index 0 is home.
	const normalizeSetupCities = useCallback(
		citiesList => {
			const normalizedCities = [];
			const seenCityKeys = new Set();

			for (const entry of citiesList || []) {
				const cityObj =
					typeof entry === 'number'
						? brain.cities.find(cityCandidate => cityCandidate.cityID === entry)
						: typeof entry === 'string'
						? brain.cities.find(cityCandidate => cityCandidate.hashID === entry) || brain.cities.find(cityCandidate => String(cityCandidate.cityID) === entry)
						: entry && typeof entry === 'object'
						? entry
						: null;

				const cityKey = cityObj?.cityID ?? cityObj?.hashID;
				if (!cityObj || cityKey == null) continue;
				if (seenCityKeys.has(cityKey)) continue;

				seenCityKeys.add(cityKey);
				normalizedCities.push(cityObj);
			}
			return normalizedCities;
		},
		[brain.cities]
	);

	const debouncedSearchValue = useDebounce(searchValue, 500);
	const radCities = useMemo(() => {
		if (nowAt === 'editor' || isIntroduction || brain.user?.cities.length === 1) return {};
		const baseCity = brain.cities.find(city => city.cityID === brain.user.cities[0]);
		if (!baseCity) return {};
		return brain.user.cities
			.slice(1)
			.map(c => brain.cities.find(city => city.cityID === c))
			.filter(Boolean)
			.reduce(
				(acc, city) => {
					const distance = getDistance(baseCity.lat, baseCity.lng, city.lat, city.lng);
					if (distance < 10) acc[10].push(city.cityID);
					else if (distance < 25) acc[25].push(city.cityID);
					else if (distance < 50) acc[50].push(city.cityID);
					return acc;
				},
				{ 0: [brain.user.cities[0]], 10: [], 25: [], 50: [] }
			);
	}, [nowAt, isIntroduction, brain.user?.cities, brain.cities]);

	async function fetchSuggestions(query) {
		try {
			if (!query || query.length < 2) return setSuggestItems([]), setShowSuggest(false);
			// RESTRICT TO SAME CITY FOR RADIUS/EXACT MODES IN EDITOR -----------------------
			const restrictCity = nowAt === 'editor' && ['radius', 'exact'].includes(data.locaMode) ? eventCityObj?.city || data.city?.city || data.city : null;
			const items = await fetchLocationSuggestions(query, { locaMode: data.locaMode, nowAt, inMenu, cities: citiesSrc, restrictCity }, isIntroduction);

			if (items.length > 0) setSuggestItems(items), setShowSuggest(true);
			else setSuggestItems([]), setShowSuggest(false);
		} catch (error) {
			console.error('Error fetching geocode data:', error), setSuggestItems([]), setShowSuggest(false);
		}
	}

	// Use effect to trigger search when debounced value changes
	useLayoutEffect(() => {
		if (debouncedSearchValue) {
			fetchSuggestions(debouncedSearchValue);
		} else {
			setSuggestItems([]);
			setShowSuggest(false);
		}
	}, [debouncedSearchValue]);

	const handleInputChange = e => {
		const value = e.target.value;
		setLocaInput(value);
		setSearchValue(value);
		if (!value.length) resetSearchState();
	};

	useLayoutEffect(() => {
		if (!inMenu && nowAt !== 'setup') {
			man('resetLoca', {});
			resetSearchState();
		}
		const handleEscKey = event => event.key === 'Escape' && setShowSuggest(false);
		window.addEventListener('keydown', handleEscKey);
		return () => {
			window.removeEventListener('keydown', handleEscKey);
		};
	}, [data?.locaMode, inMenu, nowAt, resetSearchState]);

	// ------------------------ keep city name in input when switching to city mode during edit, even if city not in user list
	useLayoutEffect(() => {
		if (nowAt !== 'editor' || data.locaMode !== 'city' || !isEditing) return;
		const existingCity = (typeof data.city === 'object' && data.city) || brain.cities.find(c => c.cityID === data.cityID) || (eventCityObj ? { ...eventCityObj, is: 'city' } : null);
		if (!existingCity || !existingCity.city) return;
		const value = getLocaInput({ is: 'city', ...existingCity });
		if (value && value !== locaInput) setLocaInput(value);
	}, [nowAt, data.locaMode, data.city, data.cityID, eventCityObj, locaInput, isEditing]);

	const man = (inp, val) => {
		if (inMenu) {
			const activateInvert = brain.user.cities.length > 2 && curSelCities.length === brain.user.cities.length;
			if (activateInvert) setInvertButton(val), (invertTimeout.current = setTimeout(() => setInvertButton(null), 2000));
			else if (invertButton === val) clearTimeout(invertTimeout.current), setInvertButton(null);

			setCurSelCities(
				inp === 'defaultCities'
					? brain.user.cities
					: inp === 'selCitiesInRad'
					? !isNaN(val)
						? brain.user.cities.filter(city =>
								Object.keys(radCities)
									.filter(key => key <= val)
									.flatMap(rad => radCities[rad])
									.includes(city)
						  )
						: val === 'Domov'
						? [brain.user.cities[0]]
						: brain.user.cities
					: activateInvert || inp === 'searchedCity'
					? [val]
					: invertButton === val
					? brain.user.cities.filter(city => city !== val)
					: curSelCities.includes(val)
					? curSelCities.filter(city => city != val)
					: [...curSelCities.filter(city => brain.user.cities.includes(city.cityID || city)), val]
			);
		} else if (nowAt === 'editor') superMan(inp, val);
		else if (nowAt !== 'setup' && data.locaMode === 'city' && inp !== 'addCity') superMan('city', val), setShowSuggest(false);
		else {
			const newCities = [
				...(inp === 'delCity'
					? data.cities.filter(city => (city.cityID || city.hashID) !== val)
					: inp === 'setHome'
					? [val, ...data.cities.filter(city => (city.cityID || city.hashID) !== (val.cityID || val.hashID))]
					: inp === 'addCity'
					? (() => {
							const existingCity = citiesSrc.find(city => (city.cityID || city.hashID) === (val.cityID || val.hashID));
							if (existingCity) return citiesSrc;
							else if (citiesSrc.length >= MAX_COUNTS.cities) return citiesSrc;
							else return [...citiesSrc, val];
					  })()
					: inp === 'searchedCity'
					? [val]
					: citiesSrc.includes(val)
					? citiesSrc.filter(city => city !== val)
					: [...citiesSrc, val]),
			];

			superMan('cities', normalizeSetupCities(newCities));
			setShowSuggest(false);
		}
	};

	// Memoize the processed items
	const processedSuggestItems = useMemo(() => processLocationItems(suggestItems), [suggestItems]);
	const city = eventCityObj?.city || data.city?.city || data.city;
	const setupCitiesLimitReached = nowAt === 'setup' && Array.isArray(data.cities) && data.cities.length >= MAX_COUNTS.cities;
	function inputPlaceholder() {
		if (nowAt === 'setup' && isIntroduction) return 'vyhledej města pro odběr událostí (začni domovským) ...';
		else if (nowAt === 'setup' && !isIntroduction) return 'vyhledej města pro odběr událostí ...';
		else if (data?.locaMode === 'city') return 'vyhledej město a nebo níže vyber ...';
		else if (data?.locaMode === 'radius') return city ? `vyhledej střed oblasti v ${city} ...` : 'vyhledej střed oblasti (ulice, adresa, podnik ...)';
		else if (data?.locaMode === 'exact') return city ? `vyhledej místo v ${city} ...` : 'vyhledej přesné místo (adresa, podnik ...)';
		else if (inMenu) return 'Vyhledej konkrétní město a nebo níže povybírej ...';
		else if (!brain.user.id) return 'Chceš přesné výpočty? Zadej i adresu (klidně přibližnou)...';
		else if (!data.cities?.length) return 'vyhledej město či adresu ...';
		else if (citiesSrc.length >= 3) return 'Pro hledání odeber některé město ...';
		else return `Vyhledej si další města ke sledování ...`;
	}

	// DETERMINE IF SEARCH SHOULD BE HIDDEN/DISABLED ----------------------------------
	const hideSearch = isEditingFriendly && data.locaMode === 'city' && brain.user.cities.some(city => city === data.cityID);
	const disableSearch = setupCitiesLimitReached || (nowAt === 'editor' && data.locaMode === 'city' && isEditing && !hasUserCitySelected && (data.cityID || data.city));

	// Handle focus event
	const handleInputFocus = () => {
		if (locaInput?.trim().length && suggestItems.length > 0) setShowSuggest(true);
	};

	// Handle input blur
	const handleInputBlur = () => {
		setTimeout(() => {
			if (isIntroduction || inMenu) return;
			if (!suggestClicked.current) resetSearchState();
			else suggestClicked.current = false;
		}, 600); // Increased timeout to prevent race condition with click event on mobile/slow devices
	};

	// Handle suggestion item click
	const handleSuggestionClick = item => {
		suggestClicked.current = true;
		setShowSuggest(false);
		setSuggestItems([]);
		setSearchValue('');
		setLocaInput(getLocaInput(item));

		if (isIntroduction) {
			const newCities = [...(data.cities || [])];
			if (newCities.length >= MAX_COUNTS.cities) return;
			if (!newCities.some(city => city.hashID === item.hashID)) {
				newCities.push(item);
				superMan('cities', newCities);
			}
		} else {
			const existingCity = brain.cities.find(c => c.hashID === item.hashID);
			man(nowAt === 'editor' ? 'location' : nowAt === 'setup' ? 'addCity' : 'searchedCity', existingCity || item);
		}
		// REFOCUS SEARCH INPUT AFTER SELECTION ---
		if (nowAt !== 'editor') setTimeout(() => locaInp.current?.focus(), 50);
	};

	const suggestionsRef = useRef(null);
	const [numOfCols] = useMasonResize({
		wrapper: suggestionsRef,
		brain,
		contType: 'userStrips',
		deps: [suggestItems.length],
		contLength: suggestItems.length,
	});

	// Process suggestions into card format for Masonry
	const suggestionCards = useMemo(() => {
		return processedSuggestItems.map((item, index) => {
			const { city, place, hashID, label, location, part } = item;
			const isCurCity = curSelCities.length === 1 && (curSelCities[0]?.hashID === hashID || brain.cities.find(c => c.cityID === curSelCities[0].cityID)?.hashID === hashID);

			return (
				<sugg-card
					key={hashID}
					onClick={() => handleSuggestionClick(item)}
					class={`${isCurCity ? 'bInsetBlue' : ''} 
					flexRow aliStart justCen gapS bHover shaComment pointer block 
					padHorS padVerXs boRadS shaCon w100
					`}>
					<icon-wrapper class='flexRow gapXs aliCen justCen padTopXxxs'>
						<img src={`/icons/${item.is === 'city' ? 'home' : item.is === 'place' ? 'premise' : 'location'}.png`} className='mw5 aspect1610 ' alt='' />
						<texts-part class='flexCol noPoint textLeft marTopXs w100 h100'>
							<span className='fs11 inline marBotXxxs boldS'>{place || `${part || city}`}</span>
							<span className='fs7 textLeft'>
								{location}
								{label && <span className='tGrey'> ({label})</span>}
							</span>
						</texts-part>
					</icon-wrapper>
				</sugg-card>
			);
		});
	}, [processedSuggestItems, curSelCities]);

	return (
		<location-strip ref={suggestionsRef} class={` posRel   flexCol block w100`}>
			{nowAt === 'setup' && (
				<title-texts>
					{/* SECTION DESCRIPTION (EXISTING USERS ONLY) --- */}
					{data.id && (
						<>
							<span className='xBold marBotXxs inlineBlock fs15'>Sledované lokality</span>
							<p className='fs8 marBotXs mw160 lh1 marAuto'>
								Vyber si města, do nichž jsi ochotný cestovat za událostmi a za lidmi. Z těchto měst se ti bude automaticky načítat veškerý obsah.
							</p>
						</>
					)}
				</title-texts>
			)}
			{/* LIMIT WARNING (ALL USERS) --- */}
			{setupCitiesLimitReached && (
				<span className='fs16 tRed xBold textSha marBotXs block'>
					Dosažen limit: {MAX_COUNTS.cities}/{MAX_COUNTS.cities}
				</span>
			)}

			{/* LOCATION INPUT ------------------------------------------------------------------------ */}
			{(inMenu || citiesSrc.length < 10) && !hideSearch && (
				<input
					value={locaInput}
					disabled={disableSearch}
					autoFocus={(nowAt === 'home' && !isMobile) || (nowAt === 'editor' && !data.city && !data.cityID)}
					onKeyDown={e => e.key === 'Enter' && locaInp.current.blur()}
					onBlur={handleInputBlur}
					onChange={handleInputChange}
					onFocus={handleInputFocus}
					className={`${inform.includes('noCity') ? 'borderRed' : 'shaBlue '}  ${(inMenu && locaInput) || isIntroduction ? 'boldXs fs18 mw160' : 'fs16'} ${
						disableSearch ? '' : ''
					} hvw3 mih5  textAli w100 marAuto borderBot boldXs phLight`}
					placeholder={inputPlaceholder()}
					type='text'
					ref={locaInp}
				/>
			)}

			{inform.includes('noCity') && !isIntroduction && <span className='tRed fs12 block marTopXs xBold'>Přidej si alespoň 1 město (domovské)</span>}

			{/* SEARCH RESULTS --------------------------------------------------------------------------------- */}
			{showSuggest && suggestItems.length > 0 && (
				<suggest-items class=' padBotXs mhvh33 block overAuto bgWhite'>
					<Masonry
						content={suggestionCards}
						config={{
							contType: 'locaStrips',
							numOfCols: Math.min(4, Math.max(1, numOfCols)), // Min 1 column, max 4 columns
							noPadTop: true,
						}}
						brain={brain}
					/>
				</suggest-items>
			)}

			{/* CITIES WRAPPER ---------------------------------------------------------------------------- */}
			{(nowAt !== 'editor' || (data.locaMode === 'city' && (!isEditing || (isEditing && brain.user.cities.some(city => city === data.cityID))))) && !showSuggest && (
				<cities-wrapper class={`flexCen wrap marTopXs w100 gapXxs  posRel   marAuto  `}>
					{(isIntroduction ? data.cities || [] : nowAt === 'setup' ? data.cities || [] : brain.user.cities).map((city, i) => {
						city = brain.cities.find(c => c.cityID === city) || city;

						const id = city?.cityID ?? city?.hashID;
						const isHomeCity = nowAt === 'setup' && i === 0;
						const isSelected = (data.hashID || data.cityID) === id;
						const isDisabled = nowAt === 'editor' && isEditingFriendly && !isSelected; // disable for: friendly edit OR new event with city locked

						return (
							<city-button
								key={id}
								onClick={() => {
									if (isDisabled) return; // prevent click on disabled buttons
									resetSearchState();
									if (inMenu && brain.user.cities.length === 1 && curSelCities.includes(id)) return;
									if (isIntroduction) {
										const newCities = data.cities.filter(c => (c.hashID || c.cityID) !== (city.hashID || city.cityID));
										superMan('cities', newCities);
									} else man(nowAt === 'setup' ? 'delCity' : nowAt === 'editor' ? 'cityID' : 'selCity', id);
								}}
								class={`${isDisabled && !isSelected ? 'opacityXs' : 'bHover'} ${
									invertButton === id || isIntroduction || curSelCities.includes(id) || isSelected ? 'xBold bInsetBluTopS ' : ''
								} ${`${
									nowAt === 'editor' ? (isSelected ? 'bInsetBlueTop  borTop textSha boRadS  xBold fs14' : '  fs14 xBold') : inMenu ? '  boldM fs15  ' : '  bold fs13'
								}  posRel miw16  `}  
								  ${inMenu && curSelCities.includes(id) ? 'bInsetBlueTopS borTop xBold' : ''}
								 
								 ${nowAt === 'setup' ? 'textLeft' : ''} shaLight padVerXs   flexCen bgTrans       `}>
								{nowAt === 'setup' && (
									<button
										title='Domovské město'
										type='button'
										onClick={e => {
											e.stopPropagation();
											if (isIntroduction) {
												const newCities = [...data.cities];
												const clickedCity = city;
												const filteredCities = newCities.filter(c => (c.hashID || c.cityID) !== (clickedCity.hashID || clickedCity.cityID));
												superMan('cities', normalizeSetupCities([city, ...filteredCities]));
											} else {
												const newCities = [...data.cities];
												const clickedCity = city;
												const filteredCities = newCities.filter(c => (c.cityID || c.hashID) !== (clickedCity.cityID || clickedCity.hashID));
												superMan('cities', normalizeSetupCities([city, ...filteredCities]));
											}
										}}
										className='padHorS  border bgTrans marRigS w14  mw8 padVerXxxs  bHover boRadS  h100 shaLight'>
										<img src={`/icons/home.png`} className={`${!isHomeCity ? 'desaturated' : ''} mw3 `} alt='' />
									</button>
								)}
								{inMenu && invertButton === id ? 'invertovat?' : city.city}
							</city-button>
						);
					})}
				</cities-wrapper>
			)}

			{/* SAME CITY WARNING FOR RADIUS/EXACT MODES ------------------------------------------- */}
			{nowAt === 'editor' && isEditing && isFriendly && (eventCityObj || data.city) && (
				<span className='tRed fs9 borderRed wAuto inlineBlock  marAuto padBotXxs marTopS  xBold block marBotXs textAli'>
					{data.locaMode === 'city' ? 'POZOR! Město nelze u přátelských setkání měnit!' : 'POZOR: Místo musí být v původním městě:'}{' '}
					{data.locaMode === 'city' ? '' : eventCityObj?.city || data.city?.city || data.city}
				</span>
			)}

			{/* QUICK SELECTION BUTTONS -------------------------------------------------------------------- */}
			{inMenu && brain.user.cities.length > 1 && (
				<quick-sel className='flexCen  growAll marTopS   posRel posRel  boRadXs  wAuto    marBotL marAuto'>
					{['Domov', 10, 25, 50, 'Všechny']
						.filter(button => {
							return button === 'Domov'
								? !curSelCities.includes(brain.user.cities[0]) || curSelCities.length > 1
								: button === 'Všechny'
								? curSelCities.length !== brain.user.cities.length
								: radCities[button]?.length &&
								  !areEqual(
										curSelCities.map(city => city.cityID || city).sort((a, b) => a - b),
										radCities[button].sort((a, b) => a - b)
								  );
						})
						.map((button, _, arr) => (
							<button
								key={button}
								onClick={() => {
									resetSearchState();
									man('selCitiesInRad', button);
								}}
								style={{ width: `calc(100%/${arr.length})px` }}
								className='grow bgTrans fs7  bInsetBlueTopXs bInsetBlueTopXs padVerXxxs  xBold posRel mw30  shaBlue tDarkBlue  boRadXs    borBotLight  bHover '>
								{button}
								{typeof button === 'number' ? ' km' : ''}
							</button>
						))}
				</quick-sel>
			)}
			{nowAt === 'setup' && citiesSrc.length >= 10 && (
				<>
					<blue-divider class={` hr0-5 borTop block   borTop bgTrans  w100    marAuto   `} />
					<span className={` boRadXxs boldS bBlue  tWhite tSha10  posRel inlineBlock bInsetBlueTopXl    borTop2   mw140   zinMax  fPadHorXs padVerXxs  w100    marAuto    fs8 bgWhite`}>
						{`Zásobník je plný. Pro změnu odeber nějaké město ...`}
					</span>
				</>
			)}
		</location-strip>
	);
}

export default LocationPicker;
