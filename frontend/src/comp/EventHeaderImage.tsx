import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

function EventHeaderImage({ event, fadedIn = [], maximizeImg = false, onImageClick, isMobile = false, brain, nowAt }: any) {
	const isMeeting = event.type.startsWith('a');

	const imgVers = event?.imgVers?.toString().split('_')[0] || 0;
	const randomImg = useMemo(() => Math.floor(Math.random() * 30) + 1, []);
	const imgSrc = `${import.meta.env.VITE_BACK_END}/public/events/${randomImg}_${imgVers}${maximizeImg ? 'L' : ''}`;
	const navigate = useNavigate();

	const queueIDs = brain?.contQueueIDs || [],
		queueLen = queueIDs.length;
	const thisEventIndex = queueIDs.findIndex(id => id == event.id); // LOOSE EQUALITY - ID TYPE MISMATCH ---------------------------
	const inQueue = thisEventIndex !== -1,
		canGoPrev = inQueue && thisEventIndex > 0,
		canGoNext = inQueue && thisEventIndex < queueLen - 1;
	const navigateToEvent = id => {
		window.scrollTo({ top: 0, behavior: 'instant' });
		navigate(`/event/${id}!${encodeURIComponent(event.title).replace(/\./g, '-').replace(/%20/g, '_')}`);
	};

	return (
		<header-div class={`${fadedIn.includes('Image') ? 'fadedIn' : ''} ${isMeeting ? 'hvw50 mh30' : ' '} fadingIn   posRel zin1  flexCol aliCen posRel w100 marAuto`}>
			{/* PAGE BUTTONS ---------------------------------------- */}
			{inQueue && queueLen > 1 && nowAt === 'event' && (
				<page-bs class="flexRow posAbs center spaceBet w100 h100 boRadS zinMaXl marAuto">
					<button disabled={!canGoPrev} onClick={() => canGoPrev && navigateToEvent(queueIDs[thisEventIndex - 1])} className={`bgTransXs miw6 fsG boldM mih6 padAllXs shaTop ${!canGoPrev ? 'opacityL noPoint' : ''}`}>
						{'<'}
					</button>
					<button disabled={!canGoNext} onClick={() => canGoNext && navigateToEvent(queueIDs[thisEventIndex + 1])} className={`bgTransXs fsG boldM miw6 mih6 padAllXs shaTop ${!canGoNext ? 'opacityL noPoint' : ''}`}>
						{'>'}
					</button>
				</page-bs>
			)}

			{isMeeting ? (
				// FRIENDLY MEETING --------------------------------------------------------------
				<meeting-image class="posRel block w100 h100">
					<img loading="lazy" className="w100 boRadXs maskLow  zinMin h100 hvh40  cover" src={`/covers/friendlyMeetings/${event.type}.png`} alt="" />
					{/* EVENT TYPE ICON ----------------------------------------------------------------*/}
					{!maximizeImg && <img className={` posAbs maskLowXs  boRadL  w70  ${!isMeeting ? 'botCen mw35' : 'topCen mw33 marTopS '}`} src={`/icons/types/${event.type}.png`} alt="" />}
				</meeting-image>
			) : (
				// REGULAR EVENT --------------------------------------------------------------
				<event-image class="posRel block fPadHorXs padTopS w100 marAuto">
					<image-wrapper class="posRel block w100 h100">
						<img onClick={onImageClick} style={onImageClick ? { maxWidth: `${window.innerWidth - 2}px` } : undefined} src={`${isMeeting ? `/covers/friendlyMeetings/${event.type}.png` : `${imgSrc}.webp`}`} className={`${isMobile ? 'w100' : ' mih40'} ${maximizeImg ? 'mhvh80' : ' mhvh40'} ${onImageClick ? 'pointer' : ''}  boRadXxs  marAuto cover flexCen zinMax posRel`} alt="" />
						{/* EVENT TYPE ICON ----------------------------------------------------------------*/}
						{!maximizeImg && nowAt !== 'editor' && (
							<event-type class={` flexCen noPoint aliCen posAbs zinMaXl botCen imw40 botCen downEvenMore `}>
								<img className=" padHorM boRadL w80" src={`/icons/types/${event.type}.png`} alt="" />
							</event-type>
						)}
					</image-wrapper>
					<blurred-imgs class={`flexCen  maskLow hvh60 posAbs topCen blur posRel w100`}>
						<img src={`${imgSrc}.webp`} className={`w50 h100 ${maximizeImg ? 'mhvh80 mih80' : ' mhvh80'} `} />
						<img src={`${imgSrc}.webp`} className={`w50 ${maximizeImg ? 'mhvh80 mih80' : ' mhvh80'} h100 `} style={{ transform: 'scaleX(-1)' }} />
					</blurred-imgs>
				</event-image>
			)}
		</header-div>
	);
}

export default EventHeaderImage;
