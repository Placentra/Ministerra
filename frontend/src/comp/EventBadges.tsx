import { BASIC_TOPICS, USER_GROUPS } from '../../../shared/constants';

// EVENT BADGES COMPONENT DEFINITION ---
// Displays summarized demographic and interest indicators based on confirmed event participants
function EventBadges(props) {
	const { obj, nowAt } = props;
	const isEvent = nowAt === 'event';

	const hasIndis = obj.badges.indis?.length > 0;
	const hasBasics = obj.badges.basics?.length > 0;
	const hasGroups = obj.badges.groups?.length > 0;

	if (!hasIndis && !hasBasics && !hasGroups) return null;

	return (
		<event-badges class={isEvent ? 'marTopS gapXs marBotXs flexCol justCen w100' : 'flexRow aliCen wrap gapXs'}>
			{/* SECTION TITLE --- */}
			<span className={`fs11 marTopXxs xBold textSha tDarkBlue marRigS ${isEvent ? 'textAli' : ''}`}>{isEvent ? 'Dominují (nad 30%):' : 'Dominují:'}</span>

			<div className={`flexRow wrap aliCen ${isEvent ? 'justCen gapS' : 'gapXs'}`}>
				{/* INDIVIDUAL TRAIT INDICATORS --- */}
				{hasIndis && (
					<indis-wrapper class='flexRow gapXxxs'>
						{obj.badges.indis
							.filter(indi => indi <= 10 && indi !== 0) // Filter out special/invalid indis
							.map(indi => (
								<indi-badge
									key={indi}
									class={`${isEvent ? 'imw7' : 'imw2-5'} posRel textAli imw2-5 padHorXxs bGlassSubtle shaBlue boRadXs`}
									title={`Indicator ${indi}`} // Basic tooltip
								>
									<img src={`/icons/indicators/${indi}.png`} alt='' className='w100' />
								</indi-badge>
							))}
					</indis-wrapper>
				)}

				{/* PROGRESSIVE TOPICS --- */}
				{hasBasics && (
					<basics-wrapper class={`flexRow aliCen ${isEvent ? 'fs8' : 'fs7'} boRadXxs padHorXxs bGlassSubtle`}>
						<span className='boldM tGreen marRigXxs'>Prog:</span>
						<span className='boldXs tDarkBlue'>
							{obj.badges.basics
								.filter(basic => basic <= 19)
								.map(basic => BASIC_TOPICS.get(Number(basic)))
								.filter(Boolean)
								.join(', ')
								.toLowerCase()}
						</span>
					</basics-wrapper>
				)}

				{/* INTEREST GROUPS --- */}
				{hasGroups && (
					<groups-wrapper class={`flexRow aliCen ${isEvent ? 'fs8' : 'fs7'} boRadXxs padHorXxs bGlassSubtle`}>
						<span className='boldM tBlue marRigXxs'>Skupiny:</span>
						<span className='boldXs tDarkBlue'>
							{obj.badges.groups
								.map(group => {
									// Search in all group categories
									for (const [, map] of USER_GROUPS) {
										if (map.has(String(group))) return map.get(String(group));
									}
									return null;
								})
								.filter(Boolean)
								.join(', ')}
						</span>
					</groups-wrapper>
				)}
			</div>
		</event-badges>
	);
}
export default EventBadges;
