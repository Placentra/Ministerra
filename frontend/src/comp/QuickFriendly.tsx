import Editor from '../mainSections/Editor';
import useCentralFlex from '../hooks/useCentralFlex';
import { useState, useEffect, useMemo, memo, forwardRef } from 'react';
import { FRIENDLY_MEETINGS } from '../../../shared/constants';

const QuickFriendly = forwardRef(function QuickFriendly(props: any, ref: any) {
	const { brain, show, fadedIn, quick, showMan, snapMan, provideSnap, initialize } = props;
	const [showMore, setShowMore] = useState(false);
	const meetWidth = useCentralFlex('quicks', [showMore, FRIENDLY_MEETINGS.size], 'home', showMore ? FRIENDLY_MEETINGS.size : 4);
	const meetStats = useMemo(
		() =>
			Array.from(FRIENDLY_MEETINGS.entries()).reduce((acc, [type]) => {
				const { people, events } = brain.user.curCities.reduce(
					(total, cityID) => {
						const stats = brain.meetStats[cityID]?.[type] || { events: 0, people: 0 };
						return ((total.events += stats.events), (total.people += stats.people), total);
					},
					{ events: 0, people: 0 }
				) || { events: 0, people: 0 };
				acc[type] = { people, events };
				return acc;
			}, {} as any),
		[brain.meetStats, brain.user.curCities]
	);

	useEffect(() => {
		setShowMore(false);
	}, [initialize]);

	return (
		<quick-friendly ref={ref} class={`${show.views ? 'padBotL ' : ''}  posRel   ${fadedIn.includes('Quicks') ? 'fadedIn ' : ''} fadingIn marBotXl block w100 marAuto`}>
			<friendlyMeetings-wrapper class={'flexCen aliStretch wrap  w100 '}>
				<div className={`bgWhite topCen opacityS shaCon mih2 posAbs w100 zinMaXl`} />
				<div className={`bgWhite topCen opacityM shaCon mih0-3 posAbs w100 zinMaXl`} />
				{quick === false &&
					Object.entries(meetStats as any)
						.filter(([type]) => showMore || Number(type.slice(1)) <= 8)
						.map(([type, { people, events }]: any, i) => {
							return (
								// SINGLE MEETING WRAPPER --------------------------------
								<single-meeting key={type} style={{ width: '100%', ...(meetWidth && { maxWidth: `${meetWidth}px` }) }} className={`  flexCol aliCen bHover pointer ${showMore ? 'aspect167 mih14 ' : 'aspect167 hvw25 mh18'} marBotXs    posRel`}>
									<img onClick={() => showMan('quick', type)} className={`boRadXxs posAbs topCen cover w100 h80 maskLowXs `} src={`/covers/friendlyMeetings/a${i + 1}.png`} alt="" />
									{/* QUICK CREATE / SHOW EVENTS OR ATTENDEES BUTTONS -------------------------------- */}
									<action-buttons class="posAbs botCen flexCen  w100">
										{['events', 'editor', 'people'].map((b, i) => {
											const disable = (b === 'people' && people === 0) || (b === 'events' && events === 0);
											if (b === 'editor')
												return (
													<create-button key={b} onClick={() => showMan('quick', type)} className={` maskTopXs posRel flexCol bHover aliCen marBotXs textAli justCen `}>
														<img style={{ filter: 'brightness(1) saturate(0.95) hue-rotate(-0deg)' }} className={` ${showMore ? 'w80 mw10' : 'w60 mw12'}  bgTrans padHorXxs padTopS  maskLowXxs   `} src={`/icons/types/${type}.png`} alt="" />

														<span className={`${showMore ? 'fs12' : 'fs12'} upTiny xBold    bgTrans   textSha posRel tSha lh1 noWrap`}>{FRIENDLY_MEETINGS.get(type).quick}</span>
													</create-button>
												);
											return (
												<events-people
													key={b}
													onClick={e => {
														if (disable) return;
														const lastSnap = provideSnap('last'),
															sameTypes = lastSnap.types.length === 1 && lastSnap.types[0] == type;
														(e.stopPropagation(),
															!sameTypes || lastSnap.contView !== b
																? (snapMan('quicks', { type, contView: b === 'events' ? b : 'users' }),
																	delete brain.itemsOnMap,
																	delete brain.lastFetchMapIDs,
																	b === 'events' &&
																		show.map === true &&
																		(delete brain.canScroll,
																		requestAnimationFrame(() => {
																			const mapEl = document.querySelector('map-canvas');
																			mapEl && window.scrollTo({ top: mapEl.getBoundingClientRect().top + window.scrollY - 50, behavior: 'smooth' });
																		})))
																: requestAnimationFrame(() => {
																		if (b === 'events' && show.map === true) {
																			const mapEl = document.querySelector('map-canvas');
																			mapEl && window.scrollTo({ top: mapEl.getBoundingClientRect().top + window.scrollY - 50, behavior: 'smooth' });
																		} else {
																			const contEl = document.querySelector('#content');
																			contEl && window.scrollTo({ top: contEl.offsetTop, behavior: 'smooth' });
																		}
																	}));
													}}
													class={`${disable ? 'opacityS' : showMore ? 'fs10 boldXs textSha' : 'fs10 boldXs textSha'} flexCol posRel justCen selfEnd borWhite bHover w20 aliCen maskTopXs bgTrans padHorXs ${showMore ? 'padTopXs bgTrans padHorXs  marBotXs' : 'padTopM marBotXs'}`}>
													<img className={`mw6 miw4 marBotXxxs w100  `} src={`/icons/${i === 0 ? 'event' : 'people'}.png`} alt="" />
													{b === 'events' ? events : people}
												</events-people>
											);
										})}
									</action-buttons>
								</single-meeting>
							);
						})}
			</friendlyMeetings-wrapper>
			{quick === false && (
				<button onClick={() => setShowMore(showMore ? false : true)} className={`${showMore ? 'tRed fs12  borderRed' : ' borderBot  arrowDown1 opacityL fs10'}  bgTrans  shaBlueLight  bold       hover  zinMax  posRel padAllXxs   marTopS  boRadXxs w50 marAuto mw30`}>
					{!showMore ? 'zobrazit více' : 'zobrazit méně'}
				</button>
			)}

			{/* QUICK EDITOR WRAPPER -------------------------------------------- */}
			{quick !== false && (
				<editor-wrapper class={'block  marTopXxl marBotXl w100'}>
					<Editor quickType={quick} showMan={showMan} setShowMore={setShowMore} brain={brain} />
					<button onClick={() => showMan('quick', false)} className="bgTransXs tRed shaBlue    marBotXxs bGlassSubtle  posRel borderBot     tRed zinMax downLittle  posRel padAllXs boldM fs10   boRadXxs w50 marAuto mw30  ">
						zavřít formulář
					</button>
				</editor-wrapper>
			)}
		</quick-friendly>
	);
});

function areEqualQuickFriendly(prev, next) {
	return prev.quick === next.quick && prev.show === next.show && prev.fadedIn === next.fadedIn && prev.initialize === next.initialize && prev.brain.meetStats === next.brain.meetStats && prev.brain.user.curCities === next.brain.user.curCities;
}
export default memo(QuickFriendly, areEqualQuickFriendly);
