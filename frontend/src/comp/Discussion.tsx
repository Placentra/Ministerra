import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import TextArea from './TextArea';
import SortMenu from './SortMenu';
import Comment from './Comment';
import axios from 'axios';
import { forage, delUndef, setPropsToContent, fetchOwnProfile, createSubsetObj } from '../../helpers';
import { notifyGlobalError } from '../hooks/useErrorsMan';

const emptyCursors = {
	recent: ['new', 0, 0],
	oldest: ['old', 0, 0],
	popular: ['pop', 0],
	hottest: ['hot', 0],
};

// TODO should probably create a single source for comments authors instead of having each content have its own author data
// TODO will need to put indexes on scores and replies in the database. this sorting will be probably available in the more expensive version of the app
// TODO consider storing delete/edited content (messages/comments) directly into the database and potentially emiiting directly from the module (not emitter)
// TODO  stored comments are immediately visible instead of hidden until sync (own comments, previously written under event)
// TODO removing (not deleting) comment with replies (all from user) is unreliable. BE returns deleted not removed (might not be always)
// bug delete/remove determining logic (or BE logic) is weird. older comments where all replies belong to user are only deleted with the replies still visible
// todo  modify the DEL syncmode to use a 15 minute trigger flag, which wille either only get the del flags  only vs all metadata

// DISCUSSION COMPONENT DEFINITION ---
// Orchestrates comment threads, sorting, and optimistic posting for events
function Discussion(props) {
	const { obj, fadedIn, brain, setStatus } = props;
	const [comments, setComments] = useState([]),
		[selSort, setSelSort] = useState(['recent', false]),
		hideSort = [...(!comments?.some(c => c.replies > 0) ? ['hottest', '+replies'] : []), ...(!comments?.some(c => c.score > 0) ? ['popular'] : [])],
		[[curSyncMode, cursOrOffset], infinityTrigger, fetchInProg] = [obj.cursors?.recent || [], useRef(false), useRef(false)];

	const discussionTrigger = useRef(null);
	const sortedComms = useMemo(() => mergeOrSort(comments, null, selSort[0]), [comments, comments?.length, selSort]),
		canOrder = ['recent', 'oldest'].includes(selSort[0]),
		[showingMenuCommID, setShowingMenuCommID] = useState(null);

	// COMMENT MERGE AND SORT LOGIC ---
	// Deduplicates and merges new server data with local state, applying selected sort order
	function mergeOrSort(comms = [], newData, sortBy) {
		const sortFn = sort => {
			return (a, b) => {
				const [{ score: scA, replies: reA, id: idA }, { score: scB, replies: reB, id: idB }] = [a, b];
				if (sort === 'recent' || (!sort && !selSort[1])) return idB - idA;
				if (sort === 'oldest') return idA - idB;
				if (sort === 'popular') return scB - scA || reB - reA;
				if (sort === 'hottest') return reB - reA || scB - scA;
				return 0;
			};
		};
		if (newData) {
			const existingById = new Map(comms.map(c => [c.id, c]));
			const sanitized = newData.map(comm => {
				const isBaseOnly = comm.user == null;
				const existing = isBaseOnly ? existingById.get(comm.id) : null;
				let merged = comm;
				if (existing && isBaseOnly) {
					const { created: _omitCreated, ...commWithoutCreated } = comm;
					merged = {
						...commWithoutCreated,
						user: existing.user,
						imgVers: existing.imgVers,
						first: existing.first,
						last: existing.last,
						awards: existing.awards,
						mark: existing.mark,
						content: comm.flag === 'del' ? null : existing.content,
						created: existing.created,
					};
				}
				return merged;
			});
			const [newCommsMap, curCommIDs] = [
				new Map(
					setPropsToContent('comments', sanitized, brain).map(comm => [
						comm.id,
						{ ...comm, created: typeof comm.created === 'number' ? comm.created : Date.parse(comm.created) },
					])
				),
				new Set(comms.map(comm => comm.id)),
			];
			const updatedComms = comms.map(comm => {
				const newComm = newCommsMap.get(comm.id);
				return newComm ? Object.assign(comm, { commsData: comm.commsData }, newComm) : comm;
			});
			return [...newData.filter(p => !curCommIDs.has(p.id)).map(p => ({ ...p, repliesData: [] })), ...updatedComms].sort(sortFn('recent'));
		} else return comms?.sort(sortFn(sortBy)) || [];
	}

	// INITIALIZATION HOOK ---
	// Loads cached comments and cursors from local storage on component mount
	useLayoutEffect(() => {
		(async function init() {
			await initCommsAndCursors(obj, 'event', 'commsData', 'commsSyncedAt');
			setComments(obj.commsData || []);
		})();
	}, []);

	// REAL-TIME NOTIFICATION LISTENER ---
	// Subscribes to socket events for new comments and replies to trigger UI updates
	const currentSort = selSort[0];
	useEffect(() => {
		const handleNewComment = async e => {
			if (String(e.detail?.eventId) !== String(obj.id)) return;
			const { what, parentCommentId } = e.detail;
			if (what === 'comment' && currentSort === 'recent' && !fetchInProg.current) {
				const firstID = obj.commsData?.[0]?.id || 0;
				fetchInProg.current = true;
				try {
					const { data } = await axios.post('discussion', {
						eventID: obj.id,
						mode: 'getComments',
						selSort: 'recent',
						lastID: firstID,
					});
					if (data?.comms?.length) {
						const newComms = mergeOrSort(obj.commsData || [], data.comms, 'recent');
						obj.commsData = newComms;
						if (data.sync) obj.commsSyncedAt = data.sync;
						setComments([...newComms]);
						await forage({ mode: 'set', what: 'comms', id: obj.id, val: { commsData: obj.commsData, commsSyncedAt: obj.commsSyncedAt, cursors: obj.cursors } });
					}
				} catch (err) {
					console.error('Failed to fetch new comment:', err);
				} finally {
					fetchInProg.current = false;
				}
			}
			if (what === 'reply' && parentCommentId) {
				window.dispatchEvent(new CustomEvent('reply:new', { detail: { parentCommentId, eventId: obj.id } }));
			}
		};
		window.addEventListener('comments:new', handleNewComment);
		return () => window.removeEventListener('comments:new', handleNewComment);
	}, [obj.id, currentSort]);

	// CURSOR INITIALIZATION LOGIC ---
	// Prepares pagination cursors for different sorting modes based on existing data
	async function initCommsAndCursors(obj, mode, arrName, syncPropName) {
		const emptyData = { cursors: emptyCursors, [arrName]: [], [syncPropName]: 0 };
		if (!obj[arrName]) Object.assign(obj, mode === 'event' ? (await forage({ mode: `get`, what: 'comms', id: obj.id })) || emptyData : emptyData);
		if (Date.now() - obj[syncPropName] > 2000) {
			const gotAll = obj.cursors === 'gotAll';
			const [minId, maxId] = (() => {
				const arr = obj[arrName] || [];
				if (!arr.length) return [0, 0];
				const ids = arr.map(c => c.id);
				return [Math.min(...ids), Math.max(...ids)];
			})();
			obj.cursors = {
				recent: ['new', 0, gotAll ? minId : obj.cursors.recent?.[2] || obj[arrName][0]?.id || 0],
				oldest: ['old', 0, gotAll ? maxId : obj.cursors.oldest?.[2] || obj[arrName][obj[arrName].length - 1]?.id || 0],
				popular: ['pop', 0, 0],
				hottest: ['hot', 0, 0],
			};
		}
	}

	// DISCUSSION MANAGER ---
	// Handles all comment actions including posting, editing, deleting, and fetching more data
	async function handleDiscussionAction(inp) {
		try {
			const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
			const { comment, parent = obj, depth = 0, sort, isNew, content } = inp;
			const [sortBy, canOrder, cursorsRef, targetCommsArr] = [sort || selSort[0], ['recent', 'oldest'].includes(sort || selSort[0]), parent.cursors, parent.repliesData || parent.commsData];

			let [syncMode, cursOrOffset = 0, sortsLastID] = cursorsRef?.[sortBy] || [];
			let [{ mode }, firstID, lastID] = [inp, null, null];

			if (mode === 'selSort') {
				if (sort === 'replies') return setSelSort(prev => [prev[0], !prev[1]]);
				else if (syncMode === 'gotAll' || cursOrOffset) return setSelSort(prev => [sort, prev[1]]);
				else mode = 'getComments';
			}

			const axiosPayload = delUndef({
				eventID: obj.id,
				target: ['delete', 'remove'].includes(mode) ? (depth === 0 ? null : parent.id) : comment?.id,
				id: comment?.id,
				mode,
				content,
				isNew,
			});

			if (mode === 'getComments' || mode === 'getReplies') {
				const orderedComms = canOrder && (sortBy === 'recent' ? targetCommsArr : targetCommsArr.slice().reverse());
				const shouldGetCommID = whichOne => {
					if (!targetCommsArr?.length || cursOrOffset === sortsLastID) return false;
					if (whichOne === 'first') return (sortBy === 'recent' && syncMode === 'new') || (sortBy === 'oldest' && syncMode === 'old');
					if (whichOne === 'last') return (sortBy === 'recent' && syncMode !== 'old') || (sortBy === 'oldest' && syncMode !== 'new');
				};
				if (shouldGetCommID('first')) {
					const eligible = orderedComms.filter(c => (!cursOrOffset || (sortBy === 'recent' ? c.id < cursOrOffset : c.id > cursOrOffset)) && Date.now() - c.created > 1000 * 60 * 15);
					if (eligible.length > 0) firstID = sortBy === 'recent' ? Math.max(...eligible.map(c => c.id)) : Math.min(...eligible.map(c => c.id));
				}
				lastID = shouldGetCommID('last') && sortsLastID;
				Object.assign(axiosPayload, { firstID, lastID, cursOrOffset, lastSync: mode === 'getComments' && !cursOrOffset ? obj.commsSyncedAt : null, selSort: sortBy });
				if (firstID === lastID) firstID = axiosPayload.firstID = null;
			}

			let data;
			try {
				data = (await axios.post('discussion', delUndef(axiosPayload))).data;
			} catch (error) {
				notifyGlobalError(error, 'Nepodařilo se načíst diskusi.');
				return;
			}
			const [{ comms: axiComms = [], sync }, nextSyncMode, oppositeSort] = [data, sortBy === 'recent' ? 'old' : 'new', sortBy === 'recent' ? 'oldest' : 'recent'];
			const lastAxiID = axiComms.length > 0 ? axiComms[axiComms.length - 1]?.id || 0 : 0;

			if (mode === 'post') {
				if (!brain.user.first) await fetchOwnProfile(brain);
				const newComment = {
					user: brain.user.id,
					...createSubsetObj(brain.user, ['imgVers', 'first', 'last']),
					cursors: 'gotAll',
					repliesData: [],
					created: Date.now(),
					target: comment?.id,
					content,
					replies: 0,
					score: 0,
					id: data,
					own: true,
				};
				parent[comment ? 'replies' : 'comments']++, targetCommsArr.unshift(newComment);
			}

			if (mode === 'getComments' || mode === 'getReplies') {
				const newComms = mergeOrSort(targetCommsArr, axiComms, sortBy);
				(targetCommsArr.length = 0), targetCommsArr.push(...newComms);
				// SYNC TIMESTAMP UPDATE ---
				// For getComments: set on event object (obj.commsSyncedAt)
				// For getReplies: set on parent comment (parent.repliesSyncedAt)
				if (sync) {
					if (mode === 'getComments') obj.commsSyncedAt = sync;
					else parent.repliesSyncedAt = sync;
				}
				const oppositeCursor = typeof cursorsRef === 'object' && cursorsRef !== null ? cursorsRef[oppositeSort] : null;
				const isAllCommentsFetched =
					axiComms.length < 20 || (canOrder && oppositeCursor && ((sortBy === 'recent' && lastAxiID <= oppositeCursor[1]) || (sortBy === 'oldest' && lastAxiID >= oppositeCursor[1])));
				if (!isAllCommentsFetched) {
					if (typeof cursorsRef !== 'object' || cursorsRef === null) parent.cursors = { ...emptyCursors };
					const safeCursorsRef = parent.cursors;
					safeCursorsRef[sortBy] ??= canOrder ? ['new', 0, 0] : [0];
					if (canOrder) {
						if (syncMode === 'new' && sortBy === 'recent' && targetCommsArr.some(c => c.id > lastAxiID && c.created > fifteenMinutesAgo))
							safeCursorsRef[sortBy][0] = lastAxiID <= lastID ? 'old' : 'del';
						else if (syncMode === 'del' && axiComms.filter(c => !c.content).map(c => c.id).length !== axiComms.length) safeCursorsRef[sortBy][0] = nextSyncMode;
						else if (syncMode === 'old' && sortBy === 'oldest' && targetCommsArr.some(c => c.id < lastAxiID && c.created > fifteenMinutesAgo))
							safeCursorsRef[sortBy][0] = lastAxiID >= lastID ? 'new' : 'del';
						safeCursorsRef[sortBy][1] = lastAxiID;
						const boundaryFn = sortBy === 'recent' ? Math.min : Math.max;
						safeCursorsRef[sortBy][2] = boundaryFn(safeCursorsRef[sortBy][2] || lastAxiID, lastAxiID);
					} else safeCursorsRef[sortBy][0] += axiComms.length;
				}
				parent.cursors = isAllCommentsFetched ? 'gotAll' : parent.cursors;
			}

			if (mode === 'edit') {
				const targetComment = targetCommsArr.find(c => c.id === comment.id);
				if (targetComment) targetComment.content = content;
			}

			if (mode === 'delete') {
				parent[parent.replies !== undefined ? 'replies' : 'comments']--;
				if (data === 'deleted') (comment.content = null), (comment.flag = 'del');
			}

			parent[comment ? 'repliesData' : 'commsData'] = mergeOrSort(targetCommsArr, null, sortBy);
			if (parent.comments !== undefined) setStatus(prev => ({ ...prev, comments: parent.comments }));
			sort && setSelSort([sort, selSort[1]]),
				setComments(() => {
					if (!comment || (depth === 0 && ['delete', 'remove'].includes(mode))) return [...targetCommsArr];
					else return [...comments];
				});

			await forage({ mode: 'set', what: `comms`, id: obj.id, val: ['commsData', 'commsSyncedAt', 'cursors'].reduce((acc, key) => ({ ...acc, [key]: obj[key] }), {}) });
		} catch (err) {
			if (import.meta.env.DEV) console.error('Discussion error:', err);
		} finally {
			fetchInProg.current = false;
		}
	}

	// INFINITE SCROLL OBSERVER ---
	// Automatically fetches more comments when the end of the scrollable list is reached
	useEffect(() => {
		const infiniteObserver = new IntersectionObserver(
			entries => {
				entries.forEach(entry => {
					if (entry.isIntersecting && obj.cursors !== 'gotAll' && !fetchInProg.current) (fetchInProg.current = true), handleDiscussionAction({ mode: 'getComments' });
				});
			},
			{ rootMargin: '0%' }
		);
		if (infinityTrigger.current) infiniteObserver.observe(infinityTrigger.current);
		return () => infiniteObserver.disconnect();
	}, [selSort, curSyncMode, cursOrOffset, obj.commsSyncedAt]);

	// COMPONENT RENDERING ---
	// Renders the full discussion thread including input area, sort menu, and comment list
	return (
		<discussion-div ref={discussionTrigger} id='discussion' class={`${fadedIn.includes('Discussion') ? 'fadedIn' : 'fadingIn'} flexCol  block w100  aliCen  posRel    justCen marAuto`}>
			<discussion-wrapper class={`flexCol  block marAuto   posRel mihvh100 noBackground fPadHorXs  `}>
				{/* POST INPUT AREA --- */}
				{/* Sticky input field for creating new top-level comments */}
				<TextArea {...{ fadedIn: fadedIn, emptyDiscussion: (comments || []).length === 0, superMan: handleDiscussionAction, target: null, thisIs: 'comment' }} />
				{/* THREAD SORT MENU --- */}
				{/* Filter controls for changing the display order of the discussion */}
				{comments?.length > 1 && <SortMenu {...{ fadedIn, mode: 'discussion', hideSort, superMan: handleDiscussionAction, selSort, setSelSort }} />}
				{/* COMMENT LIST CONTAINER --- */}
				{/* Renders the collection of comments using the recursive Comment component */}
				<comments-wrapper class='block w100 mw140 flexCol gapXxxs    marAuto h100  '>
					{(obj.cursors === 'gotAll'
						? sortedComms
						: canOrder
						? sortedComms.filter(
								c =>
									cursOrOffset &&
									(selSort[0] === 'recent' ? c.id >= cursOrOffset || (c.own && c.created > obj.commsSyncedAt) : c.id <= cursOrOffset || (c.own && c.created > obj.commsSyncedAt))
						  )
						: sortedComms.slice(0, cursOrOffset || 0)
					).map((comment, i) => (
						<Comment
							brain={brain}
							mergeOrSort={mergeOrSort}
							showingMenuCommID={showingMenuCommID}
							setShowingMenuCommID={setShowingMenuCommID}
							initCommsAndCursors={initCommsAndCursors}
							selSort={selSort}
							eventID={obj.id}
							key={comment.id}
							{...{ comment, isFirst: i === 0, depth: 0, superMan: handleDiscussionAction }}
						/>
					))}
				</comments-wrapper>
			</discussion-wrapper>
			{/* INFINITE SCROLL TRIGGER --- */}
			{/* Visual marker at the end of the list to prompt data fetching and signal end of content */}
			<after-content ref={infinityTrigger} class={`${obj.cursors === 'gotAll' ? '' : 'mih1'} flexCol noBackground justCen gapS miw36 aliCen imw50 marAuto`}>
				{obj.cursors === 'gotAll' && (
					<end-content class='flexCol aliCen mw50 marAuto iw80 w100 textAli'>
						<img src='/icons/placeholdergood.png' alt='' />
						<p className='xBold fsF'>Komponenta na konec obsahu</p>
					</end-content>
				)}
			</after-content>
		</discussion-div>
	);
}
export default Discussion;
