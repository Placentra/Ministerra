import { useState, useRef, useEffect, memo } from 'react';
import { humanizeDateTime } from '../../helpers';
import useCentralFlex from '../hooks/useCentralFlex';

const monthNames = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const weekDays = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

// HELPERS ---
const isSameDate = (date1, date2) => date1?.toDateString() === date2?.toDateString();

// DATE TIME PICKER COMPONENT ---
// Provides a comprehensive interface for selecting dates, times, and ranges
const DateTimePicker = props => {
	const [nowDate, { mode, starts, ends, superMan, prop, maxDate, noAutoHide, type }] = [new Date(), props],
		[dateMode, setDateMode] = useState(starts ? null : prop ? null : 'starts'),
		[hoursMode, setHoursMode] = useState(nowDate.getHours() >= 12 ? 'odpoledne' : 'dopoledne'),
		[scrollTarget, fullDate, startOnly, noTime, noAmPm] = [useRef(), ['birth'].includes(prop), ['meetWhen'].includes(prop), ['birth'].includes(prop), ['meetWhen'].includes(prop)],
		// INPUT NORMALIZATION ------------------------------------------------
		// Accept Date OR ms timestamps from app state (numbers only).
		startsDate = starts instanceof Date ? starts : typeof starts === 'number' ? new Date(starts) : null,
		endsDate = ends instanceof Date ? ends : typeof ends === 'number' ? new Date(ends) : null,
		maxDateDate = maxDate instanceof Date ? maxDate : typeof maxDate === 'number' ? new Date(maxDate) : null,
		dateSrc = dateMode === 'ends' ? endsDate || (startsDate ? new Date(startsDate.getFullYear(), startsDate.getMonth(), startsDate.getDate(), startsDate.getHours()) : null) : startsDate;

	// TIME PORTIONS STATE ---
	// Manages individual components of the date and time selection
	const [timePortions, setTimePortions] = useState({
			year: !fullDate && (maxDateDate || nowDate).getFullYear(),
			month: mode === 'week' ? (maxDateDate || nowDate).getMonth() : null,
			day: mode === 'week' ? (maxDateDate || nowDate).getDate() : null,
			...(!noTime && {
				hour: null,
				min: null,
			}),
		}),
		// DESTRUCTURED TIME UNITS ---
		[year, month, day, hour, min] = dateSrc ? [dateSrc.getFullYear(), dateSrc.getMonth(), dateSrc.getDate(), dateSrc.getHours(), dateSrc.getMinutes()] : (Object.values(timePortions) as any[]),
		// DECADE AND CALENDAR STATE ---
		[selDecade, setSelDecade] = useState(year ? Math.floor(year / 10) * 10 : null),
		[showAllDecades, setShowAllDecades] = useState(Boolean(!year)),
		[currentHour, curYear, curMonth, isToday, isStarts] = [
			nowDate.getHours(),
			nowDate.getFullYear(),
			nowDate.getMonth(),
			isSameDate(dateSrc || new Date(year, month, day), nowDate),
			!dateMode || dateMode === 'starts',
		];

	// PORTION VALIDITY CHECK ---
	// Returns true if the given portion value is valid within the proposed context
	function isPortionValid(key: string, value: number | null, proposed: Record<string, number | null>): boolean {
		if (value === null) return true;
		const now = new Date(),
			curY = now.getFullYear(),
			curM = now.getMonth(),
			curD = now.getDate(),
			curH = now.getHours(),
			curMin = now.getMinutes();

		switch (key) {
			case 'month': {
				if (fullDate) return proposed.year === curY - 13 ? value <= now.getMonth() : true;
				const proposedDate = new Date(proposed.year!, value);
				if (proposed.year === curY + 2 && value > curM) return false;
				if (maxDateDate && proposedDate > new Date(maxDateDate.getFullYear(), maxDateDate.getMonth())) return false;
				if (startsDate && !isStarts) return proposedDate >= new Date(startsDate.getFullYear(), startsDate.getMonth());
				return proposedDate.getTime() >= new Date().setMonth(curM - 1);
			}
			case 'day': {
				const daysInMonth = new Date(proposed.year!, proposed.month! + 1, 0).getDate();
				if (value > daysInMonth) return false;
				if (fullDate) return proposed.year === curY - 13 && proposed.month === now.getMonth() ? value <= curD : true;
				const proposedTs = new Date(proposed.year!, proposed.month!, value).setHours(0, 0, 0, 0);
				if (proposed.year === curY + 2 && proposed.month === curM && value > curD) return false;
				return starts && !isStarts ? proposedTs >= new Date(starts as any).setHours(0, 0, 0, 0) : proposedTs >= new Date().setHours(0, 0, 0, 0);
			}
			case 'hour': {
				const proposedSrc = new Date(proposed.year!, proposed.month!, proposed.day!);
				if (maxDateDate && isSameDate(proposedSrc, maxDateDate)) return value <= maxDateDate.getHours();
				// ENDS HOUR VALIDATION WITH MINUTE AWARENESS ---
				// When on same day as starts, hour must have at least one valid minute slot
				if (startsDate && !isStarts && !prop && isSameDate(proposedSrc, startsDate)) {
					if (value < startsDate.getHours()) return false;
					if (value === startsDate.getHours()) return startsDate.getMinutes() < 45;
					return true;
				}
				if (isStarts && endsDate && isSameDate(proposedSrc, endsDate)) return value <= endsDate.getHours();
				const proposedIsToday = isSameDate(proposedSrc, now);
				return proposedIsToday && isStarts ? (value === curH ? curMin < 45 : value >= curH) : true;
			}
			case 'min': {
				const proposedSrc = new Date(proposed.year!, proposed.month!, proposed.day!, proposed.hour!);
				if (prop === 'meetWhen' && maxDateDate && isSameDate(new Date(proposed.year!, proposed.month!, proposed.day!), maxDateDate)) {
					const meetTime = new Date(proposed.year!, proposed.month!, proposed.day!, proposed.hour!, value).getTime();
					return meetTime <= maxDateDate.getTime() - 15 * 60 * 1000;
				}
				if (maxDateDate && isSameDate(proposedSrc, maxDateDate) && proposed.hour === maxDateDate.getHours()) return value <= maxDateDate.getMinutes() - 15;
				if (startsDate && !isStarts && !prop && isSameDate(proposedSrc, startsDate) && proposed.hour === startsDate.getHours()) return value > startsDate.getMinutes();
				const proposedIsToday = isSameDate(new Date(proposed.year!, proposed.month!, proposed.day!), now);
				return proposedIsToday && isStarts && proposed.hour === curH ? value >= curMin : true;
			}
		}
		return true;
	}

	// CASCADE INVALIDATION ---
	// Validates proposed portions and clears from first invalid portion onwards
	function cascadeInvalidatePortions(proposed: Record<string, number | null>, changedKey: string): Record<string, number | null> {
		const order = noTime ? ['year', 'month', 'day'] : ['year', 'month', 'day', 'hour', 'min'],
			changedIndex = order.indexOf(changedKey);
		let shouldClear = false;

		for (let i = changedIndex + 1; i < order.length; i++) {
			const key = order[i];
			if (shouldClear) {
				proposed[key] = null;
				continue;
			}
			if (proposed[key] === null) continue;
			if (!isPortionValid(key, proposed[key], proposed)) {
				proposed[key] = null;
				shouldClear = true;
			}
		}
		return proposed;
	}

	// SELECTION HANDLER LOGIC ---
	// Processes updates to year, month, day, or time and synchronizes with parent state
	function handlePickerChange(inp, val) {
		if (inp === 'decade') {
			setTimePortions({ year: null, month: null, day: null, ...(noTime ? {} : { hour: null, min: null }) });
			return superMan(dateMode, null);
		}

		// SOURCE PORTIONS BUILD ---
		// Use dateSrc values when editing existing date, otherwise use timePortions
		const srcPortions = dateSrc
			? { year: dateSrc.getFullYear(), month: dateSrc.getMonth(), day: dateSrc.getDate(), ...(noTime ? {} : { hour: dateSrc.getHours(), min: dateSrc.getMinutes() }) }
			: timePortions;

		// PROPOSED PORTIONS BUILD ---
		// Merge new value into source portions, then cascade invalidate
		const proposed = cascadeInvalidatePortions({ ...srcPortions, [inp]: val }, inp),
			[uYear, uMonth, uDay, uHour, uMin] = [proposed.year, proposed.month, proposed.day, proposed.hour, proposed.min];

		// CASCADE TRIGGERED CLEAR (EXISTING DATE) ---
		// If editing existing date and cascade nulled any portion, clear stored date and switch to partial mode
		if (dateSrc && (uMonth === null || uDay === null || (!noTime && (uHour === null || uMin === null)))) {
			superMan(dateMode, null);
			return setTimePortions(proposed);
		}

		// INCOMPLETE SELECTION (NEW DATE) ---
		// If building new date and required portions missing, stay in partial mode
		if (prop !== 'birth' && (uMonth === null || uDay === null)) {
			superMan(dateMode, null);
			return setTimePortions(proposed);
		}

		const portions = { ...proposed, ...(['hour', 'min'].includes(inp) ? { [inp]: val } : {}) } as Record<string, number | null>;
		const newDate = new (Date as any)(portions.year, portions.month, portions.day, portions.hour || 0, portions.min || 0);

		if (Object.values(portions).includes(null)) return setTimePortions(portions);

		superMan(prop || dateMode, newDate);

		// PICKER CLOSURE GATE ---
		// Only close picker when user completes the final step (minutes selection)
		if (inp === 'min') setDateMode(null);

		if (dateMode === 'starts' && ends && newDate.getTime() > (ends instanceof Date ? ends.getTime() : Number(ends))) superMan('ends', null);
	}

	// GET NEXT DAYS -------------------------------------------------------
	function getWeekDays() {
		const numDays = prop === 'meetWhen' ? 2 : 7;
		const startDate = maxDateDate ? new Date(maxDateDate) : new Date();
		if (maxDate) startDate.setDate(startDate.getDate() - numDays + 1);

		return Array.from({ length: numDays }, (_, i) => {
			const date = new Date(startDate);
			date.setDate(startDate.getDate() + i);
			const label = i === 0 ? (prop === 'meetWhen' ? 'den předem' : 'Dnes') : i === 1 ? (prop === 'meetWhen' ? 'stejný den' : 'Zítra') : weekDays[(date.getDay() + 6) % 7];
			return { label, date };
		});
	}
	// INIT AUTO-SCSROLL------------------------------------------------
	useEffect(() => {
		if (mode !== 'week') scrollTarget.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
	}, []);

	// PROGRESSIVE BOTTOM SCROLL ------------------------------------------------
	useEffect(() => {
		if (!dateSrc && mode !== 'week' && !fullDate) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
	}, [timePortions]);

	// FILTERS FOR BUTTONS ------------------------------------------------
	const yearsFilter = y => {
		if (startsDate && !isStarts && y < startsDate.getFullYear()) return false;
		if (maxDateDate && y > maxDateDate.getFullYear()) return false;
		return fullDate ? y >= nowDate.getFullYear() - 100 && y <= nowDate.getFullYear() - 13 : true;
	};

	const monthsFilter = m => {
		if (fullDate) return year === nowDate.getFullYear() - 13 ? m <= nowDate.getMonth() : true;
		const d = new Date(year, m);
		if (year === curYear + 2 && m > curMonth) return false;
		if (maxDateDate && d > new Date(maxDateDate.getFullYear(), maxDateDate.getMonth())) return false;
		if (startsDate && !isStarts) return d >= new Date(startsDate.getFullYear(), startsDate.getMonth());
		return d.getTime() >= new Date().setMonth(new Date().getMonth() - 1);
	};

	const hoursFilter = h => {
		// AFTERNOON FORCE ---
		// When AM/PM picker is hidden (afternoon today), always use afternoon hours regardless of hoursMode state
		const forceAfternoon = isToday && currentHour >= 12 && !noAmPm;
		const adj = noAmPm ? h : forceAfternoon || hoursMode === 'odpoledne' ? h + 12 : h;
		const src = dateSrc || new Date(year, month, day);
		if (maxDateDate && isSameDate(src, maxDateDate)) return adj <= maxDateDate.getHours();
		// ENDS HOUR FILTER WITH MINUTE AWARENESS ---
		// When on same day as starts, hour must have at least one valid minute slot (need > startsMinute)
		if (startsDate && !isStarts && !prop && isSameDate(src, startsDate)) {
			if (adj < startsDate.getHours()) return false;
			if (adj === startsDate.getHours()) return startsDate.getMinutes() < 45;
			return true;
		}
		if (isStarts && endsDate && isSameDate(src, endsDate)) return adj <= endsDate.getHours();
		return isToday && isStarts ? (adj === currentHour ? new Date().getMinutes() < 45 : adj >= currentHour) : true;
	};

	const minutesFilter = m => {
		const src = dateSrc || new Date(year, month, day, hour);
		// MEET WHEN MINUTE FILTER ---
		// Compare full timestamps to handle hour boundaries correctly; ensure at least 15 min buffer before event
		if (prop === 'meetWhen' && maxDateDate && isSameDate(new Date(year, month, day), maxDateDate)) {
			const meetTime = new Date(year, month, day, hour, m).getTime(),
				bufferMs = 15 * 60 * 1000;
			return meetTime <= maxDateDate.getTime() - bufferMs;
		}
		if (maxDateDate && isSameDate(src, maxDateDate) && hour === maxDateDate.getHours()) return m <= maxDateDate.getMinutes() - 15;
		// ENDS PICKER MINUTE FILTER ---
		// Skip for meetWhen since startsDate IS the value being edited, not a range boundary
		if (startsDate && !isStarts && !prop && isSameDate(src, startsDate) && hour === startsDate.getHours()) return m > startsDate.getMinutes();
		const currentMin = nowDate.getMinutes();
		return isToday && isStarts && hour === currentHour ? m >= currentMin : true;
	};

	// WIDTHS FOR BUTTONS ---------------------------------------------
	const decadeWidth = useCentralFlex('decades', [showAllDecades], null, Array.from({ length: 10 }, (_, i) => 1920 + i * 10).length);
	const monthsWidth = useCentralFlex('months', [year, dateMode], null, Array.from({ length: 12 }, (_, i) => i).filter(monthsFilter).length);
	const daysWidth = useCentralFlex('days', [month, dateMode], null, 7);
	const hoursWidth = useCentralFlex('hours', [day, hoursMode], null, Array.from({ length: noAmPm ? 24 : 12 }, (_, i) => i).filter(hoursFilter).length);
	const minutesWidth = useCentralFlex('minutes', [hour, dateMode], null, Array.from({ length: 4 }, (_, i) => i * 15).filter(minutesFilter).length);

	// DAY SELECTION GENERATION ------------------------------------------------
	const calendarDays = (() => {
		if (month === null || !year) return [];
		const days = Array.from({ length: 31 }, (_, i) => new Date(year, month, i + 1))
			.filter(d => d.getMonth() === month)
			.map(d => ({ day: d.getDate() }))
			.filter(({ day }) => {
				if (fullDate) return year === nowDate.getFullYear() - 13 && month === nowDate.getMonth() ? day <= nowDate.getDate() : true;
				const d = new Date(year, month, day).setHours(0, 0, 0, 0);
				if (year === curYear + 2 && curMonth === month && day > nowDate.getDate()) return false;
				return starts && !isStarts ? d >= new Date(starts).setHours(0, 0, 0, 0) : d >= new Date().setHours(0, 0, 0, 0);
			});
		const first = new Date(year, month, 1).getDay();
		return [...Array.from({ length: days.length ? (first === 0 ? 6 : first - 1) : 0 }, () => ({ day: null })), ...days];
	})();

	return (
		<date-time ref={scrollTarget} class={` flexCen  w100 mw180  textAli zinMaXl  posRel marAuto wrap`}>
			{/* DATE MODE CONTROLS --- */}
			{/* Provides toggles between selecting start and end times for events */}
			{(starts || prop === 'meetWhen') && (mode !== 'week' || (prop === 'meetWhen' && dateMode !== prop)) && !noAutoHide && (
				<starts-ends class={`flexCen aliStretch w100 boRadXs textAli  posRel        marAuto  `}>
					{['starts', 'ends']
						.filter(field => field === 'starts' || (starts && !startOnly))
						.map(field => {
							const startsInPast = !maxDate && field === 'starts' && starts < nowDate;
							const endsBeforeStart = !dateMode && field === 'ends' && ends && new Date(ends) < new Date(starts);
							return (
								<button
									key={field}
									className={`${mode === 'week' ? ' mw80 borBot2 sideBors  ' : ''} ${
										prop === 'meetWhen' ? 'padTopS padBotS bw50' : mode !== 'week' ? ' padTopM padBotM bw50' : 'padVerS padTopM padBotS bw100'
									} h100 ${field === dateMode ? 'arrowDown ' : ''}  textSha posRel bHover   posRel grow padHorS`}
									onClick={() => (setDateMode(prop ? (dateMode === prop ? null : prop) : dateMode === field ? null : field), setHoursMode(hour >= 12 ? 'odpoledne' : 'dopoledne'))}>
									{/* SELECTION STATUS LABEL --- */}
									{/* Displays humanized date or validation warnings for the current field */}
									{field === dateMode && <blue-divider class='hr1   block  bInsetBlueTopXl  posAbs botCen bgTrans w100 marAuto' />}

									<texts-wrapper class='flexCol w100 selfCen'>
										<span
											className={`${
												startsInPast || endsBeforeStart
													? 'bRed fs14 bold tWhite'
													: prop === 'meetWhen'
													? 'fs20 xBold'
													: field === dateMode
													? 'fs30   xBold '
													: mode !== 'week'
													? 'boldM fs30'
													: 'xBold tBlue  fs10'
											} lh1 `}>
											{startsInPast
												? 'Začátek je v minulosti!'
												: endsBeforeStart
												? 'Začátek je před koncem!'
												: field === 'starts' && !starts
												? prop === 'meetWhen'
													? 'Vybrat čas srazu'
													: 'Zvol datum a čas'
												: field === 'ends' && !ends
												? 'Zadat konec'
												: field === 'starts' && starts
												? `${prop === 'meetWhen' ? `Sraz ${isSameDate(new Date(starts), maxDateDate) ? 'stejný den v' : 'den předem v'} ` : ''} ${
														humanizeDateTime({ dateInMs: starts, timeOnly: prop === 'meetWhen' }) || ''
												  }`
												: field === 'ends' && ends
												? `${humanizeDateTime({ dateInMs: ends }) || ''}`
												: ''}
										</span>
										{/* SUB-INSTRUCTIONS --- */}
										{/* Contextual guidance for date/time selection requirements */}
										{Boolean(field !== 'ends' || !ends) && mode !== 'week' && !startsInPast && !endsBeforeStart && (
											<span
												className={` fs14	 w100 ${
													dateMode === field ? ((field === 'starts' && !starts) || (field === 'ends' && !ends) ? 'tRed xBold' : 'tGreen xBold') : 'tBlue'
												}  noPoint  `}>
												{dateMode === field
													? (field === 'starts' && !starts) || (field === 'ends' && !ends)
														? 'skrýt datumář'
														: `potvrdit čas ${field === 'starts' ? 'začátku' : 'konce'}`
													: field === 'starts'
													? starts
														? prop === 'meetWhen'
															? 'změnit čas'
															: 'změnit začátek'
														: prop === 'meetWhen'
														? 'nepovinné'
														: 'začátek povinný'
													: field === 'ends'
													? ends
														? 'změnit konec'
														: 'konec nepovinný'
													: ''}
											</span>
										)}
										{field === 'ends' && ends && (
											<button
												onClick={e => (e.stopPropagation(), superMan('ends', null), setDateMode(null))}
												className={` zinMaXl tRed xBold hover  padVerXxs  mw20 borderLight  borderBot marAuto fs12 borderLight`}>
												smazat konec
											</button>
										)}
									</texts-wrapper>
								</button>
							);
						})}
					{!startOnly && (
						<img className={'posAbs   zinMax mw20 bgTrans shaCon boRadXs zin2500  padAllS w14 upTiny miw10'} src={type ? `/icons/types/${type}.png` : '/icons/dateTime.png'} alt='' />
					)}
				</starts-ends>
			)}

			{/* CALENDAR PICKER SECTION --- */}
			{/* Renders interactive year, month, and day grids for precise date selection */}
			{dateMode && (
				<date-picker class={`${dateSrc && mode !== 'week' ? 'marTopS' : ''} w100`}>
					{mode !== 'week' && (
						<year-month class='w100 marAuto posRel aliStretch flexCol'>
							{/* DECADE SELECTION GRID --- */}
							{/* Optimizes navigation through long timeframes like birth dates */}
							{fullDate && (
								<decade-picker class='w100  zinMax    marAuto wrap bPadS flexCen'>
									{Array.from({ length: selDecade && !showAllDecades ? 1 : 10 }, (_, i) => (selDecade && !showAllDecades ? selDecade : 1920 + i * 10)).map(d => (
										<button
											key={d}
											style={{ width: '100%', maxWidth: selDecade && !showAllDecades ? '800px' : decadeWidth ? `${decadeWidth}px` : undefined }}
											className={`${d === selDecade ? `borBotLight  arrowDown1 posRel fs20 flexRow  zinMax  xBold textSha` : 'xBold fs16'} grow`}
											onClick={() => {
												if (selDecade && !showAllDecades && year) handlePickerChange('year', null);
												else if (!showAllDecades) {
													setShowAllDecades(true);
													setSelDecade(null);
												} else {
													setSelDecade(d);
													setShowAllDecades(false);
												}
											}}>
											{selDecade && !showAllDecades ? (year ? `Ročník ${year}` : `${d} - ${d + 9}`) : `${d}+`}
										</button>
									))}
								</decade-picker>
							)}

							{/* YEAR SELECTION GRID --- */}
							{/* Displays individual years within a decade or near future */}
							{((selDecade && (showAllDecades || (!dateSrc && !year))) || !fullDate) && (
								<year-picker class='flexCen marAuto posRel borderBot bPadVerM  bInsetBlueTopXs posRel    aliStretch w100'>
									{(fullDate && selDecade ? Array.from({ length: 10 }, (_, i) => selDecade + i) : Array.from({ length: 3 }, (_, i) => nowDate.getFullYear() + i))
										.filter(yearsFilter)
										.map(b => (
											<button
												key={b}
												className={` grow bHover ${b === year ? ' bBor2  tDarkBlue  fs22 boRadXxs posRel bgTrans xBold' : 'shaBlueLight fs16 boldXs noBackground'}`}
												onClick={() => handlePickerChange('year', b)}>
												{b}
											</button>
										))}
								</year-picker>
							)}

							{/* MONTH SELECTION GRID --- */}
							{/* Interactive month list filtered by logical date constraints */}
							{year && !showAllDecades && (
								<month-picker class={'flexCen   marAuto  marBotM  bPadVerS wrap w100'}>
									{Array.from({ length: 12 }, (_, i) => i)
										.filter(monthsFilter)
										.map(b => (
											<button
												style={{ width: '100%', ...(monthsWidth && { maxWidth: `${Math.min(400, monthsWidth)}px` }) }}
												className={`${b === month ? 'bBlue  tSha10 tWhite fs17 posRel   xBold' : 'fs12 boldXs textSha shaBlue '}  shaBlue   bHover `}
												key={b}
												onClick={() => handlePickerChange('month', b)}>
												{monthNames[b]}
											</button>
										))}
								</month-picker>
							)}
						</year-month>
					)}

					{/* DAY SELECTION GRID --- */}
					{/* Standard monthly calendar view with automatic weekday alignment */}
					{month !== null && year && mode !== 'week' && !showAllDecades && (
						<day-picker class=' posRel w100  posRel  marAuto marBotXl flexRow wrap'>
							{/* WEEKDAY COLUMN LABELS --- */}
							{!fullDate && (
								<weekdays-labels class={'  flexCen w100 '}>
									{weekDays.map((day, i) => (
										<div key={i} className='w15 xBold fs13 tDarkBlue posRel padVerXxs'>
											{day}
										</div>
									))}
								</weekdays-labels>
							)}

							{/* DYNAMIC DAY BUTTONS --- */}
							{/* Computes padding for weekday alignment and renders interactive day cells */}
							<day-buttons class='w100  posRel thickBors marAuto  flexRow wrap'>
								{calendarDays.map(({ day: b }, i) => (
									<button
										key={`${month}_${i}`}
										style={{ width: '100%', maxWidth: `${daysWidth - 1}px` }}
										className={` ${
											b === null ? 'bGlasSubtle' : b === day ? 'tDarkBlue fs12 borRed thickBors boRadXs bInsetBlueTop posRel xBold' : 'shaBlue boldXs fs8 bgWhite'
										} borBotLight mih3 bHover`}
										onClick={() => b !== null && handlePickerChange('day', b)}>
										{b ?? ''}
										{b && b === day ? '.' : ''}
									</button>
								))}
							</day-buttons>
						</day-picker>
					)}

					{/* QUICK WEEK SELECTION --- */}
					{/* Simplified view for selecting days within the current relative week */}
					{mode === 'week' && (
						<weekdays-picker className={`${prop === 'meetWhen' ? 'bPadVerS bmw50' : 'bPadVerM'} w100   thickBors aliEnd flexCen`}>
							{getWeekDays().map(({ label, date }, i) => (
								<button
									style={{ width: '100%', ...(daysWidth && { maxWidth: `${daysWidth}px` }) }}
									key={i}
									className={`grow    padVerXs ${!day ? 'xBold' : date.getDate() !== day ? 'boldM' : 'xBold'} ${
										date.getDate() === day
											? prop === 'meetWhen'
												? 'bInsetBlueTopXs2 bBor2  posRel  xBold   fs20  tDarkBlue'
												: 'tWhite  bInsetBlueBotXl  posRel  xBold tSha10  fs16  tDarkBlue'
											: 'fs16'
									} `}
									onClick={() => {
										if (date.getMonth() !== month) handlePickerChange('month', date.getMonth());
										handlePickerChange('day', date.getDate());
									}}>
									{label}
								</button>
							))}
						</weekdays-picker>
					)}

					{/* PRECISE TIME SELECTION SECTION --- */}
					{/* Handles hours and minutes input with support for AM/PM or 24h formats */}
					{!noTime && (day || mode === 'week') && (
						<time-section class={` marAuto block  ${mode === 'week' ? 'bInsetBlueTopXs' : ''}  posRel  posRel     flexCol w100`}>
							{mode === 'week' && (
								<blue-divider class={` hr0-5  block bInsetBlueTopXxs  bgTrans borderTop  w90  ${(!isToday || nowDate.getHours() < 12) && !noAmPm ? 'marBotL' : ''}   marAuto   `} />
							)}

							{/* DAY PART SELECTOR --- */}
							{/* AM/PM toggle for regions or user preferences supporting 12h clock */}
							{(!isToday || nowDate.getHours() < 12) && !noAmPm && (
								<>
									<ampm-picker className={` flexCen   mw80 marAuto   `}>
										{['dopoledne', 'odpoledne'].map(period => {
											const isAfternoon = currentHour >= 12;
											const todayAndAfterNoon = isSameDate(dateSrc, nowDate) && nowDate.getHours() >= 12;
											const isTomorrow = isSameDate(dateSrc, new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1));
											if (period === 'dopoledne' && isAfternoon && isSameDate(dateSrc, nowDate)) return null;
											if (!todayAndAfterNoon || isTomorrow)
												return (
													<button
														key={period}
														className={`${
															hoursMode === period ? 'bInsetBlueBotXl borderBot  tWhite tSha10 posRel fs16 bInsetBlueBot xBold' : 'boldS fs16'
														} padVerXxs w50 xBold`}
														onClick={() => {
															const adjustedHour = hour != null ? (hoursMode === 'odpoledne' && hour < 12 ? hour + 12 : hour) : null;
															if (adjustedHour != null) handlePickerChange('hour', adjustedHour);
															setHoursMode(period);
														}}>
														{period}
													</button>
												);
										})}
									</ampm-picker>
									<blue-divider class='hr0-5  zin1 block borRed bInsetBlueTopXl borTop bgTrans w40 marAuto' />
								</>
							)}

							{/* HOUR SELECTION GRID --- */}
							{/* Interactive hour blocks filtered by availability and timeframe */}
							<hour-picker className='flexCen posRel w100  marAuto wrap'>
								{Array.from({ length: noAmPm ? 24 : 12 }, (_, i) => i)
									.filter(hoursFilter)
									.map((b, i) => {
										// AFTERNOON FORCE ---
										// When AM/PM picker is hidden (afternoon today), always use afternoon hours
										const forceAfternoon = isToday && currentHour >= 12 && !noAmPm;
										const adjustedHour = noAmPm ? b : forceAfternoon || hoursMode === 'odpoledne' ? b + 12 : b;
										return (
											<button
												key={b}
												style={{ width: '100%', ...(hoursWidth && { maxWidth: `${Math.min(400, hoursWidth)}px` }) }}
												className={`flexRow grow bHover ${
													adjustedHour === hour ? 'tDarkBlue fs25   boRadXs  bInsetBlueTopXs bBor2 posRel xBold' : 'shaBlueLight  fs18'
												} padVerXxs `}
												onClick={() => handlePickerChange('hour', adjustedHour)}>
												<div className='flexRow '>
													<span className={`${adjustedHour === hour ? 'fs25 tDarkBlue xBold' : 'fs12 bold'}`}>{adjustedHour}</span>
													{((i === 0 && !hour) || adjustedHour === hour) && <span className='fsB marLefXxs'>hod</span>}
												</div>
											</button>
										);
									})}
							</hour-picker>

							{/* MINUTE SELECTION GRID --- */}
							{/* Quick access to 15-minute intervals for efficient time entry */}
							{hour !== null && (
								<minutes-picker className='flexCen borBotLight posRel  w100 marAuto wrap'>
									{Array.from({ length: 4 }, (_, i) => i * 15)
										.filter(minutesFilter)
										.map((b, i) => (
											<button
												key={b}
												style={{ width: '100%', ...(minutesWidth && { maxWidth: `${Math.min(200, minutesWidth)}px` }) }}
												className={`bHover ${b === min ? 'tDarkBlue fs22 borRed  boRadXs   posRel xBold' : 'fs18  boldM shaBlueLight'} padVerXxs`}
												onClick={() => handlePickerChange('min', b)}>
												<div className='flexRow'>
													{b}
													{(b === min || (i === 0 && !min)) && <span className='fs14 marLefXxs'>min</span>}
												</div>
											</button>
										))}
								</minutes-picker>
							)}
						</time-section>
					)}
				</date-picker>
			)}
		</date-time>
	);
};

function areEqual(prev, next) {
	return (
		prev.starts === next.starts &&
		prev.ends === next.ends &&
		prev.type === next.type &&
		prev.mode === next.mode &&
		prev.prop === next.prop &&
		prev.maxDate === next.maxDate &&
		prev.noAutoHide === next.noAutoHide &&
		prev.meetWhen === next.meetWhen &&
		prev.nowAt === next.nowAt
	);
}
export default memo(DateTimePicker, areEqual);
