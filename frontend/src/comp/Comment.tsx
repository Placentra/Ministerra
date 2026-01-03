// INDIVIDUAL COMMENT COMPONENT ---
// Renders a single comment/reply with support for nested threads, rating, and reporting.
import { useState, memo, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import TextArea from './TextArea';
import SimpleProtocol from './SimpleProtocol';
import RateAwards from './RateAwards';
import MenuStrip from './MenuStrip';
import { humanizeDateTime } from '../../helpers';
import ContentIndis from './ContentIndis';
import { useCommentsMan } from '../hooks/useCommentsMan';

// COMMENT COMPONENT ---
// Core logic for comment display, replies fetching, and interactive modes.
// COMMENT COMPONENT DEFINITION ---
// Handles individual comment display, replies, rating, and reporting protocols
function Comment(props) {
	const commentsMan = useCommentsMan();
	const { comment, isFirst, selSort, depth, parent, mergeOrSort, mention, superMan, brain, eventID, showingMenuCommID, setShowingMenuCommID, initCommsAndCursors } = props;
	const [modes, setModes] = useState({ replies: false, textArea: false, protocol: false, actions: false, menu: false });
	const sortBy = depth === 0 ? (selSort[1] ? selSort[0] : 'recent') : 'oldest';
	const [status, setStatus] = useState({ own: comment.own, mark: comment.mark, score: comment.score, copied: false, awards: comment.awards || [], replies: comment.replies || 0 });
	const reportScrollRef = useRef(null),
		commentContainerRef = useRef(null),
		[showMentionContent, setShowMentionContent] = useState(false);

	const [curSyncMode, cursOrOffset, curLastID] = comment.cursors?.[sortBy] || [],
		canOrder = ['recent', 'oldest'].includes(sortBy);

	// SORTED REPLIES COMPUTATION ---
	const sortedReplies = useMemo(() => {
		const repliesData = comment?.repliesData;
		return repliesData?.length ? mergeOrSort(repliesData, null, sortBy) : [];
	}, [comment?.id, comment?.repliesData, sortBy, mergeOrSort]);

	// MANAGER HANDLER ---
	async function man({ mode, content }: any) {
		await commentsMan({ mode, content, depth, comment, modes, parent, setShowingMenuCommID, superMan, eventID, brain, sortBy, status, setStatus, setModes });
	}

	// INITIALIZATION AND KEYBOARD HANDLERS ---
	useEffect(() => {
		let mounted = true;
		(async () => {
			if (mounted && depth < 2 && comment?.repliesData?.length && !comment.cursors) await initCommsAndCursors(comment, 'comment', 'repliesData', 'repliesSyncedAt');
		})();
		const handleEscapeKey = e => e.key === 'Escape' && setModes(prev => ({ ...prev, textArea: false }));
		document.addEventListener('keydown', handleEscapeKey);
		return () => ((mounted = false), document.removeEventListener('keydown', handleEscapeKey));
	}, [comment?.id, comment?.repliesData?.length, depth, initCommsAndCursors]);

	// REAL-TIME REPLY NOTIFICATIONS ---
	const repliesExpanded = modes.replies;
	useEffect(() => {
		if (depth !== 0) return;
		const handleNewReply = async e => {
			if (String(e.detail?.parentCommentId) !== String(comment.id)) return;
			(comment.replies = (comment.replies || 0) + 1), setStatus(prev => ({ ...prev, replies: comment.replies }));
			if (repliesExpanded) await superMan({ mode: 'getReplies', comment, parent: comment, depth: 0 });
		};
		window.addEventListener('reply:new', handleNewReply);
		return () => window.removeEventListener('reply:new', handleNewReply);
	}, [comment.id, repliesExpanded, depth]);

	// CONTEXT MENU SYNC ---
	useLayoutEffect(() => {
		if (showingMenuCommID !== comment.id) setModes(prev => ({ ...prev, menu: false }));
	}, [showingMenuCommID]);

	return (
		<comment-container
			ref={commentContainerRef}
			class={` ${modes.protocol ? 'shaCon borderLight' : ''}  block ${modes.textArea || modes.actions ? ' marTopS boRadXs ' : ''} ${depth > 0 ? 'marLefXl ' : ' '} ${
				modes.replies === true ? `${depth === 0 ? ' marBotL boRadM marVerXs ' : depth === 1 ? 'marBotM' : ''}` : ''
			} ${depth === 0 ? 'shaComment' : depth === 1 ? `borBotLight` : ''} ${depth === 2 && isFirst ? 'marTopS' : ''} ${modes.menu ? 'borderLight boRadXs' : ''} posRel boRadXxs zin10`}>
			<comment-body class={` ${modes.protocol ? 'fPadHorXxs' : ''} bHover ${depth === 0 ? 'bgTrans ' : depth === 1 ? 'padVerXxs' : 'padVerXxxs'} flexRow boRadXs posRel`}>
				{depth === 1 && <div style={{ left: '10px', top: '-5rem' }} className='bDarkBlue maskLow zin1 opacityXs wr2 h100 posAbs'></div>}

				{/* USER AVATAR --- */}
				<img-wrapper
					onClick={e => (e.stopPropagation(), man({ mode: 'menu' }))}
					class={`${
						depth === 0 ? 'mw14 marRigM miw5 w25 ' : depth === 1 ? 'marRigM marLefXs mw8 miw4 w20 zinMax' : 'w14 marRigM bgTrans marLefS shaCon mw7 miw3'
					} posRel textAli bHover zinMaXl selfStart`}>
					<img
						className={`aspect1610 bhover w100 ${modes.menu ? 'bsContentGlow borBot8' : ''} boRadXs borderLight posRel shaComment zinMaXl `}
						src={comment.imgVers ? `${import.meta.env.VITE_BACK_END}/public/users/${comment.user}_${comment.imgVers}S.webp` : '/icons/placeholder169.png'}
						alt=''
					/>
				</img-wrapper>

				{/* INTERACTIVE OVERLAYS --- */}
				<action-divs>
					{!comment.own && <rating-div onClick={() => man({ mode: 'rating' })} class={`topRight boRadM maskTop zin100 posAbs grow h100`} />}
					<reply-div onClick={() => man({ mode: 'reply' })} class={`topLeft posAbs grow maskTop zin100 ${comment.own ? 'w100' : 'w50'} h100`} />
				</action-divs>

				{/* COMMENT CONTENT --- */}
				<texts-div class='flexCol justCen posRel selfCen w100 '>
					<p>
						<span className={`${depth === 0 ? 'fs9 lh1-3 boldM ' : depth === 1 ? 'fs9 lh1-3 boldM ' : 'fs8 lh0-8 bold '} tDarkBlue marRigS `}>
							{(comment.first || brain.user.first) + ' ' + (comment.last || brain.user.last)}
						</span>
						<ContentIndis status={status} superMan={man} isCardOrStrip={true} brain={brain} obj={comment} thisIs={'comment'} />
						{mention && (
							<>
								<span onClick={() => setShowMentionContent(!showMentionContent)} className='tBlue pointer inline lh1 boldM fs8 marRigXs marLefS'>{`@${
									mention.first || brain.user.first
								} ${mention.last || brain.user.last}`}</span>
								<span className='tBlue lh1 inline fs8'>{mention.content.slice(0, !showMentionContent ? 100 : undefined)}</span>
							</>
						)}
					</p>
					<span className={` ${depth === 0 ? 'fsB boldXxs textSha' : depth === 1 ? 'fsA boldXxs' : 'fs7'} lh1 ${comment.flag === 'del' ? 'tRed boldXs' : ''} `}>
						{comment.flag === 'del' ? 'Komentář byl smazán uživatelem' : comment.content}
					</span>
					{depth < 2 && status.replies > 0 && (
						<button
							onClick={e => (
								e.stopPropagation(),
								(comment.cursors === 'gotAll' && (comment.repliesData?.length || 0) >= status.replies) || (comment.repliesData?.length && !modes.replies)
									? man({ mode: 'toggleReplies' })
									: man({ mode: 'getReplies' })
							)}
							className={`grow w100 ${depth === 0 ? `${modes.replies !== true ? 'mw20' : 'mw30'} fsB padVeXxs marTopXs ` : 'fsA marTopXs boldXs mw20'} ${
								modes.replies !== true ? 'bold' : ' tRed bGlassSubtle xBold'
							} posRel padVerXxs zinMaXl bHover`}>
							{modes.replies === true ? `Sbalit (${status.replies})` : `${status.replies} odpovědí`}
						</button>
					)}
				</texts-div>
				<span onClick={() => man({ mode: 'menu' })} className=' boRadXxs fs7 boldXs posRel padHorXs flexRow aliCen tGrey posAbs topRight boRadXxs noBackground miw3 inlineBlock selfStart '>
					{humanizeDateTime({ dateInMs: comment.created, getGranularPast: true })}
				</span>
			</comment-body>

			{/* EXPANDABLE MODES --- */}
			{modes.menu && <MenuStrip modes={modes} obj={comment} superMan={man} status={status} setStatus={setStatus} setModes={setModes} brain={brain} thisIs={'comment'} />}
			<scroll-target ref={reportScrollRef}></scroll-target>
			{modes.protocol && <SimpleProtocol superMan={man} modes={modes} setModes={setModes} thisIs={'comment'} target={comment.id} />}
			{modes.textArea && <TextArea content={modes.textArea === 'edit' ? comment.content : undefined} target={comment.id} isReply={true} setModes={setModes} superMan={man} thisIs={'comment'} />}
			{modes.actions && <RateAwards {...{ obj: comment, thisIs: 'comment', status, setStatus, fadedIn: ['RatingBs'], modes, setModes, isCardOrStrip: true }} />}

			{/* NESTED REPLIES --- */}
			{modes.replies === true && (
				<replies-wrapper class={`${depth === 0 ? 'gapXxxs padLefM' : 'gapXxxs '} posRel overflow flexCol `}>
					{depth === 1 && <div style={{ left: 'clamp(5vw, 8vh, 30px)', zIndex: -1 }} className='bBlue opacityS wr0-2 maskLowXs h100 posAbs upLittle'></div>}
					{(!curSyncMode
						? sortedReplies
						: canOrder
						? sortedReplies.filter(c =>
								sortBy === 'recent' ? c.id >= cursOrOffset || (c.own && c.created > comment.repliesSyncedAt) : c.id <= cursOrOffset || (c.own && c.created > comment.repliesSyncedAt)
						  )
						: sortedReplies.slice(0, cursOrOffset || 0)
					).map((comm, i) => (
						<Comment
							key={comm.id}
							{...{
								parent: comment,
								mention: depth === 1 && sortedReplies.find(reply => reply.id === comm.target),
								comment: comm,
								selSort,
								isFirst: i === 0,
								mergeOrSort,
								setShowingMenuCommID,
								initCommsAndCursors,
								showingMenuCommID,
								eventID,
								depth: Math.min(2, depth + 1),
								brain,
								superMan,
							}}
						/>
					))}
				</replies-wrapper>
			)}
			{curSyncMode && modes.replies === true && sortedReplies?.length > 0 && sortedReplies.length % 20 === 0 && (
				<replies-controls class='flexRow'>
					<button onClick={e => (e.stopPropagation(), man({ mode: 'getReplies' }))} className='bBottom bBottom--green grow marBotXs zinMax w40 mw30 fsB border bold padVerXxs '>
						Načíst další
					</button>
				</replies-controls>
			)}
		</comment-container>
	);
}

export default memo(Comment);
