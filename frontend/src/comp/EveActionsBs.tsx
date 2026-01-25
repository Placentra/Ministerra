import { useState, useMemo, useEffect, useRef } from 'react';
import RateAwards from './RateAwards';
import IntersPrivsButtons from './IntersPrivsButtons';
import TimeoutIndicator from './TimeoutIndicator';
import { ratingSrc } from '../../sources';
import { PRIVACIES, INTERESTS } from '../../../shared/constants';

// PRIVACY LABELS ---
const attenVisibSrc = { [PRIVACIES.public]: 'všichni', [PRIVACIES.links]: 'spojenci', [PRIVACIES.trusts]: 'důvěrní', [PRIVACIES.owner]: 'autor' };

// SOCIAL ICON ASSETS ---
const src = { Facebook: '/icons/facebook.png', Google: '/icons/google.png', Instagram: '/icons/instagram.png', Twitter: '/icons/twitter.png' };

type ActiveView = 'main' | 'attendance' | 'rating' | 'share';

// SUB-VIEW WRAPPER ---------------------------
const SubViewWrapper = ({ children }: { children: any; title: string }) => <sub-view class="flexCol  w100 bInsetBlueTopXs2 aliCen posRel fadingIn fadedIn">{children}</sub-view>;

function EveActionsBs({ obj, nowAt, fadedIn, setModes, brain, status, setStatus, modes, isInactive, thisIs, isPast }: any) {
	const [activeView, setActiveView] = useState<ActiveView>('main');
	const [timerProgress, setTimerProgress] = useState(0);
	const intervalRef = useRef<any>();

	// HANDLE BACK TO MAIN MENU ---------------------------
	const goBack = () => setActiveView('main');

	// TIMER LOGIC ---------------------------
	const resetTimer = () => {
		clearInterval(intervalRef.current);
		const duration = 4000;
		const start = Date.now();
		intervalRef.current = setInterval(() => {
			const elapsed = Date.now() - start;
			const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
			setTimerProgress(remaining);
			if (remaining <= 0) {
				clearInterval(intervalRef.current);
				goBack();
			}
		}, 50);
	};

	useEffect(() => {
		if (activeView !== 'main') resetTimer();
		else {
			clearInterval(intervalRef.current);
			setTimerProgress(0);
		}
		return () => clearInterval(intervalRef.current);
	}, [activeView]);

	// DYNAMIC ATTENDANCE BUTTON CONTENT ---------------------------
	const attendanceButtonContent = useMemo(() => {
		const isEventPrivate = obj.priv && !['pub', 'ind'].includes(obj.priv);
		let privLabel = attenVisibSrc[status.interPriv] || 'všichni';
		
		// Contextual Label Override:
		// If event is private and user selected 'pub', it means "Participants", not "Everyone".
		if (isEventPrivate && status.interPriv === PRIVACIES.public) {
			privLabel = 'účastníci';
		}

		const base = { priv: privLabel };
		if (status.inter === INTERESTS.surely) return { ...base, icon: '/icons/surely.png', label: 'Určitě jdu', class: 'tGreen' };
		if (status.inter === INTERESTS.maybe) return { ...base, icon: '/icons/maybe.png', label: 'Možná jdu', class: 'tOrange' };
		if (status.inter === INTERESTS.interested) return { ...base, icon: '/icons/eye.png', label: 'Zajímá mě', class: 'tBlue' };
		return { ...base, icon: '/icons/attendance.png', label: 'Účast', class: 'tDarkBlue' };
	}, [status.inter, status.interPriv, obj.priv]);

	// RATING BUTTON CONTENT ---------------------------
	const ratingButtonContent = useMemo(() => {
		if (status.mark) {
			const marks = { event: [-4, 1, 3, 5], user: [1, 5], comment: [-2, 1, 3, 5] };
			const powersOfTwo = [1, 2, 4, 8, 16, 32];
			const ratingContext = thisIs === 'event' && obj.type.startsWith('a') ? 'meeting' : thisIs;
			const markIndex = marks[thisIs].indexOf(status.mark);
			const markName = ratingSrc[ratingContext].rating[markIndex] || '';
			const awardNames = (status.awards || [])
				.map(a => {
					const idx = powersOfTwo.indexOf(a);
					return ratingSrc[ratingContext].awards.cz[idx];
				})
				.filter(Boolean);

			return { icon: '/icons/rating.png', label: markName, awards: awardNames, class: 'tPurple' };
		}
		return { icon: '/icons/rating.png', label: '', awards: [], class: 'tDarkBlue' };
	}, [status.mark, status.awards, thisIs, obj.type]);

	// MAIN CONTROL BAR ---------------------------
	const MainControlBar = (
		<main-bar class="flexRow w100 spaceBet aliStretch">
			<button
				onClick={() => {
					setActiveView(activeView === 'attendance' ? 'main' : 'attendance');
					if (!status.inter) setModes(prev => ({ ...prev, autoSelectInter: true }));
				}}
				className={`grow bHover  bBor padVerXxs posRel   bgTrans flexCol aliCen ${attendanceButtonContent.class} ${activeView === 'attendance' ? 'bInsetBlueBotXs arrowDown1' : ''}`}>
				<div className="flexRow aliCen gapXxs">
					<img className={`${nowAt === 'event' ? 'mw6' : 'mw4'} aspect1610`} src={attendanceButtonContent.icon} alt="" />
					{status.inter && <span className="fs12 textSha tDarkBlue xBold">{attendanceButtonContent.label}</span>}
				</div>
				{!status.inter && <span className="fs5 bold">Účast</span>}
				{status.inter && <span className="fs7 boldXs posRel upTiny textSha">vidí: {attendanceButtonContent.priv}</span>}
			</button>
			<button
				onClick={() => {
					setActiveView(activeView === 'rating' ? 'main' : 'rating');
					if (!status.mark) setModes(prev => ({ ...prev, autoSelectRating: true }));
				}}
				className={`grow bBor ${activeView === 'rating' ? 'bInsetBlueBotXs arrowDown1' : ''} padVerXxs posRel  bgTrans flexCol aliCen bHover ${ratingButtonContent.class}`}>
				<div className="flexRow aliCen gapXxs">
					<img className={`${nowAt === 'event' ? 'mw6' : 'mw4'} aspect1610`} src={ratingButtonContent.icon} alt="" />
					{status.mark > 0 && <span className="fs12 textSha tDarkBlue xBold">{ratingButtonContent.label}</span>}
				</div>
				{!status.mark && <span className="fs5 bold">Hodnotit</span>}
				{ratingButtonContent.awards.length > 0 && <span className="fs7 boldXs textSha  posRel upTiny opacityL">+ {ratingButtonContent.awards.join(', ')}</span>}
			</button>
			<button onClick={() => setActiveView(activeView === 'share' ? 'main' : 'share')} className={`grow bBor ${activeView === 'share' ? 'bInsetBlueBotXs arrowDown1' : ''} padVerXxs posRel flexCol aliCen bHover bgTrans tDarkBlue`}>
				<img className={`${nowAt === 'event' ? 'mw6' : 'mw4'} aspect1610`} src="/icons/share.png" alt="" />
				<span className="fs5 bold">Sdílet</span>
			</button>
		</main-bar>
	);

	// RENDER CONTENT BASED ON ACTIVE VIEW ---------------------------
	return (
		<secondary-bs onClick={e => e.stopPropagation()} class={`fadingIn ${fadedIn.includes('BsEvent') ? 'fadedIn' : ''} flexCol zinMenu posRel marAuto aliStretch w100 bgWhite shaBot boRadS`}>
			{MainControlBar}

			{activeView !== 'main' && <blue-divider class="hr0-2 zin1 block opacityM     bInsetBlueTopXl  bgTrans w80 marAuto" />}

			{activeView === 'attendance' && <SubViewWrapper title="Vaše účast">{!isPast && <IntersPrivsButtons obj={obj} nowAt={nowAt} fadedIn={fadedIn} setModes={setModes} brain={brain} status={status} setStatus={setStatus} modes={modes} isInactive={isInactive} resetTimer={resetTimer} />}</SubViewWrapper>}

			{activeView === 'rating' && (
				<SubViewWrapper title="Hodnocení">
					{!isPast && (
						<>
							<RateAwards obj={obj} nowAt={nowAt} fadedIn={fadedIn} setModes={setModes} brain={brain} status={status} setStatus={setStatus} modes={modes} isInactive={isInactive} thisIs={thisIs} goBack={goBack} resetTimer={resetTimer} />
						</>
					)}
				</SubViewWrapper>
			)}

			{activeView === 'share' && (
				<SubViewWrapper title="Sdílení">
					<share-b class="flexCen aliStretch zinMax padTopXxs w100  wrap">
						{Object.keys(src).map(button => (
							<button key={button} className="bHover bBor w25 posRel padVerXs flexCol aliCen boRadXxs bgTrans">
								<img className="mw5 marBotXxxs" src={src[button]} alt="" />
								<span className="fs5 tGrey lh1">{button}</span>
							</button>
						))}
					</share-b>
				</SubViewWrapper>
			)}

			{activeView !== 'main' && timerProgress > 0 && <TimeoutIndicator progress={timerProgress} invert={true} noRedColor={true} />}
		</secondary-bs>
	);
}

export default EveActionsBs;
