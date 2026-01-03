import { useState, useRef, useEffect, memo } from 'react';
import { humanizeDateTime } from '../../helpers';
import useCentralFlex from '../hooks/useCentralFlex';

const monthNames = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const weekDays = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

// BUG zkontrolovat přestupné roky
// DATE TIME PICKER COMPONENT ---
// Provides a comprehensive interface for selecting dates, times, and ranges
const DateTimePicker = props => {
	const [nowDate, { mode, starts, ends, superMan, prop, maxDate, noAutoHide }] = [new Date(), props],
		dateModeTimeout = useRef(null),
		[dateMode, setDateMode] = useState(prop ?? starts ? null : 'starts'),
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
			year: !fullDate && nowDate.getFullYear(),
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

	// SELECTION HANDLER LOGIC ---
	// Processes updates to year, month, day, or time and synchronizes with parent state
	function handlePickerChange(inp, val) {
		let [currentYear, updatedMonth, updatedDay] = [new Date().getFullYear(), inp === 'month' ? val : month, inp === 'day' ? val : day];
		if (dateSrc && dateMode && !noAutoHide) clearTimeout(dateModeTimeout.current), (dateModeTimeout.current = setTimeout(() => setDateMode(null), 2000));
		if (inp === 'decade') {
			setTimePortions({ year: null, month: null, day: null });
			superMan(dateMode, null);
			return;
		}
		if (inp === 'year' && (val < currentYear || (val === currentYear && month < new Date().getMonth()))) updatedMonth = null;
		if ((inp === 'year' && !updatedMonth) || (inp === 'month' && new Date(year, month + 1, 0).getDate() < day)) updatedDay = null;
		if (prop !== 'birth' && (updatedMonth === null || updatedDay === null))
			return superMan(dateMode, null), setTimePortions(prev => ({ ...prev, [inp]: val, month: updatedMonth, day: updatedDay }));

		const newPortions = {
			...timePortions,
			year: inp === 'year' ? val : timePortions.year,
			month: updatedMonth ?? timePortions.month,
			day: updatedDay ?? timePortions.day,
			...(['hour', 'min'].includes(inp) && { [inp]: val }),
		};

		const dateMethods = { year: 'setFullYear', month: 'setMonth', day: 'setDate', hour: 'setHours', min: 'setMinutes' };
		const newDate = dateSrc ? new Date(new Date(dateSrc[dateMethods[inp]](val))) : new (Date as any)(...Object.values(newPortions));

		if (!dateSrc)
			return Object.values(newPortions).includes(null) ? setTimePortions(newPortions) : (superMan(prop || dateMode, newDate), (mode !== 'week' || prop === 'meetWhen') && setDateMode(null));
		if (dateMode === 'starts' && ends && newDate.getTime() > (ends instanceof Date ? ends.getTime() : Number(ends))) superMan('ends', null);
		superMan(dateMode, newDate);
	}
	// CHECK IF SAME DATE --------------------------------------------------------------
	function isSameDate(date1, date2) {
		if (!date1 || !date2) return false;
		return date1.toDateString() === date2.toDateString();
	}

	// GET NEXT DAYS -------------------------------------------------------
	function getWeekDays() {
		const numDays = prop === 'meetWhen' ? 2 : 7;
		const days = [];
		const startDate = maxDateDate ? new Date(maxDateDate) : new Date();
		if (maxDate) startDate.setDate(startDate.getDate() - numDays + 1);
		for (let i = 0; i < numDays; i++) {
			const day = new Date(startDate);
			day.setDate(startDate.getDate() + i);
			if (i === 0) days.push({ label: prop === 'meetWhen' ? 'den předem' : 'Dnes', date: day });
			else if (i === 1) days.push({ label: prop === 'meetWhen' ? 'stejný den' : 'Zítra', date: day });
			else days.push({ label: weekDays[(day.getDay() + 6) % 7], date: day });
		}
		return days;
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
	const [yearsFilter, monthsFilter, hoursFilter, minutesFilter] = [
		year => {
			if (startsDate && !isStarts && year < startsDate.getFullYear()) return false;
			if (maxDateDate && year > maxDateDate.getFullYear()) return false;
			// For birth date selection, only allow years that would make the person at least 13 years old
			if (fullDate) {
				const minYear = nowDate.getFullYear() - 100; // Don't allow ages over 100
				const maxYear = nowDate.getFullYear() - 13; // Must be at least 13 years old
				return year >= minYear && year <= maxYear;
			}
			return true;
		},
		month => {
			if (fullDate) {
				// For birth date in the current year minus 13, only allow months up to current month
				if (year === nowDate.getFullYear() - 13) {
					return month <= nowDate.getMonth();
				}
				return true;
			}
			const newDate = new Date(year, month);
			if (year === curYear + 2 && month > curMonth) return false;
			if (maxDateDate && newDate > new Date(maxDateDate.getFullYear(), maxDateDate.getMonth())) return false;
			if (startsDate && !isStarts) return newDate >= new Date(startsDate.getFullYear(), startsDate.getMonth());
			return newDate.getTime() >= new Date().setMonth(new Date().getMonth() - 1);
		},
		hour => {
			const adjustedHour = noAmPm ? hour : hoursMode === 'odpoledne' ? hour + 12 : hour;
			const currentMinutes = new Date().getMinutes();
			if (maxDateDate && isSameDate(dateSrc || new Date(year, month, day), maxDateDate)) return adjustedHour <= maxDateDate.getHours();
			if (startsDate && !isStarts && isSameDate(dateSrc, startsDate)) return adjustedHour >= startsDate.getHours();
			if (isStarts && endsDate && isSameDate(dateSrc, endsDate)) return adjustedHour <= endsDate.getHours();
			if (isToday && isStarts) {
				if (adjustedHour === currentHour && currentMinutes >= 45) return false;
				return adjustedHour >= currentHour;
			}
			return true;
		},
		minute => {
			if (maxDateDate && isSameDate(dateSrc || new Date(year, month, day, hour), maxDateDate) && hour === maxDateDate.getHours()) return minute <= maxDateDate.getMinutes() - 15;
			if (startsDate && !isStarts && isSameDate(dateSrc, startsDate) && hour === startsDate.getHours()) return minute > startsDate.getMinutes();
			if (isToday && isStarts && hour === currentHour) return minute >= new Date().getMinutes();
			return true;
		},
	];

	// WIDTHS FOR BUTTONS ---------------------------------------------
	const decadeWidth = useCentralFlex('decades', [showAllDecades], null, Array.from({ length: 10 }, (_, i) => 1920 + i * 10).length);
	const monthsWidth = useCentralFlex('months', [year, dateMode], null, Array.from({ length: 12 }, (_, i) => i).filter(monthsFilter).length);
	const daysWidth = useCentralFlex('days', [month, dateMode], null, 7);
	const hoursWidth = useCentralFlex('hours', [day, hoursMode], null, Array.from({ length: noAmPm ? 24 : 12 }, (_, i) => i).filter(hoursFilter).length);
	const minutesWidth = useCentralFlex('minutes', [hour, dateMode], null, Array.from({ length: 4 }, (_, i) => i * 15).filter(minutesFilter).length);

	return (
		<date-time ref={scrollTarget} class={` flexCen  w100 mw180  textAli zinMaXl  posRel marAuto wrap`}>
			{/* DATE MODE CONTROLS --- */}
			{/* Provides toggles between selecting start and end times for events */}
			{starts && (mode !== 'week' || prop === 'meetWhen') && !noAutoHide && (
				<starts-ends class={`flexCen w100 boRadM textAli  posRel ${mode !== 'week' ? 'bPadTopM bPadBotM thickBors bw50' : 'bPadVerS bw100'}   marAuto  `}>
					{['starts', 'ends']
						.filter(field => field === 'starts' || (starts && !startOnly))
						.map(field => {
							const startsInPast = !maxDate && field === 'starts' && starts < nowDate;
							const endsBeforeStart = field === 'ends' && ends && new Date(ends) < new Date(starts);
							return (
								<button
									key={field}
									className={`${dateMode === field ? 'bGlass arrowDown1 posRel' : ''} ${
										mode === 'week' ? 'mw60  borRed sideBors posRel downTiny' : ''
									}  textSha posRel bgTrans padHorS`}
									onClick={() => (setDateMode(prop ? (dateMode === prop ? null : prop) : dateMode === field ? null : field), setHoursMode(hour >= 12 ? 'odpoledne' : 'dopoledne'))}>
									{/* SELECTION STATUS LABEL --- */}
									{/* Displays humanized date or validation warnings for the current field */}
									<texts-wrapper class='flexCol bPadS w100 selfCen'>
										<span
											className={`${
												startsInPast || endsBeforeStart
													? 'bRed fsH bold tWhite'
													: field === dateMode || prop === 'meetWhen'
													? 'fs20   xBold '
													: mode !== 'week'
													? 'bold fs20'
													: 'xBold tBlue  fs10'
											} lh1 `}>
											{prop === 'meetWhen' && <span className={'fs12'}>{`Sraz bude `}</span>}
											{startsInPast
												? 'Začátek je v minulosti!'
												: endsBeforeStart
												? 'Začátek je před koncem!'
												: field === 'starts' && dateMode === 'starts' && !starts
												? 'Zvol datum a čas'
												: field === 'ends' && !ends
												? 'Zadat konec'
												: field === 'starts' && starts
												? `${humanizeDateTime({ dateInMs: starts }) || ''}`
												: field === 'ends' && ends
												? `${humanizeDateTime({ dateInMs: ends }) || ''}`
												: ''}
										</span>
										{/* SUB-INSTRUCTIONS --- */}
										{/* Contextual guidance for date/time selection requirements */}
										{mode !== 'week' && !startsInPast && !endsBeforeStart && (
											<span className={` fs8 w100 tBlue fw400 noPoint  `}>
												{dateMode === field ? 'skrýt datumový vybírač' : field === 'starts' ? 'začátek povinný' : field === 'ends' ? 'konec nepovinný' : ''}
											</span>
										)}
										{field === 'ends' && ends && (
											<button
												onClick={e => (e.stopPropagation(), superMan('ends', null), setDateMode(null))}
												className={`posAbs zinMaXl tRed xBold hover hr0-5 downTiny boRadM mw10 borderLight padHorM borRed botCen fs8 borderLight`}>
												smazat
											</button>
										)}
									</texts-wrapper>
								</button>
							);
						})}
					{!startOnly && <img className={'posAbs center  downLittle zinMax mw16 w10 miw10'} src='/icons/history.png' alt='' />}
				</starts-ends>
			)}

			{/* CALENDAR PICKER SECTION --- */}
			{/* Renders interactive year, month, and day grids for precise date selection */}
			{(dateMode || !starts) && (
				<date-picker class={`${dateSrc && mode !== 'week' ? 'marTopL' : ''} w100`}>
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
											className={`${d === selDecade ? `borBotLight  arrowDown1 posRel fs14 flexRow  zinMax  xBold textSha` : ' fs14'} grow`}
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
								<year-picker class='flexCen marAuto posRel borderBot bPadVerM posRel marTopS  aliStretch w100'>
									{(fullDate && selDecade ? Array.from({ length: 10 }, (_, i) => selDecade + i) : Array.from({ length: 3 }, (_, i) => nowDate.getFullYear() + i))
										.filter(yearsFilter)
										.map(b => (
											<button
												key={b}
												className={`w25 grow bHover ${b === year ? 'bBlue  tSha10 tWhite fs17 boRadXxs posRel bgTrans xBold' : 'shaBlueLight fs12  noBackground'}`}
												onClick={() => handlePickerChange('year', b)}>
												{b}
											</button>
										))}
								</year-picker>
							)}

							{/* MONTH SELECTION GRID --- */}
							{/* Interactive month list filtered by logical date constraints */}
							{year && !showAllDecades && (
								<month-picker class={'flexCen   marAuto marBotM marTopS  bPadVerM wrap w100'}>
									{Array.from({ length: 12 }, (_, i) => i)
										.filter(monthsFilter)
										.map(b => (
											<button
												style={{ width: '100%', ...(monthsWidth && { maxWidth: `${Math.min(400, monthsWidth)}px` }) }}
												className={`${b === month ? 'bBlue  tSha10 tWhite fs17 posRel   xBold' : 'fs12  textSha shaBlue '}  shaBlue   bHover `}
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
						<day-picker class=' posRel w100  posRel  marAuto flexRow wrap'>
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
								{(() => {
									const days = Array.from({ length: 31 }, (_, i) => new Date(year, month, i + 1))
										.filter(date => date.getMonth() === month)
										.map(date => ({ day: date.getDate() }))
										.filter(({ day }) => {
											if (fullDate) {
												if (year === nowDate.getFullYear() - 13 && month === nowDate.getMonth()) return day <= nowDate.getDate();
												return true;
											}
											const today = new Date();
											const date = new Date(year, month, day);
											if (year === curYear + 2 && curMonth === month && date.getDate() > nowDate.getDate()) return false;
											return starts && !isStarts
												? new Date(date.setHours(0, 0, 0, 0)) >= new Date(new Date(starts).setHours(0, 0, 0, 0))
												: new Date(date.setHours(0, 0, 0, 0)) >= new Date(today.setHours(0, 0, 0, 0));
										});

									const firstDayWeekday = days.length > 0 ? new Date(year, month, 1).getDay() : 0;
									const mondayBasedWeekday = firstDayWeekday === 0 ? 6 : firstDayWeekday - 1;
									const emptyDays = days.length > 0 ? Array.from({ length: mondayBasedWeekday }, () => ({ day: null })) : [];

									return [...emptyDays, ...days].map(({ day: b }, i) => (
										<button
											style={{ width: '100%', maxWidth: `${daysWidth - 1}px` }}
											className={` ${
												b === null ? 'bGlasSubtle' : b === day ? 'tDarkBlue fs12 borRed thickBors boRadXs bInsetBlueTop posRel xBold' : 'shaBlue boldXs fs7 bgWhite'
											} borBotLight mih3 bHover`}
											key={`${month}_${i}`}
											onClick={() => b !== null && handlePickerChange('day', b)}>
											{b ?? ''}
											{b && b === day ? '.' : ''}
										</button>
									));
								})()}
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
										date.getDate() === day ? '  tWhite  bInsetBlueBotXl  posRel  xBold tSha10  fs16  tDarkBlue' : 'fs16'
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
						<time-section class={` marAuto block  ${mode === 'week' ? 'bInsetBlueTopXs' : ''}  posRel  posRel shaCon    flexCol w100`}>
							{mode === 'week' && <blue-divider class={` hr0-5  block bInsetBlueTopXxs  bgTrans borderTop  w90     marAuto   `} />}

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
															hoursMode === period ? 'bInsetBlueBotXl borderBot  tWhite tSha10 posRel fs11 bInsetBlueBot xBold' : 'boldS fs11'
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
									<blue-divider class='hr0-5 marBotL zin1 block borRed bInsetBlueTopXl borTop bgTrans w40 marAuto' />
								</>
							)}

							{/* HOUR SELECTION GRID --- */}
							{/* Interactive hour blocks filtered by availability and timeframe */}
							<hour-picker className='flexCen posRel w100  marAuto wrap'>
								{Array.from({ length: noAmPm ? 24 : 12 }, (_, i) => i)
									.filter(hoursFilter)
									.map((b, i) => {
										const adjustedHour = noAmPm ? b : hoursMode === 'odpoledne' ? b + 12 : b;
										return (
											<button
												key={b}
												style={{ width: '100%', ...(hoursWidth && { maxWidth: `${Math.min(400, hoursWidth)}px` }) }}
												className={`flexRow grow bHover ${
													adjustedHour === hour ? 'tDarkBlue fs25   boRadXs  bInsetBlueTopXs bBor2 posRel xBold' : 'noBackground shaBlue fs18'
												} padVerXs `}
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
												className={`bHover ${b === min ? 'tDarkBlue fs18 borRed  boRadXs   posRel xBold' : 'fs12  boldM shaBlueLight'} padVerXxs`}
												onClick={() => handlePickerChange('min', b)}>
												<div className='flexRow'>
													{b}
													{(b === min || (i === 0 && !min)) && <span className='fsB marLefXxs'>min</span>}
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
	return prev.starts === next.starts && prev.ends === next.ends && prev.birth === next.birth && prev.dateMode === next.dateMode && prev.mode === next.mode;
}
export default memo(DateTimePicker, areEqual);
