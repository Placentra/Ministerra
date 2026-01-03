import axios from 'axios';
import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { forage, areEqual, getEventRank } from '../../helpers';
import useCentralFlex from '../hooks/useCentralFlex';
import { ratingSrc } from '../../sources';
import { notifyGlobalError } from '../hooks/useErrorsMan';

// TODO add a timer to the rating, so that the glow is not visible for too long
// todo create interval based on number of ratings given, to show information about what to rate (do not rate looks, rate the progressivity)
// todo can send just a plain 4item array instead of object to save traffic.
/** ----------------------------------------------------------------------------
 * RATE & AWARDS
 * UI for rating events/users/comments plus awarding badges; debounces writes and
 * keeps brain cache + forage storage in sync while animating choices.
 * --------------------------------------------------------------------------- */
function RateAwards(props) {
	const { obj, thisIs, brain: propsBrain, nowAt: propsNowAt, status, modes, setStatus, setModes } = props, // isCardOrStrip removed - unused ---------------------------
		{ brain = propsBrain, nowAt = propsNowAt } = useOutletContext() || {},
		[fade, setFade] = useState(false),
		[blinkAwards, setBlinkAwards] = useState(true),
		[marks, powersOfTwo] = [{ event: [-4, 1, 3, 5], user: [1, 5], comment: [-2, 1, 3, 5] }, [1, 2, 4, 8, 16, 32]],
		awardsSrc = ratingSrc[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs].awards.en.slice(0, ['comment', 'event'].includes(thisIs) ? undefined : obj.exps?.length > 0 ? 4 : 3),
		bWidth = useCentralFlex('awards', [modes, status], nowAt, awardsSrc.length),
		hideTimeout = useRef(),
		{ mark, awards = [] } = status;

	// RATING DONE CALL ---------------------------
	useEffect(() => {
		if (!fade) setFade(true);
		if (blinkAwards) setTimeout(() => setBlinkAwards(false), status.awards?.length ? 100 : nowAt === 'event' ? 2000 : 1000);
	}, [status.mark, status.awards]);

	useLayoutEffect(() => {
		if (!fade) setTimeout(() => setFade(true), 100);
		setTimeout(() => setBlinkAwards(false), 1000);
		clearTimeout(hideTimeout.current);
		hideTimeout.current = setTimeout(() => setModes(prev => ({ ...prev, awards: false })), 5000);
	}, [modes.menu, modes.actions, modes.awards]);

	async function man(inp, val) {
		clearTimeout(hideTimeout.current), (hideTimeout.current = setTimeout(() => setModes(prev => ({ ...prev, awards: false })), 5000));
		clearTimeout(brain.rateInProg[obj.id]?.timeout);
		let scoreFromUser, newAwards, awardsCode, newRating;
		const label = { event: 'rateEve', user: 'rateUsers', comment: 'rateComm' }[thisIs];

		function calculate(mark = 0, awards = [], getCode = false) {
			if (getCode) return awards.reduce((acc, cur) => acc + cur, 0);
			if (awards.length === 0) return mark;
			const coefs = { event: [-8, -2, 4, 5, 5, 10], meeting: [-8, 4, 5, 10], user: [3, 5, 10, 10], comment: {} };
			const multiplier = awards.reduce((acc, award) => acc + coefs[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs][powersOfTwo.indexOf(award)], 0) || 1;
			const oppositeSigns = (mark > 0 && multiplier < 0) || (mark < 0 && multiplier > 0);
			return Math.floor(mark * multiplier * (oppositeSigns ? 0.4 : 1) * ((mark < 0 && multiplier < 0) || oppositeSigns ? -1 : 1));
		}
		scoreFromUser = calculate(obj.mark, obj.awards || []);
		if (inp === 'award') {
			newAwards = (awards.includes(val) ? awards.filter(award => award !== val) : [...awards, val]).sort();
			(awardsCode = calculate(mark, newAwards, true)), (newRating = (calculate(mark, newAwards) || 0) - scoreFromUser);
		} else newRating = (val ? calculate(val, awards) : 0) - scoreFromUser;
		const newStatus = { ...status, score: Math.max(obj.score + newRating, 0), ...(inp === 'mark' ? { mark: val, awards: !val ? [] : awards } : { awards: newAwards }) };
		try {
			setStatus(newStatus);
			if ((inp === 'mark' && val === obj.mark) || (inp === 'award' && areEqual(newAwards, obj.awards))) return;
			else if (newStatus.mark || obj.mark !== 0) {
				Object.assign(brain.rateInProg, {
					[obj.id]: {
						props: { score: newStatus.score, awards: newStatus.awards, mark: newStatus.mark },
						timeout: setTimeout(async () => {
							const finalMark = inp === 'mark' ? val || 0 : status.mark;
							const finalAwards = inp === 'award' ? awardsCode : finalMark === 0 ? 0 : calculate(null, awards, true);

							try {
								await axios.post('rating', {
									mode: thisIs,
									targetID: obj.id,
									mark: finalMark,
									awards: finalAwards,
									score: newRating,
								});

								const interactions = (brain.user.unstableObj || brain.user)[label] || [];
								const index = interactions.findIndex(arr => String(arr[0]) === String(obj.id));
								if (newStatus.mark !== 0) {
									const arr = [obj.id, inp === 'mark' ? val : newStatus.mark, inp === 'mark' ? calculate(null, awards, true) : awardsCode];
									index !== -1 ? interactions.splice(index, 1, arr) : interactions.push(arr);
								} else if (index !== -1) interactions.splice(index, 1);
								Object.assign(obj, { mark: newStatus.mark, awards: newStatus.awards, score: newStatus.score, rank: getEventRank(obj) });
								forage({ mode: 'set', what: 'user', val: brain.user });
							} catch (error) {
								notifyGlobalError(error, 'Hodnocení se nepodařilo uložit.');
								Object.assign(brain, { rateInProg: {} });
								setStatus(prev => ({ ...prev, mark: obj.mark || 0, awards: obj.awards || [] }));
							}
						}, 3000),
					},
				});
			}
		} catch (err) {
			notifyGlobalError(err, 'Hodnocení se nepodařilo uložit.');
			Object.assign(brain, { rateInProg: {} }), setStatus(prev => ({ ...prev, mark: obj.mark || 0, awards: obj.awards || [] }));
		}
	}

	return (
		<rate-awards class={`fadingIn ${!fade ? '' : 'fadedIn'}   ${blinkAwards ? 'bsContentGlow' : ''} block w100 marAuto      textAli  posRel `}>
			<rating-bs class='flexCen aliStretch gapXxxs   w100'>
				{ratingSrc[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs].rating.map((button, i) => {
					const isSelected = status.mark === marks[thisIs][i];
					return (
						<button
							style={{ width: `calc(100% / ${ratingSrc[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs].rating.length})` }}
							key={button}
							onClick={() => {
								const buttMark = marks[thisIs][i];
								if (!mark) setModes(prev => ({ ...prev, awards: true })), man('mark', buttMark), nowAt === 'event' && setTimeout(() => setBlinkAwards(false), 2000);
								else if (buttMark === mark) modes.awards && man('mark', 0), setModes(prev => ({ ...prev, awards: !prev.awards }));
								else man('mark', buttMark), setModes(prev => ({ ...prev, awards: true }));
							}}
							className={`${!isSelected ? ` boldM textSha  ${nowAt === 'event' ? 'fs14' : 'fs10'}` : `xBold ${nowAt === 'event' ? 'fs18' : 'fs16'} borRedSel `}   ${
								nowAt === 'event' ? 'padVerXs ' : 'padVerXs'
							} textSha posRel      zin10 w25 bHover   noBackground flexCol aliCen`}>
							{isSelected && <blue-divider class='hr0-3  zin1 block posAbs botCen w80 bInsetBlueTopXl borTop bgTrans w40 marAuto' />}
							<button-texture style={{ filter: 'brightness(1.5)' }} class='noPoint padAllXxxs posAbs botCen zin1 w100 h100 bInsetBlueBotXs opacityM hr2' />
							{button}
						</button>
					);
				})}
			</rating-bs>

			{modes.awards && (
				<awards-bs class={`fadingIn ${fade ? 'fadedIn' : ''} bInsetBlueTopXs flexCen posRel marBotXxxs  zin1 aliStretch  wrap w100`}>
					{awardsSrc.map((primB, i) => {
						return (
							<button
								key={primB}
								style={{ width: '100%', maxWidth: `${bWidth - 1}px` }}
								onClick={() => (awards.length < (thisIs === 'event' ? 4 : 3) || awards.includes(powersOfTwo[i])) && man('award', powersOfTwo[i])}
								className={`${awards.includes(powersOfTwo[i]) ? 'borRed boRadS' : 'allOff'}   ${
									nowAt !== 'event' ? 'padBotXs padTopXl' : 'padTopXl '
								}   posRel hvw18 mh12 bHover grow `}>
								<img src='/icons/placeholdergood.png' className={`posAbs topCen maskLow h80 grow w100`} alt='' />
								{/* <img src='/icons/placeholdergood.png' className='blueGlass marBotXxxs zinMax mw6 w25 miw4' alt='' /> */}
								<span className=' fs9 xBold zinMax   lh0-8 '>{ratingSrc[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs].awards.cz[i]}</span>
								{(!status.embeded || thisIs !== 'event') && (
									<span className='fs6  mw30 zinMax   lh1'>{ratingSrc[thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs].awardsTexts[i]}</span>
								)}
							</button>
						);
					})}
				</awards-bs>
			)}
		</rate-awards>
	);
}

export default RateAwards;
